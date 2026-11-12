/**
 * In-process integration tests for relay S2 — WebSocket passthrough
 * (docs/relay-design.md §6.1, §7, §11 S2).
 *
 * Run with: `node --test lib/relay/test/relay-s2.test.mjs`, or the whole
 * relay suite with `npm run test:relay`.
 *
 * No external processes and no dependencies. Every test builds the same
 * four-piece stack the design describes:
 *
 *   browser (raw RFC 6455 client)
 *        │  WS upgrade + frames
 *        ▼
 *   relay (`relay/main.mjs`)  ── ws_open / ws_frame / ws_close ──▶ hub link
 *        │                                                   (`hub-link.js`)
 *        ▼                                                          │
 *   bridge (`lib/relay/bridge.js`) ── client-side WS handshake ──▶ fake local
 *                                                                  WS origin
 *
 * The relay and the hub speak the real protocol because they *are* the real
 * relay, hub link and bridge; only the "DSH web server" is faked. The fake
 * origin is a real `node:http` server with an `upgrade` handler, so the
 * bridge's client-side handshake is exercised for real.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'

import { RELAY_LIMITS, createRelay } from '../../../relay/main.mjs'
import { createBridge } from '../bridge.js'
import {
  WS_OPCODES,
  WsFrameParser,
  createHubLink,
  encodeWsFrame,
  webSocketAccept,
} from '../hub-link.js'

const HUB_ID = 'hub_s2'

// ---------------------------------------------------------------------------
// generic helpers
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

/** One plain HTTP request against the relay (buffers the response). */
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

/**
 * Issue a raw WebSocket upgrade and resolve with the non-101 HTTP response
 * (the relay answers 4xx/5xx on the raw socket when it refuses the tunnel).
 */
function rawUpgrade(port, path, headers = {}) {
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
        ...headers,
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

// ---------------------------------------------------------------------------
// raw WebSocket client (browser side)
// ---------------------------------------------------------------------------

/** Build a close-frame payload: 2-byte code + UTF-8 reason. */
function closePayload(code, reason = '') {
  const text = Buffer.from(String(reason), 'utf8')
  const payload = Buffer.allocUnsafe(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return payload
}

/**
 * Wrap an upgraded browser-side socket in a tiny client.
 * @param {import('node:net').Socket} socket - the upgraded socket.
 * @param {Buffer} head - bytes read after the 101.
 * @returns {object} client with `send`, `sendRaw`, `next`, `close`, `waitClose`.
 */
function createWsClient(socket, head) {
  const parser = new WsFrameParser({ expectMasked: false })
  /** @type {Array<{kind: string, data: Buffer}>} */
  const messages = []
  /** @type {Array<(message: {kind: string, data: Buffer}) => void>} */
  const waiters = []
  /** @type {Array<(info: {code: number, reason: string}) => void>} */
  const closeWaiters = []
  let closeInfo = null

  const deliver = (frame) => {
    if (frame.opcode === WS_OPCODES.TEXT || frame.opcode === WS_OPCODES.BINARY) {
      const message = {
        kind: frame.opcode === WS_OPCODES.TEXT ? 'text' : 'bin',
        data: frame.payload,
      }
      const waiter = waiters.shift()
      if (waiter === undefined) messages.push(message)
      else waiter(message)
      return
    }
    if (frame.opcode === WS_OPCODES.CLOSE) {
      closeInfo = {
        code: frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005,
        reason: frame.payload.subarray(2).toString('utf8'),
      }
      for (const waiter of closeWaiters.splice(0)) waiter(closeInfo)
      try {
        socket.end()
      } catch {
        // already gone
      }
    }
  }

  socket.on('data', (chunk) => {
    let frames
    try {
      frames = parser.push(chunk)
    } catch {
      return
    }
    for (const frame of frames) deliver(frame)
  })
  socket.on('error', () => {})

  const client = {
    socket,
    /** Send one whole message (masked, as a client must). */
    send(payload, kind = 'text') {
      const opcode = kind === 'text' ? WS_OPCODES.TEXT : WS_OPCODES.BINARY
      socket.write(encodeWsFrame(opcode, payload, { mask: true }))
    },
    /** Send pre-encoded bytes (used for fragmentation tests). */
    sendRaw(buffer) {
      socket.write(buffer)
    },
    /** Resolve with the next whole message. */
    next(timeoutMs = 5000) {
      if (messages.length > 0) return Promise.resolve(messages.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a WebSocket message')), timeoutMs)
        timer.unref?.()
        waiters.push((message) => {
          clearTimeout(timer)
          resolve(message)
        })
      })
    },
    /** Start the closing handshake from the browser side. */
    close(code = 1000, reason = '') {
      socket.write(encodeWsFrame(WS_OPCODES.CLOSE, closePayload(code, reason), { mask: true }))
    },
    /** Resolve with the close the relay sent back. */
    waitClose(timeoutMs = 5000) {
      if (closeInfo !== null) return Promise.resolve(closeInfo)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a WebSocket close')), timeoutMs)
        timer.unref?.()
        closeWaiters.push((info) => {
          clearTimeout(timer)
          resolve(info)
        })
      })
    },
    destroy() {
      socket.destroy()
    },
  }

  if (head !== undefined && head.length > 0) {
    for (const frame of parser.push(head)) deliver(frame)
  }
  return client
}

