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
 * the recorded definitions, runtime mode (§10): role gating, runtime.json
 * persistence, connect/enable/disconnect/auto-restart against a fake hub, and
 * base-URL auto-detection (§4.2 proxy headers, Origin rescue, IPv6, sub-path),
 * per-session target selection (selection routes, tool default, list marker),
 * and the relay host wiring (v1.6.0): config validation, hubId minting/reuse in
 * its own relay.json, `/state.relay` for disabled/connecting/connected/failed,
 * and the `relay` address candidate (first and recommended only while up).
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { apply, PLUGIN_VERSION, resolveConfig } from '../index.js'
import { resolveBaseUrl } from '../lib/http.js'
import { createSelectionStore, MAX_SELECTIONS } from '../lib/selection.js'
import { MAX_ACCESS_SESSIONS, createAccessStore } from '../lib/access.js'
import { mintSecret, newComputerId, normalizeDisplayName, sha256Hex, tokenMatches } from '../lib/keys.js'
import { normalizeState, prunePendingKeys } from '../lib/state.js'
import {
  annotateRouteHealth, chooseRoute, collectServerUrls, probeRoute, refreshRouteHealth,
  resetRouteHealth, resolveAddressPayload, ROUTE_COOLDOWN_MS,
} from '../lib/addresses.js'
import { createTunnel } from '../lib/tunnel.js'
import { createRuntimeStatusRoutes } from '../lib/routes.js'
import { deriveRelayPublicUrl, mintHubId, normalizeRelayUrl } from '../lib/relay-manager.js'
import * as contracts from '../lib/contracts.js'
import {
  DENY_CODES, OPERATIONS, OPERATION_REQUIREMENTS, TOOL_OPERATIONS,
  assertOperationTable, assertToolsExhaustive, capsOf, createPolicy, legacyCaps, normalizeCaps, supports,
} from '../lib/policy.js'

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
  let fakeHost = '127.0.0.1'
  const routes = new Map()
  const tools = new Map()
  const sections = []
  const disposers = []
  let origin = null
  let connection
  const services = new Map()

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
      return services.get(name)
    },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      get protocol() {
        return origin === null ? undefined : new URL(origin).protocol
      },
      get port() {
        return origin === null ? undefined : (Number(new URL(origin).port) || undefined)
      },
      // v1.4.0: the real service exposes the actual bind host; tests override it.
      get host() {
        return fakeHost
      },
      getOrigin() {
        if (origin === null) throw new Error('webserver: origin read before the listener bound a port')
        return origin
      },
    },
    // Reachable-address probe seam (v1.3.3): deterministic loopback-only by
    // default so HTTP assertions do not depend on the test machine's NICs.
    addressDeps: {
      // R6: routes are probed; the fake URLs in these tests do not resolve, so
      // the default probe answers "healthy" unless a phase injects its own.
      probe: async () => ({ ok: true, status: 200, ms: 1, error: null }),
      probeTailscale: async () => null,
      interfaces: { lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] },
      hostname: 'smoke-host.local',
    },
    // Relay link seam (v1.6.0): declared so the strict proxy allows the read;
    // a phase that wants a fake hub-link assigns it before mount().
    relayDeps: undefined,
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }

  // Cordis throws when a plugin reads a context property it did not `inject`.
  // The proxy reproduces that, so a plugin that loads here also loads in the
  // real host (this is how the `ctx.hubDeps` activation bug was caught).
  const strictCtx = new Proxy(ctx, {
    get(target, property, receiver) {
      if (typeof property === 'symbol' || property === 'then') return Reflect.get(target, property, receiver)
      if (!(property in target)) {
        throw new Error(`cannot get property "${String(property)}" without inject`)
      }
      return Reflect.get(target, property, receiver)
    },
  })

  return {
    ctx: strictCtx,
    routes,
    tools,
    sections,
    setOrigin(value) {
      origin = value
    },
    setHost(value) {
      fakeHost = value
    },
    setGate(value) {
      connection = value
    },
    setService(name, value) {
      if (value === undefined) services.delete(name)
      else services.set(name, value)
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
/** Route entries gain R6 health bookkeeping; shape assertions ignore it. */
function withoutHealth(list) {
  return list.map(({ health, ...rest }) => rest)
}

async function mount(config, { addressDeps, webServerHost, tunnelExec, hubDeps, relayDeps } = {}) {
  const fake = createFakeContext()
  if (addressDeps !== undefined) fake.ctx.addressDeps = addressDeps
  // R5b test seam: an injected clock + short lease for the presence sweep.
  if (hubDeps !== undefined) fake.ctx.hubDeps = hubDeps
  // v1.6.0 relay seam: a fake hub-link factory, so no relay is dialled.
  if (relayDeps !== undefined) fake.ctx.relayDeps = relayDeps
  if (typeof webServerHost === 'string' && webServerHost !== '') fake.setHost(webServerHost)
  if (typeof tunnelExec === 'function') fake.ctx.tunnelExec = tunnelExec
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
    agentVersion: PLUGIN_VERSION,
    tokenHash: sha256Hex(mintSecret()),
    createdAt: iso(Date.now() - 60_000),
    lastSeenAt: iso(Date.now() - 3_600_000),
    activatedAt: iso(Date.now() - 60_000),
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
      assert.deepEqual(response.data, { ok: true, version: PLUGIN_VERSION, computers: 0, online: 0, agents: [] })
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
          agentVersion: PLUGIN_VERSION,
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

      // §11.6.4: the key stays pending until the first stream, so a retry
      // before activation re-enrolls the same record and rotates its token.
      const again = await call(origin, `${API}/agent/enroll`, {
        method: 'POST',
        body: { key: app.secondKey, capabilities: ['exec'], machine: { hostname: 'smoke-mac.local' } },
      })
      assert.equal(again.status, 200)
      assert.equal(again.data.computerId, app.computerId, 'a pending key re-enrolls the same computer')
      app.token = again.data.token

      const status = await call(origin, `${API}/key-status?key=${encodeURIComponent(app.secondKey)}`)
      assert.equal(status.data.status, 'waiting', 'still pending until a stream activates it')
      assert.equal(status.data.computer, null)
    })

    await check('state: a pending enrollment is hidden until its first stream', async () => {
      // §11.6.4: activation is the first successful stream; before that the
      // computer is not listed, but the key stays visible to the connect dialog.
      const response = await call(origin, `${API}/state`)
      assert.deepEqual(response.data.computers, [])
      assert.equal(response.data.pendingKey.key, app.secondKey)
      const health = await call(origin, `${API}/health`)
      assert.equal(health.data.computers, 0)
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
      assert.deepEqual(hello.data, {
        computerId: app.computerId,
        name: 'Smoke Mac',
        heartbeatMs: 300,
        capabilities: ['exec'],
        features: ['stream', 'fs'],
      })
      assert.ok(client.raw.includes('retry: 2000'), 'SSE must start with retry: 2000')
    })

    await check('state: the first stream activates the enrollment and consumes the key', async () => {
      const state = await call(origin, `${API}/state`)
      assert.equal(state.data.computers.length, 1)
      const computer = state.data.computers[0]
      assert.equal(computer.id, app.computerId)
      assert.equal(typeof computer.activatedAt, 'string')
      assert.equal(computer.capabilities[0], 'exec')
      assert.equal(state.data.pendingKey, null)
      const status = await call(origin, `${API}/key-status?key=${encodeURIComponent(app.secondKey)}`)
      assert.equal(status.data.status, 'connected')
      assert.equal(status.data.computer.id, app.computerId)
      const consumed = await call(origin, `${API}/agent/enroll`, {
        method: 'POST',
        body: { key: app.secondKey, machine: { hostname: 'smoke-mac.local' } },
      })
      assert.equal(consumed.status, 409)
      assert.equal(consumed.data.error, 'key-used')
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
        body: JSON.stringify({ meta: { cpuModel: 'Apple M4 Max', agentVersion: PLUGIN_VERSION, caps: { exec: true, fs: true, jobs: true } } }),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(response.data, { ok: true, name: 'Smoke Mac' })
      const state = await call(origin, `${API}/state`)
      assert.equal(state.data.computers[0].cpuModel, 'Apple M4 Max')
      assert.equal(state.data.computers[0].agentVersion, PLUGIN_VERSION)
      // R2: caps from heartbeat meta are stored and normalized.
      assert.deepEqual(state.data.computers[0].caps, { exec: true, fs: true, jobs: true, pty: false, tunnel: false })
    })

    // --- tools -------------------------------------------------------------
    await check('computer_list: value and render', async () => {
      const listTool = app.fake.tools.get('computer_list')
      assert.ok(listTool, 'computer_list was not registered')
      const value = await listTool.execute({}, {})
      assert.equal(value.computers.length, 1)
      assert.equal(value.computers[0].online, true)
      // R2: the list exposes caps; pty:false hides nothing that worked before.
      assert.deepEqual(value.computers[0].caps, { exec: true, fs: true, jobs: true, pty: false, tunnel: false })
      assert.equal(value.selectedComputerId, null, 'no session agent means no selection')
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
      // Handlers attached immediately: a failing assertion below must not
      // leave the pending execution as an unhandled rejection.
      const pending = execTool.execute(
        { computer: 'Smoke Mac', command: 'echo hi' },
        { signal: new AbortController().signal },
      ).then((value) => ({ value }), (error) => ({ error }))
      const execEvent = await app.sse.nextEvent('exec', 2000)
      assert.match(execEvent.data.requestId, /^req_[0-9a-f]{24}$/)
      assert.equal(execEvent.data.command, 'echo hi')
      // cwd defaults to the agent's reported workspace base (none here → null).
      assert.equal(execEvent.data.cwd, null)
      // The host owns the foreground deadline; the agent gets its own ceiling.
      assert.equal(execEvent.data.timeoutMs, 86_400_000)
      assert.equal(execEvent.data.stream, true)
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

      const settled = await pending
      assert.ok(settled.value, `expected success, got ${settled.error && settled.error.message}`)
      const value = settled.value
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
      assert.match(settled.error.message, /did not answer within 600ms/)
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
        .then((value) => ({ value }), (error) => ({ error }))
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
      const settledBig = await pending
      assert.ok(settledBig.value, `expected success, got ${settledBig.error && settledBig.error.message}`)
      const value = settledBig.value
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
      await assert.rejects(execTool.execute({ command: 'ls' }, {}), /no computer selected/)
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
  const sseClients = []
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
          agentVersion: PLUGIN_VERSION,
          capabilities: ['exec', 'fs'],
          metadata: { version: 1, agentVersion: PLUGIN_VERSION, mode: 'embedded', workspaceBase: '/home/smoke', caps: { exec: true, fs: false, jobs: true } },
          machine: { hostname: 'linux-box.local', name: 'ignored-name', os: 'linux', arch: 'x64', platform: 'linux' },
        },
      })
      assert.equal(response.status, 200)
      assert.equal(response.data.name, 'Smoke Linux', 'the key label wins over machine.name')
      assert.equal(response.data.serverUrl, publicUrl)
      app.token = response.data.token
      app.computerId = response.data.computerId
      // §11.6.4: activate with the first stream before it appears in /state.
      const client = await openSse(origin, `${API}/agent/events`, { authorization: `Bearer ${app.token}` })
      sseClients.push(client)
      await client.nextEvent('hello', 2000)
      const state = await call(origin, `${API}/state`)
      assert.equal(state.data.computers[0].platformLabel, 'Linux')
      assert.equal(state.data.computers[0].name, 'Smoke Linux')
      assert.equal(state.data.computers[0].mode, 'embedded', 'mode is stored from the enroll metadata block')
      assert.deepEqual(state.data.computers[0].caps, { exec: true, fs: false, jobs: true, pty: false, tunnel: false }, 'caps are stored from the enroll metadata block')
      assert.equal(state.data.computers[0].workspaceBase, '/home/smoke')
      assert.deepEqual(state.data.computers[0].capabilities, ['exec', 'fs'])
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
    for (const client of sseClients) client.close()
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

  await check('state: legacy records missing activatedAt are migrated, explicit null stays pending', async () => {
    const legacy = normalizeState({
      version: 1,
      computers: [
        { id: 'cmp_legacy', name: 'Old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'cmp_pending', name: 'New', createdAt: '2026-01-02T00:00:00.000Z', activatedAt: null },
        { id: 'cmp_active', name: 'Active', createdAt: '2026-01-03T00:00:00.000Z', activatedAt: '2026-01-04T00:00:00.000Z' },
      ],
      pendingKeys: [],
    }, () => Date.parse('2026-06-01T00:00:00.000Z'))
    const byId = new Map(legacy.computers.map((computer) => [computer.id, computer]))
    assert.equal(byId.get('cmp_legacy').activatedAt, '2026-01-01T00:00:00.000Z', 'pre-activation records are backfilled')
    assert.equal(byId.get('cmp_pending').activatedAt, null, 'a v1.1 pending enrollment stays hidden')
    assert.equal(byId.get('cmp_active').activatedAt, '2026-01-04T00:00:00.000Z')
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
      promoteOnTimeout: true,
      minAgentVersion: '',
      preferAddress: 'auto',
      tailscaleServe: { enabled: false, httpsPort: 8443 },
      relay: { enabled: false, url: '', publicUrl: '', accessKey: '', hubId: '', name: '' },
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
    assert.deepEqual(resolveConfig({ tailscaleServe: true }).tailscaleServe, { enabled: true, httpsPort: 8443 })
    assert.deepEqual(resolveConfig({ tailscaleServe: { enabled: true, httpsPort: 9443 } }).tailscaleServe, { enabled: true, httpsPort: 9443 })
    assert.deepEqual(resolveConfig({ tailscaleServe: {} }).tailscaleServe, { enabled: false, httpsPort: 8443 })
    assert.throws(() => resolveConfig({ tailscaleServe: { enabled: 'yes' } }), /tailscaleServe\.enabled must be a boolean/)
    assert.throws(() => resolveConfig({ tailscaleServe: { httpsPort: 70000 } }), /tailscaleServe\.httpsPort must be an integer/)
    assert.throws(() => resolveConfig({ tailscaleServe: 'yes' }), /tailscaleServe must be an object/)
    assert.equal(resolveConfig({ preferAddress: 'lan' }).preferAddress, 'lan')
    assert.throws(() => resolveConfig({ preferAddress: 'wan' }), /preferAddress must be one of/)
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
    lastStreamMetadata: null,
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
      // v1.3.2: record the connect handshake so the embedded-runtime mode can
      // be asserted end to end.
      const metadataHeader = req.headers['x-dsh-computers-metadata']
      const metadataText = Array.isArray(metadataHeader) ? metadataHeader[0] : metadataHeader
      if (typeof metadataText === 'string' && metadataText !== '') {
        try {
          state.lastStreamMetadata = JSON.parse(Buffer.from(metadataText, 'base64url').toString('utf8'))
        } catch {
          state.lastStreamMetadata = null
        }
      }
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
      assert.deepEqual(health.data, { ok: true, version: PLUGIN_VERSION, computers: 0, online: 0, agents: [] })
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
      assert.equal(hubRole.fake.tools.size, 7)
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
      assert.equal(bothRole.fake.tools.size, 7)
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

    await check(`runtime: the embedded manager enrolls with metadata.mode='embedded'${connectionNote}`, async () => {
      if (!hasStartRuntime) {
        // Without the agent export the enroll still happens; the metadata block
        // is host-owned so it is assertable either way.
      }
      const enroll = hub.state.enrollBodies.at(-1)
      assert.ok(enroll, 'the hub received the enroll POST')
      assert.equal(enroll.metadata.mode, 'embedded', 'enroll metadata declares the embedded runtime')
      assert.equal(enroll.metadata.version, 1)
      assert.equal(typeof enroll.metadata.hostname, 'string')
      assert.equal(typeof enroll.metadata.os, 'string')
      assert.equal(typeof enroll.metadata.arch, 'string')
      assert.equal(typeof enroll.metadata.workspaceBase, 'string')
      assert.ok(Array.isArray(enroll.metadata.capabilities) && enroll.metadata.capabilities.includes('exec'))
      assert.deepEqual(enroll.capabilities, enroll.metadata.capabilities)
      assert.equal(enroll.agentVersion, enroll.metadata.agentVersion)
    })

    await check(`runtime: startRuntime passes mode='embedded' to the agent (connect handshake)${connectionNote}`, async () => {
      if (!hasStartRuntime) return
      await hub.waitForConnections(1)
      assert.ok(hub.state.lastStreamMetadata, 'the agent sent the connect handshake header')
      assert.equal(hub.state.lastStreamMetadata.mode, 'embedded')
      assert.ok(Array.isArray(hub.state.lastStreamMetadata.capabilities))
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
// Phase G — base URL auto-detection (PROTOCOL §4.2 `resolveBaseUrl`)
// ---------------------------------------------------------------------------

async function phaseG(root) {
  /** Minimal ctx stub: resolveBaseUrl only reads webServer.protocol/port/getOrigin. */
  const mkCtx = ({ protocol, origin, port, originThrows = false } = {}) => ({
    webServer: {
      get protocol() {
        return protocol
      },
      getOrigin() {
        if (originThrows) throw new Error('webserver: origin read before the listener bound a port')
        return origin
      },
      get port() {
        return port
      },
    },
  })
  const req = (headers = {}) => ({ headers })
  const noConfig = { publicUrl: '' }
  const boundCtx = () => mkCtx({ protocol: 'http:', origin: 'http://127.0.0.1:3000', port: 3000 })

  await check('base URL: publicUrl wins over every header, sub-path kept verbatim', async () => {
    const headers = { host: '127.0.0.1:3000', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example' }
    assert.equal(resolveBaseUrl({ ctx: boundCtx(), config: { publicUrl: 'https://public.example' }, req: req(headers) }), 'https://public.example')
    assert.equal(resolveBaseUrl({ ctx: boundCtx(), config: { publicUrl: 'https://public.example/' }, req: req(headers) }), 'https://public.example')
    assert.equal(resolveBaseUrl({ ctx: boundCtx(), config: { publicUrl: ' https://public.example/dsh/ ' }, req: req(headers) }), 'https://public.example/dsh')
    // Credentials/query/fragment cannot be part of a base URL: dropped so the
    // generated command stays a clean URL.
    assert.equal(
      resolveBaseUrl({ ctx: boundCtx(), config: { publicUrl: 'https://user:pass@public.example/dsh?x=1#frag' }, req: req(headers) }),
      'https://public.example/dsh',
    )
    // A malformed publicUrl is the operator's bug: detection still runs.
    assert.equal(
      resolveBaseUrl({ ctx: boundCtx(), config: { publicUrl: 'not a url' }, req: req({ host: '127.0.0.1:3000' }) }),
      'http://127.0.0.1:3000',
    )
  })

  await check('base URL: x-forwarded-proto + x-forwarded-host become the origin', async () => {
    const ctx = boundCtx()
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: '127.0.0.1:3000', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'dsh.example.com' }) }),
      'https://dsh.example.com',
    )
    // First comma entry of each; default ports are normalized away.
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: '127.0.0.1:3000', 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'dsh.example.com, internal.example' }) }),
      'https://dsh.example.com',
    )
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: '127.0.0.1:3000', 'x-forwarded-proto': 'HTTPS', 'x-forwarded-host': 'dsh.example.com:443' }) }),
      'https://dsh.example.com',
    )
  })

  await check('base URL: RFC 7239 Forwarded uses the FIRST element only', async () => {
    const ctx = boundCtx()
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: '127.0.0.1:3000', forwarded: 'for=192.0.2.60;proto=https;host=dsh.example.com, for=198.51.100.1;proto=http;host=internal.example' }) }),
      'https://dsh.example.com',
    )
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: '127.0.0.1:3000', forwarded: 'proto="https";host="dsh.example.com";for=198.51.100.1' }) }),
      'https://dsh.example.com',
    )
  })

  await check('base URL: x-forwarded-ssl:on supplies the protocol (old nginx)', async () => {
    const ctx = boundCtx()
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: '127.0.0.1:3000', 'x-forwarded-ssl': 'on', 'x-forwarded-host': 'dsh.example.com' }) }),
      'https://dsh.example.com',
    )
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: 'dsh.example.com', 'x-forwarded-ssl': 'on' }) }),
      'https://dsh.example.com',
    )
    // x-forwarded-proto wins when both are present.
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: '127.0.0.1:3000', 'x-forwarded-ssl': 'on', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'dsh.example.com' }) }),
      'http://dsh.example.com',
    )
  })

  await check('base URL: incomplete forwarded pair falls through to Host + listener protocol', async () => {
    const ctx = boundCtx()
    const hostOnly = resolveBaseUrl({ ctx, config: noConfig, req: req({ host: '127.0.0.1:3000', 'x-forwarded-host': 'dsh.example.com' }) })
    assert.equal(hostOnly, 'http://127.0.0.1:3000')
    assert.ok(!hostOnly.includes('undefined'), 'never mix a forwarded host with an unknown protocol')
    // A protocol-only hint still rescues a Host the proxy passed through
    // unchanged (HTTPS proxy that omits X-Forwarded-Host).
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: '127.0.0.1:3000', 'x-forwarded-proto': 'https' }) }),
      'https://127.0.0.1:3000',
    )
  })

  await check('base URL: Host header + listener protocol', async () => {
    assert.equal(
      resolveBaseUrl({ ctx: mkCtx({ protocol: 'http:' }), config: noConfig, req: req({ host: '192.168.1.9:8080' }) }),
      'http://192.168.1.9:8080',
    )
    assert.equal(
      resolveBaseUrl({ ctx: mkCtx({ protocol: 'https:' }), config: noConfig, req: req({ host: 'dsh.example.com' }) }),
      'https://dsh.example.com',
    )
  })

  await check('base URL: browser Origin rescues an HTTPS proxy without X-Forwarded-Proto', async () => {
    const ctx = boundCtx()
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: 'dsh.example.com', origin: 'https://dsh.example.com' }) }),
      'https://dsh.example.com',
    )
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: 'dsh.example.com:8443', origin: 'https://dsh.example.com:8443' }) }),
      'https://dsh.example.com:8443',
    )
    // A different Origin host is not a vouch: the listener protocol wins.
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: 'dsh.example.com', origin: 'https://evil.example' }) }),
      'http://dsh.example.com',
    )
    // `Origin: null` is present-but-unparseable: refused as a hint.
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: 'dsh.example.com', origin: 'null' }) }),
      'http://dsh.example.com',
    )
  })

  await check('base URL: malicious forwarded values fall through to a valid origin', async () => {
    const ctx = boundCtx()
    const bad = ['evil.com/x', 'a@b', 'host\r\nx', 'javascript:alert(1)', '', 'x'.repeat(1000)]
    for (const value of bad) {
      const viaHost = resolveBaseUrl({
        ctx,
        config: noConfig,
        req: req({ host: '127.0.0.1:3000', 'x-forwarded-proto': 'https', 'x-forwarded-host': value }),
      })
      // The bad host never survives; with an https hint the request's own Host
      // is still rescued, which is a valid origin.
      assert.equal(viaHost, 'https://127.0.0.1:3000', `x-forwarded-host ${JSON.stringify(value)} must fall through`)
      assert.match(viaHost, /^https?:\/\/[^\s/]+$/)
      assert.ok(!viaHost.includes(String(value)) || String(value) === '')
      const viaRfc = resolveBaseUrl({
        ctx,
        config: noConfig,
        req: req({ host: '127.0.0.1:3000', forwarded: `proto=https;host=${value}` }),
      })
      assert.equal(viaRfc, 'http://127.0.0.1:3000', `Forwarded host ${JSON.stringify(value)} must fall through`)
    }
    // A forwarded host with a non-http scheme is refused too.
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: '127.0.0.1:3000', 'x-forwarded-proto': 'ftp', 'x-forwarded-host': 'dsh.example.com' }) }),
      'http://127.0.0.1:3000',
    )
  })

  await check('base URL: IPv6 authorities work', async () => {
    const ctx = boundCtx()
    assert.equal(
      resolveBaseUrl({ ctx, config: noConfig, req: req({ host: '127.0.0.1:3000', 'x-forwarded-proto': 'https', 'x-forwarded-host': '[::1]:3000' }) }),
      'https://[::1]:3000',
    )
    assert.equal(
      resolveBaseUrl({ ctx: mkCtx({ protocol: 'http:' }), config: noConfig, req: req({ host: '[::1]:3000' }) }),
      'http://[::1]:3000',
    )
  })

  await check('base URL: getOrigin and port last resorts', async () => {
    assert.equal(resolveBaseUrl({ ctx: mkCtx({ origin: 'http://127.0.0.1:3000' }), config: noConfig, req: req({}) }), 'http://127.0.0.1:3000')
    assert.equal(resolveBaseUrl({ ctx: mkCtx({ originThrows: true, port: 3000 }), config: noConfig, req: req({}) }), 'http://127.0.0.1:3000')
    assert.equal(resolveBaseUrl({ ctx: { webServer: {} }, config: noConfig, req: req({}) }), '')
    assert.equal(resolveBaseUrl({}), '')
  })

  // ---- through the real HTTP handlers --------------------------------------
  const app = await mount({ ...FAST_CONFIG, stateDir: join(root, 'g') })
  try {
    // Host/forwarded headers are for URL generation only; a permissive gate
    // keeps the browser fence out of the way for these assertions.
    app.fake.setGate({ requestRejection: () => undefined, trustedHosts: [] })

    await check('base URL: /state and /keys agree on forwarded headers; command embeds it', async () => {
      const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'dsh.example.com' }
      const state = await raw(app.origin, `${API}/state`, { headers })
      assert.equal(state.status, 200)
      assert.equal(state.data.serverUrl, 'https://dsh.example.com')

      const key = await raw(app.origin, `${API}/keys`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ os: 'macos' }),
      })
      assert.equal(key.status, 200)
      assert.equal(key.data.serverUrl, 'https://dsh.example.com')
      assert.equal(key.data.installUrl, `https://dsh.example.com/api/dsh-computers/join.sh?key=${encodeURIComponent(key.data.key)}`)
      assert.equal(key.data.command, `curl -fsSL 'https://dsh.example.com/api/dsh-computers/join.sh?key=${encodeURIComponent(key.data.key)}' | sh`)
      assert.equal(key.data.windowsCommand, `irm 'https://dsh.example.com/api/dsh-computers/join.ps1?key=${encodeURIComponent(key.data.key)}' | iex`)
      assert.ok(!key.data.command.includes('//api/'), 'no double slash in the generated command')

      const join = await raw(app.origin, `${API}/join.sh?key=${encodeURIComponent(key.data.key)}`, { headers })
      assert.equal(join.status, 200)
      assert.ok(join.text.includes("SERVER='https://dsh.example.com'"), 'the installer embeds the same resolved base')
    })

    await check('base URL: Host header drives /state when nothing is forwarded', async () => {
      const lan = await raw(app.origin, `${API}/state`, { headers: { host: '192.168.1.9:8080' } })
      assert.equal(lan.data.serverUrl, 'http://192.168.1.9:8080')
      const rescued = await raw(app.origin, `${API}/state`, { headers: { host: 'dsh.example.com', origin: 'https://dsh.example.com' } })
      assert.equal(rescued.data.serverUrl, 'https://dsh.example.com')
      const sslOnly = await raw(app.origin, `${API}/state`, { headers: { host: 'dsh.example.com', 'x-forwarded-ssl': 'on' } })
      assert.equal(sslOnly.data.serverUrl, 'https://dsh.example.com')
    })
  } finally {
    await app.close()
  }

  // ---- sub-path publicUrl through the handlers -----------------------------
  const prefixApp = await mount({
    ...FAST_CONFIG,
    stateDir: join(root, 'g-prefix'),
    publicUrl: 'https://dsh.example.com/dsh/',
  })
  try {
    await check('base URL: sub-path publicUrl is verbatim and never double-slashes', async () => {
      const state = await call(prefixApp.origin, `${API}/state`)
      assert.equal(state.data.serverUrl, 'https://dsh.example.com/dsh')
      const key = await call(prefixApp.origin, `${API}/keys`, { method: 'POST', body: { os: 'linux' } })
      assert.equal(key.data.serverUrl, 'https://dsh.example.com/dsh')
      assert.equal(key.data.installUrl, `https://dsh.example.com/dsh/api/dsh-computers/join.sh?key=${encodeURIComponent(key.data.key)}`)
      assert.ok(!key.data.command.includes('//api/'), 'no double slash after the prefix')
      assert.ok(!key.data.command.includes('dsh//'))
      const join = await call(prefixApp.origin, `${API}/join.sh?key=${encodeURIComponent(key.data.key)}`)
      assert.ok(join.text.includes("SERVER='https://dsh.example.com/dsh'"))
      assert.ok(join.text.includes('"$SERVER/api/dsh-computers/agent.mjs"'), 'installer downloads through the prefixed base')
    })
  } finally {
    await prefixApp.close()
  }
}

