/**
 * In-process integration tests for relay S1 (docs/relay-design.md §6.1,
 * §6.2, §7, §11).
 *
 * Run with: `node --test lib/relay/test/`.
 *
 * No external processes and no dependencies: every test builds the same
 * three-piece stack the design describes —
 *
 *   HTTP client ──▶ relay (`relay/main.mjs`)
 *                      │  WebSocket, S0 wire frames (lib/relay/wire.js + mux.js)
 *                      ▼
 *                 hub dialer (`lib/relay/hub-link.js`)
 *                      │  bridge (`lib/relay/bridge.js`)
 *                      ▼
 *                 fake local origin (node:http)
 *
 * The fake hub speaks the real S0 protocol because it is the real hub-link
 * plus the real bridge; only the "DSH web server" is faked.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'

import { RELAY_LIMITS, createRelay } from '../../../relay/main.mjs'
import { createBridge } from '../bridge.js'
import { createHubLink } from '../hub-link.js'

const HUB_ID = 'hub_test'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Sleep for `ms` (test scheduling only). */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll `fn` until it returns truthy or the deadline passes. */
async function waitFor(fn, options = {}) {
  const { timeoutMs = 4000, intervalMs = 10, label = 'condition' } = options
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      if (await fn()) return
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}${lastError === null ? '' : `: ${lastError.message}`}`)
}

/** Resolve with the bound port of a node:http server. */
function listenPort(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

/** Close an http server, killing keep-alive sockets. */
function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

/**
 * One HTTP request against the relay. Buffers the response (except SSE tests,
 * which read the raw stream) and never rejects on a 4xx/5xx status.
 */
function request({ port, path, method = 'GET', headers = {}, body = undefined, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    let responded = false
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers })
    const timer = setTimeout(() => {
      req.destroy(new Error(`client timeout after ${timeoutMs} ms`))
    }, timeoutMs)
    timer.unref?.()
    req.on('response', (res) => {
      responded = true
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        clearTimeout(timer)
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      })
      res.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    req.on('error', (error) => {
      if (responded) return
      clearTimeout(timer)
      reject(error)
    })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Issue a raw WebSocket upgrade and resolve with the non-101 HTTP response. */
function rawUpgrade(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode, headers: res.headers, body: '' })
    })
    req.on('response', (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Minimal fake relay stream for direct bridge unit tests. */
function fakeStream(meta) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  const emit = (event, ...args) => {
    for (const fn of [...(listeners.get(event) ?? [])]) fn(...args)
  }
  const stream = {
    id: 2,
    kind: 'http',
    meta,
    settled: false,
    heads: [],
    resets: [],
    chunks: [],
    ends: 0,
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return stream
    },
    once(event, fn) {
      const wrapped = (...args) => {
        stream.off(event, wrapped)
        fn(...args)
      }
      return stream.on(event, wrapped)
    },
    off(event, fn) {
      const list = listeners.get(event) ?? []
      const index = list.indexOf(fn)
      if (index !== -1) list.splice(index, 1)
      return stream
    },
    emit,
    write(chunk) {
      stream.chunks.push(Buffer.from(chunk))
      return true
    },
    writeHead(status, headers) {
      stream.heads.push({ status, headers })
    },
    end() {
      stream.ends += 1
      emit('end')
    },
    fail(code, message) {
      if (stream.settled) return
      stream.settled = true
      stream.resets.push({ code, message })
      emit('reset', { code, message })
    },
    pause() {},
    resume() {},
  }
  return stream
}

/** A fake DSH web server: just enough routes for the S1 assertions. */
async function startOrigin() {
  /** @type {Array<{method: string, url: string, headers: object, body: Buffer}>} */
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      const pathname = String(req.url).split('?')[0]
      if (pathname === '/api/x') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-origin': 'fake' })
        res.end(JSON.stringify({ ok: true, path: pathname, host: req.headers.host }))
        return
      }
      if (pathname === '/api/echo') {
        res.writeHead(201, { 'content-type': 'text/plain' })
        res.end(body)
        return
      }
      if (pathname === '/api/host') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(String(req.headers.host))
        return
      }
      if (pathname === '/api/big') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(Buffer.alloc(200 * 1024, 0x62))
        return
      }
      if (pathname === '/api/sse') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write('data: one\n\n')
        setTimeout(() => {
          res.write('data: two\n\n')
          res.end()
        }, 80)
        return
      }
      if (pathname === '/api/never') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('part1')
        // Deliberately never ends: the hub disconnect test kills it.
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
  })
  const port = await listenPort(server)
  return {
    server,
    port,
    requests,
    close: () => closeServer(server),
  }
}

/** Start origin + relay + hub link (+ bridge) and wait until the hub is live. */
async function startStack(options = {}) {
  const {
    relayOptions = {},
    linkOptions = {},
    hubId = HUB_ID,
    withBridge = true,
  } = options
  const origin = await startOrigin()
  const relay = createRelay({ host: '127.0.0.1', port: 0, ...relayOptions })
  const address = await relay.listen()
  const link = createHubLink({
    relayUrl: `ws://127.0.0.1:${address.port}`,
    hubId,
    reconnectBaseMs: 20,
    reconnectMaxMs: 200,
    ...linkOptions,
  })
  const bridge = withBridge ? createBridge({ port: origin.port }) : null
  if (bridge !== null) link.onStream((stream) => bridge.handle(stream))
  link.start()
  await waitFor(() => link.status().state === 'open', { label: 'hub link open' })
  return {
    origin,
    relay,
    link,
    bridge,
    address,
    hubId,
    async close() {
      await link.stop()
      await relay.close()
      await origin.close()
    },
  }
}

