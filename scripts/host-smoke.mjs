#!/usr/bin/env node
/**
 * host-smoke.mjs — end-to-end harness for the dsh-computers HOST half.
 *
 * No test framework and no dependencies: a fake Cordis context records the
 * routes/tools/prompt sections that `apply()` registers, a real ephemeral
 * `node:http` listener dispatches to those routes exactly like the host's
 * webServer does, and this file plays both the browser and the machine agent
 * (SSE client + result POSTs).
 *
 * Run: node scripts/host-smoke.mjs   (exit code 0 = all assertions passed)
 *
 * Covered: config validation, state/keys/key-status/delete/rename, key TTL
 * refusals from a pre-seeded registry, enroll → SSE hello → exec → results,
 * timeout, abort, output truncation, presence (stream-only), the browser gate
 * and its fallback, 405s, join.sh/join.ps1/agent.mjs/health, both tools through
 * the recorded definitions, AND runtime mode (§10): role gating, runtime.json
 * persistence, and connect/enable/disconnect/auto-restart against a fake hub.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { apply, resolveConfig } from '../index.js'
import { mintSecret, newComputerId, normalizeDisplayName, sha256Hex, tokenMatches } from '../lib/keys.js'
import { prunePendingKeys } from '../lib/state.js'

const ROOT = new URL('../', import.meta.url).pathname
const API = '/api/dsh-computers'
const AGENT_FILE = join(ROOT, 'agent', 'dsh-computers-agent.mjs')

// ---------------------------------------------------------------------------
// Tiny assertion runner
// ---------------------------------------------------------------------------

let passed = 0
const failures = []

/** Run one labelled assertion group; a throw marks it FAIL and keeps going. */
async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${label}`)
  } catch (error) {
    failures.push({ label, error })
    const message = error && error.stack ? error.stack : String(error)
    console.error(`FAIL ${label}\n  ${message.split('\n').join('\n  ')}`)
  }
}

const iso = (ms) => new Date(ms).toISOString()

// ---------------------------------------------------------------------------
// Fake Cordis context + real HTTP listener
// ---------------------------------------------------------------------------

/**
 * A fake host context: records effects/routes/tools/sections, exposes a
 * deliberately lazy `getOrigin()` (throws until the listener binds, like the
 * real webServer), and lets a test swap the `connection` service.
 */
function createFakeContext() {
  const routes = new Map()
  const tools = new Map()
  const sections = []
  const disposers = []
  let origin = null
  let connection

  const systemPrompt = {
    section(section) {
      sections.push(section)
      return () => {
        const index = sections.indexOf(section)
        if (index !== -1) sections.splice(index, 1)
      }
    },
    getSectionOrder(name) {
      return name === 'TOOL_COMPUTER_USE' ? 3000 : undefined
    },
    context() {
      return () => {}
    },
  }

  const ctx = {
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    get(name) {
      if (name === 'connection') return connection
      if (name === 'systemPrompt') return systemPrompt
      return undefined
    },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      getOrigin() {
        if (origin === null) throw new Error('webserver: origin read before the listener bound a port')
        return origin
      },
    },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }

  return {
    ctx,
    routes,
    tools,
    sections,
    setOrigin(value) {
      origin = value
    },
    setGate(value) {
      connection = value
    },
    dispose() {
      while (disposers.length > 0) {
        const disposer = disposers.pop()
        try {
          disposer()
        } catch {
          // A broken disposer must not abort the rest of the teardown.
        }
      }
      routes.clear()
      tools.clear()
      sections.length = 0
    },
  }
}

/** Start a listener that dispatches to the fake context's registered routes. */
async function startListener(fake) {
  const server = createServer((req, res) => {
    const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://dsh-computers.invalid')
    const route = fake.routes.get(url.pathname)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'no-route' }))
      return
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(error && error.message ? error.message : error))
      } catch {
        // Socket already gone.
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  fake.setOrigin(origin)
  return {
    server,
    origin,
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve())
        // Keep-alive sockets from fetch/SSE must not hold the close open.
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      })
    },
  }
}

/** Mount the plugin against a fresh fake context and a real listener. */
async function mount(config) {
  const fake = createFakeContext()
  apply(fake.ctx, config)
  const listener = await startListener(fake)
  return {
    fake,
    origin: listener.origin,
    async close() {
      await listener.close()
      fake.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** JSON request through global fetch (normal browser-side usage). */
async function call(origin, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data = text
  try {
    data = text === '' ? undefined : JSON.parse(text)
  } catch {
    // Plain-text route.
  }
  return { status: response.status, headers: response.headers, text, data }
}

/** Raw request with full header control (used for the origin gate). */
function raw(origin, path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(path, origin)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data = text
        try {
          data = JSON.parse(text)
        } catch {
          // Plain text.
        }
        resolve({ status: response.statusCode, headers: response.headers, text, data })
      })
    })
    request.on('error', reject)
    if (body !== undefined) request.write(typeof body === 'string' ? body : JSON.stringify(body))
    request.end()
  })
}

/**
 * Minimal SSE client: parses `event:`/`data:` frames, keeps an ordered queue,
 * lets the test await named events, and resolves `ended` when the stream ends.
 */
function openSse(origin, path, headers = {}) {
  const url = new URL(path, origin)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { accept: 'text/event-stream', ...headers },
    }, (response) => {
      const queue = []
      const waiters = []
      let buffer = ''
      let ended = false
      let endResolve
      const endedPromise = new Promise((resolveEnd) => {
        endResolve = resolveEnd
      })

      const flush = () => {
        while (waiters.length > 0) {
          const waiter = waiters[0]
          const index = queue.findIndex((event) => waiter.name === null || event.name === waiter.name)
          if (index === -1) break
          const [event] = queue.splice(index, 1)
          waiters.shift()
          clearTimeout(waiter.timer)
          waiter.resolve(event)
        }
      }

      const failWaiters = () => {
        while (waiters.length > 0) {
          const waiter = waiters.shift()
          clearTimeout(waiter.timer)
          waiter.reject(new Error(`SSE stream ended while waiting for "${waiter.name ?? 'any'}"`))
        }
      }

      const client = {
        status: response.statusCode,
        headers: response.headers,
        raw: '',
        events: queue,
        ended: endedPromise,
        isEnded: () => ended,
        close() {
          try {
            request.destroy()
            response.destroy()
          } catch {
            // Already closed.
          }
        },
        nextEvent(name, timeoutMs = 3000) {
          return new Promise((resolveEvent, rejectEvent) => {
            const waiter = { name, resolve: resolveEvent, reject: rejectEvent, timer: null }
            waiter.timer = setTimeout(() => {
              const position = waiters.indexOf(waiter)
              if (position !== -1) waiters.splice(position, 1)
              rejectEvent(new Error(`timed out waiting for SSE event "${name ?? 'any'}"; saw ${JSON.stringify(queue.map((event) => event.name))}`))
            }, timeoutMs)
            waiters.push(waiter)
            flush()
          })
        },
      }

      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        client.raw += chunk
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          let name = 'message'
          const dataLines = []
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
            // `retry:` is a comment for our purposes; raw keeps it assertable.
          }
          if (dataLines.length === 0) continue
          let data = dataLines.join('\n')
          try {
            data = JSON.parse(data)
          } catch {
            // Keep the text.
          }
          queue.push({ name, data })
        }
        flush()
      })
      const onEnd = () => {
        if (ended) return
        ended = true
        endResolve()
        failWaiters()
      }
      response.on('end', onEnd)
      response.on('close', onEnd)
      response.on('error', onEnd)
      resolve(client)
    })
    request.on('error', reject)
    request.end()
  })
}

/** Poll `probe` until `predicate` holds or the deadline passes. */
async function waitFor(probe, predicate, timeoutMs = 3000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (predicate(last)) return last
    await sleep(25)
  }
  throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(last)}`)
}