// ---------------------------------------------------------------------------
// Phase H — per-session target selection (task-9)
// ---------------------------------------------------------------------------

async function phaseH(root) {
  const dir = join(root, 'h')
  const selectionsFile = join(dir, 'selections.json')
  const secondId = newComputerId()
  const secondToken = mintSecret()
  // Pre-seed a second computer whose bearer token we know, so two live SSE
  // streams can answer the override test.
  seedState(dir, {
    version: 1,
    computers: [seedComputer(secondId, 'Second Mac', { tokenHash: sha256Hex(secondToken) })],
    pendingKeys: [],
  })

  const app = await mount({ ...FAST_CONFIG, stateDir: dir })
  const sseClients = []
  try {
    const origin = app.origin
    // Enroll the first computer through the real hub API.
    const key = await call(origin, `${API}/keys`, { method: 'POST', body: { os: 'macos' } })
    const enrolled = await call(origin, `${API}/agent/enroll`, {
      method: 'POST',
      body: {
        key: key.data.key,
        agentVersion: PLUGIN_VERSION,
        machine: { hostname: 'first.local', name: 'First Mac', os: 'darwin', platform: 'macOS' },
      },
    })
    assert.equal(enrolled.status, 200)
    const firstId = enrolled.data.computerId
    const firstToken = enrolled.data.token
    const firstSse = await openSse(origin, `${API}/agent/events`, { authorization: `Bearer ${firstToken}` })
    sseClients.push(firstSse)
    await firstSse.nextEvent('hello', 2000)
    const secondSse = await openSse(origin, `${API}/agent/events`, { authorization: `Bearer ${secondToken}` })
    sseClients.push(secondSse)
    await secondSse.nextEvent('hello', 2000)

    const execTool = app.fake.tools.get('computer_exec')
    const listTool = app.fake.tools.get('computer_list')
    const sessionId = 'sess_smoke_selection'

    /** Run one computer_exec call, answer its exec event, return the outcome. */
    const runExec = async (args, sse, token, session, expectedCommand) => {
      const exec = session === undefined
        ? { signal: new AbortController().signal }
        : { signal: new AbortController().signal, agent: { id: session } }
      const outcome = execTool.execute(args, exec).then((value) => ({ value }), (error) => ({ error }))
      const event = await sse.nextEvent('exec', 3000)
      assert.equal(event.data.command, expectedCommand)
      const posted = await raw(origin, `${API}/agent/results`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: event.data.requestId,
          ok: true,
          exitCode: 0,
          stdout: 'ok\n',
          stderr: '',
          durationMs: 1,
          truncated: false,
          timedOut: false,
        }),
      })
      assert.equal(posted.status, 200)
      return await outcome
    }

    await check('selection: GET is empty before anything is pinned', async () => {
      const response = await call(origin, `${API}/selection?sessionId=${encodeURIComponent(sessionId)}`)
      assert.equal(response.status, 200)
      assert.deepEqual(response.data, { sessionId, computerId: null, computer: null })
      assert.equal(existsSync(selectionsFile), false, 'nothing persisted before the first pin')
    })

    await check('selection: POST pins a computer, GET agrees, disk is 0600', async () => {
      const pin = await call(origin, `${API}/selection`, { method: 'POST', body: { sessionId, computerId: firstId } })
      assert.equal(pin.status, 200)
      assert.equal(pin.data.sessionId, sessionId)
      assert.equal(pin.data.computerId, firstId)
      assert.equal(pin.data.computer.id, firstId)
      assert.equal(pin.data.computer.name, 'First Mac')
      assert.equal(pin.data.computer.online, true)
      assert.equal(pin.data.computer.platformLabel, 'macOS')
      const read = await call(origin, `${API}/selection?sessionId=${encodeURIComponent(sessionId)}`)
      assert.deepEqual(read.data, pin.data)

      assert.equal(existsSync(selectionsFile), true)
      assert.equal(statSync(selectionsFile).mode & 0o777, 0o600, 'selections.json must be 0600')
      const doc = JSON.parse(readFileSync(selectionsFile, 'utf8'))
      assert.equal(doc.version, 1)
      assert.equal(doc.selections[sessionId].computerId, firstId)
      assert.ok(Number.isFinite(Date.parse(doc.selections[sessionId].updatedAt)))
    })

    await check('computer_list: selectedComputerId and the render marker follow the pin', async () => {
      const value = await listTool.execute({}, { agent: { id: sessionId } })
      assert.equal(value.computers.length, 2)
      assert.equal(value.selectedComputerId, firstId)
      const content = listTool.output.render({}, value)
      assert.ok(content[0].text.includes('Pinned target for this session: **First Mac**'))
      assert.ok(content[0].text.includes('| * First Mac |'))
      assert.ok(content[0].text.includes('Rows marked * are selected'))

      const anonymous = await listTool.execute({}, {})
      assert.equal(anonymous.selectedComputerId, null)
      const anonymousContent = listTool.output.render({}, anonymous)
      assert.ok(!anonymousContent[0].text.includes('Pinned target'))
      assert.ok(!anonymousContent[0].text.includes('| * '))
    })

    await check('computer_exec: no computer argument uses the session pin', async () => {
      const outcome = await runExec({ command: 'echo pinned' }, firstSse, firstToken, sessionId, 'echo pinned')
      assert.ok(outcome.value, `expected success, got ${outcome.error && outcome.error.message}`)
      assert.equal(outcome.value.computer.id, firstId)
      assert.equal(outcome.value.computer.name, 'First Mac')
      assert.equal(outcome.value.command, 'echo pinned')
      const content = execTool.output.render({ command: 'echo pinned' }, outcome.value)
      assert.ok(content[0].text.includes('First Mac'), 'render describes the machine actually used')
    })

    await check('computer_exec: an explicit computer overrides the session pin', async () => {
      const outcome = await runExec({ computer: 'Second Mac', command: 'echo override' }, secondSse, secondToken, sessionId, 'echo override')
      assert.ok(outcome.value, `expected success, got ${outcome.error && outcome.error.message}`)
      assert.equal(outcome.value.computer.id, secondId)
      assert.equal(outcome.value.computer.name, 'Second Mac')
    })

    await check('computer_exec: no pin and no argument is an actionable error', async () => {
      const anonymous = execTool.execute({ command: 'echo nope' }, { signal: new AbortController().signal })
      await assert.rejects(anonymous, /no computer selected: pass `computer` .*pick a target computer in the composer/)
      const otherSession = execTool.execute(
        { command: 'echo nope' },
        { signal: new AbortController().signal, agent: { id: 'sess_without_a_pin' } },
      )
      await assert.rejects(otherSession, /no computer selected/)
      // An empty string computer is treated as "not provided" → selection, not a hard error.
      const emptyArg = await runExec({ computer: '   ', command: 'echo blank' }, firstSse, firstToken, sessionId, 'echo blank')
      assert.equal(emptyArg.value.computer.id, firstId)
    })

    await check('selection: POST null clears and removes the disk entry', async () => {
      const cleared = await call(origin, `${API}/selection`, { method: 'POST', body: { sessionId, computerId: null } })
      assert.equal(cleared.status, 200)
      assert.deepEqual(cleared.data, { sessionId, computerId: null, computer: null })
      const read = await call(origin, `${API}/selection?sessionId=${encodeURIComponent(sessionId)}`)
      assert.deepEqual(read.data, { sessionId, computerId: null, computer: null })
      const doc = JSON.parse(readFileSync(selectionsFile, 'utf8'))
      assert.equal(doc.selections[sessionId], undefined)
      // With the pin gone, a bare exec is an error again.
      const outcome = execTool.execute({ command: 'echo none' }, { signal: new AbortController().signal, agent: { id: sessionId } })
        .then((value) => ({ value }), (error) => ({ error }))
      const settled = await outcome
      assert.ok(settled.error)
      assert.match(settled.error.message, /no computer selected/)
    })

    await check('selection: validation and unknown ids', async () => {
      const emptyQuery = await call(origin, `${API}/selection?sessionId=`)
      assert.equal(emptyQuery.status, 400)
      assert.equal(emptyQuery.data.error, 'bad-request')
      const longQuery = await call(origin, `${API}/selection?sessionId=${'x'.repeat(257)}`)
      assert.equal(longQuery.status, 400)
      const emptyPost = await call(origin, `${API}/selection`, { method: 'POST', body: { sessionId: '  ', computerId: firstId } })
      assert.equal(emptyPost.status, 400)
      const missingField = await call(origin, `${API}/selection`, { method: 'POST', body: { sessionId } })
      assert.equal(missingField.status, 400)
      const badType = await call(origin, `${API}/selection`, { method: 'POST', body: { sessionId, computerId: 42 } })
      assert.equal(badType.status, 400)
      const unknown = await call(origin, `${API}/selection`, { method: 'POST', body: { sessionId, computerId: 'cmp_000000000000' } })
      assert.equal(unknown.status, 404)
      assert.equal(unknown.data.error, 'not-found')
    })

    await check('selection: routes sit behind the browser gate', async () => {
      app.fake.setGate({ requestRejection: () => 403, trustedHosts: [] })
      const refused = await raw(origin, `${API}/selection?sessionId=${encodeURIComponent(sessionId)}`)
      assert.equal(refused.status, 403)
      assert.equal(refused.data.error, 'unadmitted')
      app.fake.setGate(undefined)
    })

    await check('selection: a deleted computer leaves the session unselected', async () => {
      const pinned = await call(origin, `${API}/selection`, { method: 'POST', body: { sessionId, computerId: secondId } })
      assert.equal(pinned.data.computerId, secondId)
      const deleted = await call(origin, `${API}/delete`, { method: 'POST', body: { id: secondId } })
      assert.deepEqual(deleted.data, { ok: true })
      const stale = await call(origin, `${API}/selection?sessionId=${encodeURIComponent(sessionId)}`)
      assert.deepEqual(stale.data, { sessionId, computerId: null, computer: null })
      const value = await listTool.execute({}, { agent: { id: sessionId } })
      assert.equal(value.selectedComputerId, null)
    })
  } finally {
    for (const client of sseClients) client.close()
    await app.close()
  }

  await check('selection: store prunes to the 200 most recently updated entries', async () => {
    const pruneDir = join(root, 'h-prune')
    let clock = 1_000_000
    const store = createSelectionStore({ stateDir: pruneDir, now: () => (clock += 1_000) })
    for (let index = 0; index < MAX_SELECTIONS + 5; index += 1) store.set(`sess_${index}`, `cmp_${index}`)
    const all = store.all()
    assert.equal(Object.keys(all).length, MAX_SELECTIONS)
    assert.equal(all.sess_0, undefined)
    assert.equal(all.sess_4, undefined)
    assert.ok(all.sess_5)
    assert.equal(store.get(`sess_${MAX_SELECTIONS + 4}`), `cmp_${MAX_SELECTIONS + 4}`)
  })

  await check('selection: corrupt selections.json is set aside', async () => {
    const corruptDir = join(root, 'h-corrupt')
    mkdirSync(corruptDir, { recursive: true })
    writeFileSync(join(corruptDir, 'selections.json'), '{oops', { mode: 0o600 })
    const warnings = []
    const store = createSelectionStore({ stateDir: corruptDir, onWarn: (message) => warnings.push(message) })
    assert.equal(store.get('sess_any'), null)
    assert.equal(existsSync(join(corruptDir, 'selections.json')), false)
    assert.ok(warnings.some((line) => line.includes('not valid JSON')), `expected a corrupt-file warning, saw ${JSON.stringify(warnings)}`)
    const aside = readdirSync(corruptDir).filter((name) => name.startsWith('selections.json.corrupt-'))
    assert.equal(aside.length, 1)
  })
}

// ---------------------------------------------------------------------------
// Phase I — access control: routes, AND-rule, tool/list/selection enforcement
// ---------------------------------------------------------------------------