// ---------------------------------------------------------------------------
// relay routing + forwarding
// ---------------------------------------------------------------------------

test('relay: /health reports ok and tracks live hub ids', async () => {
  const relay = createRelay({ host: '127.0.0.1', port: 0 })
  const address = await relay.listen()
  const link = createHubLink({
    relayUrl: `ws://127.0.0.1:${address.port}`,
    hubId: 'hub_health',
    reconnectBaseMs: 20,
  })
  try {
    const before = await request({ port: address.port, path: '/health' })
    assert.equal(before.status, 200)
    assert.deepEqual(JSON.parse(before.body.toString()), { ok: true, hubs: [] })

    link.onStream(() => {})
    link.start()
    await waitFor(() => link.status().state === 'open', { label: 'hub link open' })
    const during = await request({ port: address.port, path: '/health' })
    assert.deepEqual(JSON.parse(during.body.toString()), { ok: true, hubs: ['hub_health'] })

    await link.stop()
    await waitFor(async () => {
      const res = await request({ port: address.port, path: '/health' })
      return JSON.parse(res.body.toString()).hubs.length === 0
    }, { label: 'hub removed from /health' })
  } finally {
    await link.stop()
    await relay.close()
  }
})

test('relay: unknown or offline hub returns 502 hub_offline', async () => {
  const stack = await startStack()
  try {
    const unknown = await request({ port: stack.address.port, path: '/r/hub_missing/api/x' })
    assert.equal(unknown.status, 502)
    assert.equal(JSON.parse(unknown.body.toString()).error, 'hub_offline')

    // The same answer once a known hub has disconnected.
    await stack.link.stop()
    await waitFor(() => stack.relay.hubIds().length === 0, { label: 'hub gone' })
    const offline = await request({ port: stack.address.port, path: `/r/${HUB_ID}/api/x` })
    assert.equal(offline.status, 502)
    assert.equal(JSON.parse(offline.body.toString()).error, 'hub_offline')
  } finally {
    await stack.close()
  }
})