/** Default test config: fast heartbeat and a short exec timeout so the smoke run stays quick. */
const FAST_CONFIG = Object.freeze({ heartbeatMs: 300, execTimeoutMs: 600, maxOutputBytes: 1024 })

/** Write a registry document directly (for TTL/offline scenarios). */
function seedState(stateDir, doc) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'state.json'), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
}

/** One plausible registry record for offline/ambiguous name scenarios. */
function seedComputer(id, name, extra = {}) {
  return {
    id,
    name,
    hostname: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.local`,
    os: 'darwin',
    arch: 'arm64',
    platformLabel: 'macOS',
    cpuModel: 'Apple M4 Pro',
    memoryBytes: 17_179_869_184,
    nodeVersion: 'v24.0.0',
    agentVersion: '1.0.0',
    tokenHash: sha256Hex(mintSecret()),
    createdAt: iso(Date.now() - 60_000),
    lastSeenAt: iso(Date.now() - 3_600_000),
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Phase A — full lifecycle against a real listener
// ---------------------------------------------------------------------------

async function phaseA(root) {
  const dir = join(root, 'a')
  const app = await mount({ ...FAST_CONFIG, stateDir: dir })
  const sseClients = []
  try {
    const origin = app.origin
    const stateFile = join(dir, 'state.json')
    assert.ok(existsSync(stateFile), 'apply() must create the state file')

    // --- health / state / keys ------------------------------------------------
    await check('health: empty deployment', async () => {
      const response = await call(origin, `${API}/health`)
      assert.equal(response.status, 200)
      assert.deepEqual(response.data, { ok: true, version: '1.0.0', computers: 0, online: 0 })
      assert.equal(response.headers.get('cache-control'), 'no-store')
    })

    await check('state: empty registry has protocol shape', async () => {
      const response = await call(origin, `${API}/state`)
      assert.equal(response.status, 200)
      assert.equal(response.data.version, 2)
      assert.equal(response.data.serverUrl, origin)
      assert.equal(response.data.heartbeatMs, 300)
      assert.deepEqual(response.data.computers, [])
      assert.equal(response.data.pendingKey, null)
    })

    await check('prompt section is empty with no computers', async () => {
      const section = app.fake.sections.find((candidate) => candidate.name === 'computers')
      assert.ok(section, 'systemPrompt.section({ name: "computers" }) was not registered')
      assert.equal(typeof section.text, 'function')
      assert.equal(section.text({}), '')
    })

    await check('keys: mint an enrollment key', async () => {
      const response = await call(origin, `${API}/keys`, { method: 'POST', body: { os: 'macos', replace: false, label: null } })
      assert.equal(response.status, 200)
      assert.match(response.data.key, /^dshc_[A-Za-z0-9_-]{43}$/)
      assert.equal(response.data.os, 'macos')
      assert.equal(response.data.serverUrl, origin)
      assert.equal(response.data.installUrl, `${origin}${API}/join.sh?key=${encodeURIComponent(response.data.key)}`)
      assert.equal(response.data.command, `curl -fsSL '${response.data.installUrl}' | sh`)
      assert.equal(response.data.windowsCommand, `irm '${origin}${API}/join.ps1?key=${encodeURIComponent(response.data.key)}' | iex`)
      assert.ok(Number.isFinite(Date.parse(response.data.expiresAt)), 'expiresAt must be ISO')
      app.firstKey = response.data.key
    })

    await check('key-status: waiting', async () => {
      const response = await call(origin, `${API}/key-status?key=${encodeURIComponent(app.firstKey)}`)
      assert.equal(response.status, 200)
      assert.deepEqual(response.data, { status: 'waiting', computer: null })
    })

    await check('keys: a second key invalidates the first', async () => {
      const response = await call(origin, `${API}/keys`, { method: 'POST', body: { os: 'linux' } })
      assert.equal(response.status, 200)
      app.secondKey = response.data.key
      const first = await call(origin, `${API}/key-status?key=${encodeURIComponent(app.firstKey)}`)
      assert.deepEqual(first.data, { status: 'used', computer: null })
      const state = await call(origin, `${API}/state`)
      assert.equal(state.data.pendingKey.key, app.secondKey)
      assert.equal(state.data.pendingKey.os, 'linux')
    })

    await check('join.sh: installer content is generated from the live URL', async () => {
      const response = await call(origin, `${API}/join.sh?key=${encodeURIComponent(app.secondKey)}`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /text\/x-shellscript/)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.match(response.text, /^#!\/bin\/sh/)
      assert.ok(response.text.includes(`SERVER='${origin}'`), 'script must embed the server URL')
      assert.ok(response.text.includes(`KEY='${app.secondKey}'`), 'script must embed the key')
      assert.match(response.text, /node -v/)
      assert.match(response.text, /22 or newer/)
      assert.ok(response.text.includes('/api/dsh-computers/agent.mjs'))
      assert.ok(response.text.includes('enroll --server'))
      assert.ok(response.text.includes('service install'))
      assert.ok(response.text.includes('service start'))
    })

    await check('join.sh: POSIX shell syntax check (sh -n)', async () => {
      const response = await call(origin, `${API}/join.sh?key=${encodeURIComponent(app.secondKey)}`)
      assert.equal(response.status, 200)
      const scriptPath = join(root, 'join-smoke.sh')
      writeFileSync(scriptPath, response.text, { mode: 0o700 })
      const result = spawnSync('sh', ['-n', scriptPath], { encoding: 'utf8' })
      assert.equal(result.status, 0, `sh -n rejected the generated installer: ${result.stderr}`)
    })

    await check('join.sh: unknown key is 410 text', async () => {
      const response = await call(origin, `${API}/join.sh?key=dshc_doesnotexist`)
      assert.equal(response.status, 410)
      assert.match(response.text, /unknown enrollment key/)
    })

    await check('join.ps1: Windows variant', async () => {
      const response = await call(origin, `${API}/join.ps1?key=${encodeURIComponent(app.secondKey)}`)
      assert.equal(response.status, 200)
      assert.ok(response.text.includes('Invoke-WebRequest'))
      assert.ok(response.text.includes(app.secondKey))
    })

    await check('agent.mjs: served byte-for-byte from the bundle, or 404 when missing', async () => {
      const response = await call(origin, `${API}/agent.mjs`)
      if (existsSync(AGENT_FILE)) {
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /text\/javascript/)
        assert.equal(response.headers.get('cache-control'), 'no-store')
        assert.equal(response.text, readFileSync(AGENT_FILE, 'utf8'), 'served bytes must equal agent/dsh-computers-agent.mjs')
        assert.ok(response.text.startsWith('#!'), 'agent bundle should start with a shebang')
      } else {
        assert.equal(response.status, 404)
        assert.equal(response.data.error, 'agent-unavailable')
      }
    })

    // --- enroll ----------------------------------------------------------------
    await check('enroll: bad bodies and keys', async () => {
      const empty = await call(origin, `${API}/agent/enroll`, { method: 'POST', body: {} })
      assert.equal(empty.status, 400)
      assert.equal(empty.data.error, 'bad-request')
      const unknown = await call(origin, `${API}/agent/enroll`, { method: 'POST', body: { key: 'dshc_unknownunknownunknown', machine: { hostname: 'x' } } })
      assert.equal(unknown.status, 401)
      assert.equal(unknown.data.error, 'invalid-key')
      const noMachine = await call(origin, `${API}/agent/enroll`, { method: 'POST', body: { key: app.secondKey } })
      assert.equal(noMachine.status, 400)
    })

    await check('enroll: creates the computer and returns the token once', async () => {
      const response = await call(origin, `${API}/agent/enroll`, {
        method: 'POST',
        body: {
          key: app.secondKey,
          agentVersion: '1.0.0',
          machine: {
            hostname: 'smoke-mac.local',
            name: 'Smoke Mac',
            os: 'darwin',
            arch: 'arm64',
            platform: 'macOS',
            cpuModel: 'Apple M4 Pro',
            memoryBytes: 17_179_869_184,
            nodeVersion: 'v24.18.1',
          },
        },
      })
      assert.equal(response.status, 200)
      assert.match(response.data.computerId, /^cmp_[0-9a-f]{12}$/)
      assert.match(response.data.token, /^dshc_[A-Za-z0-9_-]{43}$/)
      assert.equal(response.data.name, 'Smoke Mac')
      assert.equal(response.data.serverUrl, origin)
      app.computerId = response.data.computerId
      app.token = response.data.token

      const again = await call(origin, `${API}/agent/enroll`, { method: 'POST', body: { key: app.secondKey, machine: { hostname: 'smoke-mac.local' } } })
      assert.equal(again.status, 409)
      assert.equal(again.data.error, 'key-used')

      const status = await call(origin, `${API}/key-status?key=${encodeURIComponent(app.secondKey)}`)
      assert.equal(status.data.status, 'connected')
      assert.equal(status.data.computer.id, app.computerId)
    })

    await check('state: a computer is offline until its stream opens (fresh lastSeenAt is not presence)', async () => {
      // enroll() stamps lastSeenAt, but presence is the live SSE stream only:
      // no stream may never read as online.
      const response = await call(origin, `${API}/state`)
      assert.equal(response.data.computers.length, 1)
      const computer = response.data.computers[0]
      assert.equal(computer.id, app.computerId)
      assert.equal(computer.name, 'Smoke Mac')
      assert.equal(computer.platformLabel, 'macOS')
      assert.equal(computer.online, false)
      assert.deepEqual(computer.bots, { used: 0, total: 1 })
      assert.equal(response.data.pendingKey, null)
      assert.ok(Number.isFinite(Date.parse(computer.lastSeenAt)), 'lastSeenAt is still recorded for display')
    })

    await check('agent routes require the bearer token', async () => {
      const events = await raw(origin, `${API}/agent/events`)
      assert.equal(events.status, 401)
      assert.equal(events.data.error, 'invalid-token')
      const heartbeat = await raw(origin, `${API}/agent/heartbeat`, { method: 'POST', body: '{}' })
      assert.equal(heartbeat.status, 401)
    })

    // --- SSE ---------------------------------------------------------------
    await check('SSE: hello event and protocol headers', async () => {
      const client = await openSse(origin, `${API}/agent/events`, { authorization: `Bearer ${app.token}` })
      sseClients.push(client)
      app.sse = client
      assert.equal(client.status, 200)
      assert.match(client.headers['content-type'], /text\/event-stream/)
      assert.equal(client.headers['cache-control'], 'no-store')
      assert.equal(client.headers['x-accel-buffering'], 'no')
      const hello = await client.nextEvent('hello', 2000)
      assert.deepEqual(hello.data, { computerId: app.computerId, name: 'Smoke Mac', heartbeatMs: 300 })
      assert.ok(client.raw.includes('retry: 2000'), 'SSE must start with retry: 2000')
    })

    await check('state: live stream makes the computer online', async () => {
      const response = await call(origin, `${API}/state`)
      const computer = response.data.computers[0]
      assert.equal(computer.online, true)
      assert.deepEqual(computer.bots, { used: 1, total: 1 })
      const health = await call(origin, `${API}/health`)
      assert.equal(health.data.online, 1)
    })

    await check('heartbeat: refreshes metadata/lastSeenAt and echoes the name', async () => {
      const response = await raw(origin, `${API}/agent/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ meta: { cpuModel: 'Apple M4 Max', agentVersion: '1.0.1' } }),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(response.data, { ok: true, name: 'Smoke Mac' })
      const state = await call(origin, `${API}/state`)
      assert.equal(state.data.computers[0].cpuModel, 'Apple M4 Max')
      assert.equal(state.data.computers[0].agentVersion, '1.0.1')
    })

    // --- tools -------------------------------------------------------------
    await check('computer_list: value and render', async () => {
      const listTool = app.fake.tools.get('computer_list')
      assert.ok(listTool, 'computer_list was not registered')
      const value = await listTool.execute({}, {})
      assert.equal(value.computers.length, 1)
      assert.equal(value.computers[0].online, true)
      const content = listTool.output.render({}, value)
      assert.equal(content.length, 1)
      assert.equal(content[0].type, 'text')
      assert.ok(content[0].text.includes('Smoke Mac'))
      assert.ok(content[0].text.includes('| macOS | online |'))
    })

    await check('prompt section lists connected computers', async () => {
      const section = app.fake.sections.find((candidate) => candidate.name === 'computers')
      const text = section.text({})
      assert.ok(text.includes('computer_exec'))
      assert.ok(text.includes('computer_list'))
      assert.ok(text.includes('- Smoke Mac (macOS, online)'))
    })

    await check('computer_exec: end to end through SSE and results', async () => {
      const execTool = app.fake.tools.get('computer_exec')
      assert.ok(execTool, 'computer_exec was not registered')
      const pending = execTool.execute(
        { computer: 'Smoke Mac', command: 'echo hi' },
        { signal: new AbortController().signal },
      )
      const execEvent = await app.sse.nextEvent('exec', 2000)
      assert.match(execEvent.data.requestId, /^req_[0-9a-f]{24}$/)
      assert.equal(execEvent.data.command, 'echo hi')
      assert.equal(execEvent.data.cwd, null)
      assert.equal(execEvent.data.timeoutMs, 600)
      assert.equal(execEvent.data.shell, 'sh')

      const result = await raw(origin, `${API}/agent/results`, {
        method: 'POST',
        headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: execEvent.data.requestId,
          ok: true,
          exitCode: 0,
          signal: null,
          stdout: 'hi there\n',
          stderr: '',
          durationMs: 12,
          truncated: false,
          timedOut: false,
          error: null,
        }),
      })
      assert.equal(result.status, 200)
      assert.deepEqual(result.data, { ok: true })

      const value = await pending
      assert.equal(value.command, 'echo hi')
      assert.equal(value.exitCode, 0)
      assert.equal(value.stdout, 'hi there\n')
      assert.equal(value.ok, true)
      assert.equal(value.timedOut, false)
      assert.deepEqual(value.computer, { id: app.computerId, name: 'Smoke Mac' })
      const content = execTool.output.render({ command: 'echo hi' }, value)
      assert.ok(content[0].text.startsWith('$ echo hi'))
      assert.ok(content[0].text.includes('exit 0 · 12ms · Smoke Mac'))
      assert.ok(content[0].text.includes('hi there'))
    })

    await check('results: a settled request id is 404', async () => {
      const response = await raw(origin, `${API}/agent/results`, {
        method: 'POST',
        headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'req_ffffffffffffffffffffffff', ok: true, exitCode: 0 }),
      })
      assert.equal(response.status, 404)
      assert.equal(response.data.error, 'unknown-request')
    })

    await check('computer_exec: timeout cancels and rejects', async () => {
      const execTool = app.fake.tools.get('computer_exec')
      // Attach the rejection handler immediately: the promise settles while
      // this check is still reading SSE frames, and an unhandled rejection
      // would take the whole harness down.
      const outcome = execTool.execute({ computer: app.computerId, command: 'sleep 60' }, {})
        .then((value) => ({ value }), (error) => ({ error }))
      const execEvent = await app.sse.nextEvent('exec', 2000)
      const cancelEvent = await app.sse.nextEvent('cancel', 3000)
      assert.equal(cancelEvent.data.requestId, execEvent.data.requestId)
      const settled = await outcome
      assert.ok(settled.error, 'a timed-out command must reject')
      assert.match(settled.error.message, /did not finish within 600ms/)
      // `ping` frames accumulate while this check awaits; only exec frames matter.
      assert.equal(app.sse.events.filter((event) => event.name === 'exec').length, 0, 'no stray exec events expected')
    })

    await check('computer_exec: abort sends cancel then rejects', async () => {
      const execTool = app.fake.tools.get('computer_exec')
      const controller = new AbortController()
      const outcome = execTool.execute({ computer: app.computerId, command: 'sleep 60' }, { signal: controller.signal })
        .then((value) => ({ value }), (error) => ({ error }))
      const execEvent = await app.sse.nextEvent('exec', 2000)
      controller.abort()
      const cancelEvent = await app.sse.nextEvent('cancel', 2000)
      assert.equal(cancelEvent.data.requestId, execEvent.data.requestId)
      const settled = await outcome
      assert.ok(settled.error, 'an aborted command must reject')
      assert.match(settled.error.message, /aborted/)
    })

    await check('results: output is capped at maxOutputBytes and flagged', async () => {
      const execTool = app.fake.tools.get('computer_exec')
      const pending = execTool.execute({ computer: 'Smoke Mac', command: 'big-output' }, {})
      const execEvent = await app.sse.nextEvent('exec', 2000)
      await raw(origin, `${API}/agent/results`, {
        method: 'POST',
        headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: execEvent.data.requestId,
          ok: true,
          exitCode: 0,
          stdout: 'a'.repeat(5000),
          stderr: '',
          durationMs: 3,
          truncated: false,
        }),
      })
      const value = await pending
      assert.equal(value.truncated, true)
      assert.ok(value.stdout.length <= 1024 + 32, `stdout was ${value.stdout.length} chars`)
      assert.ok(value.stdout.endsWith('[output truncated]'))
    })

    // --- rename ------------------------------------------------------------
    await check('rename: pushes config and updates state', async () => {
      const response = await call(origin, `${API}/rename`, { method: 'POST', body: { id: app.computerId, name: '  Desk   Mac mini  ' } })
      assert.equal(response.status, 200)
      assert.deepEqual(response.data, { ok: true, name: 'Desk Mac mini' })
      const configEvent = await app.sse.nextEvent('config', 2000)
      assert.deepEqual(configEvent.data, { name: 'Desk Mac mini', execEnabled: true })
      const state = await call(origin, `${API}/state`)
      assert.equal(state.data.computers[0].name, 'Desk Mac mini')
      app.renamed = 'Desk Mac mini'
    })

    await check('rename: rejects invalid names and unknown ids', async () => {
      const empty = await call(origin, `${API}/rename`, { method: 'POST', body: { id: app.computerId, name: '   ' } })
      assert.equal(empty.status, 400)
      const long = await call(origin, `${API}/rename`, { method: 'POST', body: { id: app.computerId, name: 'x'.repeat(65) } })
      assert.equal(long.status, 400)
      const unknown = await call(origin, `${API}/rename`, { method: 'POST', body: { id: 'cmp_000000000000', name: 'Nope' } })
      assert.equal(unknown.status, 404)
      assert.equal(unknown.data.error, 'not-found')
    })

    // --- presence fallback -------------------------------------------------
    await check('presence: closing the stream marks the computer offline immediately', async () => {
      app.sse.close()
      const data = await waitFor(
        async () => (await call(origin, `${API}/state`)).data,
        (state) => state.computers[0]?.online === false,
        2000,
        'offline after the SSE stream closed',
      )
      assert.equal(data.computers[0].online, false)
      assert.deepEqual(data.computers[0].bots, { used: 0, total: 1 })
    })

    await check('presence: a fresh heartbeat does NOT make a stream-less computer online', async () => {
      const before = (await call(origin, `${API}/state`)).data.computers[0].lastSeenAt
      const heartbeat = await raw(origin, `${API}/agent/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      assert.equal(heartbeat.status, 200)
      const state = await call(origin, `${API}/state`)
      assert.equal(state.data.computers[0].online, false, 'no stream means offline, whatever lastSeenAt says')
      assert.deepEqual(state.data.computers[0].bots, { used: 0, total: 1 })
      const after = state.data.computers[0].lastSeenAt
      assert.ok(Date.parse(after) >= Date.parse(before), 'the heartbeat still refreshes lastSeenAt for display')
      assert.ok(Date.now() - Date.parse(after) < 5000, 'lastSeenAt must be fresh after the heartbeat')
    })

    // --- delete ------------------------------------------------------------
    await check('delete: ends the live stream and drops the record', async () => {
      const client = await openSse(origin, `${API}/agent/events`, { authorization: `Bearer ${app.token}` })
      sseClients.push(client)
      await client.nextEvent('hello', 2000)
      const response = await call(origin, `${API}/delete`, { method: 'POST', body: { id: app.computerId } })
      assert.deepEqual(response.data, { ok: true })
      await client.ended
      const state = await call(origin, `${API}/state`)
      assert.deepEqual(state.data.computers, [])
      const health = await call(origin, `${API}/health`)
      assert.equal(health.data.computers, 0)
    })

    await check('delete: unknown id is 404', async () => {
      const response = await call(origin, `${API}/delete`, { method: 'POST', body: { id: 'cmp_000000000000' } })
      assert.equal(response.status, 404)
      assert.equal(response.data.error, 'not-found')
    })

    await check('deleted computer token no longer authenticates', async () => {
      const response = await raw(origin, `${API}/agent/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      assert.equal(response.status, 401)
    })

    // --- gate + methods ----------------------------------------------------
    await check('browser gate: host rejection is answered as unadmitted', async () => {
      app.fake.setGate({
        requestRejection: (req) => (req.headers['x-smoke-refuse'] === '1' ? 403 : undefined),
        trustedHosts: [],
      })
      const refused = await raw(origin, `${API}/state`, { headers: { 'x-smoke-refuse': '1' } })
      assert.equal(refused.status, 403)
      assert.equal(refused.data.error, 'unadmitted')
      const admitted = await raw(origin, `${API}/state`)
      assert.equal(admitted.status, 200)
      app.fake.setGate({ requestRejection: () => 401, trustedHosts: [] })
      const login = await raw(origin, `${API}/state`)
      assert.equal(login.status, 401)
      assert.equal(login.data.error, 'unadmitted')
      app.fake.setGate(undefined)
    })

    await check('browser gate: fallback same-origin rules', async () => {
      // No connection service: the plugin enforces its own loopback fence.
      const crossOrigin = await raw(origin, `${API}/state`, { headers: { origin: 'http://evil.example' } })
      assert.equal(crossOrigin.status, 403)
      assert.equal(crossOrigin.data.error, 'unadmitted')
      const crossSite = await raw(origin, `${API}/state`, { headers: { 'sec-fetch-site': 'cross-site' } })
      assert.equal(crossSite.status, 403)
      const sameOrigin = await raw(origin, `${API}/state`, { headers: { origin } })
      assert.equal(sameOrigin.status, 200)
      const noOrigin = await raw(origin, `${API}/state`)
      assert.equal(noOrigin.status, 200)
    })

    await check('methods: wrong verb is 405 with allow', async () => {
      const postState = await raw(origin, `${API}/state`, { method: 'POST', body: '{}' })
      assert.equal(postState.status, 405)
      assert.match(String(postState.headers.allow), /GET/)
      const getKeys = await raw(origin, `${API}/keys`)
      assert.equal(getKeys.status, 405)
      assert.match(String(getKeys.headers.allow), /POST/)
    })

    await check('state file is valid JSON with protocol fields', async () => {
      const doc = JSON.parse(readFileSync(stateFile, 'utf8'))
      assert.equal(doc.version, 1)
      assert.ok(Array.isArray(doc.computers))
      assert.ok(Array.isArray(doc.pendingKeys))
      assert.ok(doc.pendingKeys.some((entry) => entry.key === app.secondKey && typeof entry.usedAt === 'string'))
    })
  } finally {
    for (const client of sseClients) client.close()
    await app.close()
  }
}