/**
 * Open a browser-side WebSocket to the relay.
 * @param {number} port - relay port.
 * @param {string} path - `/r/<hubId>/<rest>`.
 * @param {object} [headers] - extra upgrade headers.
 * @returns {Promise<{status: number, headers: object, key: string,
 *   client: object|null, body: string}>} the handshake outcome.
 */
function wsConnect(port, path, headers = {}) {
  const key = randomBytes(16).toString('base64')
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': key,
        ...headers,
      },
    })
    req.on('upgrade', (res, socket, head) => {
      resolve({ status: res.statusCode, headers: res.headers, key, client: createWsClient(socket, head), body: '' })
    })
    req.on('response', (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        key,
        client: null,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// fake local origin: HTTP + a real WebSocket echo server
// ---------------------------------------------------------------------------

/**
 * Start the fake "DSH web server".
 *
 * Routes: `GET /api/x` (HTTP, S1 regression), and the upgrade routes
 * `/ws/echo` (echoes every message), `/ws/server-close` (closes 30 ms after
 * the handshake), `/ws/deny` (answers 401 instead of upgrading) and
 * `/ws/silent` (accepts TCP, never answers).
 *
 * @returns {Promise<{server: object, port: number, sockets: object[],
 *   close: () => Promise<void>}>} the origin.
 */
async function startOrigin() {
  /** @type {Array<object>} one record per upgraded socket. */
  const sockets = []
  /** @type {Set<import('node:net').Socket>} */
  const live = new Set()

  const server = createServer((req, res) => {
    const pathname = String(req.url).split('?')[0]
    if (pathname === '/api/x') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-origin': 'fake' })
      res.end(JSON.stringify({ ok: true, path: pathname, host: req.headers.host }))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  server.on('upgrade', (req, socket, head) => {
    const pathname = String(req.url).split('?')[0]
    live.add(socket)
    socket.on('close', () => live.delete(socket))
    socket.on('error', () => {})

    if (pathname === '/ws/deny') {
      socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain\r\ncontent-length: 6\r\n\r\ndenied')
      return
    }
    if (pathname === '/ws/silent') {
      // Accept the TCP connection but never answer the handshake.
      socket.resume()
      return
    }

    const accept = webSocketAccept(req.headers['sec-websocket-key'])
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )

    /** @type {{path: string, frames: number, bytes: number, code: number|null,
     *   reason: string, closed: boolean}} */
    const record = { path: pathname, frames: 0, bytes: 0, code: null, reason: '', closed: false }
    sockets.push(record)

    const parser = new WsFrameParser({ expectMasked: true })
    let closeSent = false
    socket.on('data', (chunk) => {
      let frames
      try {
        frames = parser.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      for (const frame of frames) {
        if (frame.opcode === WS_OPCODES.TEXT || frame.opcode === WS_OPCODES.BINARY) {
          record.frames += 1
          record.bytes += frame.payload.length
          // Echo one unfragmented frame; the browser-side message is atomic.
          socket.write(encodeWsFrame(frame.opcode, frame.payload))
          continue
        }
        if (frame.opcode === WS_OPCODES.CLOSE) {
          record.code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005
          record.reason = frame.payload.subarray(2).toString('utf8')
          if (!closeSent) {
            closeSent = true
            socket.write(encodeWsFrame(WS_OPCODES.CLOSE, frame.payload))
            socket.end()
          }
          continue
        }
        if (frame.opcode === WS_OPCODES.PING) {
          socket.write(encodeWsFrame(WS_OPCODES.PONG, frame.payload))
        }
      }
    })
    socket.on('close', () => {
      record.closed = true
    })

    if (pathname === '/ws/server-close') {
      setTimeout(() => {
        if (closeSent) return
        closeSent = true
        socket.write(encodeWsFrame(WS_OPCODES.CLOSE, closePayload(1000, 'bye')))
        socket.end()
      }, 30).unref?.()
    }

    if (head !== undefined && head.length > 0) socket.emit('data', head)
  })

  const port = await listenPort(server)
  return {
    server,
    port,
    sockets,
    async close() {
      for (const socket of live) socket.destroy()
      live.clear()
      await closeServer(server)
    },
  }
}

/** Start origin + relay + hub link + bridge and wait until the hub is live. */
async function startStack(options = {}) {
  const {
    relayOptions = {},
    linkOptions = {},
    bridgeOptions = {},
    hubId = HUB_ID,
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
  const bridge = createBridge({ port: origin.port, ...bridgeOptions })
  link.onStream((stream) => bridge.handle(stream))
  link.start()
  await waitFor(() => link.status().state === 'open', { label: 'hub link open' })
  return {
    origin,
    relay,
    link,
    bridge,
    address,
    hubId,
    /** Wait until every tunnel stream has been released. */
    async noOpenStreams() {
      await waitFor(() => relay.stats().openStreams === 0, { label: 'no open tunnel streams' })
    },
    async close() {
      await link.stop()
      await relay.close()
      await origin.close()
    },
  }
}

// ---------------------------------------------------------------------------
// upgrade + framing
// ---------------------------------------------------------------------------

test('s2: a WS upgrade through /r/<hub>/ws returns 101 with a valid accept', async () => {
  const stack = await startStack()
  try {
    const conn = await wsConnect(stack.address.port, `/r/${HUB_ID}/ws/echo`)
    try {
      assert.equal(conn.status, 101)
      assert.equal(conn.headers['sec-websocket-accept'], webSocketAccept(conn.key))
      assert.equal(String(conn.headers.upgrade).toLowerCase(), 'websocket')
      // The bridge forced the Host header to the local listener.
      assert.equal(stack.relay.stats().wsTunnels, 1)
    } finally {
      conn.client?.destroy()
    }
  } finally {
    await stack.close()
  }
})

test('s2: a text frame round-trips through the tunnel', async () => {
  const stack = await startStack()
  try {
    const conn = await wsConnect(stack.address.port, `/r/${HUB_ID}/ws/echo`)
    try {
      conn.client.send('hello relay', 'text')
      const message = await conn.client.next()
      assert.equal(message.kind, 'text')
      assert.equal(message.data.toString('utf8'), 'hello relay')
      assert.equal(stack.origin.sockets[0].frames, 1)
    } finally {
      conn.client.destroy()
    }
  } finally {
    await stack.close()
  }
})

test('s2: a binary frame round-trips through the tunnel', async () => {
  const stack = await startStack()
  try {
    const conn = await wsConnect(stack.address.port, `/r/${HUB_ID}/ws/echo`)
    try {
      const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f])
      conn.client.send(payload, 'bin')
      const message = await conn.client.next()
      assert.equal(message.kind, 'bin')
      assert.equal(message.data.equals(payload), true)
    } finally {
      conn.client.destroy()
    }
  } finally {
    await stack.close()
  }
})

test('s2: an empty message round-trips (zero-length edge case)', async () => {
  const stack = await startStack()
  try {
    const conn = await wsConnect(stack.address.port, `/r/${HUB_ID}/ws/echo`)
    try {
      conn.client.send(Buffer.alloc(0), 'text')
      const message = await conn.client.next()
      assert.equal(message.kind, 'text')
      assert.equal(message.data.length, 0)
      assert.equal(stack.origin.sockets[0].frames, 1)
    } finally {
      conn.client.destroy()
    }
  } finally {
    await stack.close()
  }
})

test('s2: a >64 KiB message is split into wire frames and reassembled intact', async () => {
  const stack = await startStack()
  try {
    const conn = await wsConnect(stack.address.port, `/r/${HUB_ID}/ws/echo`)
    try {
      const payload = randomBytes(200 * 1024)
      conn.client.send(payload, 'bin')
      const message = await conn.client.next(8000)
      assert.equal(message.kind, 'bin')
      assert.equal(message.data.length, payload.length)
      assert.equal(message.data.equals(payload), true)
      // The local origin received exactly one whole message (the bridge
      // reassembles before writing to the local socket) …
      const record = stack.origin.sockets[0]
      assert.equal(record.frames, 1)
      assert.equal(record.bytes, payload.length)
      // … and the wire carried it as several ≤64 KiB frames.
      assert.equal(RELAY_LIMITS.maxWsMessageBytes, 8 * 1024 * 1024)
      assert.ok(
        stack.link.status().streams.framesOut >= 4,
        `expected >= 4 outbound wire frames, got ${stack.link.status().streams.framesOut}`,
      )
      assert.ok(stack.link.status().streams.wsMessagesOut >= 1)
    } finally {
      conn.client.destroy()
    }
  } finally {
    await stack.close()
  }
})

test('s2: fragmented browser frames are reassembled into one message', async () => {
  const stack = await startStack()
  try {
    const conn = await wsConnect(stack.address.port, `/r/${HUB_ID}/ws/echo`)
    try {
      // TEXT with FIN=0, then CONTINUATION with FIN=1: one logical message.
      conn.client.sendRaw(encodeWsFrame(WS_OPCODES.TEXT, 'frag-', { mask: true, fin: false }))
      conn.client.sendRaw(encodeWsFrame(WS_OPCODES.CONTINUATION, 'mented', { mask: true }))
      const message = await conn.client.next()
      assert.equal(message.kind, 'text')
      assert.equal(message.data.toString('utf8'), 'frag-mented')
      const record = stack.origin.sockets[0]
      assert.equal(record.frames, 1, 'the origin must see one whole message, not two fragments')
      assert.equal(record.bytes, Buffer.byteLength('frag-mented'))
    } finally {
      conn.client.destroy()
    }
  } finally {
    await stack.close()
  }
})

// ---------------------------------------------------------------------------
// close propagation
// ---------------------------------------------------------------------------

test('s2: closing the browser side closes the local socket', async () => {
  const stack = await startStack()
  try {
    const conn = await wsConnect(stack.address.port, `/r/${HUB_ID}/ws/echo`)
    await waitFor(() => stack.origin.sockets.length === 1, { label: 'local socket open' })
    conn.client.send('ping', 'text')
    await conn.client.next()

    conn.client.close(1000, 'bye')
    await waitFor(() => stack.origin.sockets[0].closed === true, { label: 'local socket closed' })
    assert.equal(stack.origin.sockets[0].code, 1000)
    await stack.noOpenStreams()
  } finally {
    await stack.close()
  }
})

test('s2: closing the local side closes the browser side', async () => {
  const stack = await startStack()
  try {
    const conn = await wsConnect(stack.address.port, `/r/${HUB_ID}/ws/server-close`)
    try {
      const close = await conn.client.waitClose()
      assert.equal(close.code, 1000)
      assert.equal(close.reason, 'bye')
      await stack.noOpenStreams()
    } finally {
      conn.client.destroy()
    }
  } finally {
    await stack.close()
  }
})

// ---------------------------------------------------------------------------
// refusals and limits (S1 limits still hold for upgrades)
// ---------------------------------------------------------------------------

test('s2: a WS upgrade to an unknown hub answers 502 hub_offline', async () => {
  const stack = await startStack()
  try {
    const res = await rawUpgrade(stack.address.port, '/r/hub_missing/ws')
    assert.equal(res.status, 502)
    assert.equal(JSON.parse(res.body).error, 'hub_offline')
    assert.equal(stack.relay.stats().wsTunnels, 0)
  } finally {
    await stack.close()
  }
})

test('s2: a WS upgrade with a bad handshake is rejected with 400', async () => {
  const stack = await startStack()
  try {
    const res = await rawUpgrade(stack.address.port, `/r/${HUB_ID}/ws/echo`, {
      'sec-websocket-version': '12',
    })
    assert.equal(res.status, 400)
    assert.equal(JSON.parse(res.body).error, 'bad_handshake')
  } finally {
    await stack.close()
  }
})

test('s2: an unresponsive local origin yields 504 timeout', async () => {
  const stack = await startStack({ bridgeOptions: { timeoutMs: 150 } })
  try {
    const res = await rawUpgrade(stack.address.port, `/r/${HUB_ID}/ws/silent`)
    assert.equal(res.status, 504)
    assert.equal(JSON.parse(res.body).error, 'timeout')
    await stack.noOpenStreams()
  } finally {
    await stack.close()
  }
})

test('s2: a local origin that refuses the upgrade forwards its status (401)', async () => {
  const stack = await startStack()
  try {
    const res = await rawUpgrade(stack.address.port, `/r/${HUB_ID}/ws/deny`)
    assert.equal(res.status, 401)
    assert.equal(JSON.parse(res.body).error, 'upgrade_rejected')
    await stack.noOpenStreams()
  } finally {
    await stack.close()
  }
})

test('s2: a WS upgrade consumes the per-IP token bucket (429)', async () => {
  const stack = await startStack({
    relayOptions: { rateLimit: { capacity: 1, refillPerSec: 0 } },
  })
  try {
    const first = await wsConnect(stack.address.port, `/r/${HUB_ID}/ws/echo`)
    try {
      assert.equal(first.status, 101)
      const second = await rawUpgrade(stack.address.port, `/r/${HUB_ID}/ws/echo`)
      assert.equal(second.status, 429)
      assert.equal(JSON.parse(second.body).error, 'rate_limited')
    } finally {
      first.client?.destroy()
    }
  } finally {
    await stack.close()
  }
})

test('s2: a WS upgrade is refused with 503 too_many when the hub is at maxStreams', async () => {
  const stack = await startStack({ relayOptions: { maxStreamsPerHub: 1 } })
  try {
    const first = await wsConnect(stack.address.port, `/r/${HUB_ID}/ws/echo`)
    try {
      assert.equal(first.status, 101)
      const second = await rawUpgrade(stack.address.port, `/r/${HUB_ID}/ws/echo`)
      assert.equal(second.status, 503)
      assert.equal(JSON.parse(second.body).error, 'too_many')
    } finally {
      first.client?.destroy()
    }
  } finally {
    await stack.close()
  }
})

// ---------------------------------------------------------------------------
// no regression: the plain HTTP path is unchanged
// ---------------------------------------------------------------------------

test('s2: a plain HTTP GET under /r/ still works', async () => {
  const stack = await startStack()
  try {
    const res = await request({ port: stack.address.port, path: `/r/${HUB_ID}/api/x` })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-origin'], 'fake')
    const payload = JSON.parse(res.body.toString())
    assert.equal(payload.ok, true)
    assert.equal(payload.host, `127.0.0.1:${stack.origin.port}`)
    assert.equal(stack.relay.stats().wsTunnels, 0)
  } finally {
    await stack.close()
  }
})

test('s2: an HTTP request and a WS tunnel run side by side on one hub link', async () => {
  const stack = await startStack()
  try {
    const conn = await wsConnect(stack.address.port, `/r/${HUB_ID}/ws/echo`)
    try {
      const res = await request({ port: stack.address.port, path: `/r/${HUB_ID}/api/x` })
      assert.equal(res.status, 200)
      conn.client.send('still here', 'text')
      const message = await conn.client.next()
      assert.equal(message.data.toString('utf8'), 'still here')
      assert.equal(stack.relay.stats().openStreams, 1)
    } finally {
      conn.client.destroy()
    }
    await stack.noOpenStreams()
  } finally {
    await stack.close()
  }
})