test('relay: GET /r/<hub>/api/x returns the origin status, headers and body', async () => {
  const stack = await startStack()
  try {
    const res = await request({ port: stack.address.port, path: `/r/${HUB_ID}/api/x` })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-origin'], 'fake')
    const payload = JSON.parse(res.body.toString())
    assert.equal(payload.ok, true)
    assert.equal(payload.path, '/api/x')
    // The bridge must overwrite Host with the local listener authority.
    assert.equal(payload.host, `127.0.0.1:${stack.origin.port}`)
    assert.equal(stack.origin.requests.length, 1)
  } finally {
    await stack.close()
  }
})

test('relay: POST body is forwarded to the origin and the response streams back', async () => {
  const stack = await startStack()
  try {
    const body = 'hello relay'
    const res = await request({
      port: stack.address.port,
      path: `/r/${HUB_ID}/api/echo`,
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) },
      body,
    })
    assert.equal(res.status, 201)
    assert.equal(res.body.toString(), body)
    const seen = stack.origin.requests.find((entry) => entry.url === '/api/echo')
    assert.equal(seen.method, 'POST')
    assert.equal(seen.body.toString(), body)
  } finally {
    await stack.close()
  }
})

test('relay: a >64 KiB request body is split into multiple wire frames', async () => {
  const stack = await startStack()
  try {
    const body = Buffer.alloc(200 * 1024, 0x63)
    const res = await request({
      port: stack.address.port,
      path: `/r/${HUB_ID}/api/echo`,
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': body.length },
      body,
      timeoutMs: 8000,
    })
    assert.equal(res.status, 201)
    assert.equal(res.body.length, body.length)
    assert.equal(res.body.equals(body), true)
    const seen = stack.origin.requests.find((entry) => entry.url === '/api/echo')
    assert.equal(seen.body.length, body.length)
  } finally {
    await stack.close()
  }
})

test('relay: a >64 KiB response is reassembled across wire frames', async () => {
  const stack = await startStack()
  try {
    const res = await request({
      port: stack.address.port,
      path: `/r/${HUB_ID}/api/big`,
      timeoutMs: 8000,
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.length, 200 * 1024)
    assert.equal(res.body.equals(Buffer.alloc(200 * 1024, 0x62)), true)
    // 200 KiB / 64 KiB ⇒ at least four response data frames (plus head/end).
    assert.ok(
      stack.link.status().streams.framesOut >= 4,
      `expected >= 4 outbound frames, got ${stack.link.status().streams.framesOut}`,
    )
  } finally {
    await stack.close()
  }
})

test('relay: text/event-stream arrives incrementally, not buffered', async () => {
  const stack = await startStack()
  try {
    /** @type {string[]} */
    const chunks = []
    await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: stack.address.port,
        path: `/r/${HUB_ID}/api/sse`,
      }, (res) => {
        assert.equal(res.statusCode, 200)
        assert.match(String(res.headers['content-type']), /text\/event-stream/)
        res.on('data', (chunk) => chunks.push(chunk.toString('utf8')))
        res.on('end', resolve)
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
    const text = chunks.join('')
    assert.match(text, /data: one/)
    assert.match(text, /data: two/)
    assert.ok(chunks.length >= 2, `expected >= 2 SSE chunks, got ${chunks.length}`)
  } finally {
    await stack.close()
  }
})

test('relay: a 9 MiB request body is rejected with 413 payload_too_large', async () => {
  const stack = await startStack()
  try {
    const body = Buffer.alloc(9 * 1024 * 1024, 0x61)
    const res = await new Promise((resolve, reject) => {
      let settled = false
      const req = httpRequest({
        host: '127.0.0.1',
        port: stack.address.port,
        path: `/r/${HUB_ID}/api/echo`,
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': body.length },
      })
      req.on('response', (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          if (settled) return
          settled = true
          resolve({ status: response.statusCode, body: Buffer.concat(chunks) })
        })
      })
      req.on('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
      // The server answers early and drops the rest; write errors are expected.
      req.on('error', () => {})
      req.write(body)
      req.end()
    })
    assert.equal(res.status, 413)
    assert.equal(JSON.parse(res.body.toString()).error, 'payload_too_large')
    assert.equal(RELAY_LIMITS.maxRequestBodyBytes, 8 * 1024 * 1024)
  } finally {
    await stack.close()
  }
})