// ---------------------------------------------------------------------------
// Phase B — registry with two offline computers: name resolution + disabled exec
// ---------------------------------------------------------------------------

async function phaseB(root) {
  const dir = join(root, 'b')
  const first = newComputerId()
  const second = newComputerId()
  seedState(dir, {
    version: 1,
    computers: [seedComputer(first, 'Mac mini'), seedComputer(second, 'Mac mini 2')],
    pendingKeys: [],
  })

  let app = await mount({ ...FAST_CONFIG, stateDir: dir })
  try {
    const origin = app.origin
    await check('computer_exec: ambiguous name lists candidates', async () => {
      const execTool = app.fake.tools.get('computer_exec')
      await assert.rejects(execTool.execute({ computer: 'Mac', command: 'ls' }, {}), /ambiguous/)
    })

    await check('computer_exec: exact name offline error is actionable', async () => {
      const execTool = app.fake.tools.get('computer_exec')
      await assert.rejects(execTool.execute({ computer: 'Mac mini', command: 'ls' }, {}), /is offline; run computer_list/)
    })

    await check('computer_exec: unknown name lists available computers', async () => {
      const execTool = app.fake.tools.get('computer_exec')
      await assert.rejects(execTool.execute({ computer: 'nonexistent', command: 'ls' }, {}), /no computer matches 'nonexistent'/)
    })

    await check('computer_exec: bad arguments are rejected', async () => {
      const execTool = app.fake.tools.get('computer_exec')
      await assert.rejects(execTool.execute({ command: 'ls' }, {}), /requires "computer"/)
      await assert.rejects(execTool.execute({ computer: 'Mac mini 2', command: '   ' }, {}), /requires "command"/)
      await assert.rejects(execTool.execute({ computer: 'Mac mini 2', command: 'ls', timeoutMs: 'soon' }, {}), /"timeoutMs" must be a finite number/)
    })

    await check('computer_list: both offline computers listed', async () => {
      const listTool = app.fake.tools.get('computer_list')
      const value = await listTool.execute({}, {})
      assert.equal(value.computers.length, 2)
      assert.deepEqual(value.computers.map((computer) => computer.online), [false, false])
      const content = listTool.output.render({}, value)
      assert.ok(content[0].text.includes('| offline |'))
    })
  } finally {
    await app.close()
  }

  // Same registry, exec disabled: the tool must refuse before touching the hub.
  app = await mount({ ...FAST_CONFIG, stateDir: dir, execEnabled: false })
  try {
    await check('computer_exec: execEnabled false refuses with a clear message', async () => {
      const execTool = app.fake.tools.get('computer_exec')
      await assert.rejects(execTool.execute({ computer: 'Mac mini 2', command: 'ls' }, {}), /disabled on this host/)
    })
  } finally {
    await app.close()
  }
}