async function phaseI(root) {
  const dir = join(root, 'i')
  const accessFile = join(dir, 'access.json')
  const firstId = newComputerId()
  const secondId = newComputerId()
  const thirdId = newComputerId()
  const firstToken = mintSecret()
  const secondToken = mintSecret()
  seedState(dir, {
    version: 1,
    computers: [
      seedComputer(firstId, 'First Mac', { tokenHash: sha256Hex(firstToken), lastSeenAt: iso(Date.now() - 3_600_000) }),
      seedComputer(secondId, 'Second Mac', { tokenHash: sha256Hex(secondToken), lastSeenAt: iso(Date.now() - 3_600_000) }),
      seedComputer(thirdId, 'Third Mac'),
    ],
    pendingKeys: [],
  })

  const app = await mount({ ...FAST_CONFIG, stateDir: dir })
  const sseClients = []
  const presetRoster = [{ id: 'default', name: 'Default' }, { id: 'researcher', name: 'Researcher' }]
  const liveAgents = new Map([
    ['sess_default', { id: 'sess_default', session: { id: 'sess_default' } }],
    ['sess_researcher', { id: 'sess_researcher', session: { id: 'sess_researcher' } }],
  ])
  try {
    const origin = app.origin
    // Host preset services: the researcher session uses a non-default preset.
    app.fake.setService('agentPresets', {
      list: async () => presetRoster.map((preset) => ({ ...preset })),
      presetForSession: (session) => (session && session.id === 'sess_researcher' ? 'researcher' : null),
    })
    app.fake.setService('agents', { get: (sessionId) => liveAgents.get(sessionId) })

    const firstSse = await openSse(origin, `${API}/agent/events`, { authorization: `Bearer ${firstToken}` })
    sseClients.push(firstSse)
    await firstSse.nextEvent('hello', 2000)
    const secondSse = await openSse(origin, `${API}/agent/events`, { authorization: `Bearer ${secondToken}` })
    sseClients.push(secondSse)
    await secondSse.nextEvent('hello', 2000)

    const execTool = app.fake.tools.get('computer_exec')
    const listTool = app.fake.tools.get('computer_list')
    const section = app.fake.sections.find((candidate) => candidate.name === 'computers')
    const agentOf = (sessionId) => liveAgents.get(sessionId)

    /** Run one allowed computer_exec call and answer its exec event. */
    const runExec = async (args, sse, token, sessionId, expectedCommand) => {
      const outcome = execTool.execute(args, { signal: new AbortController().signal, agent: agentOf(sessionId) })
        .then((value) => ({ value }), (error) => ({ error }))
      const event = await sse.nextEvent('exec', 3000)
      assert.equal(event.data.command, expectedCommand)
      const posted = await raw(origin, `${API}/agent/results`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: event.data.requestId, ok: true, exitCode: 0, stdout: 'ok\n', stderr: '', durationMs: 1, truncated: false, timedOut: false }),
      })
      assert.equal(posted.status, 200)
      return await outcome
    }

    await check('access: GET before any rule shows every computer allowed', async () => {
      const response = await call(origin, `${API}/access?sessionId=sess_default`)
      assert.equal(response.status, 200)
      assert.equal(response.data.sessionId, 'sess_default')
      assert.equal(response.data.presetId, 'default')
      assert.deepEqual(response.data.presets, presetRoster)
      assert.equal(response.data.sessionAllowed, null)
      assert.equal(response.data.computers.length, 3)
      for (const computer of response.data.computers) {
        assert.equal(computer.allowed, true)
        assert.equal(computer.sessionAllowed, true)
        assert.equal(computer.presetAllowed, true)
        assert.equal(typeof computer.online, 'boolean')
        assert.equal(typeof computer.platformLabel, 'string')
      }
      assert.equal(existsSync(accessFile), false, 'nothing persisted before the first rule')
    })

    await check('access: POST session allow-list persists 0600 and flips effective allowed', async () => {
      const response = await call(origin, `${API}/access`, {
        method: 'POST',
        body: { sessionId: 'sess_default', allowedComputers: [secondId] },
      })
      assert.equal(response.status, 200)
      assert.deepEqual(response.data.sessionAllowed, [secondId])
      const byId = new Map(response.data.computers.map((computer) => [computer.id, computer]))
      assert.equal(byId.get(secondId).allowed, true)
      assert.equal(byId.get(firstId).allowed, false)
      assert.equal(byId.get(firstId).sessionAllowed, false)
      assert.equal(byId.get(firstId).presetAllowed, true)

      assert.equal(existsSync(accessFile), true)
      assert.equal(statSync(accessFile).mode & 0o777, 0o600, 'access.json must be 0600')
      const doc = JSON.parse(readFileSync(accessFile, 'utf8'))
      assert.equal(doc.version, 1)
      assert.deepEqual(doc.sessions.sess_default.allow, [secondId])
      assert.ok(Number.isFinite(Date.parse(doc.sessions.sess_default.updatedAt)))
    })

    await check('access: computer-level preset rule round trip + validation', async () => {
      const read = await call(origin, `${API}/access/computer?computerId=${encodeURIComponent(firstId)}`)
      assert.equal(read.status, 200)
      assert.equal(read.data.computer.id, firstId)
      assert.deepEqual(read.data.presets, [
        { id: 'default', name: 'Default', allowed: true },
        { id: 'researcher', name: 'Researcher', allowed: true },
      ])
      assert.equal(read.data.allowedPresets, null)

      const posted = await call(origin, `${API}/access/computer`, {
        method: 'POST',
        body: { computerId: firstId, allowedPresets: ['researcher'] },
      })
      assert.equal(posted.status, 200)
      assert.deepEqual(posted.data.allowedPresets, ['researcher'])
      assert.deepEqual(posted.data.presets, [
        { id: 'default', name: 'Default', allowed: false },
        { id: 'researcher', name: 'Researcher', allowed: true },
      ])
      // Second computer only trusts the default preset (non-default preset denied there).
      const second = await call(origin, `${API}/access/computer`, {
        method: 'POST',
        body: { computerId: secondId, allowedPresets: ['default'] },
      })
      assert.equal(second.status, 200)

      const doc = JSON.parse(readFileSync(accessFile, 'utf8'))
      assert.deepEqual(doc.computers[firstId].presets, ['researcher'])
      assert.deepEqual(doc.computers[secondId].presets, ['default'])
    })

    await check('access: unknown ids and bad bodies are rejected', async () => {
      const badSession = await call(origin, `${API}/access?sessionId=`)
      assert.equal(badSession.status, 400)
      const unknownComputerInSession = await call(origin, `${API}/access`, {
        method: 'POST',
        body: { sessionId: 'sess_default', allowedComputers: ['cmp_000000000000'] },
      })
      assert.equal(unknownComputerInSession.status, 400)
      assert.equal(unknownComputerInSession.data.error, 'bad-request')
      const badType = await call(origin, `${API}/access`, {
        method: 'POST',
        body: { sessionId: 'sess_default', allowedComputers: 'all' },
      })
      assert.equal(badType.status, 400)
      const unknownPreset = await call(origin, `${API}/access/computer`, {
        method: 'POST',
        body: { computerId: firstId, allowedPresets: ['ghost'] },
      })
      assert.equal(unknownPreset.status, 400)
      assert.match(unknownPreset.data.message, /unknown Agent preset/)
      const unknownComputer = await call(origin, `${API}/access/computer`, {
        method: 'POST',
        body: { computerId: 'cmp_000000000000', allowedPresets: null },
      })
      assert.equal(unknownComputer.status, 404)
      const unknownGet = await call(origin, `${API}/access/computer?computerId=cmp_000000000000`)
      assert.equal(unknownGet.status, 404)
    })

    await check('access: effective answer ANDs session allow-list with preset rule', async () => {
      const forDefault = await call(origin, `${API}/access?sessionId=sess_default`)
      assert.equal(forDefault.data.presetId, 'default')
      const defaultById = new Map(forDefault.data.computers.map((computer) => [computer.id, computer]))
      // first: session allows? no (allow-list is [second]) AND preset rule (researcher) denies default.
      assert.equal(defaultById.get(firstId).allowed, false)
      assert.equal(defaultById.get(firstId).sessionAllowed, false)
      assert.equal(defaultById.get(firstId).presetAllowed, false)
      // second: session allows, preset rule allows default.
      assert.equal(defaultById.get(secondId).allowed, true)
      // third: excluded by the same session allow-list.
      assert.equal(defaultById.get(thirdId).allowed, false)
      assert.equal(defaultById.get(thirdId).sessionAllowed, false)

      const forResearcher = await call(origin, `${API}/access?sessionId=sess_researcher`)
      assert.equal(forResearcher.data.presetId, 'researcher')
      const researcherById = new Map(forResearcher.data.computers.map((computer) => [computer.id, computer]))
      // first allows researcher; researcher has no session rule (all); second only trusts default.
      assert.equal(researcherById.get(firstId).allowed, true)
      assert.equal(researcherById.get(secondId).allowed, false)
      assert.equal(researcherById.get(secondId).presetAllowed, false)
    })

    await check('enforcement: computer_list hides denied machines and keeps the pin honest', async () => {
      const value = await listTool.execute({}, { agent: agentOf('sess_default') })
      // Only the session's allow-list entry is visible (first is also preset-denied).
      assert.deepEqual(value.computers.map((computer) => computer.id), [secondId])
      assert.equal(value.hiddenComputerCount, 2)
      const content = listTool.output.render({}, value)
      assert.ok(!content[0].text.includes('First Mac'))
      assert.ok(content[0].text.includes('Second Mac'))
    })

    await check('enforcement: computer_exec denies a target by session allow-list', async () => {
      const denied = execTool.execute(
        { computer: 'First Mac', command: 'echo denied' },
        { signal: new AbortController().signal, agent: agentOf('sess_default') },
      )
      await assert.rejects(denied, /not accessible to this conversation/)
      await assert.rejects(
        execTool.execute({ computer: 'First Mac', command: 'echo denied' }, { signal: new AbortController().signal, agent: agentOf('sess_default') }),
        /管理访问权/,
      )
      assert.equal(firstSse.events.filter((event) => event.name === 'exec').length, 0, 'a denied call never reaches the machine')
      // The allowed machine still works.
      const allowed = await runExec({ computer: 'Second Mac', command: 'echo allowed' }, secondSse, secondToken, 'sess_default', 'echo allowed')
      assert.equal(allowed.value.computer.id, secondId)
    })

    await check('enforcement: computer_exec denies a target by the computer preset rule', async () => {
      // researcher may use first (rule) but not second (rule pins it to default).
      const denied = execTool.execute(
        { computer: 'Second Mac', command: 'echo denied' },
        { signal: new AbortController().signal, agent: agentOf('sess_researcher') },
      )
      await assert.rejects(denied, /not accessible to this conversation/)
      await assert.rejects(
        execTool.execute({ computer: 'Second Mac', command: 'echo denied' }, { signal: new AbortController().signal, agent: agentOf('sess_researcher') }),
        /管理访问权/,
      )
      assert.equal(secondSse.events.filter((event) => event.name === 'exec').length, 0)
      const allowed = await runExec({ computer: 'First Mac', command: 'echo researcher' }, firstSse, firstToken, 'sess_researcher', 'echo researcher')
      assert.equal(allowed.value.computer.id, firstId)
    })

    await check('enforcement: POST /selection refuses a denied pin (403 forbidden)', async () => {
      const denied = await call(origin, `${API}/selection`, { method: 'POST', body: { sessionId: 'sess_default', computerId: firstId } })
      assert.equal(denied.status, 403)
      assert.equal(denied.data.error, 'forbidden')
      assert.match(denied.data.message, /管理访问权/)
      const allowed = await call(origin, `${API}/selection`, { method: 'POST', body: { sessionId: 'sess_default', computerId: secondId } })
      assert.equal(allowed.status, 200)
      assert.equal(allowed.data.computerId, secondId)
    })

    await check('enforcement: a pinned computer that later becomes denied is refused at exec', async () => {
      // Pin second for sess_default, then deny the whole session.
      await call(origin, `${API}/selection`, { method: 'POST', body: { sessionId: 'sess_default', computerId: secondId } })
      await call(origin, `${API}/access`, { method: 'POST', body: { sessionId: 'sess_default', allowedComputers: [] } })
      const value = await listTool.execute({}, { agent: agentOf('sess_default') })
      assert.equal(value.computers.length, 0)
      assert.equal(value.hiddenComputerCount, 3)
      const content = listTool.output.render({}, value)
      assert.match(content[0].text, /may not use any of them/)
      assert.match(content[0].text, /管理访问权/)
      const denied = execTool.execute({ command: 'echo pinned-denied' }, { signal: new AbortController().signal, agent: agentOf('sess_default') })
      await assert.rejects(denied, /not accessible to this conversation/)
      // Reset the session rule and prove the pin works again.
      await call(origin, `${API}/access`, { method: 'POST', body: { sessionId: 'sess_default', allowedComputers: null } })
      const reread = await call(origin, `${API}/access?sessionId=sess_default`)
      assert.equal(reread.data.sessionAllowed, null)
      const restored = await runExec({ command: 'echo pinned-restored' }, secondSse, secondToken, 'sess_default', 'echo pinned-restored')
      assert.equal(restored.value.computer.id, secondId)
    })

    await check('enforcement: prompt section lists only computers allowed for the assembly Agent', async () => {
      const defaultText = section.text({ agent: agentOf('sess_default') })
      assert.ok(defaultText.includes('Second Mac'), 'default preset may use Second Mac')
      assert.ok(!defaultText.includes('First Mac'), 'default preset may not see First Mac')
      const researcherText = section.text({ agent: agentOf('sess_researcher') })
      assert.ok(researcherText.includes('First Mac'))
      assert.ok(!researcherText.includes('Second Mac'))
      // No Agent (diagnostics) falls back to the default preset rule alone.
      const diagnosticText = section.text({})
      assert.ok(diagnosticText.includes('Second Mac'))
      assert.ok(!diagnosticText.includes('First Mac'))
    })

    await check('access: null resets both rules to "all"', async () => {
      const sessionReset = await call(origin, `${API}/access`, {
        method: 'POST',
        body: { sessionId: 'sess_default', allowedComputers: null },
      })
      assert.equal(sessionReset.data.sessionAllowed, null)
      const computerReset = await call(origin, `${API}/access/computer`, {
        method: 'POST',
        body: { computerId: firstId, allowedPresets: null },
      })
      assert.equal(computerReset.data.allowedPresets, null)
      const noRule = await call(origin, `${API}/access?sessionId=sess_default`)
      for (const computer of noRule.data.computers) assert.equal(computer.allowed, true)
      const value = await listTool.execute({}, { agent: agentOf('sess_default') })
      assert.equal(value.computers.length, 3)
      assert.equal(value.hiddenComputerCount, 0)
      // Second computer still has its own rule: reset it too.
      await call(origin, `${API}/access/computer`, { method: 'POST', body: { computerId: secondId, allowedPresets: null } })
    })

    await check('access: routes sit behind the browser gate', async () => {
      app.fake.setGate({ requestRejection: () => 403, trustedHosts: [] })
      const refused = await raw(origin, `${API}/access?sessionId=sess_default`)
      assert.equal(refused.status, 403)
      assert.equal(refused.data.error, 'unadmitted')
      const refusedComputer = await raw(origin, `${API}/access/computer?computerId=${encodeURIComponent(firstId)}`)
      assert.equal(refusedComputer.status, 403)
      app.fake.setGate(undefined)
    })

    await check('access: deleting a computer drops its preset rule', async () => {
      await call(origin, `${API}/access/computer`, { method: 'POST', body: { computerId: thirdId, allowedPresets: ['default'] } })
      let doc = JSON.parse(readFileSync(accessFile, 'utf8'))
      assert.ok(doc.computers[thirdId])
      const deleted = await call(origin, `${API}/delete`, { method: 'POST', body: { id: thirdId } })
      assert.deepEqual(deleted.data, { ok: true })
      doc = JSON.parse(readFileSync(accessFile, 'utf8'))
      assert.equal(doc.computers[thirdId], undefined)
    })

    await check('access: preset fallback when the host has no agentPresets service', async () => {
      app.fake.setService('agentPresets', undefined)
      const response = await call(origin, `${API}/access?sessionId=sess_default`)
      assert.deepEqual(response.data.presets, [{ id: 'default', name: 'Default' }])
      assert.equal(response.data.presetId, 'default')
      const unknown = await call(origin, `${API}/access/computer`, {
        method: 'POST',
        body: { computerId: firstId, allowedPresets: ['researcher'] },
      })
      assert.equal(unknown.status, 400)
      assert.match(unknown.data.message, /unknown Agent preset/)
      // The computer-level rule only ever sees `default` now.
      const read = await call(origin, `${API}/access/computer?computerId=${firstId}`)
      assert.deepEqual(read.data.presets, [{ id: 'default', name: 'Default', allowed: true }])
    })
  } finally {
    for (const client of sseClients) client.close()
    await app.close()
  }

  await check('access: store prunes sessions to the 200 most recently updated', async () => {
    const pruneDir = join(root, 'i-prune')
    let clock = 1_000_000
    const store = createAccessStore({ stateDir: pruneDir, now: () => (clock += 1_000) })
    for (let index = 0; index < MAX_ACCESS_SESSIONS + 5; index += 1) store.setSessionAllow(`sess_${index}`, ['cmp_x'])
    const all = store.all()
    assert.equal(Object.keys(all.sessions).length, MAX_ACCESS_SESSIONS)
    assert.equal(all.sessions.sess_0, undefined)
    assert.equal(all.sessions.sess_4, undefined)
    assert.ok(all.sessions.sess_5)
    assert.deepEqual(store.sessionAllow(`sess_${MAX_ACCESS_SESSIONS + 4}`), ['cmp_x'])
  })

  await check('access: corrupt access.json is set aside', async () => {
    const corruptDir = join(root, 'i-corrupt')
    mkdirSync(corruptDir, { recursive: true })
    writeFileSync(join(corruptDir, 'access.json'), '{nope', { mode: 0o600 })
    const warnings = []
    const store = createAccessStore({ stateDir: corruptDir, onWarn: (message) => warnings.push(message) })
    assert.equal(store.sessionAllow('sess_any'), null)
    assert.equal(store.computerPresets('cmp_any'), null)
    assert.equal(existsSync(join(corruptDir, 'access.json')), false)
    assert.ok(warnings.some((line) => line.includes('not valid JSON')), `expected a corrupt-file warning, saw ${JSON.stringify(warnings)}`)
  })
}

// ---------------------------------------------------------------------------
// Phase J — protocol v2: capabilities, streaming chunks, DSH jobs, remote files
// ---------------------------------------------------------------------------

/** Minimal in-memory `ctx.jobs` registry for the v2 assertions. */
function createFakeJobs() {
  const records = new Map()
  let counter = 0
  return {
    records,
    start(spec) {
      const id = `computer-exec-${String(++counter).padStart(8, '0')}`
      const record = {
        id,
        kind: spec.kind,
        label: spec.label,
        owner: spec.owner,
        outputLimitBytes: spec.outputLimitBytes,
        chunks: [],
        progress: null,
        hooks: null,
        status: 'running',
        detail: null,
      }
      records.set(id, record)
      const handle = {
        id,
        append(text, options) {
          record.chunks.push({ channel: options?.channel ?? null, text })
        },
        updateProgress(line) {
          record.progress = line
        },
      }
      record.hooks = spec.run(handle)
      record.hooks.done.then((outcome) => {
        record.status = outcome.status
        record.detail = outcome.detail ?? null
      }, (error) => {
        record.status = 'failed'
        record.detail = error && error.message ? error.message : String(error)
      })
      return id
    },
    kill(id) {
      const record = records.get(id)
      if (record === undefined || record.status !== 'running') return 'already-finished'
      record.status = 'stopping'
      record.hooks.cancel('job_kill')
      return 'requested'
    },
  }
}