test('relay: hub disconnect mid-stream ends the client response without hanging', async () => {
  const stack = await startStack()
  try {
    let sawBody = false
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 3000)
      timer.unref?.()
      const req = httpRequest({
        host: '127.0.0.1',
        port: stack.address.port,
        path: `/r/${HUB_ID}/api/never`,
      }, (res) => {
        res.on('data', () => {
          sawBody = true
          // Drop the hub socket exactly while the response body is open.
          void stack.link.stop()
        })
        res.on('end', () => {
          clearTimeout(timer)
          resolve('end')
        })
        res.on('error', () => {
          clearTimeout(timer)
          resolve('error')
        })
        res.on('close', () => {
          clearTimeout(timer)
          resolve('close')
        })
      })
      req.on('error', () => {
        clearTimeout(timer)
        resolve('req-error')
      })
      req.end()
    })
    assert.equal(sawBody, true)
    assert.notEqual(outcome, 'timeout')
  } finally {
    await stack.close()
  }
})

test('relay: a second socket for a live hub id is rejected with 409 hub_taken', async () => {
  const stack = await startStack()
  try {
    const duplicate = await rawUpgrade(stack.address.port, `/ws?hub=${HUB_ID}&role=hub`)
    assert.equal(duplicate.status, 409)
    assert.equal(JSON.parse(duplicate.body).error, 'hub_taken')
    // The original socket is untouched.
    const res = await request({ port: stack.address.port, path: `/r/${HUB_ID}/api/x` })
    assert.equal(res.status, 200)
    assert.equal(stack.link.status().state, 'open')
  } finally {
    await stack.close()
  }
})

test('relay: WebSocket upgrade under /r/ is 501 not_implemented (S2)', async () => {
  const stack = await startStack()
  try {
    const res = await rawUpgrade(stack.address.port, `/r/${HUB_ID}/ws`)
    assert.equal(res.status, 501)
    assert.equal(JSON.parse(res.body).error, 'not_implemented')
    assert.match(JSON.parse(res.body).message, /S2/)
  } finally {
    await stack.close()
  }
})

test('relay: per-IP token bucket returns 429 rate_limited for new streams', async () => {
  const stack = await startStack({
    relayOptions: { rateLimit: { capacity: 2, refillPerSec: 0 } },
  })
  try {
    const first = await request({ port: stack.address.port, path: `/r/${HUB_ID}/api/x` })
    const second = await request({ port: stack.address.port, path: `/r/${HUB_ID}/api/x` })
    const third = await request({ port: stack.address.port, path: `/r/${HUB_ID}/api/x` })
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(third.status, 429)
    assert.equal(JSON.parse(third.body.toString()).error, 'rate_limited')
  } finally {
    await stack.close()
  }
})

// ---------------------------------------------------------------------------
// bridge unit tests (SSRF guard + host forcing)
// ---------------------------------------------------------------------------

test('bridge: rejects absolute URLs, protocol-relative and .. traversal (SSRF guard)', async () => {
  const origin = await startOrigin()
  const bridge = createBridge({ port: origin.port })
  try {
    const cases = [
      ['http://evil.example/steal', 'GET'],
      ['https://evil.example/steal', 'GET'],
      ['//evil.example/steal', 'GET'],
      ['/a/../../etc/passwd', 'GET'],
      ['/a/%2e%2e/secret', 'GET'],
      ['/a/..%2fsecret', 'GET'],
      ['relative/no-leading-slash', 'GET'],
      ['/api/x', 'CONNECT'],
    ]
    for (const [path, method] of cases) {
      const stream = fakeStream({ method, path })
      bridge.handle(stream)
      assert.equal(stream.resets.length, 1, `${method} ${path} should be rejected`)
      assert.equal(stream.resets[0].code, 'bad_request', `${method} ${path}`)
      assert.equal(stream.heads.length, 0, `${method} ${path}`)
    }
    assert.equal(origin.requests.length, 0, 'no rejected target may reach the origin')
  } finally {
    await origin.close()
  }
})