// ---------------------------------------------------------------------------
// Phase C — pre-seeded key states, publicUrl override, re-enrollment
// ---------------------------------------------------------------------------

async function phaseC(root) {
  const dir = join(root, 'c')
  const now = Date.now()
  const expiredKey = mintSecret()
  const usedKey = mintSecret()
  const freshKey = mintSecret()
  const publicUrl = 'https://workers.example.com'
  seedState(dir, {
    version: 1,
    computers: [],
    pendingKeys: [
      { key: expiredKey, createdAt: iso(now - 3_600_000), expiresAt: iso(now - 600_000), os: 'macos', label: null, usedAt: null, computerId: null },
      { key: usedKey, createdAt: iso(now - 120_000), expiresAt: iso(now + 600_000), os: 'windows', label: null, usedAt: iso(now - 60_000), computerId: null },
      { key: freshKey, createdAt: iso(now), expiresAt: iso(now + 900_000), os: 'linux', label: 'Smoke Linux', usedAt: null, computerId: null },
    ],
  })
  const app = await mount({ ...FAST_CONFIG, stateDir: dir, publicUrl })
  try {
    const origin = app.origin
    await check('state: publicUrl overrides the bound origin', async () => {
      const response = await call(origin, `${API}/state`)
      assert.equal(response.data.serverUrl, publicUrl)
    })

    await check('key-status: expired / used / unknown from a seeded registry', async () => {
      const expired = await call(origin, `${API}/key-status?key=${encodeURIComponent(expiredKey)}`)
      assert.equal(expired.data.status, 'expired')
      const used = await call(origin, `${API}/key-status?key=${encodeURIComponent(usedKey)}`)
      assert.equal(used.data.status, 'used')
      const unknown = await call(origin, `${API}/key-status?key=dshc_nope`)
      assert.equal(unknown.data.status, 'unknown')
    })

    await check('enroll: expired key is 410, used key is 409', async () => {
      const expired = await call(origin, `${API}/agent/enroll`, { method: 'POST', body: { key: expiredKey, machine: { hostname: 'x.local' } } })
      assert.equal(expired.status, 410)
      assert.equal(expired.data.error, 'key-expired')
      const used = await call(origin, `${API}/agent/enroll`, { method: 'POST', body: { key: usedKey, machine: { hostname: 'x.local' } } })
      assert.equal(used.status, 409)
      assert.equal(used.data.error, 'key-used')
    })

    await check('join.sh: generated from publicUrl', async () => {
      const response = await call(origin, `${API}/join.sh?key=${encodeURIComponent(freshKey)}`)
      assert.equal(response.status, 200)
      assert.ok(response.text.includes(`SERVER='${publicUrl}'`))
    })

    await check('enroll: fresh key honors the minted label and agent metadata', async () => {
      const response = await call(origin, `${API}/agent/enroll`, {
        method: 'POST',
        body: {
          key: freshKey,
          agentVersion: '1.0.0',
          machine: { hostname: 'linux-box.local', name: 'ignored-name', os: 'linux', arch: 'x64', platform: 'linux' },
        },
      })
      assert.equal(response.status, 200)
      assert.equal(response.data.name, 'Smoke Linux', 'the key label wins over machine.name')
      assert.equal(response.data.serverUrl, publicUrl)
      app.token = response.data.token
      app.computerId = response.data.computerId
      const state = await call(origin, `${API}/state`)
      assert.equal(state.data.computers[0].platformLabel, 'Linux')
      assert.equal(state.data.computers[0].name, 'Smoke Linux')
    })

    await check('keys: minted through the API carries the replacement flag', async () => {
      const response = await call(origin, `${API}/keys`, { method: 'POST', body: { os: 'macos', replace: true, label: 'Desk' } })
      assert.equal(response.status, 200)
      const doc = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
      const entry = doc.pendingKeys.find((candidate) => candidate.key === response.data.key)
      assert.equal(entry.replace, true)
      assert.equal(entry.label, 'Desk')
    })
  } finally {
    await app.close()
  }
}