async function phaseJ(root) {
  const dir = join(root, 'j')
  const v2Id = newComputerId()
  const oldId = newComputerId()
  const noFsId = newComputerId()
  const embeddedOldId = newComputerId()
  const v2Token = mintSecret()
  const oldToken = mintSecret()
  const noFsToken = mintSecret()
  const embeddedOldToken = mintSecret()
  seedState(dir, {
    version: 1,
    computers: [
      // The handshake header on the SSE connect upgrades this one to fs.
      seedComputer(v2Id, 'V2 Mac', {
        tokenHash: sha256Hex(v2Token),
        capabilities: ['exec'],
        workspaceBase: null,
        agentVersion: PLUGIN_VERSION,
      }),
      seedComputer(oldId, 'Old Mac', { tokenHash: sha256Hex(oldToken), capabilities: ['exec'], agentVersion: '1.0.0' }),
      seedComputer(noFsId, 'No FS Mac', { tokenHash: sha256Hex(noFsToken), capabilities: ['exec'], agentVersion: PLUGIN_VERSION }),
      seedComputer(embeddedOldId, 'Embedded Old Mac', {
        tokenHash: sha256Hex(embeddedOldToken),
        capabilities: ['exec'],
        agentVersion: '1.0.0',
        mode: 'embedded',
      }),
    ],
    pendingKeys: [],
  })

  // Phase J opts into the version gate explicitly; the shipped default is no gate.
  const app = await mount({ ...FAST_CONFIG, stateDir: dir, execTimeoutMs: 400, promoteOnTimeout: true, minAgentVersion: '1.3' })
  const sseClients = []
  const jobs = createFakeJobs()
  app.fake.setService('jobs', jobs)
  try {
    const origin = app.origin
    const metadata = {
      version: 1,
      agentVersion: PLUGIN_VERSION,
      hostname: 'v2.local',
      os: 'darwin',
      arch: 'arm64',
      capabilities: ['exec', 'fs'],
      workspaceBase: '/Users/smoke',
      mode: 'embedded',
      caps: { exec: true, fs: true, jobs: true, pty: false, tunnel: false },
    }
    const metadataHeader = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url')
    const v2Sse = await openSse(origin, `${API}/agent/events`, {
      authorization: `Bearer ${v2Token}`,
      'x-dsh-computers-metadata': metadataHeader,
    })
    sseClients.push(v2Sse)
    const v2Hello = await v2Sse.nextEvent('hello', 2000)
    const oldSse = await openSse(origin, `${API}/agent/events`, { authorization: `Bearer ${oldToken}` })
    sseClients.push(oldSse)
    await oldSse.nextEvent('hello', 2000)
    const noFsMetadata = Buffer.from(JSON.stringify({
      version: 1,
      agentVersion: PLUGIN_VERSION,
      hostname: 'nofs.local',
      os: 'darwin',
      arch: 'arm64',
      capabilities: ['exec'],
      workspaceBase: '/Users/nofs',
      mode: 'embedded',
    }), 'utf8').toString('base64url')
    const noFsSse = await openSse(origin, `${API}/agent/events`, {
      authorization: `Bearer ${noFsToken}`,
      'x-dsh-computers-metadata': noFsMetadata,
    })
    sseClients.push(noFsSse)
    await noFsSse.nextEvent('hello', 2000)

    const execTool = app.fake.tools.get('computer_exec')
    const listTool = app.fake.tools.get('computer_list')
    const session = { id: 'sess_v2', session: { id: 'sess_v2' } }
    const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
    const authHeaders = (token) => ({
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    })
    const postChunk = (payload, token = v2Token) => raw(origin, `${API}/agent/results/chunk`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    })
    const postResult = (payload, token = v2Token) => raw(origin, `${API}/agent/results`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    })
    const postFs = (payload, token = v2Token) => raw(origin, `${API}/agent/fs/result`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    })
    const finalOk = (requestId, stdout = '') => ({
      requestId,
      ok: true,
      exitCode: 0,
      signal: null,
      stdout,
      stderr: '',
      durationMs: 5,
      truncated: false,
      timedOut: false,
      error: null,
    })

    await check('capabilities: handshake header refreshes the registry and hello advertises features', async () => {
      // hello is written before the activation mutation for the new record, but
      // the capability echo comes from the authenticated record + handshake.
      assert.deepEqual(v2Hello.data.capabilities, ['exec', 'fs'])
      assert.deepEqual(v2Hello.data.features, ['stream', 'fs'])
      const state = await call(origin, `${API}/state`)
      const v2 = state.data.computers.find((computer) => computer.id === v2Id)
      assert.deepEqual(v2.capabilities, ['exec', 'fs'])
      assert.equal(v2.workspaceBase, '/Users/smoke')
      assert.equal(v2.drift, false)
      assert.equal(v2.updateRequired, false)
      // v1.3.2: mode from the connect handshake; legacy rows read as service.
      assert.equal(v2.mode, 'embedded', 'mode is stored from the handshake header')
      const noFsState = state.data.computers.find((computer) => computer.id === noFsId)
      assert.equal(noFsState.mode, 'embedded')
      const legacy = state.data.computers.find((computer) => computer.id === oldId)
      assert.equal(legacy.mode, 'service', 'a legacy record without mode defaults to service')
      const embOld = state.data.computers.find((computer) => computer.id === embeddedOldId)
      assert.equal(embOld.mode, 'embedded')
      // R2: caps from the connect handshake; a legacy record derives them.
      assert.deepEqual(v2.caps, { exec: true, fs: true, jobs: true, pty: false, tunnel: false })
      assert.deepEqual(legacy.caps, { exec: true, fs: false, jobs: true, pty: false, tunnel: false })
      assert.deepEqual(state.data.computers.find((computer) => computer.id === noFsId).caps, legacy.caps)
      assert.equal(legacy.drift, true)
      assert.equal(legacy.updateRequired, true)
      const health = await call(origin, `${API}/health`)
      const healthV2 = health.data.agents.find((agent) => agent.id === v2Id)
      assert.deepEqual(healthV2.capabilities, ['exec', 'fs'])
      assert.equal(healthV2.mode, 'embedded')
      assert.deepEqual(healthV2.caps, { exec: true, fs: true, jobs: true, pty: false, tunnel: false })
      assert.equal(health.data.agents.find((agent) => agent.id === oldId).mode, 'service')
      assert.equal(healthV2.drift, false)
      const value = await listTool.execute({}, { agent: session })
      const listV2 = value.computers.find((computer) => computer.id === v2Id)
      assert.deepEqual(listV2.capabilities, ['exec', 'fs'])
      assert.deepEqual(listV2.caps, { exec: true, fs: true, jobs: true, pty: false, tunnel: false })
      assert.deepEqual(value.computers.find((computer) => computer.id === oldId).caps, { exec: true, fs: false, jobs: true, pty: false, tunnel: false })
      assert.equal(listV2.mode, 'embedded')
      assert.equal(value.computers.find((computer) => computer.id === oldId).mode, 'service')
      assert.equal(listV2.drift, false)
      assert.equal(listV2.updateRequired, false)
    })

    await check('exec: cwd defaults to the reported workspaceBase', async () => {
      const pending = execTool.execute({ computer: 'V2 Mac', command: 'pwd' }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      const event = await v2Sse.nextEvent('exec', 3000)
      assert.equal(event.data.cwd, '/Users/smoke')
      assert.equal(event.data.stream, true)
      await postResult(finalOk(event.data.requestId, '/Users/smoke\n'))
      const settled = await pending
      assert.ok(settled.value, settled.error && settled.error.message)
      assert.equal(settled.value.stdout, '/Users/smoke\n')
    })

    await check('chunks: out-of-order/duplicate seq reassemble into the job ring', async () => {
      const background = await execTool.execute(
        { computer: 'V2 Mac', command: 'stream-test', run_in_background: true },
        { agent: session },
      )
      assert.equal(background.started, true)
      assert.match(background.jobId, /^computer-exec-/)
      const record = jobs.records.get(background.jobId)
      assert.ok(record, 'the job was registered through ctx.jobs')
      assert.equal(record.kind, 'computer-exec')
      assert.equal(record.label, 'V2 Mac: stream-test')
      assert.equal(record.owner, 'sess_v2')
      assert.equal(record.outputLimitBytes, FAST_CONFIG.maxOutputBytes ?? 1_048_576)

      const event = await v2Sse.nextEvent('exec', 3000)
      const seq1 = await postChunk({ requestId: event.data.requestId, seq: 1, type: 'stdout', data: b64('world') })
      const seq0 = await postChunk({ requestId: event.data.requestId, seq: 0, type: 'stdout', data: b64('hello ') })
      const duplicate = await postChunk({ requestId: event.data.requestId, seq: 0, type: 'stdout', data: b64('hello ') })
      const seq2 = await postChunk({ requestId: event.data.requestId, seq: 2, type: 'stderr', data: b64('oops') })
      assert.equal(seq1.status, 200)
      assert.equal(seq0.status, 200)
      assert.equal(duplicate.status, 200, 'duplicate seq is accepted and dropped')
      assert.equal(seq2.status, 200)
      // Heartbeat frames are liveness only.
      const heartbeat = await postChunk({ requestId: event.data.requestId, seq: 3, type: 'heartbeat', data: '' })
      assert.equal(heartbeat.status, 200)
      const final = await postResult(finalOk(event.data.requestId, 'hello world'))
      assert.equal(final.status, 200)
      const done = await record.hooks.done
      assert.equal(done.status, 'completed')
      assert.deepEqual(record.chunks.map((chunk) => `${chunk.channel}:${chunk.text}`), [
        'stdout:hello ',
        'stdout:world',
        'stderr:oops',
      ])
      // A chunk for a settled execution is 404.
      const late = await postChunk({ requestId: event.data.requestId, seq: 4, type: 'stdout', data: b64('late') })
      assert.equal(late.status, 404)
      assert.equal(late.data.error, 'unknown-request')
    })

    await check('chunks: heartbeats keep a silent foreground command alive', async () => {
      const pending = execTool.execute({ computer: 'V2 Mac', command: 'slow-but-alive', timeoutMs: 250 }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      const event = await v2Sse.nextEvent('exec', 3000)
      for (let index = 0; index < 6; index += 1) {
        await sleep(80)
        await postChunk({ requestId: event.data.requestId, seq: index, type: 'heartbeat', data: '' })
      }
      await postResult(finalOk(event.data.requestId, 'alive\n'))
      const settled = await pending
      assert.ok(settled.value, `heartbeat should prevent the timeout: ${settled.error && settled.error.message}`)
      assert.equal(settled.value.stdout, 'alive\n')
      assert.equal(settled.value.timedOut, false)
    })

    await check('jobs: background kill sends cancel and settles the job as killed', async () => {
      const background = await execTool.execute(
        { computer: 'V2 Mac', command: 'kill-me', run_in_background: true },
        { agent: session },
      )
      const record = jobs.records.get(background.jobId)
      const event = await v2Sse.nextEvent('exec', 3000)
      assert.equal(jobs.kill(background.jobId), 'requested')
      const cancel = await v2Sse.nextEvent('cancel', 3000)
      assert.equal(cancel.data.requestId, event.data.requestId)
      await postResult({
        requestId: event.data.requestId,
        ok: false,
        exitCode: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: '',
        durationMs: 2,
        truncated: false,
        timedOut: false,
        error: 'cancelled',
      })
      const done = await record.hooks.done
      assert.equal(done.status, 'killed')
      assert.equal(record.status, 'killed')
    })

    await check('jobs: a foreground timeout is promoted instead of killed', async () => {
      const pending = execTool.execute({ computer: 'V2 Mac', command: 'promote-me', timeoutMs: 200 }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      const event = await v2Sse.nextEvent('exec', 3000)
      const settled = await pending
      assert.ok(settled.value, settled.error && settled.error.message)
      assert.equal(settled.value.promoted, true)
      assert.equal(settled.value.computer.id, v2Id)
      assert.match(settled.value.jobId, /^computer-exec-/)
      const record = jobs.records.get(settled.value.jobId)
      assert.ok(record, 'the promoted execution is a real DSH job')
      assert.equal(v2Sse.events.filter((frame) => frame.name === 'cancel').length, 0, 'promotion must not cancel the command')
      // Late output keeps flowing into the adopted job, then it settles.
      await postChunk({ requestId: event.data.requestId, seq: 0, type: 'stdout', data: b64('late output') })
      await postResult(finalOk(event.data.requestId, 'late output'))
      const done = await record.hooks.done
      assert.equal(done.status, 'completed')
      assert.deepEqual(record.chunks.map((chunk) => chunk.text), ['late output'])
    })

    await check('exec: the version gate wording depends on the machine mode', async () => {
      const serviceDenied = execTool.execute({ computer: 'Old Mac', command: 'echo old' }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      const serviceSettled = await serviceDenied
      assert.ok(serviceSettled.error)
      assert.match(serviceSettled.error.message, /older than the required/)
      assert.match(serviceSettled.error.message, /重新运行安装命令/, 'service machines get the one-liner hint')
      assert.match(serviceSettled.error.message, /re-run the one-line install command/)
      assert.doesNotMatch(serviceSettled.error.message, /插件市场/)
      assert.equal(oldSse.events.filter((frame) => frame.name === 'exec').length, 0)

      const embeddedDenied = execTool.execute({ computer: 'Embedded Old Mac', command: 'echo old' }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      const embeddedSettled = await embeddedDenied
      assert.ok(embeddedSettled.error)
      assert.match(embeddedSettled.error.message, /older than the required/)
      assert.match(embeddedSettled.error.message, /设置 → 插件市场 → 检查更新/, 'embedded machines get the plugin-update hint')
      assert.match(embeddedSettled.error.message, /重启 DSH/)
      assert.doesNotMatch(embeddedSettled.error.message, /重新运行安装命令/)
    })

    await check('fs: the five file tools run end to end over the stream', async () => {
      const readTool = app.fake.tools.get('computer_read')
      const writeTool = app.fake.tools.get('computer_write')
      const editTool = app.fake.tools.get('computer_edit')
      const globTool = app.fake.tools.get('computer_glob')
      const grepTool = app.fake.tools.get('computer_grep')
      for (const tool of [readTool, writeTool, editTool, globTool, grepTool]) assert.ok(tool, 'file tools must be registered')

      // read
      const readPending = readTool.execute({ computer: 'V2 Mac', path: '/Users/smoke/a.txt' }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      const readEvent = await v2Sse.nextEvent('fs', 3000)
      assert.equal(readEvent.data.op, 'read')
      assert.equal(readEvent.data.path, '/Users/smoke/a.txt')
      await postFs({ requestId: readEvent.data.requestId, ok: true, op: 'read', path: '/Users/smoke/a.txt', text: 'alpha\nbeta\n', lines: 2, bytes: 11, truncated: false })
      const read = await readPending
      assert.ok(read.value, read.error && read.error.message)
      assert.equal(read.value.text, 'alpha\nbeta\n')
      assert.equal(read.value.lines, 2)
      assert.match(readTool.output.render({}, read.value)[0].text, /alpha/)

      // write
      const writePending = writeTool.execute({ computer: 'V2 Mac', path: '/Users/smoke/new.txt', content: 'hello', createDirs: true }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      const writeEvent = await v2Sse.nextEvent('fs', 3000)
      assert.equal(writeEvent.data.op, 'write')
      assert.equal(writeEvent.data.content, 'hello')
      assert.equal(writeEvent.data.createDirs, true)
      await postFs({ requestId: writeEvent.data.requestId, ok: true, op: 'write', path: '/Users/smoke/new.txt', bytes: 5, created: true })
      const write = await writePending
      assert.ok(write.value, write.error && write.error.message)
      assert.equal(write.value.bytes, 5)
      assert.equal(write.value.created, true)

      // edit = read + write
      const editPending = editTool.execute({ computer: 'V2 Mac', path: '/Users/smoke/a.txt', old: 'beta', new: 'gamma' }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      const editRead = await v2Sse.nextEvent('fs', 3000)
      assert.equal(editRead.data.op, 'read')
      await postFs({ requestId: editRead.data.requestId, ok: true, op: 'read', path: '/Users/smoke/a.txt', text: 'alpha\nbeta\n', lines: 2, bytes: 11, truncated: false })
      const editWrite = await v2Sse.nextEvent('fs', 3000)
      assert.equal(editWrite.data.op, 'write')
      assert.equal(editWrite.data.content, 'alpha\ngamma\n')
      await postFs({ requestId: editWrite.data.requestId, ok: true, op: 'write', path: '/Users/smoke/a.txt', bytes: 12, created: false })
      const edit = await editPending
      assert.ok(edit.value, edit.error && edit.error.message)
      assert.equal(edit.value.replacements, 1)

      // edit: ambiguous old text must error without writing
      const ambiguous = editTool.execute({ computer: 'V2 Mac', path: '/Users/smoke/a.txt', old: 'a', new: 'b' }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      const ambiguousRead = await v2Sse.nextEvent('fs', 3000)
      await postFs({ requestId: ambiguousRead.data.requestId, ok: true, op: 'read', path: '/Users/smoke/a.txt', text: 'aaa', lines: 1, bytes: 3, truncated: false })
      const ambiguousSettled = await ambiguous
      assert.ok(ambiguousSettled.error)
      assert.match(ambiguousSettled.error.message, /appears 3 times/)

      // glob
      const globPending = globTool.execute({ computer: 'V2 Mac', pattern: '**/*.ts' }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      const globEvent = await v2Sse.nextEvent('fs', 3000)
      assert.equal(globEvent.data.op, 'glob')
      assert.equal(globEvent.data.pattern, '**/*.ts')
      await postFs({ requestId: globEvent.data.requestId, ok: true, op: 'glob', paths: ['/Users/smoke/a.ts', '/Users/smoke/b.ts'] })
      const glob = await globPending
      assert.ok(glob.value, glob.error && glob.error.message)
      assert.deepEqual(glob.value.paths, ['/Users/smoke/a.ts', '/Users/smoke/b.ts'])

      // grep
      const grepPending = grepTool.execute({ computer: 'V2 Mac', pattern: 'needle', path: '/Users/smoke', include: '*.ts' }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      const grepEvent = await v2Sse.nextEvent('fs', 3000)
      assert.equal(grepEvent.data.op, 'grep')
      assert.equal(grepEvent.data.pattern, 'needle')
      assert.equal(grepEvent.data.include, '*.ts')
      await postFs({ requestId: grepEvent.data.requestId, ok: true, op: 'grep', matches: [{ path: '/Users/smoke/a.ts', line: 2, text: 'const needle = 1' }] })
      const grep = await grepPending
      assert.ok(grep.value, grep.error && grep.error.message)
      assert.deepEqual(grep.value.matches, [{ path: '/Users/smoke/a.ts', line: 2, text: 'const needle = 1' }])
      assert.match(grepTool.output.render({}, grep.value)[0].text, /a\.ts:2: const needle/)
    })

    await check('fs: an agent without the fs capability answers with the upgrade hint', async () => {
      const readTool = app.fake.tools.get('computer_read')
      const settled = await readTool.execute({ computer: 'No FS Mac', path: '/tmp/x' }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      assert.ok(settled.error)
      assert.match(settled.error.message, /does not support remote file access/)
      assert.match(settled.error.message, /'fs' capability is missing/, 'the error names the missing capability')
      assert.match(settled.error.message, /"fs":false/, 'the error shows the reported caps')
      assert.match(settled.error.message, /设置 → 插件市场 → 检查更新/, 'this machine is embedded, so the plugin-update hint is used')
      assert.doesNotMatch(settled.error.message, /重新运行安装命令/)
      assert.equal(noFsSse.events.filter((frame) => frame.name === 'fs').length, 0)
    })

    await check('exec: run_in_background is refused clearly without a jobs registry', async () => {
      app.fake.setService('jobs', undefined)
      const settled = await execTool.execute(
        { computer: 'V2 Mac', command: 'bg-without-jobs', run_in_background: true },
        { agent: session },
      ).then((value) => ({ value }), (error) => ({ error }))
      assert.ok(settled.error)
      assert.match(settled.error.message, /jobs registry is not loaded/)
      app.fake.setService('jobs', jobs)
    })
  } finally {
    for (const client of sseClients) client.close()
    await app.close()
  }

  // promoteOnTimeout: false keeps the v1 cancel-and-error behaviour.
  const fallback = await mount({ ...FAST_CONFIG, stateDir: dir, execTimeoutMs: 200, promoteOnTimeout: false })
  try {
    const fallbackToken = v2Token
    const sse = await openSse(fallback.origin, `${API}/agent/events`, { authorization: `Bearer ${fallbackToken}` })
    try {
      await sse.nextEvent('hello', 2000)
      await check('exec: promoteOnTimeout=false keeps the cancel-and-error path', async () => {
        const execTool = fallback.fake.tools.get('computer_exec')
        const pending = execTool.execute({ computer: 'V2 Mac', command: 'no-timeout', timeoutMs: 150 }, { agent: { id: 'sess_v2' } })
          .then((value) => ({ value }), (error) => ({ error }))
        const event = await sse.nextEvent('exec', 3000)
        const cancel = await sse.nextEvent('cancel', 3000)
        assert.equal(cancel.data.requestId, event.data.requestId)
        const settled = await pending
        assert.ok(settled.error)
        assert.match(settled.error.message, /did not answer within 150ms/)
      })
    } finally {
      sse.close()
    }
  } finally {
    await fallback.close()
  }
}

// ---------------------------------------------------------------------------
// Phase K — reachable-address candidates (v1.3.3)
// ---------------------------------------------------------------------------

async function phaseK(root) {
  const dir = join(root, 'k')
  seedState(dir, { version: 1, computers: [], pendingKeys: [] })

  const ctxOf = (port = 49749, host = '127.0.0.1') => ({
    webServer: { host, port, protocol: 'http:', getOrigin: () => `http://127.0.0.1:${port}` },
  })
  const reqOf = (host = '127.0.0.1:49749') => ({ headers: { host } })
  const healthyProbe = async () => ({ ok: true, status: 200, ms: 1, error: null })
  const loopbackOnlyDeps = {
    probe: healthyProbe,
    probeTailscale: async () => null,
    interfaces: { lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] },
    hostname: 'smoke-host.local',
  }
  // A machine with both Tailscale and a LAN address, plus the desktop bind.
  const tailscaleDeps = {
    probe: healthyProbe,
    probeTailscale: async () => '100.121.33.106',
    interfaces: {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.168.8.198', family: 'IPv4', internal: false }],
    },
    hostname: 'desk.local',
  }
  const BASE_CONFIG = { publicUrl: '', preferAddress: 'auto' }

  await check('addresses: desktop bind (127.0.0.1) marks tailscale/lan unreachable and recommends loopback', async () => {
    const options = { ctx: ctxOf(49749, '127.0.0.1'), config: BASE_CONFIG, req: reqOf(), ...tailscaleDeps }
    const payload = await resolveAddressPayload(options)
    assert.equal(payload.serverUrl, 'http://127.0.0.1:49749')
    assert.equal(payload.loopbackOnly, true)
    assert.deepEqual(payload.listener, { host: '127.0.0.1', port: 49749, loopback: true })
    assert.deepEqual(withoutHealth(payload.serverUrls), [
      { url: 'http://100.121.33.106:49749', kind: 'tailscale', label: 'Tailscale', recommended: false, reachable: false },
      { url: 'http://192.168.8.198:49749', kind: 'lan', label: '局域网', recommended: false, reachable: false },
      { url: 'http://127.0.0.1:49749', kind: 'loopback', label: '本机', recommended: true, reachable: true },
    ])
  })

  await check('addresses: server bind (100.x) makes tailscale reachable and recommended, LAN unreachable', async () => {
    const payload = await resolveAddressPayload({
      ctx: ctxOf(49749, '100.121.33.106'), config: BASE_CONFIG, req: reqOf(), ...tailscaleDeps,
    })
    assert.equal(payload.serverUrl, 'http://100.121.33.106:49749')
    assert.equal(payload.loopbackOnly, false)
    assert.deepEqual(payload.listener, { host: '100.121.33.106', port: 49749, loopback: false })
    assert.deepEqual(withoutHealth(payload.serverUrls), [
      { url: 'http://100.121.33.106:49749', kind: 'tailscale', label: 'Tailscale', recommended: true, reachable: true },
      { url: 'http://192.168.8.198:49749', kind: 'lan', label: '局域网', recommended: false, reachable: false },
      { url: 'http://127.0.0.1:49749', kind: 'loopback', label: '本机', recommended: false, reachable: false },
    ])
  })

  await check('addresses: CGNAT interface scan finds Tailscale when the binary is missing', async () => {
    const list = await collectServerUrls({
      ctx: ctxOf(49749, '100.121.33.106'),
      config: BASE_CONFIG,
      req: reqOf(),
      probeTailscale: async () => null,
      interfaces: {
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        utun0: [{ address: '100.121.33.106', family: 'IPv4', internal: false }],
      },
      hostname: 'desk.local',
    })
    assert.equal(list[0].kind, 'tailscale')
    assert.equal(list[0].url, 'http://100.121.33.106:49749')
    assert.equal(list[0].recommended, true)
    assert.equal(list[0].reachable, true)
  })

  await check('addresses: publicUrl always wins and is reachable by promise', async () => {
    const payload = await resolveAddressPayload({
      ctx: ctxOf(49749, '127.0.0.1'),
      config: { publicUrl: 'https://dsh.example.com', preferAddress: 'auto' },
      req: reqOf(),
      ...tailscaleDeps,
    })
    assert.equal(payload.serverUrl, 'https://dsh.example.com')
    assert.equal(payload.loopbackOnly, false)
    assert.deepEqual(withoutHealth(payload.serverUrls)[0], {
      url: 'https://dsh.example.com', kind: 'public', label: '公网', recommended: true, reachable: true,
    })
    assert.ok(payload.serverUrls.some((item) => item.kind === 'tailscale'), 'other candidates are still offered')
  })

  await check('addresses: preferAddress=lan with a LAN bind picks the LAN candidate', async () => {
    const payload = await resolveAddressPayload({
      ctx: ctxOf(49749, '192.168.8.198'),
      config: { publicUrl: '', preferAddress: 'lan' },
      req: reqOf(),
      ...tailscaleDeps,
    })
    const recommended = payload.serverUrls.filter((item) => item.recommended)
    assert.equal(recommended.length, 1)
    assert.equal(recommended[0].kind, 'lan')
    assert.equal(recommended[0].url, 'http://192.168.8.198:49749')
    assert.equal(recommended[0].reachable, true)
    assert.equal(payload.serverUrls.find((item) => item.kind === 'tailscale').reachable, false)
  })

  await check('addresses: preferAddress never recommends an unreachable kind (falls back)', async () => {
    // The LAN is preferred but the listener is a desktop bind: LAN is not reachable.
    const unreachablePreference = await resolveAddressPayload({
      ctx: ctxOf(49749, '127.0.0.1'),
      config: { publicUrl: '', preferAddress: 'lan' },
      req: reqOf(),
      ...tailscaleDeps,
    })
    assert.equal(unreachablePreference.serverUrl, 'http://127.0.0.1:49749')
    assert.equal(unreachablePreference.loopbackOnly, true)
    // Public is preferred but not configured: auto order decides.
    const missingKind = await resolveAddressPayload({
      ctx: ctxOf(49749, '127.0.0.1'),
      config: { publicUrl: '', preferAddress: 'public' },
      req: reqOf(),
      ...loopbackOnlyDeps,
    })
    assert.deepEqual(missingKind.serverUrls.map((item) => item.kind), ['loopback'])
    assert.equal(missingKind.serverUrls[0].recommended, true)
  })

  await check('addresses: dedupe keeps one entry per url (single loopback)', async () => {
    const list = await collectServerUrls({
      ctx: ctxOf(49749, '192.168.8.198'),
      config: { publicUrl: 'http://192.168.8.198:49749', preferAddress: 'auto' },
      req: reqOf('192.168.8.198:49749'),
      probeTailscale: async () => '100.64.1.2',
      interfaces: {
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        en0: [{ address: '192.168.8.198', family: 'IPv4', internal: false }],
        utun0: [{ address: '100.64.1.2', family: 'IPv4', internal: false }],
      },
      hostname: 'desk.local',
    })
    const urls = list.map((item) => item.url)
    assert.equal(new Set(urls).size, urls.length, 'no duplicate urls')
    assert.equal(urls.filter((url) => url === 'http://127.0.0.1:49749').length, 1)
    assert.equal(urls.filter((url) => url === 'http://192.168.8.198:49749').length, 1)
    assert.equal(urls.filter((url) => url === 'http://100.64.1.2:49749').length, 1)
    assert.equal(list.filter((item) => item.recommended).length, 1)
  })

  await check('addresses: item shape and kind/label vocabulary are stable', async () => {
    const list = await collectServerUrls({
      ctx: ctxOf(49749, '100.121.33.106'),
      config: { publicUrl: 'https://dsh.example.com' },
      req: reqOf(),
      ...tailscaleDeps,
    })
    const expected = {
      public: '公网', forwarded: '转发地址', host: '当前访问地址',
      tailscale: 'Tailscale', lan: '局域网', mdns: '本机名', loopback: '本机',
    }
    for (const item of list) {
      assert.deepEqual(Object.keys(item).sort(), ['kind', 'label', 'reachable', 'recommended', 'url'])
      assert.equal(typeof item.url, 'string')
      assert.equal(typeof item.recommended, 'boolean')
      assert.equal(typeof item.reachable, 'boolean')
      assert.ok(item.kind in expected, `unexpected kind ${item.kind}`)
      assert.equal(item.label, expected[item.kind])
    }
  })

  // --- HTTP wiring: the payload the settings modal consumes -----------------
  const app = await mount({ ...FAST_CONFIG, stateDir: dir }, { addressDeps: tailscaleDeps, webServerHost: '127.0.0.1' })
  try {
    const origin = app.origin
    const port = new URL(origin).port
    const loopbackUrl = `http://127.0.0.1:${port}`

    await check('addresses: desktop /state is honest about the loopback bind', async () => {
      const state = await call(origin, `${API}/state`)
      assert.equal(state.data.serverUrl, loopbackUrl)
      assert.equal(state.data.loopbackOnly, true)
      assert.deepEqual(state.data.listener, { host: '127.0.0.1', port: Number(port), loopback: true })
      assert.deepEqual(state.data.serverUrls.map((item) => [item.kind, item.reachable, item.recommended]), [
        ['tailscale', false, false],
        ['lan', false, false],
        ['loopback', true, true],
      ])
    })

    await check('addresses: desktop /keys embeds the loopback address, not an unreachable one', async () => {
      const response = await call(origin, `${API}/keys`, { method: 'POST', body: { os: 'macos' } })
      assert.equal(response.status, 200)
      assert.equal(response.data.serverUrl, loopbackUrl)
      assert.equal(response.data.loopbackOnly, true)
      assert.deepEqual(response.data.listener, { host: '127.0.0.1', port: Number(port), loopback: true })
      assert.ok(response.data.command.includes(`${loopbackUrl}/api/dsh-computers/join.sh?key=`))
      assert.ok(!response.data.command.includes('100.121.33.106'), 'never advertise an address the listener cannot serve')
      assert.ok(!response.data.command.includes('192.168.8.198'))
    })
  } finally {
    await app.close()
  }

  // --- server-like deployment: bind on the Tailscale interface ---------------
  const serverApp = await mount({ ...FAST_CONFIG, stateDir: dir }, { addressDeps: tailscaleDeps, webServerHost: '100.121.33.106' })
  try {
    const origin = serverApp.origin
    const port = new URL(origin).port
    const tailscaleUrl = `http://100.121.33.106:${port}`
    await check('addresses: server bind recommends tailscale and flags LAN unreachable', async () => {
      const state = await call(origin, `${API}/state`)
      assert.equal(state.data.serverUrl, tailscaleUrl)
      assert.equal(state.data.loopbackOnly, false)
      assert.deepEqual(state.data.listener, { host: '100.121.33.106', port: Number(port), loopback: false })
      const byKind = new Map(state.data.serverUrls.map((item) => [item.kind, item]))
      assert.equal(byKind.get('tailscale').reachable, true)
      assert.equal(byKind.get('tailscale').recommended, true)
      assert.equal(byKind.get('lan').reachable, false)
      assert.equal(byKind.get('loopback').reachable, false)
      const response = await call(origin, `${API}/keys`, { method: 'POST', body: { os: 'macos' } })
      assert.ok(response.data.command.includes(`${tailscaleUrl}/api/dsh-computers/join.sh?key=`))
    })
  } finally {
    await serverApp.close()
  }

  // --- loopback-only deployment: loopbackOnly true + command embeds loopback --
  const loopbackApp = await mount({ ...FAST_CONFIG, stateDir: dir }, { addressDeps: loopbackOnlyDeps })
  try {
    const origin = loopbackApp.origin
    const port = new URL(origin).port
    await check('addresses: loopback-only deployment reports loopbackOnly and embeds 127.0.0.1', async () => {
      const state = await call(origin, `${API}/state`)
      assert.equal(state.data.loopbackOnly, true)
      assert.deepEqual(state.data.serverUrls.map((item) => item.kind), ['loopback'])
      assert.equal(state.data.serverUrl, `http://127.0.0.1:${port}`)
      const response = await call(origin, `${API}/keys`, { method: 'POST', body: { os: 'macos' } })
      assert.equal(response.data.loopbackOnly, true)
      assert.ok(response.data.command.includes(`http://127.0.0.1:${port}/api/dsh-computers/join.sh?key=`))
    })
  } finally {
    await loopbackApp.close()
  }
}

// ---------------------------------------------------------------------------
// Phase L — owned Tailscale Serve tunnel (v1.4.0)
// ---------------------------------------------------------------------------

/** Stub for the tunnel's exec seam: record invocations, answer by argv. */
function createTunnelExecPlan({ serveStatus = '', serveCode = 0, serveError = null, dnsName = 'hub.tail1234.ts.net.' } = {}) {
  const calls = []
  const run = async ({ args }) => {
    calls.push([...args])
    if (args[0] === 'serve' && args[1] === 'status') {
      return { code: 0, stdout: serveStatus, stderr: '', error: null }
    }
    if (args[0] === 'serve') {
      return serveCode === 0
        ? { code: 0, stdout: '', stderr: '', error: null }
        : { code: serveCode, stdout: '', stderr: 'Error: serve failed', error: serveError }
    }
    if (args[0] === 'status') {
      return {
        code: dnsName === null ? 1 : 0,
        stdout: dnsName === null ? '' : JSON.stringify({ Self: { DNSName: dnsName } }),
        stderr: '',
        error: dnsName === null ? 'status failed' : null,
      }
    }
    return { code: 0, stdout: '', stderr: '', error: null }
  }
  return { calls, run }
}

/** Poll /state until `predicate` accepts the payload (tunnel setup is async). */
async function waitForTunnelState(origin, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const response = await call(origin, `${API}/state`)
    last = response.data
    if (predicate(last)) return last
    await sleep(40)
  }
  throw new Error(`tunnel state did not settle; last = ${JSON.stringify(last)}`)
}

async function phaseL(root) {
  const dir = join(root, 'l')
  seedState(dir, { version: 1, computers: [], pendingKeys: [] })

  const makeManager = async (tunnelConfig, plan) => {
    const manager = createTunnel({
      ctx: { webServer: { port: 49749 }, tunnelExec: plan.run },
      config: tunnelConfig,
      onWarn: () => {},
    })
    await manager.start()
    return manager
  }

  await check('tunnel: serves our bound port and derives the ts.net URL', async () => {
    const plan = createTunnelExecPlan()
    const manager = await makeManager({ enabled: true, httpsPort: 8443 }, plan)
    assert.deepEqual(manager.status(), {
      enabled: true,
      configured: true,
      url: 'https://hub.tail1234.ts.net:8443',
      targetPort: 49749,
      error: null,
    })
    assert.ok(
      plan.calls.some((args) => args.join(' ') === 'serve --bg --https=8443 http://127.0.0.1:49749'),
      `serve command line: ${JSON.stringify(plan.calls)}`,
    )
    assert.ok(plan.calls.some((args) => args.join(' ') === 'status --json'))
  })

  await check('tunnel: re-point is idempotent when Serve already targets our port', async () => {
    const plan = createTunnelExecPlan({
      serveStatus: JSON.stringify({
        Web: { 'hub.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:49749' } } } },
      }),
    })
    const manager = await makeManager({ enabled: true, httpsPort: 8443 }, plan)
    assert.equal(manager.status().configured, true)
    assert.equal(manager.status().url, 'https://hub.tail1234.ts.net:8443')
    assert.equal(
      plan.calls.some((args) => args[0] === 'serve' && args[1] !== 'status'),
      false,
      'an existing mapping to our port is not re-pointed',
    )
  })

  await check('tunnel: custom httpsPort and a clean DNS name', async () => {
    const plan = createTunnelExecPlan({ dnsName: 'workstation.tail9999.ts.net' })
    const manager = await makeManager({ enabled: true, httpsPort: 9443 }, plan)
    assert.equal(manager.status().url, 'https://workstation.tail9999.ts.net:9443')
    assert.ok(plan.calls.some((args) => args.join(' ') === 'serve --bg --https=9443 http://127.0.0.1:49749'))
  })

  await check('tunnel: a failing serve command surfaces an error and no URL', async () => {
    const plan = createTunnelExecPlan({ serveCode: 1, serveError: 'permission denied' })
    const manager = await makeManager({ enabled: true, httpsPort: 8443 }, plan)
    const state = manager.status()
    assert.equal(state.enabled, true)
    assert.equal(state.configured, false)
    assert.equal(state.url, '')
    assert.equal(state.targetPort, 49749)
    assert.match(state.error, /permission denied|serve failed|status/)
  })

  await check('tunnel: disabled by default does nothing', async () => {
    const plan = createTunnelExecPlan()
    const manager = await makeManager({ enabled: false, httpsPort: 8443 }, plan)
    assert.deepEqual(manager.status(), {
      enabled: false, configured: false, url: '', targetPort: null, error: null,
    })
    assert.deepEqual(plan.calls, [])
  })

  // --- HTTP integration: /state.tunnel + the tunnel address candidate ------
  const addressDeps = {
    probeTailscale: async () => '100.121.33.106',
    interfaces: { lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] },
    hostname: 'smoke-host.local',
  }
  const plan = createTunnelExecPlan()
  const app = await mount(
    { ...FAST_CONFIG, stateDir: dir, tailscaleServe: { enabled: true, httpsPort: 8443 } },
    { addressDeps, tunnelExec: plan.run },
  )
  try {
    const origin = app.origin
    const port = new URL(origin).port
    await check('tunnel: /state exposes it and the tunnel URL becomes the recommendation', async () => {
      const state = await waitForTunnelState(origin, (data) => data.tunnel.configured === true)
      assert.deepEqual(state.tunnel, {
        enabled: true,
        configured: true,
        url: 'https://hub.tail1234.ts.net:8443',
        targetPort: Number(port),
        error: null,
      })
      assert.equal(state.serverUrl, 'https://hub.tail1234.ts.net:8443')
      assert.equal(state.loopbackOnly, false)
      assert.deepEqual(withoutHealth(state.serverUrls)[0], {
        url: 'https://hub.tail1234.ts.net:8443',
        kind: 'tunnel',
        label: 'Tailscale Serve',
        recommended: true,
        reachable: true,
      })
      // The serve target really is the port this listener bound.
      assert.ok(plan.calls.some((args) => args.join(' ') === `serve --bg --https=8443 http://127.0.0.1:${port}`))
    })

    await check('tunnel: /keys embeds the ts.net URL, never loopback', async () => {
      const response = await call(origin, `${API}/keys`, { method: 'POST', body: { os: 'macos' } })
      assert.equal(response.status, 200)
      assert.equal(response.data.serverUrl, 'https://hub.tail1234.ts.net:8443')
      assert.equal(response.data.loopbackOnly, false)
      assert.ok(response.data.command.includes('https://hub.tail1234.ts.net:8443/api/dsh-computers/join.sh?key='))
      assert.ok(!response.data.command.includes('127.0.0.1'))
      assert.ok(!response.data.command.includes('100.121.33.106'))
    })
  } finally {
    await app.close()
  }

  // --- failure integration: no candidate, the error is surfaced -------------
  const failingPlan = createTunnelExecPlan({ serveCode: 1, serveError: 'tailscale is not running' })
  const failingApp = await mount(
    { ...FAST_CONFIG, stateDir: dir, tailscaleServe: { enabled: true, httpsPort: 8443 } },
    { addressDeps, tunnelExec: failingPlan.run },
  )
  try {
    const origin = failingApp.origin
    const port = new URL(origin).port
    await check('tunnel: a failed serve keeps loopback recommended and surfaces the error', async () => {
      const state = await waitForTunnelState(origin, (data) => data.tunnel.error !== null)
      assert.equal(state.tunnel.enabled, true)
      assert.equal(state.tunnel.configured, false)
      assert.equal(state.tunnel.url, '')
      assert.match(state.tunnel.error, /tailscale is not running|serve failed/)
      assert.equal(state.serverUrl, `http://127.0.0.1:${port}`)
      assert.equal(state.loopbackOnly, true)
      assert.equal(state.serverUrls.some((item) => item.kind === 'tunnel'), false, 'no fake tunnel candidate')
      const response = await call(origin, `${API}/keys`, { method: 'POST', body: { os: 'macos' } })
      assert.ok(response.data.command.includes(`http://127.0.0.1:${port}/api/dsh-computers/join.sh?key=`))
    })
  } finally {
    await failingApp.close()
  }

  // --- disabled integration: the default shape stays inert ------------------
  const disabledApp = await mount({ ...FAST_CONFIG, stateDir: dir }, { addressDeps })
  try {
    await check('tunnel: disabled config reports the inert shape and adds no candidate', async () => {
      const state = await call(disabledApp.origin, `${API}/state`)
      assert.deepEqual(state.data.tunnel, { enabled: false, configured: false, url: '', targetPort: null, error: null })
      assert.equal(state.data.serverUrls.some((item) => item.kind === 'tunnel'), false)
    })
  } finally {
    await disabledApp.close()
  }
}

// ---------------------------------------------------------------------------
// Phase M — lib/contracts.js unit assertions (R1, docs/refactor-plan.md)
// ---------------------------------------------------------------------------

async function phaseM() {
  await check('contracts: leaf module has no imports and no state', async () => {
    const source = readFileSync(new URL('../lib/contracts.js', import.meta.url), 'utf8')
    assert.equal(source.includes('require('), false, 'no CommonJS require')
    assert.equal(/(^|\n)\s*import\s/.test(source), false, 'no ES imports: zero-dependency leaf')
  })

  await check('contracts: vocabulary constants are complete and frozen', async () => {
    assert.equal(contracts.PROTOCOL_VERSION, 2)
    assert.equal(contracts.STATE_VERSION, 1)
    assert.equal(contracts.API_BASE, '/api/dsh-computers')
    assert.deepEqual(contracts.CAPABILITIES, ['exec', 'fs', 'jobs', 'pty', 'tunnel'])
    assert.deepEqual(contracts.HOST_FEATURES, ['stream', 'fs'])
    assert.deepEqual(contracts.EXECUTION_STATUSES, ['completed', 'failed', 'cancelled', 'timeout'])
    assert.deepEqual(contracts.DISPOSITIONS, ['reusable', 'broken'])
    assert.equal(contracts.EXECUTION_STATUS.TIMEOUT, 'timeout')
    assert.equal(contracts.DISPOSITION.BROKEN, 'broken')
    assert.equal(contracts.WIRE_EVENT.HELLO, 'hello')
    assert.equal(contracts.WIRE_EVENT.FS, 'fs')
    assert.equal(contracts.CHUNK_TYPE.HEARTBEAT, 'heartbeat')
    assert.equal(contracts.ERROR_CODES.INVALID_TOKEN, 'invalid-token')
    assert.equal(contracts.ERROR_CODES.UNKNOWN_REQUEST, 'unknown-request')
    assert.equal(contracts.JOB_STATUS.KILLED, 'killed')
    assert.ok(Object.isFrozen(contracts.CAPABILITIES))
    assert.ok(Object.isFrozen(contracts.ERROR_CODES))
  })

  await check('contracts: frame constructors reproduce the wire field order', async () => {
    assert.deepEqual(
      contracts.helloFrame({ computerId: 'cmp_1', name: 'Mac', heartbeatMs: 20000, capabilities: ['exec'], features: ['stream', 'fs'] }),
      { computerId: 'cmp_1', name: 'Mac', heartbeatMs: 20000, capabilities: ['exec'], features: ['stream', 'fs'] },
    )
    assert.deepEqual(
      contracts.execFrame({ requestId: 'req_1', command: 'echo hi', timeoutMs: 500 }),
      { requestId: 'req_1', command: 'echo hi', cwd: null, timeoutMs: 500, shell: 'sh', stream: true },
    )
    assert.deepEqual(contracts.cancelFrame('req_1'), { requestId: 'req_1' })
    assert.deepEqual(
      contracts.fsFrame({ requestId: 'fsr_1', op: 'read', payload: { path: '/tmp/a', offset: 1 } }),
      { requestId: 'fsr_1', op: 'read', path: '/tmp/a', offset: 1 },
    )
    assert.deepEqual(
      contracts.chunkFrame({ requestId: 'req_1', seq: 3, type: 'stdout', data: 'aGk=' }),
      { requestId: 'req_1', seq: 3, type: 'stdout', data: 'aGk=' },
    )
    assert.deepEqual(
      contracts.resultFrame({ requestId: 'req_1' }),
      { requestId: 'req_1', ok: false, exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 0, truncated: false, timedOut: false, error: null },
    )
    assert.equal(contracts.pingFrame(42).t, 42)
  })

  await check('contracts: guards accept real shapes and reject garbage', async () => {
    assert.equal(contracts.isHello({ computerId: 'cmp_1' }), true)
    assert.equal(contracts.isHello({}), false)
    assert.equal(contracts.isExecRequest({ requestId: 'r', command: 'c' }), true)
    assert.equal(contracts.isExecRequest({ requestId: 'r' }), false)
    assert.equal(contracts.isChunkFrame({ requestId: 'r', seq: 0, type: 'stdout', data: 'x' }), true)
    assert.equal(contracts.isChunkFrame({ requestId: 'r', type: 'heartbeat', data: '' }), true)
    assert.equal(contracts.isChunkFrame({ requestId: 'r', seq: 0, stdout: 'a', stderr: '' }), true)
    assert.equal(contracts.isChunkFrame({ requestId: 'r', seq: 0, type: 'nope' }), false)
    assert.equal(contracts.isChunkFrame({ requestId: 42 }), false)
    assert.equal(contracts.isResultFrame({ requestId: 'r' }), true)
    assert.equal(contracts.isFsResult({ requestId: 'fsr' }), true)
    assert.equal(contracts.isFsRequest({ requestId: 'fsr', op: 'read' }), true)
    assert.equal(contracts.isFsRequest({ requestId: 'fsr' }), false)
    assert.equal(contracts.isCapability('pty'), true)
    assert.equal(contracts.isCapability('bogus'), false)
    assert.equal(contracts.isPlainObject([]), false)
  })

  await check('contracts: metadata header round trip and drift tolerance', async () => {
    const metadata = contracts.connectMetadata({
      agentVersion: '1.5.0',
      hostname: 'mac',
      os: 'darwin',
      arch: 'arm64',
      capabilities: ['exec', 'fs'],
      workspaceBase: '/Users/x',
      mode: 'embedded',
      caps: { exec: true, fs: true },
    })
    assert.equal(metadata.version, 1)
    assert.equal(metadata.mode, 'embedded')
    assert.deepEqual(metadata.caps, { exec: true, fs: true })
    const header = contracts.encodeMetadataHeader(metadata)
    assert.deepEqual(contracts.decodeMetadataHeader(header), metadata)
    assert.equal(contracts.decodeMetadataHeader('not-base64-json'), null)
    assert.equal(contracts.decodeMetadataHeader(''), null)
    assert.deepEqual(contracts.decodeMetadataHeader(['eyJ4IjoxfQ']), { x: 1 })
    // optional(object schema): unknown/absent fields are dropped, never fatal.
    const parser = contracts.optional({
      mode: (value) => (value === 'embedded' || value === 'service' ? value : undefined),
      workspaceBase: (value) => (typeof value === 'string' ? value : undefined),
    })
    assert.deepEqual(parser({ mode: 'service', workspaceBase: '/w', extra: 'ignored' }), { mode: 'service', workspaceBase: '/w' })
    assert.deepEqual(parser({ mode: 'bogus' }), {})
    assert.equal(parser(null), null)
    assert.deepEqual(contracts.pickKnown({ a: 1, b: 2, c: undefined }, ['a', 'c', 'd']), { a: 1 })
    const optString = contracts.optional((value) => (typeof value === 'string' ? value.trim() : undefined), 'fallback')
    assert.equal(optString(undefined), 'fallback')
    assert.equal(optString('  x '), 'x')
    assert.equal(optString(42), 'fallback')
  })

  await check('contracts: browser payload constructors match the served shapes', async () => {
    const state = contracts.statePayload({
      role: 'both',
      serverUrl: 'http://127.0.0.1:1',
      serverUrls: [],
      loopbackOnly: true,
      listener: { host: '127.0.0.1', port: 1, loopback: true },
      tunnel: { enabled: false, configured: false, url: '', targetPort: null, error: null },
      heartbeatMs: 20000,
      computers: [],
      pendingKey: null,
    })
    assert.deepEqual(Object.keys(state), ['version', 'role', 'serverUrl', 'serverUrls', 'loopbackOnly', 'listener', 'tunnel', 'heartbeatMs', 'computers', 'pendingKey'])
    assert.equal(state.version, 2)
    const keys = contracts.keysPayload({
      key: 'k', os: 'macos', expiresAt: 'e', serverUrl: 'u', serverUrls: [], loopbackOnly: true,
      listener: {}, command: 'c', windowsCommand: 'w', installUrl: 'i',
    })
    assert.deepEqual(Object.keys(keys), ['key', 'os', 'expiresAt', 'serverUrl', 'serverUrls', 'loopbackOnly', 'listener', 'command', 'windowsCommand', 'installUrl'])
    assert.deepEqual(contracts.keyStatusPayload({ status: 'waiting' }), { status: 'waiting', computer: null })
    assert.deepEqual(contracts.emptyStateDocument(), { version: 1, computers: [], pendingKeys: [] })
    assert.deepEqual(contracts.errorEnvelope('bad-request', 'nope'), { error: 'bad-request', message: 'nope' })
    assert.deepEqual(contracts.errorEnvelope('bad-request', 'nope', 'ctx'), { error: 'bad-request', message: 'nope', detail: 'ctx' })
    assert.equal(contracts.runtimeStatusPayload({ configured: false, enabled: false, connected: false, serverUrl: '', computerId: '', name: '', since: null, lastError: null }).configured, false)
    assert.deepEqual(contracts.enrollRequest({ key: 'k', agentVersion: '1', capabilities: ['exec'], metadata: {}, machine: {} }), { key: 'k', agentVersion: '1', capabilities: ['exec'], metadata: {}, machine: {} })
    assert.deepEqual(contracts.heartbeatBody({ meta: { agentVersion: '1' }, extra: { capabilities: ['exec'], bogus: 1 } }), { meta: { agentVersion: '1' }, capabilities: ['exec'] })
    assert.equal(contracts.AGENT_PATHS.CHUNK, '/agent/results/chunk')
  })
}

// ---------------------------------------------------------------------------
// Phase N — R2: caps-derived policy (lib/policy.js)
// ---------------------------------------------------------------------------

async function phaseN(root) {
  await check('policy: legacy caps derivation and normalization', async () => {
    assert.deepEqual(legacyCaps({ capabilities: ['exec', 'fs'] }), { exec: true, fs: true, jobs: true, pty: false, tunnel: false })
    assert.deepEqual(legacyCaps({}), { exec: true, fs: false, jobs: true, pty: false, tunnel: false })
    // Legacy derivation keeps pty/tunnel off even if a stale capability list mentions pty.
    assert.deepEqual(legacyCaps({ capabilities: ['exec', 'fs', 'pty'] }), { exec: true, fs: true, jobs: true, pty: false, tunnel: false })
    assert.equal(normalizeCaps('nope'), null)
    assert.equal(normalizeCaps(null), null)
    assert.deepEqual(normalizeCaps({ fs: true }), { exec: true, fs: true, jobs: false, pty: false, tunnel: false })
    assert.deepEqual(normalizeCaps({ exec: false, tunnel: true }), { exec: false, fs: false, jobs: false, pty: false, tunnel: true })
  })

  await check('policy: supports() is the single feature predicate', async () => {
    assert.equal(supports({ caps: { exec: true, fs: true, jobs: true, pty: false, tunnel: false } }, 'fs'), true)
    assert.equal(supports({ caps: { fs: true } }, 'jobs'), false, 'absent flag hides the feature')
    assert.equal(supports({ capabilities: ['exec', 'fs'] }, 'fs'), true, 'legacy derivation still answers')
    assert.equal(supports({ capabilities: [] }, 'pty'), false)
    assert.equal(supports({}, 'bogus'), false)
    assert.deepEqual(capsOf({ caps: { fs: true } }), { exec: true, fs: true, jobs: false, pty: false, tunnel: false })
    assert.deepEqual(capsOf({ capabilities: ['exec'] }), legacyCaps({ capabilities: ['exec'] }))
  })

  // R2: the version gate is an operator kill-switch only; with no minAgentVersion
  // an old agent is not blocked, and its reported/derived caps decide features.
  const dir = join(root, 'n')
  const token = mintSecret()
  const computerId = newComputerId()
  seedState(dir, {
    version: 1,
    computers: [
      seedComputer(computerId, 'Legacy Box', {
        tokenHash: sha256Hex(token),
        capabilities: ['exec'],
        agentVersion: '1.0.0',
      }),
    ],
    pendingKeys: [],
  })
  const app = await mount({ ...FAST_CONFIG, stateDir: dir })
  try {
    const origin = app.origin
    const sse = await openSse(origin, `${API}/agent/events`, { authorization: `Bearer ${token}` })
    try {
      await sse.nextEvent('hello', 2000)
      await check('policy: version gate is opt-in; caps decide features', async () => {
        const execTool = app.fake.tools.get('computer_exec')
        const pending = execTool.execute({ computer: 'Legacy Box', command: 'echo legacy' }, { agent: { id: 'sess_n' } })
          .then((value) => ({ value }), (error) => ({ error }))
        const event = await sse.nextEvent('exec', 3000)
        assert.equal(event.data.command, 'echo legacy', 'an old agent is not version-blocked when no minimum is configured')
        await raw(origin, `${API}/agent/results`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: event.data.requestId, ok: true, exitCode: 0, signal: null,
            stdout: 'legacy\n', stderr: '', durationMs: 1, truncated: false, timedOut: false, error: null,
          }),
        })
        const settled = await pending
        assert.ok(settled.value, settled.error && settled.error.message)
        assert.equal(settled.value.stdout, 'legacy\n')
        const listTool = app.fake.tools.get('computer_list')
        const value = await listTool.execute({}, { agent: { id: 'sess_n' } })
        assert.deepEqual(value.computers[0].caps, { exec: true, fs: false, jobs: true, pty: false, tunnel: false })
        assert.equal(value.computers[0].agentVersion, '1.0.0')
        assert.equal(value.computers[0].updateRequired, false, 'no forced upgrade without minAgentVersion')
        assert.equal(value.computers[0].caps.pty, false)
        assert.equal(settled.value.ok, true, 'pty:false hides nothing that worked before')
      })

      await check('policy: a capability absent from caps is refused and named', async () => {
        const readTool = app.fake.tools.get('computer_read')
        const settled = await readTool.execute({ computer: 'Legacy Box', path: '/tmp/x' }, { agent: { id: 'sess_n' } })
          .then((value) => ({ value }), (error) => ({ error }))
        assert.ok(settled.error)
        assert.match(settled.error.message, /'fs' capability is missing/)
        assert.match(settled.error.message, /"fs":false/)
        assert.match(settled.error.message, /does not support remote file access/)
      })
    } finally {
      sse.close()
    }
  } finally {
    await app.close()
  }
}

// ---------------------------------------------------------------------------
// Phase O — R3: typed terminal states + honest cancellation
// ---------------------------------------------------------------------------

async function phaseO(root) {
  const dir = join(root, 'o')
  const computerId = newComputerId()
  const token = mintSecret()
  seedState(dir, {
    version: 1,
    computers: [seedComputer(computerId, 'R3 Box', {
      tokenHash: sha256Hex(token),
      capabilities: ['exec', 'jobs'],
      caps: { exec: true, fs: false, jobs: true, pty: false, tunnel: false },
      agentVersion: PLUGIN_VERSION,
    })],
    pendingKeys: [],
  })
  const app = await mount({ ...FAST_CONFIG, stateDir: dir, execTimeoutMs: 400, promoteOnTimeout: true })
  const jobs = createFakeJobs()
  app.fake.setService('jobs', jobs)
  const sseClients = []
  const session = { id: 'sess_o', session: { id: 'sess_o' } }
  try {
    const origin = app.origin
    const sse = await openSse(origin, `${API}/agent/events`, { authorization: `Bearer ${token}` })
    sseClients.push(sse)
    await sse.nextEvent('hello', 2000)
    const execTool = app.fake.tools.get('computer_exec')
    const postResult = (body) => raw(origin, `${API}/agent/results`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const finalResult = (requestId, result) => postResult({
      requestId, ok: true, exitCode: 0, signal: null, stdout: '', stderr: '',
      durationMs: 5, truncated: false, timedOut: false, error: null, ...result,
    })
    const runForeground = async (command) => {
      const pending = execTool.execute({ computer: 'R3 Box', command }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      const event = await sse.nextEvent('exec', 3000)
      return { pending, event }
    }

    await check('terminal: a successful execution is completed/reusable and renders byte-identically', async () => {
      const { pending, event } = await runForeground('ok')
      await finalResult(event.data.requestId, { stdout: 'done\n' })
      const settled = await pending
      assert.ok(settled.value, settled.error && settled.error.message)
      assert.deepEqual(settled.value.terminal, {
        status: contracts.EXECUTION_STATUS.COMPLETED,
        disposition: contracts.DISPOSITION.REUSABLE,
        confirmed: true,
        exitCode: 0,
        signal: null,
        error: null,
      })
      // No extra status line for a clean success: the render is unchanged.
      assert.equal(execTool.output.render({}, settled.value)[0].text, '$ ok\nexit 0 · 5ms · R3 Box\n\ndone')
    })

    await check('terminal: a failing command is failed/reusable', async () => {
      const { pending, event } = await runForeground('fail')
      await finalResult(event.data.requestId, { ok: false, exitCode: 2, error: 'boom', stdout: '', stderr: 'boom\n' })
      const settled = await pending
      assert.ok(settled.value, settled.error && settled.error.message)
      assert.equal(settled.value.terminal.status, contracts.EXECUTION_STATUS.FAILED)
      assert.equal(settled.value.terminal.disposition, contracts.DISPOSITION.REUSABLE)
      assert.equal(settled.value.terminal.confirmed, true)
      assert.equal(settled.value.terminal.exitCode, 2)
      assert.match(execTool.output.render({}, settled.value)[0].text, /status: failed/)
    })

    await check('terminal: an agent-reported timeout is timeout/reusable', async () => {
      const { pending, event } = await runForeground('slow')
      await finalResult(event.data.requestId, { ok: false, exitCode: null, signal: 'SIGKILL', timedOut: true })
      const settled = await pending
      assert.ok(settled.value, settled.error && settled.error.message)
      assert.equal(settled.value.terminal.status, contracts.EXECUTION_STATUS.TIMEOUT)
      assert.equal(settled.value.terminal.disposition, contracts.DISPOSITION.REUSABLE)
      const text = execTool.output.render({}, settled.value)[0].text
      assert.match(text, /status: timeout · confirmed/)
    })

    await check('terminal: a cancelled background job that reports back is confirmed', async () => {
      const background = await execTool.execute({ computer: 'R3 Box', command: 'kill-confirmed', run_in_background: true }, { agent: session })
      const record = jobs.records.get(background.jobId)
      assert.ok(record)
      const event = await sse.nextEvent('exec', 3000)
      assert.equal(jobs.kill(background.jobId), 'requested')
      await sse.nextEvent('cancel', 3000)
      // The agent acknowledges within the grace window with a final result.
      await finalResult(event.data.requestId, { ok: false, exitCode: null, signal: 'SIGTERM' })
      const done = await record.hooks.done
      assert.equal(done.status, contracts.JOB_STATUS.KILLED)
      assert.equal(done.result.status, contracts.EXECUTION_STATUS.CANCELLED)
      assert.equal(done.result.confirmed, true, 'a final result after cancel is a confirmed stop')
      assert.equal(done.result.disposition, contracts.DISPOSITION.REUSABLE)
      assert.equal(done.result.signal, 'SIGTERM')
      assert.match(done.detail, /confirmed/)
    })

    await check('terminal: a cancelled job that never reports back is broken, not "cancelled"', async () => {
      const background = await execTool.execute({ computer: 'R3 Box', command: 'kill-silent', run_in_background: true }, { agent: session })
      const record = jobs.records.get(background.jobId)
      const event = await sse.nextEvent('exec', 3000)
      assert.equal(jobs.kill(background.jobId), 'requested')
      await sse.nextEvent('cancel', 3000)
      // Grace expires (~5 s) with no final result from the agent.
      const done = await record.hooks.done
      assert.equal(done.status, contracts.JOB_STATUS.KILLED)
      assert.equal(done.result.status, contracts.EXECUTION_STATUS.CANCELLED)
      assert.equal(done.result.confirmed, false, 'never claim a stop we did not confirm')
      assert.equal(done.result.disposition, contracts.DISPOSITION.BROKEN)
      assert.match(done.result.error, /may still be running/)
      assert.match(done.detail, /NOT confirmed/)
      assert.equal(event.data.command, 'kill-silent')
    })

    await check('terminal: a stream drop mid-command is failed/broken', async () => {
      const background = await execTool.execute({ computer: 'R3 Box', command: 'drop-me', run_in_background: true }, { agent: session })
      const record = jobs.records.get(background.jobId)
      await sse.nextEvent('exec', 3000)
      sse.close()
      const done = await record.hooks.done
      assert.equal(done.status, contracts.JOB_STATUS.FAILED)
      assert.equal(done.result.status, contracts.EXECUTION_STATUS.FAILED)
      assert.equal(done.result.disposition, contracts.DISPOSITION.BROKEN)
      assert.match(done.result.error, /offline|lost/)
      assert.match(done.detail, /broken/)
      // Too late to cancel: the job is already finished.
      assert.equal(jobs.kill(background.jobId), 'already-finished')
    })

    await check('terminal: render names broken state and what may still be running', async () => {
      const value = {
        computer: { id: computerId, name: 'R3 Box' },
        command: 'orphan',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 12,
        ok: false,
        timedOut: false,
        truncated: false,
        terminal: {
          status: contracts.EXECUTION_STATUS.CANCELLED,
          disposition: contracts.DISPOSITION.BROKEN,
          confirmed: false,
          exitCode: null,
          signal: null,
          error: 'cancellation not confirmed',
        },
      }
      const text = execTool.output.render({}, value)[0].text
      assert.match(text, /status: cancelled · NOT confirmed · broken — the command may still be running on the machine/)
    })
  } finally {
    for (const client of sseClients) client.close()
    await app.close()
  }
}

// ---------------------------------------------------------------------------
// Phase P — R4: exhaustive permission table + single authorize() gate
// ---------------------------------------------------------------------------

async function phaseP(root) {
  await check('permissions: the operation table is frozen and exhaustive', async () => {
    assert.deepEqual([...OPERATIONS], [
      'exec', 'exec.background', 'cancel', 'read', 'write', 'edit', 'glob', 'grep', 'fs.request', 'list',
    ])
    assert.ok(Object.isFrozen(OPERATIONS))
    assert.ok(Object.isFrozen(OPERATION_REQUIREMENTS))
    assert.deepEqual(Object.keys(OPERATION_REQUIREMENTS).sort(), [...OPERATIONS].sort())
    const fields = ['access', 'activation', 'description', 'feature', 'hostGate', 'jobsService', 'label', 'operatorGate', 'presence']
    for (const op of OPERATIONS) {
      const rule = OPERATION_REQUIREMENTS[op]
      assert.ok(Object.isFrozen(rule), `${op} rule is frozen`)
      assert.deepEqual(Object.keys(rule).sort(), fields, `${op} has the exhaustive field set`)
      assert.ok(rule.feature === null || contracts.CAPABILITIES.includes(rule.feature), `${op} feature is a declared capability`)
    }
    assert.equal(assertOperationTable(), true)
    // A rule cannot be added or replaced at runtime.
    assert.throws(() => { OPERATION_REQUIREMENTS['new.op'] = { ...OPERATION_REQUIREMENTS.list } }, TypeError)
    assert.equal(DENY_CODES.SESSION_DENIED, 'session-denied')
    assert.ok(Object.isFrozen(DENY_CODES))
  })

  await check('permissions: every registered tool maps to a declared operation', async () => {
    assert.deepEqual(Object.keys(TOOL_OPERATIONS).sort(), [
      'computer_edit', 'computer_exec', 'computer_glob', 'computer_grep',
      'computer_list', 'computer_read', 'computer_write',
    ])
    for (const [tool, mapped] of Object.entries(TOOL_OPERATIONS)) {
      for (const op of Array.isArray(mapped) ? mapped : [mapped]) {
        assert.ok(OPERATIONS.includes(op), `${tool} maps to declared operation ${op}`)
      }
    }
    assert.equal(assertToolsExhaustive(Object.keys(TOOL_OPERATIONS)), true)
    assert.throws(() => assertToolsExhaustive(['computer_exec', 'mystery_tool']), /does not cover every tool: unmapped \[mystery_tool\]/)
  })

  // A fake access control with overridable rules (the real one is mounted below).
  const accessStub = ({ sessionAllows = () => true, presetAllows = () => true } = {}) => ({ sessionAllows, presetAllows })
  const baseComputer = {
    id: 'cmp_policy',
    name: 'Policy Box',
    activatedAt: '2026-01-01T00:00:00.000Z',
    agentVersion: PLUGIN_VERSION,
    caps: { exec: true, fs: true, jobs: true, pty: false, tunnel: false },
    mode: 'embedded',
  }
  const policy = createPolicy({ config: { execEnabled: true, minAgentVersion: '' }, isOnline: () => true, hasJobs: () => true })
  const session = { sessionId: 'sess_policy', presetId: 'default' }

  await check('permissions: a fully capable, allowed, online computer can do every operation', async () => {
    for (const operation of OPERATIONS) {
      const decision = policy.authorize({ computer: baseComputer, operation, session, access: accessStub() })
      assert.deepEqual(decision, { allowed: true }, `${operation} allowed`)
    }
  })

  await check('permissions: a missing capability denies exactly the operations that need it', async () => {
    const noCaps = { ...baseComputer, caps: { exec: false, fs: false, jobs: false, pty: false, tunnel: false } }
    for (const operation of OPERATIONS) {
      const rule = OPERATION_REQUIREMENTS[operation]
      const decision = policy.authorize({ computer: noCaps, operation, session, access: accessStub() })
      if (rule.feature === null) {
        assert.equal(decision.allowed, true, `${operation} has no capability requirement`)
      } else {
        assert.equal(decision.allowed, false, `${operation} must be denied`)
        assert.equal(decision.code, DENY_CODES.CAPABILITY_MISSING)
        assert.match(decision.reason, /capability rule/)
        assert.match(decision.reason, new RegExp(`'${rule.feature}' capability is missing`))
      }
    }
  })

  await check('permissions: an ACL-denied session cannot reach any operation', async () => {
    const deniedSession = accessStub({ sessionAllows: () => false })
    for (const operation of OPERATIONS) {
      const decision = policy.authorize({ computer: baseComputer, operation, session, access: deniedSession })
      assert.equal(decision.allowed, false, `${operation} denied for the session`)
      assert.equal(decision.code, DENY_CODES.SESSION_DENIED)
      assert.match(decision.reason, /session allow-list/)
      assert.match(decision.reason, /not accessible to this conversation/)
      assert.match(decision.reason, /管理访问权/)
    }
  })

  await check('permissions: a preset rule denies exactly the blocked preset', async () => {
    const blockedPreset = accessStub({ presetAllows: (computerId, presetId) => presetId !== 'blocked' })
    for (const operation of OPERATIONS) {
      const denied = policy.authorize({ computer: baseComputer, operation, session: { sessionId: 's', presetId: 'blocked' }, access: blockedPreset })
      assert.equal(denied.allowed, false, `${operation} denied for the blocked preset`)
      assert.equal(denied.code, DENY_CODES.PRESET_DENIED)
      assert.match(denied.reason, /preset rule/)
      assert.match(denied.reason, /Agent preset 'blocked'/)
      const allowed = policy.authorize({ computer: baseComputer, operation, session: { sessionId: 's', presetId: 'allowed' }, access: blockedPreset })
      assert.equal(allowed.allowed, true, `${operation} allowed for another preset`)
    }
  })

  await check('permissions: every deny code is reachable and names the blocking rule', async () => {
    const noHost = createPolicy({ config: { execEnabled: false }, isOnline: () => true, hasJobs: () => true })
    for (const operation of ['exec', 'exec.background']) {
      const decision = noHost.authorize({ computer: baseComputer, operation, session, access: accessStub() })
      assert.equal(decision.code, DENY_CODES.HOST_DISABLED)
      assert.match(decision.reason, /disabled on this host/)
    }
    assert.equal(noHost.authorize({ computer: baseComputer, operation: 'read', session, access: accessStub() }).allowed, true)

    const gated = createPolicy({ config: { minAgentVersion: '9.9' }, isOnline: () => true, hasJobs: () => true })
    const version = gated.authorize({ computer: baseComputer, operation: 'exec', session, access: accessStub() })
    assert.equal(version.code, DENY_CODES.VERSION_BELOW_MINIMUM)
    assert.match(version.reason, /operator version gate/)
    assert.match(version.reason, /older than the required/)
    assert.match(version.reason, /设置 → 插件市场|重新运行安装命令/)

    const noJobs = createPolicy({ config: {}, isOnline: () => true, hasJobs: () => false })
    const jobs = noJobs.authorize({ computer: baseComputer, operation: 'exec.background', session, access: accessStub() })
    assert.equal(jobs.code, DENY_CODES.JOBS_UNAVAILABLE)
    assert.match(jobs.reason, /jobs registry is not loaded/)
    assert.equal(noJobs.authorize({ computer: baseComputer, operation: 'exec', session, access: accessStub() }).allowed, true)

    const inactive = { ...baseComputer, activatedAt: null }
    const notActivated = policy.authorize({ computer: inactive, operation: 'read', session, access: accessStub() })
    assert.equal(notActivated.code, DENY_CODES.NOT_ACTIVATED)
    assert.match(notActivated.reason, /activation rule/)
    assert.equal(policy.authorize({ computer: inactive, operation: 'list', session, access: accessStub() }).allowed, true)

    const offlinePolicy = createPolicy({ config: {}, isOnline: () => false, hasJobs: () => true })
    const offline = offlinePolicy.authorize({ computer: baseComputer, operation: 'read', session, access: accessStub() })
    assert.equal(offline.code, DENY_CODES.OFFLINE)
    assert.match(offline.reason, /presence rule/)
    assert.equal(offlinePolicy.authorize({ computer: baseComputer, operation: 'list', session, access: accessStub() }).allowed, true)

    assert.equal(policy.authorize({ computer: baseComputer, operation: 'pty.open', session, access: accessStub() }).code, DENY_CODES.UNKNOWN_OPERATION)
    assert.equal(policy.authorize({ computer: null, operation: 'read', session, access: accessStub() }).code, DENY_CODES.COMPUTER_UNKNOWN)
  })

  // --- integration: tools go through the authority and nothing else ----------
  const dir = join(root, 'p')
  const fsToken = mintSecret()
  const fsComputerId = newComputerId()
  const offlineToken = mintSecret()
  const offlineComputerId = newComputerId()
  const execToken = mintSecret()
  const execComputerId = newComputerId()
  seedState(dir, {
    version: 1,
    computers: [
      seedComputer(fsComputerId, 'No FS Policy Box', {
        tokenHash: sha256Hex(fsToken), capabilities: ['exec'],
        caps: { exec: true, fs: false, jobs: false, pty: false, tunnel: false }, agentVersion: PLUGIN_VERSION,
      }),
      seedComputer(offlineComputerId, 'Offline Policy Box', {
        tokenHash: sha256Hex(offlineToken), capabilities: ['exec'],
        caps: { exec: true, fs: true, jobs: true, pty: false, tunnel: false }, agentVersion: PLUGIN_VERSION,
      }),
      seedComputer(execComputerId, 'Exec Policy Box', {
        tokenHash: sha256Hex(execToken), capabilities: ['exec', 'jobs'],
        caps: { exec: true, fs: false, jobs: true, pty: false, tunnel: false }, agentVersion: PLUGIN_VERSION,
      }),
    ],
    pendingKeys: [],
  })
  const app = await mount({ ...FAST_CONFIG, stateDir: dir })
  const sseClients = []
  try {
    const origin = app.origin
    const execSse = await openSse(origin, `${API}/agent/events`, { authorization: `Bearer ${execToken}` })
    sseClients.push(execSse)
    await execSse.nextEvent('hello', 2000)
    const sessionP = { id: 'sess_p', session: { id: 'sess_p' } }

    await check('permissions: tools surface the deny code from the authority', async () => {
      const readTool = app.fake.tools.get('computer_read')
      const denied = await readTool.execute({ computer: 'No FS Policy Box', path: '/tmp/x' }, { agent: sessionP })
        .then((value) => ({ value }), (error) => ({ error }))
      assert.ok(denied.error)
      assert.equal(denied.error.code, DENY_CODES.CAPABILITY_MISSING, 'capability denial carries the code')
      assert.match(denied.error.message, /capability rule/)

      const offlineTool = await readTool.execute({ computer: 'Offline Policy Box', path: '/tmp/x' }, { agent: sessionP })
        .then((value) => ({ value }), (error) => ({ error }))
      assert.ok(offlineTool.error)
      assert.equal(offlineTool.error.code, DENY_CODES.OFFLINE)
      assert.match(offlineTool.error.message, /offline/)

      // ACL: deny every computer for this session, then the same tool call.
      const acl = await call(origin, `${API}/access`, {
        method: 'POST',
        body: { sessionId: 'sess_p_denied', allowedComputers: [] },
      })
      assert.equal(acl.status, 200)
      const sessionDenied = { id: 'sess_p_denied', session: { id: 'sess_p_denied' } }
      const execTool = app.fake.tools.get('computer_exec')
      const deniedExec = await execTool.execute({ computer: 'Exec Policy Box', command: 'echo hi' }, { agent: sessionDenied })
        .then((value) => ({ value }), (error) => ({ error }))
      assert.ok(deniedExec.error)
      assert.equal(deniedExec.error.code, DENY_CODES.SESSION_DENIED)
      assert.match(deniedExec.error.message, /管理访问权/)

      // The same call is allowed once the session rule is reset.
      await call(origin, `${API}/access`, {
        method: 'POST',
        body: { sessionId: 'sess_p_denied', allowedComputers: null },
      })
      const allowedExec = execTool.execute({ computer: 'Exec Policy Box', command: 'echo hi' }, { agent: sessionDenied })
        .then((value) => ({ value }), (error) => ({ error }))
      const event = await execSse.nextEvent('exec', 3000)
      await raw(origin, `${API}/agent/results`, {
        method: 'POST',
        headers: { authorization: `Bearer ${execToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: event.data.requestId, ok: true, exitCode: 0, signal: null,
          stdout: 'hi\n', stderr: '', durationMs: 1, truncated: false, timedOut: false, error: null,
        }),
      })
      const settled = await allowedExec
      assert.ok(settled.value, settled.error && settled.error.message)
    })

    await check('permissions: tools.js contains no inline capability/ACL/version gates', async () => {
      const source = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
      for (const banned of ['supports(', 'requireCapability(', 'requireCurrentAgent(', 'callerAllowed', 'gateTarget', 'access.isAllowed', 'sessionAllows(', 'presetAllows(', 'denialMessage', 'upgradeHint']) {
        assert.equal(source.includes(banned), false, `tools.js must not contain '${banned}' (the authority owns it)`)
      }
      assert.ok((source.match(/authorizeOp\(/g) ?? []).length >= 6, 'every gated tool goes through authorizeOp')
      assert.ok((source.match(/policy\.authorize\(/g) ?? []).length >= 1, 'the job cancel path uses policy.authorize too')
      // Every registered tool is in the table (load-time check already ran; prove it here).
      assert.equal(assertToolsExhaustive([...app.fake.tools.keys()]), true)
    })
  } finally {
    for (const client of sseClients) client.close()
    await app.close()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const watchdog = setTimeout(() => {
  console.error('FAIL host-smoke: global timeout (60s)')
  process.exit(1)
}, 60_000)

/**
 * Phase Q — R5b: presence is an application lease, not "the socket is open".
 *
 * The hub is built with an injected clock and a 45 s lease, so the sweep can be
 * advanced by moving the clock instead of sleeping.
 */
async function phaseQ(root) {
  const dir = join(root, 'q')
  const computerId = newComputerId()
  const token = mintSecret()
  seedState(dir, {
    version: 1,
    computers: [seedComputer(computerId, 'Lease Box', {
      tokenHash: sha256Hex(token),
      capabilities: ['exec'],
      caps: { exec: true, fs: false, jobs: false, pty: false, tunnel: false },
      agentVersion: PLUGIN_VERSION,
    })],
    pendingKeys: [],
  })
  let clock = Date.now()
  const app = await mount(
    { ...FAST_CONFIG, stateDir: dir },
    { hubDeps: { now: () => clock, leaseMs: 45_000, leaseCheckMs: 0 } },
  )
  const sseClients = []
  const session = { id: 'sess_q', session: { id: 'sess_q' } }
  const heartbeat = (body) => raw(app.origin, `${API}/agent/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const listOnline = async () => {
    const state = await call(app.origin, `${API}/state`)
    const entry = state.data.computers.find((computer) => computer.id === computerId)
    return entry
  }
  try {
    await check('lease: a silent but open stream goes offline once the lease runs out', async () => {
      const sse = await openSse(app.origin, `${API}/agent/events`, { authorization: `Bearer ${token}` })
      sseClients.push(sse)
      await sse.nextEvent('hello', 2000)
      const fresh = await listOnline()
      assert.equal(fresh.online, true)
      assert.equal(typeof fresh.leaseExpiresAt, 'number')
      assert.equal(fresh.leaseExpiresAt, clock + 45_000)

      // No validated frame for longer than the lease: still connected, not online.
      clock += 45_001
      const state = await call(app.origin, `${API}/state`)
      const entry = state.data.computers.find((computer) => computer.id === computerId)
      assert.equal(entry.online, false, 'a silent stream must not count as presence')
      assert.equal(entry.leaseExpiresAt, null)
      // The sweep retires the stream on the next read attempt; presence is what
      // matters and it is already false above.
    })

    await check('lease: a heartbeat keeps the computer online', async () => {
      const sse = await openSse(app.origin, `${API}/agent/events`, { authorization: `Bearer ${token}` })
      sseClients.push(sse)
      await sse.nextEvent('hello', 2000)
      // 40 s of silence would be fine, then a heartbeat pushes the deadline out.
      clock += 40_000
      const beat = await heartbeat({})
      assert.equal(beat.status, 200)
      const entry = await listOnline()
      assert.equal(entry.online, true)
      assert.equal(entry.leaseExpiresAt, clock + 45_000)
    })

    await check('lease: a chunk POST alone refreshes presence', async () => {
      // Chunks are validated inbound frames too, so a long streaming command
      // keeps the machine online without any heartbeat.
      clock += 40_000
      const event = await (async () => {
        const execTool = app.fake.tools.get('computer_exec')
        void execTool.execute({ computer: 'Lease Box', command: 'echo lease' }, { agent: session }).catch(() => {})
        return await sseClients.at(-1).nextEvent('exec', 3000)
      })()
      const chunk = await raw(app.origin, `${API}/agent/results/chunk`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: event.data.requestId, seq: 0, type: 'stdout', data: Buffer.from('lease\n').toString('base64') }),
      })
      assert.equal(chunk.status, 200)
      const entry = await listOnline()
      assert.equal(entry.online, true)
      assert.equal(entry.leaseExpiresAt, clock + 45_000)
      // Let the foreground execution settle so the next case starts clean.
      await raw(app.origin, `${API}/agent/results`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: event.data.requestId, ok: true, exitCode: 0, signal: null,
          stdout: 'lease\n', stderr: '', durationMs: 3, truncated: false, timedOut: false, error: null,
        }),
      })
    })

    await check('lease: a late heartbeat after expiry re-registers with a fresh lease', async () => {
      clock += 46_000
      assert.equal((await listOnline()).online, false)
      const sse = await openSse(app.origin, `${API}/agent/events`, { authorization: `Bearer ${token}` })
      sseClients.push(sse)
      await sse.nextEvent('hello', 2000)
      const entry = await listOnline()
      assert.equal(entry.online, true)
      assert.equal(entry.leaseExpiresAt, clock + 45_000)
      const beat = await heartbeat({})
      assert.equal(beat.status, 200)
      assert.equal((await listOnline()).online, true)
    })

    await check('lease: an offline computer is refused by the exec tool', async () => {
      clock += 46_000
      const execTool = app.fake.tools.get('computer_exec')
      const settled = await execTool.execute({ computer: 'Lease Box', command: 'echo nope' }, { agent: session })
        .then((value) => ({ value }), (error) => ({ error }))
      assert.ok(settled.error, 'an expired lease must refuse execution')
      assert.match(settled.error.message, /offline/i)
    })
  } finally {
    for (const sse of sseClients) {
      try {
        sse.close()
      } catch {
        // already gone
      }
    }
    await app.close()
  }
}


/**
 * Phase R — R6: probe before use, cool a failed route down, keep identity tied
 * to the computer record rather than to an address.
 */
async function phaseR(root) {
  const dir = join(root, 'r')
  const computerId = newComputerId()
  const token = mintSecret()
  seedState(dir, {
    version: 1,
    computers: [seedComputer(computerId, 'Route Box', {
      tokenHash: sha256Hex(token),
      capabilities: ['exec'],
      caps: { exec: true, fs: false, jobs: false, pty: false, tunnel: false },
      agentVersion: PLUGIN_VERSION,
    })],
    pendingKeys: [],
  })
  const ctxOf = (host) => ({
    webServer: { host, port: 49749, protocol: 'http:', getOrigin: () => `http://127.0.0.1:${49749}` },
  })
  const reqOf = () => ({ headers: { host: '127.0.0.1:49749' } })
  const deps = {
    probeTailscale: async () => '100.121.33.106',
    interfaces: {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.168.8.198', family: 'IPv4', internal: false }],
    },
    hostname: 'desk.local',
  }
  const app = await mount({ ...FAST_CONFIG, stateDir: dir }, { webServerHost: '100.121.33.106' })
  try {
    await check('routes: a probe records ok/failed and honours the cooldown', async () => {
      resetRouteHealth()
      let clock = 1_000_000
      const now = () => clock
      let healthy = true
      const probe = async (url) => (healthy
        ? { ok: true, status: 200, ms: 3, error: null }
        : { ok: false, status: 0, ms: 4, error: 'connect ECONNREFUSED' })
      const candidates = [
        { url: 'https://a.example', reachable: true },
        { url: 'https://b.example', reachable: true },
      ]

      await refreshRouteHealth(candidates, { probe, now })
      let annotated = annotateRouteHealth(candidates, { now })
      assert.deepEqual(annotated.map((item) => item.health.state), ['ok', 'ok'])
      assert.equal(annotated[0].health.checkedAt, clock)
      assert.equal(annotated[0].health.cooldownUntil, null)

      // A failure marks the route failed and starts the cooldown.
      healthy = false
      clock += 400_000 // past the recheck window, so it is due again
      await refreshRouteHealth(candidates, { probe, now })
      annotated = annotateRouteHealth(candidates, { now })
      assert.deepEqual(annotated.map((item) => item.health.state), ['failed', 'failed'])
      assert.equal(annotated[0].health.failures, 1)
      assert.equal(annotated[0].health.cooldownUntil, clock + ROUTE_COOLDOWN_MS)

      // Inside the cooldown it is NOT probed again, even when due by age.
      let probes = 0
      const countingProbe = async () => {
        probes += 1
        return { ok: true, status: 200, ms: 1, error: null }
      }
      clock += 1_000
      await refreshRouteHealth(candidates, { probe: countingProbe, now })
      assert.equal(probes, 0, 'a route in cooldown must not be re-probed')

      // After the cooldown it is probed again and can recover.
      clock += ROUTE_COOLDOWN_MS + 1
      await refreshRouteHealth(candidates, { probe: countingProbe, now })
      assert.equal(probes, 2)
      annotated = annotateRouteHealth(candidates, { now })
      assert.deepEqual(annotated.map((item) => item.health.state), ['ok', 'ok'])
      assert.equal(annotated[0].health.failures, 0)
    })

    await check('routes: a failed route stops being recommended, the next one takes over', async () => {
      resetRouteHealth()
      const clock = 2_000_000
      const now = () => clock
      // Only the Tailscale route answers; then it stops answering.
      let tailscaleOk = true
      const probe = async (url) => {
        const ok = url.includes('hub.example.com') ? tailscaleOk : true
        return ok ? { ok: true, status: 200, ms: 2, error: null } : { ok: false, status: 0, ms: 2, error: 'refused' }
      }
      // Desktop bind with a configured publicUrl (a tunnel/proxy): the public
      // route is the preferred one while it answers, and loses the slot when it
      // stops answering, falling back to the loopback route.
      const options = {
        ctx: ctxOf('127.0.0.1'),
        config: { publicUrl: 'https://hub.example.com', preferAddress: 'auto' },
        req: reqOf(),
        probe,
        now,
      }

      await refreshRouteHealth(await collectServerUrls(options), { probe, now })
      const first = await resolveAddressPayload(options)
      assert.equal(first.serverUrl, 'https://hub.example.com')
      assert.equal(first.serverUrls.find((item) => item.kind === 'public').health.state, 'ok')

      tailscaleOk = false // now the public probe refuses
      await refreshRouteHealth(await collectServerUrls(options), { probe, now: () => clock + 400_000 })
      const second = await resolveAddressPayload({ ...options, now: () => clock + 400_000 })
      const publicRoute = second.serverUrls.find((item) => item.kind === 'public')
      assert.equal(publicRoute.health.state, 'failed')
      assert.equal(publicRoute.recommended, false, 'a failed route must not stay recommended')
      assert.equal(second.serverUrl, 'http://127.0.0.1:49749', 'the next usable route takes over')
    })

    await check('routes: a probe that never answers is a failure, not a hang', async () => {
      resetRouteHealth()
      const startedAt = Date.now()
      const outcome = await probeRoute('http://127.0.0.1:9', {
        timeoutMs: 150,
        fetchImpl: (url, init) => new Promise((resolve, reject) => {
          // Reject on abort exactly like fetch does.
          if (init?.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }),
      })
      assert.equal(outcome.ok, false)
      assert.match(outcome.error, /timeout after 150ms/)
      assert.ok(Date.now() - startedAt < 2_000, 'the probe must give up on its own budget')
    })

    await check('routes: /state carries route health and identity is the record, not the address', async () => {
      resetRouteHealth()
      const before = await call(app.origin, `${API}/state`)
      const entry = before.data.computers.find((computer) => computer.id === computerId)
      assert.ok(entry, 'the computer is listed')
      const idsBefore = before.data.computers.map((computer) => computer.id)
      for (const candidate of before.data.serverUrls) {
        assert.ok(['unknown', 'ok', 'failed'].includes(candidate.health.state), 'health.state is exposed')
        assert.equal(typeof candidate.health.failures, 'number')
        assert.ok(candidate.health.checkedAt === null || typeof candidate.health.checkedAt === 'number')
        assert.ok(candidate.health.cooldownUntil === null || typeof candidate.health.cooldownUntil === 'number')
      }
      // Identity: changing the advertised address changes no computer id.
      const idsAfter = before.data.computers.map((computer) => computer.id)
      assert.deepEqual(idsAfter, idsBefore)
      assert.equal(entry.id, computerId, 'the id comes from the record, never from a route')
      assert.equal(entry.tokenHash === undefined, true, 'the record keeps its secret out of /state')
      const keys = await call(app.origin, `${API}/keys`, { method: 'POST', body: { os: 'macos' } })
      assert.ok(keys.data.serverUrls.every((candidate) => candidate.health !== undefined))
      assert.equal(keys.data.serverUrl, before.data.serverUrl, '/keys and /state agree on the route')
    })

    await check('routes: chooseRoute never picks a cooling route', async () => {
      const now = () => 5_000_000
      const list = annotateRouteHealth([
        { url: 'https://cool.example', kind: 'public', label: '公网', reachable: true, recommended: true },
        { url: 'https://warm.example', kind: 'lan', label: '局域网', reachable: true, recommended: false },
      ], { now })
      // Simulate a cooldown on the preferred route.
      list[0].health.cooldownUntil = 5_000_000 + 1_000
      assert.equal(chooseRoute(list).url, 'https://warm.example')
      list[1].health.cooldownUntil = 5_000_000 + 1_000
      assert.equal(chooseRoute(list), null, 'all routes cooling means no recommendation')
    })
  } finally {
    await app.close()
  }
}

// ---------------------------------------------------------------------------
// Phase S — relay host wiring (v1.6.0, docs/relay-design.md §5/§6.2/§10)
// ---------------------------------------------------------------------------

/** The documented `/state.relay` shape when relay is off (or no manager). */
const RELAY_OFF = Object.freeze({
  enabled: false,
  configured: false,
  hubId: '',
  url: '',
  publicUrl: '',
  state: 'disabled',
  connectedAt: null,
  lastError: null,
  streams: 0,
})

/** The relay service this build targets. */
const RELAY_URL = 'wss://dsh-relay.nextai.show'

/** A minted hubId: `hub_` + 32 hex characters (16 random bytes). */
const HUB_ID_SHAPE = /^hub_[0-9a-f]{32}$/

/**
 * A fake hub-link: no socket, no relay process. It records the options the
 * manager dialled with and lets a test drive the state machine the manager
 * polls, so `/state.relay` is assertable end to end.
 */
function createFakeHubLink() {
  const status = { state: 'connecting', connectedAt: null, lastError: null, streams: { open: 0 } }
  const link = {
    options: {},
    started: 0,
    stopped: 0,
    handlers: [],
    start() {
      link.started += 1
      return link
    },
    stop() {
      link.stopped += 1
      status.state = 'closed'
      status.connectedAt = null
    },
    onStream(handler) {
      link.handlers.push(handler)
      return () => {}
    },
    status() {
      return { ...status, streams: { ...status.streams } }
    },
    set(patch) {
      Object.assign(status, patch)
      return link
    },
  }
  return link
}

/** A relayDeps seam that hands the manager one fake link. */
function fakeRelayDeps(link) {
  return {
    createHubLink(options) {
      link.options = options
      return link
    },
  }
}

/** GET /state and return only the relay block. */
async function relayOf(origin) {
  return (await call(origin, `${API}/state`)).data.relay
}

async function phaseS(root) {
  await check('relay: config validation (object/boolean, url, limits, frozen)', async () => {
    assert.deepEqual(resolveConfig({}).relay, { enabled: false, url: '', publicUrl: '', accessKey: '', hubId: '', name: '' })
    assert.equal(resolveConfig({ relay: false }).relay.enabled, false)
    // Boolean shorthand `true` still needs an address: there is deliberately no
    // default relay host, so the error names the service to use.
    assert.throws(() => resolveConfig({ relay: true }), /relay\.url is required when relay is enabled/)
    assert.throws(() => resolveConfig({ relay: { enabled: true } }), /relay\.url is required when relay is enabled/)
    assert.throws(() => resolveConfig({ relay: { enabled: true, url: 'ftp://dsh-relay.nextai.show' } }), /relay\.url must be ws:\/\/ or wss:\/\//)
    assert.throws(() => resolveConfig({ relay: { enabled: true, url: 'dsh-relay.nextai.show' } }), /relay\.url must be an absolute/)
    assert.throws(() => resolveConfig({ relay: { enabled: true, url: 'wss://dsh-relay.nextai.show/ws' } }), /relay\.url must not carry a path/)
    const normalized = resolveConfig({ relay: { enabled: true, url: 'https://dsh-relay.nextai.show/' } })
    assert.equal(normalized.relay.url, 'wss://dsh-relay.nextai.show')
    assert.ok(Object.isFrozen(normalized.relay), 'the relay config is frozen')
    assert.ok(Object.isFrozen(normalized), 'the resolved config is frozen')
    assert.equal(
      resolveConfig({ relay: { publicUrl: 'https://dsh-relay.nextai.show/r/hub_x/' } }).relay.publicUrl,
      'https://dsh-relay.nextai.show/r/hub_x',
    )
    assert.throws(() => resolveConfig({ relay: { publicUrl: 'wss://dsh-relay.nextai.show' } }), /relay\.publicUrl must use http or https/)
    assert.throws(() => resolveConfig({ relay: { publicUrl: '/r/hub_x' } }), /relay\.publicUrl must be an absolute/)
    assert.equal(resolveConfig({ relay: { accessKey: 'k'.repeat(256) } }).relay.accessKey.length, 256)
    assert.throws(() => resolveConfig({ relay: { accessKey: 'k'.repeat(257) } }), /relay\.accessKey must be at most 256/)
    assert.throws(() => resolveConfig({ relay: { accessKey: 42 } }), /relay\.accessKey must be a string/)
    assert.equal(resolveConfig({ relay: { hubId: 'hub_A-1.b_c' } }).relay.hubId, 'hub_A-1.b_c')
    assert.equal(resolveConfig({ relay: { hubId: '' } }).relay.hubId, '')
    assert.throws(() => resolveConfig({ relay: { hubId: 'hub x' } }), /relay\.hubId must match/)
    assert.throws(() => resolveConfig({ relay: { hubId: 'x'.repeat(129) } }), /relay\.hubId must match/)
    assert.throws(() => resolveConfig({ relay: { hubId: 7 } }), /relay\.hubId must be a string/)
    assert.equal(resolveConfig({ relay: { name: 'n'.repeat(64) } }).relay.name.length, 64)
    assert.throws(() => resolveConfig({ relay: { name: 'n'.repeat(65) } }), /relay\.name must be at most 64/)
    assert.throws(() => resolveConfig({ relay: { name: 5 } }), /relay\.name must be a string/)
    assert.throws(() => resolveConfig({ relay: 'yes' }), /relay must be an object/)
    assert.throws(() => resolveConfig({ relay: [] }), /relay must be an object/)
    // Unknown keys are ignored (design §10), not fatal.
    assert.equal(resolveConfig({ relay: { enabled: false, maxStreams: 7 } }).relay.enabled, false)
    assert.deepEqual(resolveConfig({ relay: { enabled: false } }).relay, { enabled: false, url: '', publicUrl: '', accessKey: '', hubId: '', name: '' })
  })

  await check('relay: url helpers normalise the relay address and derive the entry', async () => {
    assert.deepEqual(normalizeRelayUrl('https://dsh-relay.nextai.show/'), { url: 'wss://dsh-relay.nextai.show', error: null })
    assert.deepEqual(normalizeRelayUrl('http://127.0.0.1:8080'), { url: 'ws://127.0.0.1:8080', error: null })
    assert.equal(normalizeRelayUrl('').url, '')
    assert.match(normalizeRelayUrl('ftp://dsh-relay.nextai.show').error, /ws:\/\/ or wss:\/\//)
    assert.match(normalizeRelayUrl('wss://dsh-relay.nextai.show/ws').error, /must not carry a path/)
    assert.equal(deriveRelayPublicUrl('', RELAY_URL, 'hub_x'), 'https://dsh-relay.nextai.show/r/hub_x')
    assert.equal(deriveRelayPublicUrl('https://edge.example/r/hub_x/', RELAY_URL, 'hub_x'), 'https://edge.example/r/hub_x')
    assert.match(mintHubId(), HUB_ID_SHAPE)
  })

  await check('relay: /state.relay is the disabled shape and nothing is persisted', async () => {
    const offDir = join(root, 's-off')
    const app = await mount({ ...FAST_CONFIG, stateDir: offDir })
    try {
      const state = (await call(app.origin, `${API}/state`)).data
      assert.deepEqual(state.relay, RELAY_OFF)
      assert.equal(state.serverUrls.some((candidate) => candidate.kind === 'relay'), false)
      assert.equal(existsSync(join(offDir, 'relay.json')), false, 'a disabled relay must not create relay.json')
    } finally {
      await app.close()
    }
  })

  await check('relay: /state.relay is the documented shape when no manager is mounted', async () => {
    // `role: 'runtime'` also reports the link; with no manager it must answer
    // the disabled shape rather than throw.
    const fake = createFakeContext()
    createRuntimeStatusRoutes({ ctx: fake.ctx, config: resolveConfig({}), role: 'runtime', version: PLUGIN_VERSION, tunnel: null, relay: null })
    const listener = await startListener(fake)
    try {
      const response = await call(listener.origin, `${API}/state`)
      assert.deepEqual(response.data.relay, RELAY_OFF)
    } finally {
      await listener.close()
      fake.dispose()
    }
  })

  await check('relay: a hubId is minted once, persisted 0600, and reused on reload', async () => {
    const relayDir = join(root, 's-hub')
    const link = createFakeHubLink()
    const first = await mount({
      ...FAST_CONFIG,
      stateDir: relayDir,
      publicUrl: 'https://public.example.com',
      relay: { enabled: true, url: 'https://dsh-relay.nextai.show/' },
    }, { relayDeps: fakeRelayDeps(link) })
    let hubId
    try {
      // The manager waits for the web server to bind, then dials.
      const connecting = await waitFor(() => relayOf(first.origin), (relay) => relay.state === 'connecting', 4000, 'relay connecting')
      assert.equal(connecting.enabled, true)
      assert.equal(connecting.configured, true)
      assert.match(connecting.hubId, HUB_ID_SHAPE)
      assert.equal(connecting.url, RELAY_URL)
      assert.equal(connecting.publicUrl, `https://dsh-relay.nextai.show/r/${connecting.hubId}`)
      assert.equal(connecting.connectedAt, null)
      assert.equal(connecting.lastError, null)
      assert.equal(connecting.streams, 0)
      hubId = connecting.hubId
      // The manager dialled with the normalised url and the minted id.
      assert.equal(link.options.relayUrl, RELAY_URL)
      assert.equal(link.options.hubId, hubId)
      assert.equal(link.options.token, '')
      assert.equal(link.started, 1, 'the link is started exactly once')
      // Its own document, 0600, versioned.
      const identityFile = join(relayDir, 'relay.json')
      assert.ok(existsSync(identityFile), 'relay.json must be written when the id is minted')
      assert.equal(statSync(identityFile).mode & 0o777, 0o600, `relay.json must be 0600, got 0${(statSync(identityFile).mode & 0o777).toString(8)}`)
      const identity = JSON.parse(readFileSync(identityFile, 'utf8'))
      assert.deepEqual(Object.keys(identity).sort(), ['createdAt', 'hubId', 'version'])
      assert.equal(identity.version, 1)
      assert.equal(identity.hubId, hubId)
      assert.ok(Number.isFinite(Date.parse(identity.createdAt)), 'createdAt must be ISO')
      // Never in state.json: resetting the registry must not orphan the address.
      assert.equal(readFileSync(join(relayDir, 'state.json'), 'utf8').includes(hubId), false, 'the hubId must not live in state.json')
      // While connecting, the relay is not advertised (a dead address is worse).
      assert.equal((await call(first.origin, `${API}/state`)).data.serverUrls.some((c) => c.kind === 'relay'), false)

      // Connected: first candidate, reachable, and it wins over publicUrl.
      link.set({ state: 'open', connectedAt: Date.now() })
      const connected = await waitFor(async () => (await call(first.origin, `${API}/state`)).data, (data) => data.relay.state === 'connected', 5000, 'relay connected')
      assert.equal(connected.relay.connectedAt > 0, true)
      const candidate = connected.serverUrls[0]
      assert.equal(candidate.kind, 'relay', 'the relay candidate is first')
      assert.equal(candidate.label, '中继')
      assert.equal(candidate.url, connected.relay.publicUrl)
      assert.equal(candidate.reachable, true)
      assert.equal(candidate.recommended, true)
      assert.equal(connected.serverUrl, connected.relay.publicUrl, 'the relay wins the recommendation')
      assert.ok(connected.serverUrls.some((c) => c.kind === 'public'), 'the public candidate is still listed')
      assert.equal(connected.serverUrls.filter((c) => c.recommended).length, 1, 'exactly one recommendation')
      assert.ok(candidate.health !== undefined, 'candidates keep the health annotation')

      // A drop removes the address instead of advertising a dead one.
      link.set({ state: 'reconnecting', connectedAt: null, lastError: 'socket closed' })
      const dropped = await waitFor(async () => (await call(first.origin, `${API}/state`)).data, (data) => data.relay.state === 'reconnecting', 5000, 'relay reconnecting')
      assert.equal(dropped.relay.lastError, 'socket closed')
      assert.equal(dropped.serverUrls.some((c) => c.kind === 'relay'), false, 'a down relay is not advertised')
    } finally {
      await first.close()
    }
    assert.equal(link.stopped >= 1, true, 'dispose stops the link')

    // Reload: the persisted id is reused, never re-minted.
    const link2 = createFakeHubLink()
    const second = await mount({
      ...FAST_CONFIG,
      stateDir: relayDir,
      relay: { enabled: true, url: RELAY_URL },
    }, { relayDeps: fakeRelayDeps(link2) })
    try {
      const reused = await waitFor(() => relayOf(second.origin), (relay) => relay.state === 'connecting', 4000, 'relay reload')
      assert.equal(reused.hubId, hubId, 'the persisted hubId is reused')
      assert.equal(link2.options.hubId, hubId)
      assert.equal(JSON.parse(readFileSync(join(relayDir, 'relay.json'), 'utf8')).hubId, hubId)
    } finally {
      await second.close()
    }
  })

  await check('relay: an explicitly configured hubId is persisted and reused', async () => {
    const pinnedDir = join(root, 's-pinned')
    const link = createFakeHubLink()
    const app = await mount({
      ...FAST_CONFIG,
      stateDir: pinnedDir,
      relay: { enabled: true, url: RELAY_URL, hubId: 'hub_pinned-1' },
    }, { relayDeps: fakeRelayDeps(link) })
    try {
      const relay = await waitFor(() => relayOf(app.origin), (value) => value.state === 'connecting', 4000, 'pinned hubId')
      assert.equal(relay.hubId, 'hub_pinned-1')
      assert.equal(link.options.hubId, 'hub_pinned-1')
      const identity = JSON.parse(readFileSync(join(pinnedDir, 'relay.json'), 'utf8'))
      assert.equal(identity.hubId, 'hub_pinned-1')
      assert.equal(identity.version, 1)
    } finally {
      await app.close()
    }
  })

  await check('relay: resetting state.json keeps the hubId', async () => {
    const resetDir = join(root, 's-reset')
    const linkA = createFakeHubLink()
    const before = await mount({
      ...FAST_CONFIG,
      stateDir: resetDir,
      relay: { enabled: true, url: RELAY_URL },
    }, { relayDeps: fakeRelayDeps(linkA) })
    let hubId
    try {
      hubId = (await waitFor(() => relayOf(before.origin), (relay) => relay.hubId !== '', 4000, 'hubId')).hubId
    } finally {
      await before.close()
    }
    // A registry reset is routine troubleshooting: the address other machines
    // bookmarked must survive it, so the id lives in relay.json only.
    rmSync(join(resetDir, 'state.json'), { force: true })
    const linkB = createFakeHubLink()
    const after = await mount({
      ...FAST_CONFIG,
      stateDir: resetDir,
      relay: { enabled: true, url: RELAY_URL },
    }, { relayDeps: fakeRelayDeps(linkB) })
    try {
      const relay = await waitFor(() => relayOf(after.origin), (value) => value.hubId !== '', 4000, 'hubId after reset')
      assert.equal(relay.hubId, hubId, 'a state.json reset must not change the address')
      assert.ok(existsSync(join(resetDir, 'relay.json')))
      assert.deepEqual(JSON.parse(readFileSync(join(resetDir, 'state.json'), 'utf8')).computers, [], 'the registry itself is empty again')
    } finally {
      await after.close()
    }
  })

  await check('relay: a corrupt relay.json is set aside and a fresh hubId is minted', async () => {
    const corruptDir = join(root, 's-corrupt')
    mkdirSync(corruptDir, { recursive: true })
    writeFileSync(join(corruptDir, 'relay.json'), '{not json', { mode: 0o600 })
    const link = createFakeHubLink()
    const app = await mount({
      ...FAST_CONFIG,
      stateDir: corruptDir,
      relay: { enabled: true, url: RELAY_URL },
    }, { relayDeps: fakeRelayDeps(link) })
    try {
      const relay = await waitFor(() => relayOf(app.origin), (value) => value.hubId !== '', 4000, 'fresh hubId')
      assert.match(relay.hubId, HUB_ID_SHAPE)
      assert.equal(readdirSync(corruptDir).filter((name) => name.startsWith('relay.json.corrupt-')).length, 1, 'the corrupt file is moved aside')
      assert.equal(JSON.parse(readFileSync(join(corruptDir, 'relay.json'), 'utf8')).hubId, relay.hubId)
    } finally {
      await app.close()
    }
  })

  await check('relay: a link that cannot be built reports failed and never throws', async () => {
    const failDir = join(root, 's-fail')
    const app = await mount({
      ...FAST_CONFIG,
      stateDir: failDir,
      relay: { enabled: true, url: RELAY_URL },
    }, { relayDeps: { createHubLink: () => { throw new Error('dialer exploded') } } })
    try {
      const relay = await waitFor(() => relayOf(app.origin), (value) => value.state === 'failed', 4000, 'relay failed')
      assert.equal(relay.enabled, true)
      assert.equal(relay.configured, false, 'a link that never started is not configured')
      assert.match(relay.lastError, /dialer exploded/)
      assert.match(relay.hubId, HUB_ID_SHAPE, 'the id is minted before the dial')
      const state = (await call(app.origin, `${API}/state`)).data
      assert.equal(state.serverUrls.some((c) => c.kind === 'relay'), false, 'a failed relay is not advertised')
      assert.notEqual(state.serverUrl, '', 'the hub stays usable over its direct addresses')
    } finally {
      await app.close()
    }
  })
}

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
  await phaseG(root)
  await phaseH(root)
  await phaseI(root)
  await phaseJ(root)
  await phaseK(root)
  await phaseL(root)
  await phaseM()
  await phaseN(root)
  await phaseO(root)
  await phaseP(root)
  await phaseQ(root)
  await phaseR(root)
  await phaseS(root)
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