test('bridge: forces Host to the local listener and forwards path/query', async () => {
  const origin = await startOrigin()
  const bridge = createBridge({ port: origin.port })
  try {
    const stream = fakeStream({
      method: 'GET',
      path: '/api/host?q=1',
      headers: { host: 'evil.example', 'x-test': 'yes' },
    })
    bridge.handle(stream)
    stream.emit('end')
    await waitFor(() => stream.ends > 0 || stream.resets.length > 0, { label: 'bridge response' })
    assert.equal(stream.resets.length, 0)
    assert.equal(stream.heads.length, 1)
    assert.equal(stream.heads[0].status, 200)
    const seen = origin.requests[0]
    assert.equal(seen.url, '/api/host?q=1')
    assert.equal(seen.headers.host, `127.0.0.1:${origin.port}`)
    assert.equal(seen.headers['x-test'], 'yes')
    assert.equal(stream.chunks.map((chunk) => chunk.toString('utf8')).join(''), `127.0.0.1:${origin.port}`)
  } finally {
    await origin.close()
  }
})

// ---------------------------------------------------------------------------
// hub-link dialer: reconnect + heartbeat
// ---------------------------------------------------------------------------

test('hub-link: reconnects after the relay drops the hub socket', async () => {
  const stack = await startStack({
    linkOptions: { reconnectBaseMs: 20, reconnectMaxMs: 100 },
  })
  try {
    const before = stack.link.status().attempts
    assert.equal(stack.relay.disconnectHub(HUB_ID), true)
    await waitFor(
      () => stack.link.status().state === 'open' && stack.link.status().attempts > before,
      { label: 'hub-link reconnect' },
    )
    const res = await request({ port: stack.address.port, path: `/r/${HUB_ID}/api/x` })
    assert.equal(res.status, 200)
  } finally {
    await stack.close()
  }
})

test('hub-link: an unreachable relay is retried, never thrown', async () => {
  const probe = createServer()
  const deadPort = await listenPort(probe)
  await closeServer(probe)
  const link = createHubLink({
    relayUrl: `ws://127.0.0.1:${deadPort}`,
    hubId: 'hub_down',
    reconnectBaseMs: 20,
    reconnectMaxMs: 80,
  })
  try {
    link.start()
    await waitFor(() => link.status().lastError !== null, { label: 'dial failure recorded' })
    assert.notEqual(link.status().state, 'open')
    assert.ok(link.status().attempts >= 1)
    await link.stop()
    assert.equal(link.status().state, 'closed')
  } finally {
    await link.stop()
  }
})

test('hub-link: heartbeat ping/pong keeps a live link open', async () => {
  const stack = await startStack({ linkOptions: { pingIntervalMs: 20, maxMissedPongs: 2 } })
  try {
    await waitFor(() => stack.link.status().pongs >= 2, { label: 'heartbeat pongs' })
    assert.equal(stack.link.status().state, 'open')
    assert.equal(stack.link.status().missedPongs, 0)
  } finally {
    await stack.close()
  }
})

test('hub-link: tears down after two missed pongs', async () => {
  const server = createServer()
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}${WS_GUID}`)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.on('error', () => {})
    // Deliberately never answer wire pings: the dialer must notice and retry.
  })
  const port = await listenPort(server)
  const link = createHubLink({
    relayUrl: `ws://127.0.0.1:${port}`,
    hubId: 'hub_deaf',
    pingIntervalMs: 20,
    maxMissedPongs: 2,
    reconnectBaseMs: 20,
    reconnectMaxMs: 40,
  })
  try {
    link.start()
    await waitFor(() => link.status().state === 'open', { label: 'stub relay open' })
    await waitFor(() => link.status().attempts >= 2, { timeoutMs: 3000, label: 'heartbeat teardown' })
    assert.notEqual(link.status().state, 'closed')
  } finally {
    await link.stop()
    await closeServer(server)
  }
})