// ---------------------------------------------------------------------------
// Phase D — pure helpers and config validation
// ---------------------------------------------------------------------------

async function phaseD() {
  await check('state: prune drops used/expired entries older than 1h only', async () => {
    const now = Date.now()
    const doc = {
      version: 1,
      computers: [],
      pendingKeys: [
        { key: 'used-old', usedAt: iso(now - 2 * 3_600_000), expiresAt: iso(now - 3_600_000) },
        { key: 'used-new', usedAt: iso(now - 60_000), expiresAt: iso(now + 3_600_000) },
        { key: 'expired-old', usedAt: null, expiresAt: iso(now - 2 * 3_600_000) },
        { key: 'expired-new', usedAt: null, expiresAt: iso(now - 60_000) },
        { key: 'live', usedAt: null, expiresAt: iso(now + 60_000) },
      ],
    }
    prunePendingKeys(doc, now)
    assert.deepEqual(doc.pendingKeys.map((entry) => entry.key), ['used-new', 'expired-new', 'live'])
  })

  await check('keys: token comparison is length-safe and constant time', async () => {
    const token = mintSecret()
    const hash = sha256Hex(token)
    assert.equal(tokenMatches(token, hash), true)
    assert.equal(tokenMatches(mintSecret(), hash), false)
    assert.equal(tokenMatches(token, 'not-hex'), false)
    assert.equal(tokenMatches(token, hash.slice(0, 8)), false)
    assert.equal(tokenMatches(undefined, hash), false)
  })

  await check('keys: display-name normalization', async () => {
    assert.equal(normalizeDisplayName('  Desk   Mac\nmini  '), 'Desk Mac mini')
    assert.equal(normalizeDisplayName('   '), null)
    assert.equal(normalizeDisplayName('x'.repeat(65)), null)
    assert.equal(normalizeDisplayName('x'.repeat(64)), 'x'.repeat(64))
    assert.equal(normalizeDisplayName(null), null)
  })

  await check('config: defaults, publicUrl trimming and validation', async () => {
    assert.deepEqual(resolveConfig(undefined), {
      role: 'both',
      publicUrl: '',
      stateDir: '',
      keyTtlMinutes: 15,
      heartbeatMs: 20_000,
      execTimeoutMs: 120_000,
      execEnabled: true,
      maxOutputBytes: 1_048_576,
    })
    assert.equal(resolveConfig({ publicUrl: 'https://example.com/' }).publicUrl, 'https://example.com')
    assert.throws(() => resolveConfig({ publicUrl: 'example.com' }), /publicUrl must be an absolute http\(s\) URL/)
    assert.throws(() => resolveConfig({ heartbeatMs: 5 }), /heartbeatMs must be an integer between/)
    assert.throws(() => resolveConfig({ execEnabled: 'yes' }), /execEnabled must be a boolean/)
    assert.throws(() => resolveConfig({ maxOutputBytes: 0 }), /maxOutputBytes must be an integer between/)
    assert.throws(() => resolveConfig('nope'), /config must be an object/)
  })
}

// ---------------------------------------------------------------------------
// Fake hub — the remote controller a runtime-mode plugin dials out to
// (PROTOCOL §3.1 enroll, §3.2 SSE, §3.3 results, §3.4 heartbeat)
// ---------------------------------------------------------------------------

/** Small JSON writer used only inside the fake hub. */
function hubJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Read a whole request body as UTF-8 text. */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * A local fake hub: enroll/SSE/results/heartbeat, in memory.
 * @returns {Promise<object>} hub handle with state, origin, waiters and close().
 */
async function createFakeHub() {
  const state = {
    validKey: mintSecret(),
    expiredKey: mintSecret(),
    usedKey: mintSecret(),
    issuedToken: null,
    computerId: newComputerId(),
    name: 'smoke-runtime',
    origin: null,
    enrollBodies: [],
    streams: new Set(),
    connectionCount: 0,
    results: [],
    heartbeats: [],
    lastAuth: null,
    server: null,
  }

  state.server = createServer(async (req, res) => {
    let url
    try {
      url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://hub.invalid')
    } catch {
      hubJson(res, 400, { error: 'bad-request' })
      return
    }
    const path = url.pathname

    if (req.method === 'POST' && path === '/api/dsh-computers/agent/enroll') {
      let body
      try {
        body = JSON.parse(await readRequestBody(req))
      } catch {
        hubJson(res, 400, { error: 'bad-request', message: 'bad json' })
        return
      }
      state.enrollBodies.push(body)
      if (body.key === state.validKey) {
        if (state.issuedToken === null) state.issuedToken = mintSecret()
        hubJson(res, 200, {
          computerId: state.computerId,
          token: state.issuedToken,
          name: state.name,
          serverUrl: state.origin,
        })
        return
      }
      if (body.key === state.expiredKey) {
        hubJson(res, 410, { error: 'key-expired', message: 'this smoke key expired' })
        return
      }
      if (body.key === state.usedKey) {
        hubJson(res, 409, { error: 'key-used', message: 'this smoke key was already used' })
        return
      }
      hubJson(res, 401, { error: 'invalid-key', message: 'unknown smoke key' })
      return
    }

    if (req.method === 'GET' && path === '/api/dsh-computers/agent/events') {
      const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
      const token = header.replace(/^bearer[ \t]+/i, '').trim()
      state.lastAuth = token
      if (state.issuedToken === null || token !== state.issuedToken) {
        hubJson(res, 401, { error: 'invalid-token', message: 'bad smoke token' })
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      res.write(`event: hello\ndata: ${JSON.stringify({
        computerId: state.computerId,
        name: state.name,
        heartbeatMs: 300,
      })}\n\n`)
      state.streams.add(res)
      state.connectionCount += 1
      const timer = setInterval(() => {
        try {
          res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`)
        } catch {
          // The runtime went away.
        }
      }, 200)
      if (typeof timer.unref === 'function') timer.unref()
      const cleanup = () => {
        clearInterval(timer)
        state.streams.delete(res)
      }
      res.on('close', cleanup)
      res.on('error', cleanup)
      return
    }

    if (req.method === 'POST' && path === '/api/dsh-computers/agent/results') {
      try {
        state.results.push(JSON.parse(await readRequestBody(req)))
      } catch {
        state.results.push(null)
      }
      hubJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && path === '/api/dsh-computers/agent/heartbeat') {
      try {
        state.heartbeats.push(JSON.parse(await readRequestBody(req)))
      } catch {
        state.heartbeats.push(null)
      }
      hubJson(res, 200, { ok: true, name: state.name })
      return
    }

    hubJson(res, 404, { error: 'not-found' })
  })

  await new Promise((resolve) => state.server.listen(0, '127.0.0.1', resolve))
  state.origin = `http://127.0.0.1:${state.server.address().port}`
  return {
    state,
    origin: state.origin,
    /** Resolve once at least `count` SSE streams have ever been opened. */
    waitForConnections(count, timeoutMs = 5000) {
      return waitFor(async () => state.connectionCount, (value) => value >= count, timeoutMs, `hub to see ${count} runtime connection(s)`)
    },
    /** Resolve once no SSE stream is open. */
    waitForNoStreams(timeoutMs = 5000) {
      return waitFor(async () => state.streams.size, (value) => value === 0, timeoutMs, 'hub to see the runtime disconnect')
    },
    async close() {
      for (const res of [...state.streams]) {
        try {
          res.destroy()
        } catch {
          // Already gone.
        }
      }
      state.streams.clear()
      await new Promise((resolve) => {
        state.server.close(() => resolve())
        if (typeof state.server.closeAllConnections === 'function') state.server.closeAllConnections()
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Phase E — role gating (PROTOCOL §10.1)
// ---------------------------------------------------------------------------

async function phaseE(root) {
  const dir = join(root, 'e-runtime')
  const runtimeRole = await mount({ ...FAST_CONFIG, stateDir: dir, role: 'runtime' })
  try {
    await check('role=runtime: runtime + status routes registered, hub API/tools/prompt absent', async () => {
      const paths = [...runtimeRole.fake.routes.keys()].sort()
      assert.deepEqual(paths, [
        `${API}/health`,
        `${API}/runtime`,
        `${API}/runtime/connect`,
        `${API}/runtime/disconnect`,
        `${API}/runtime/enable`,
        `${API}/state`,
      ])
      assert.equal(runtimeRole.fake.tools.size, 0, 'runtime role must not register computer_* tools')
      assert.equal(runtimeRole.fake.sections.length, 0, 'runtime role must not register a prompt section')
      // Every controller route is absent: agent API, keys, join scripts, bundle.
      for (const suffix of ['/agent/enroll', '/agent/events', '/agent/results', '/agent/heartbeat',
        '/keys', '/key-status', '/delete', '/rename', '/join.sh?key=x', '/join.ps1?key=x', '/agent.mjs']) {
        const response = await call(runtimeRole.origin, `${API}${suffix}`)
        assert.equal(response.status, 404, `runtime role must not serve ${suffix}`)
      }
    })

    await check('role=runtime: /state still reports role and an empty computer list (client contract)', async () => {
      const response = await call(runtimeRole.origin, `${API}/state`)
      assert.equal(response.status, 200)
      assert.equal(response.data.version, 2)
      assert.equal(response.data.role, 'runtime')
      assert.deepEqual(response.data.computers, [], 'a runtime owns no registry: the list card must hide')
      assert.equal(response.data.pendingKey, null)
      assert.equal(response.data.heartbeatMs, 300)
      assert.equal(response.data.serverUrl, runtimeRole.origin)
      const health = await call(runtimeRole.origin, `${API}/health`)
      assert.equal(health.status, 200)
      assert.deepEqual(health.data, { ok: true, version: '1.0.0', computers: 0, online: 0 })
    })

    await check('role=runtime: GET /runtime is unconfigured, full status shape, role echoed', async () => {
      const response = await call(runtimeRole.origin, `${API}/runtime`)
      assert.equal(response.status, 200)
      assert.deepEqual(response.data, {
        configured: false,
        enabled: false,
        connected: false,
        serverUrl: '',
        computerId: '',
        name: '',
        since: null,
        lastError: null,
        role: 'runtime',
      })
      // ui-dev's client contract: all §10.3 keys plus role, always present.
      assert.deepEqual(Object.keys(response.data).sort(), [
        'computerId', 'configured', 'connected', 'enabled', 'lastError', 'name', 'role', 'serverUrl', 'since',
      ])
    })

    await check('role=runtime: /state is behind the browser gate as well', async () => {
      runtimeRole.fake.setGate({ requestRejection: () => 401, trustedHosts: [] })
      const refused = await call(runtimeRole.origin, `${API}/state`)
      assert.equal(refused.status, 401)
      assert.equal(refused.data.error, 'unadmitted')
      runtimeRole.fake.setGate(undefined)
    })

    await check('role=runtime: runtime routes sit behind the same browser gate', async () => {
      runtimeRole.fake.setGate({ requestRejection: () => 403, trustedHosts: [] })
      const refused = await raw(runtimeRole.origin, `${API}/runtime/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverUrl: 'http://127.0.0.1:1', key: 'dshc_x' }),
      })
      assert.equal(refused.status, 403)
      assert.equal(refused.data.error, 'unadmitted')
      runtimeRole.fake.setGate(undefined)
    })
  } finally {
    await runtimeRole.close()
  }

  const hubRole = await mount({ ...FAST_CONFIG, stateDir: join(root, 'e-hub'), role: 'hub' })
  try {
    await check('role=hub: hub routes + tools registered, no runtime routes', async () => {
      assert.ok(hubRole.fake.routes.has(`${API}/state`))
      assert.ok(hubRole.fake.routes.has(`${API}/agent/enroll`))
      assert.equal(hubRole.fake.tools.size, 2)
      assert.equal(hubRole.fake.sections.length, 1)
      assert.equal(hubRole.fake.routes.has(`${API}/runtime`), false)
      const runtime = await call(hubRole.origin, `${API}/runtime`)
      assert.equal(runtime.status, 404, 'hub role must not serve runtime routes')
      const state = await call(hubRole.origin, `${API}/state`)
      assert.equal(state.data.role, 'hub')
    })
  } finally {
    await hubRole.close()
  }

  const bothRole = await mount({ ...FAST_CONFIG, stateDir: join(root, 'e-both') })
  try {
    await check('role default=both: hub and runtime surfaces coexist', async () => {
      assert.equal(bothRole.fake.tools.size, 2)
      assert.ok(bothRole.fake.routes.has(`${API}/runtime`))
      assert.ok(bothRole.fake.routes.has(`${API}/state`))
      const state = await call(bothRole.origin, `${API}/state`)
      assert.equal(state.data.role, 'both')
      const runtime = await call(bothRole.origin, `${API}/runtime`)
      assert.equal(runtime.status, 200)
      assert.equal(runtime.data.role, 'both')
      assert.equal(runtime.data.configured, false)
    })
  } finally {
    await bothRole.close()
  }
}

// ---------------------------------------------------------------------------
// Phase F — runtime manager: connect / enable / disconnect / auto-restart
// ---------------------------------------------------------------------------

async function phaseF(root) {
  // Does the agent bundle export the embedded runtime yet? (agent-dev's task.)
  let hasStartRuntime = false
  try {
    const agentModule = await import(new URL('../agent/dsh-computers-agent.mjs', import.meta.url).href)
    hasStartRuntime = typeof agentModule.startRuntime === 'function'
  } catch {
    hasStartRuntime = false
  }
  console.log(`NOTE runtime mode: agent exports startRuntime = ${hasStartRuntime ? 'yes (full connection coverage)' : 'NO (connection-half assertions degrade to enrollment only)'}`)
  const connectionNote = hasStartRuntime ? '' : ' [startRuntime missing → enrollment-only]'

  const dir = join(root, 'f-runtime')
  const runtimeFile = join(dir, 'runtime.json')
  const hub = await createFakeHub()
  let app = await mount({ ...FAST_CONFIG, stateDir: dir, role: 'runtime' })
  try {
    const origin = app.origin

    await check(`runtime: unconfigured GET /runtime${connectionNote}`, async () => {
      const response = await call(origin, `${API}/runtime`)
      assert.equal(response.status, 200)
      assert.equal(response.data.configured, false)
      assert.equal(response.data.enabled, false)
      assert.equal(response.data.connected, false)
      assert.equal(response.data.serverUrl, '', 'serverUrl is always a string (client contract)')
      assert.equal(response.data.computerId, '')
      assert.equal(response.data.name, '')
      assert.equal(response.data.role, 'runtime')
      assert.equal(existsSync(runtimeFile), false, 'nothing may be persisted before connect')
    })

    await check('runtime: connect rejects malformed URLs and keys before dialing out', async () => {
      const badUrl = await call(origin, `${API}/runtime/connect`, { method: 'POST', body: { serverUrl: 'not-a-url', key: 'dshc_x' } })
      assert.equal(badUrl.status, 400)
      assert.equal(badUrl.data.error, 'bad-request')
      const badProtocol = await call(origin, `${API}/runtime/connect`, { method: 'POST', body: { serverUrl: 'ftp://example.com', key: 'dshc_x' } })
      assert.equal(badProtocol.status, 400)
      const noKey = await call(origin, `${API}/runtime/connect`, { method: 'POST', body: { serverUrl: hub.origin } })
      assert.equal(noKey.status, 400)
      assert.equal(existsSync(runtimeFile), false)
    })

    await check('runtime: unreachable hub → 502 hub-unreachable and nothing persisted', async () => {
      const response = await call(origin, `${API}/runtime/connect`, {
        method: 'POST',
        body: { serverUrl: 'http://127.0.0.1:1', key: hub.state.validKey },
      })
      assert.equal(response.status, 502)
      assert.equal(response.data.error, 'hub-unreachable')
      assert.match(response.data.message, /cannot reach the hub|did not answer/)
      assert.equal(existsSync(runtimeFile), false)
    })

    await check('runtime: invalid key → 401 invalid-key and nothing persisted', async () => {
      const response = await call(origin, `${API}/runtime/connect`, {
        method: 'POST',
        body: { serverUrl: hub.origin, key: 'dshc_unknownunknownunknown' },
      })
      assert.equal(response.status, 401)
      assert.equal(response.data.error, 'invalid-key')
      assert.equal(existsSync(runtimeFile), false)
      assert.equal(hub.state.enrollBodies.length, 1, 'the hub received the enroll attempt')
      assert.equal(hub.state.enrollBodies[0].key, 'dshc_unknownunknownunknown')
    })

    await check('runtime: expired/used keys map to 410/409', async () => {
      const expired = await call(origin, `${API}/runtime/connect`, { method: 'POST', body: { serverUrl: hub.origin, key: hub.state.expiredKey } })
      assert.equal(expired.status, 410)
      assert.equal(expired.data.error, 'key-expired')
      const used = await call(origin, `${API}/runtime/connect`, { method: 'POST', body: { serverUrl: hub.origin, key: hub.state.usedKey } })
      assert.equal(used.status, 409)
      assert.equal(used.data.error, 'key-used')
      assert.equal(existsSync(runtimeFile), false)
    })

    await check(`runtime: valid key enrolls, persists runtime.json 0600 and starts${connectionNote}`, async () => {
      const response = await call(origin, `${API}/runtime/connect`, {
        method: 'POST',
        body: { serverUrl: hub.origin, key: hub.state.validKey },
      })
      assert.equal(response.status, 200)
      assert.equal(response.data.configured, true)
      assert.equal(response.data.enabled, true)
      assert.equal(response.data.serverUrl, hub.origin)
      assert.equal(response.data.computerId, hub.state.computerId)
      assert.equal(response.data.role, 'runtime')
      // Client contract: the full §10.3 status object, always the same shape.
      assert.deepEqual(Object.keys(response.data).sort(), [
        'computerId', 'configured', 'connected', 'enabled', 'lastError', 'name', 'role', 'serverUrl', 'since',
      ])

      assert.equal(existsSync(runtimeFile), true)
      const mode = statSync(runtimeFile).mode & 0o777
      assert.equal(mode, 0o600, `runtime.json must be 0600, got 0${mode.toString(8)}`)
      const doc = JSON.parse(readFileSync(runtimeFile, 'utf8'))
      assert.equal(doc.version, 1)
      assert.equal(doc.enabled, true)
      assert.equal(doc.serverUrl, hub.origin)
      assert.equal(doc.computerId, hub.state.computerId)
      assert.equal(doc.token, hub.state.issuedToken, 'the issued token is stored once and reused')
      assert.ok(Number.isFinite(Date.parse(doc.enrolledAt)))
      assert.equal(hub.state.enrollBodies.at(-1).machine.hostname.length > 0, true, 'enroll sends machine facts')

      if (hasStartRuntime) {
        const connected = await waitFor(
          async () => (await call(origin, `${API}/runtime`)).data,
          (status) => status.connected === true,
          6000,
          'runtime to report connected',
        )
        assert.equal(connected.connected, true)
        assert.equal(typeof connected.since, 'string')
        await hub.waitForConnections(1)
        assert.equal(hub.state.lastAuth, hub.state.issuedToken, 'SSE carries the issued bearer token')
      } else {
        const status = await call(origin, `${API}/runtime`)
        assert.equal(status.data.connected, false)
        assert.match(status.data.lastError, /does not export startRuntime|embedded runtime is unavailable/)
      }
    })

    await check(`runtime: enable(false) stops the runtime and persists the switch${connectionNote}`, async () => {
      const response = await call(origin, `${API}/runtime/enable`, { method: 'POST', body: { enabled: false } })
      assert.equal(response.status, 200)
      assert.equal(response.data.enabled, false)
      assert.equal(response.data.connected, false)
      assert.equal(JSON.parse(readFileSync(runtimeFile, 'utf8')).enabled, false)
      if (hasStartRuntime) await hub.waitForNoStreams()
    })

    await check(`runtime: enable(true) starts it again${connectionNote}`, async () => {
      const response = await call(origin, `${API}/runtime/enable`, { method: 'POST', body: { enabled: true } })
      assert.equal(response.status, 200)
      assert.equal(response.data.enabled, true)
      assert.equal(JSON.parse(readFileSync(runtimeFile, 'utf8')).enabled, true)
      if (hasStartRuntime) {
        await hub.waitForConnections(2)
        const status = await waitFor(
          async () => (await call(origin, `${API}/runtime`)).data,
          (value) => value.connected === true,
          6000,
          'runtime to reconnect',
        )
        assert.equal(status.connected, true)
      }
    })

    await check('runtime: invalid enable body is 400', async () => {
      const response = await call(origin, `${API}/runtime/enable`, { method: 'POST', body: { enabled: 'yes' } })
      assert.equal(response.status, 400)
      assert.equal(response.data.error, 'bad-request')
    })

    await check(`runtime: auto-starts from runtime.json on a fresh plugin load${connectionNote}`, async () => {
      const connectionsBefore = hub.state.connectionCount
      await app.close()
      app = null
      // A brand-new manager (new plugin mount) must read runtime.json and dial
      // out by itself — "starting DSH = starting the runtime".
      app = await mount({ ...FAST_CONFIG, stateDir: dir, role: 'runtime' })
      const status = await waitFor(
        async () => (await call(app.origin, `${API}/runtime`)).data,
        (value) => value.configured === true && value.enabled === true && (hasStartRuntime ? value.connected === true : true),
        6000,
        'auto-started runtime',
      )
      assert.equal(status.configured, true)
      assert.equal(status.enabled, true)
      if (hasStartRuntime) {
        assert.equal(status.connected, true)
        await hub.waitForConnections(connectionsBefore + 1)
      }
    })

    await check('runtime: disconnect stops it and removes runtime.json', async () => {
      const response = await call(app.origin, `${API}/runtime/disconnect`, { method: 'POST' })
      assert.equal(response.status, 200)
      assert.equal(response.data.configured, false)
      assert.equal(response.data.enabled, false)
      assert.equal(response.data.connected, false)
      assert.equal(response.data.serverUrl, '')
      assert.equal(existsSync(runtimeFile), false, 'runtime.json must be deleted')
      if (hasStartRuntime) await hub.waitForNoStreams()
      const after = await call(app.origin, `${API}/runtime`)
      assert.equal(after.data.configured, false)
    })

    await check('runtime: enable(true) without configuration is refused', async () => {
      const response = await call(app.origin, `${API}/runtime/enable`, { method: 'POST', body: { enabled: true } })
      assert.equal(response.status, 400)
      assert.equal(response.data.error, 'bad-request')
    })
  } finally {
    if (app !== null) await app.close()
    await hub.close()
  }

  // Corrupt runtime.json must not brick the plugin (and must warn once).
  const corruptDir = join(root, 'f-corrupt')
  mkdirSync(corruptDir, { recursive: true })
  writeFileSync(join(corruptDir, 'runtime.json'), '{not json', { mode: 0o600 })
  const warnings = []
  const originalWarn = console.warn
  let corruptApp
  console.warn = (...args) => warnings.push(args.map(String).join(' '))
  try {
    corruptApp = await mount({ ...FAST_CONFIG, stateDir: corruptDir, role: 'runtime' })
  } finally {
    console.warn = originalWarn
  }
  try {
    await check('runtime: corrupt runtime.json is set aside, plugin still serves status', async () => {
      const response = await call(corruptApp.origin, `${API}/runtime`)
      assert.equal(response.status, 200)
      assert.equal(response.data.configured, false)
      assert.equal(existsSync(join(corruptDir, 'runtime.json')), false)
      // The bad file is preserved for inspection as runtime.json.corrupt-<ts>.
      const aside = readdirSync(corruptDir).filter((name) => name.startsWith('runtime.json.corrupt-'))
      assert.equal(aside.length, 1, 'the corrupt file must be moved aside')
      assert.ok(
        warnings.some((line) => line.includes('runtime.json') && line.includes('not valid JSON')),
        `expected a corrupt-file warning, saw ${JSON.stringify(warnings)}`,
      )
    })
  } finally {
    await corruptApp.close()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const watchdog = setTimeout(() => {
  console.error('FAIL host-smoke: global timeout (60s)')
  process.exit(1)
}, 60_000)
watchdog.unref()

const root = mkdtempSync(join(tmpdir(), 'dshc-smoke-'))
let exitCode = 0
try {
  await phaseA(root)
  await phaseB(root)
  await phaseC(root)
  await phaseD()
  await phaseE(root)
  await phaseF(root)
} finally {
  rmSync(root, { recursive: true, force: true })
  clearTimeout(watchdog)
}

if (failures.length > 0) {
  console.error(`\nFAIL host-smoke: ${failures.length} assertion group(s) failed, ${passed} passed`)
  exitCode = 1
} else {
  console.log(`\nPASS host-smoke: ${passed} assertion groups passed`)
}
process.exit(exitCode)
