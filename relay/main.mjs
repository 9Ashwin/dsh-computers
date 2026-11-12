/**
 * Standalone relay server (docs/relay-design.md §6.2, §7, S1).
 *
 * One `node:http` server carries three ingress shapes:
 *
 * ```
 * GET /health                       → {ok:true, hubs:[hubId…]}
 * GET /ws?hub=<id>&role=hub         → WebSocket upgrade (hub dial-in)
 * GET /r/<hubId>/<rest>             → generic HTTP tunnel to that hub
 * WS  /r/<hubId>/<rest>             → 501 (WebSocket passthrough is S2)
 * ```
 *
 * The relay is deliberately a dumb pipe at this stage: it forwards a browser
 * or agent HTTP request through the hub's S0 wire socket, streams the response
 * back (including `text/event-stream`) without buffering, and enforces the
 * limits from design §7.4/§13:
 *
 * - request body ≤ 8 MiB (413 `payload_too_large`);
 * - response chunks ≤ 64 KiB (the wire codec's payload cap);
 * - ≤ 256 concurrent streams per hub (503 `too_many`);
 * - a per-IP token bucket for new streams (429 `rate_limited`);
 * - no hub socket → 502 `hub_offline`; a second hub socket → 409 `hub_taken`.
 *
 * The relay is the mux `client` (odd stream ids) and each hub is the mux
 * `hub` (even ids). Frames are decoded by the shared `createLinkChannel`
 * adapter, which is also what `lib/relay/hub-link.js` uses on the other side.
 *
 * There is no `process.exit` here: `createRelay()` is a library object, and
 * `bin/dsh-computers-relay.mjs` owns process concerns.
 */

import { createServer } from 'node:http'

import { MAX_PAYLOAD_BYTES } from '../lib/relay/wire.js'
import {
  createLinkChannel,
  createWsPeer,
  filterHopByHopHeaders,
  webSocketAccept,
} from '../lib/relay/hub-link.js'

/** Hard limits (design §7.4, §13) — exported so tests/smoke can assert them. */
export const RELAY_LIMITS = Object.freeze({
  /** Largest buffered request body; larger requests get 413. */
  maxRequestBodyBytes: 8 * 1024 * 1024,
  /** Largest payload carried by one wire frame (matches wire.js). */
  maxResponseChunkBytes: 64 * 1024,
  /**
   * After the body cap is crossed the relay keeps draining (and discarding)
   * the request up to this size so the client can still read the 413 response;
   * beyond it the socket is reset (memory stays bounded either way).
   */
  maxDrainedRequestBodyBytes: 16 * 1024 * 1024,
  /** Concurrent streams allowed on one hub link. */
  maxStreamsPerHub: 256,
  /** Largest inbound WebSocket message (one wire frame is ≤ ~73 KiB). */
  maxWsMessageBytes: 8 * 1024 * 1024,
  /** First-byte timeout for a relayed request (design §7.4 `timeout`). */
  requestTimeoutMs: 30000,
  /** Per-IP token bucket for new tunnel streams. */
  rateLimit: Object.freeze({ capacity: 60, refillPerSec: 30 }),
})

/** Hub ids are `hub_…` in the design; accept the broader safe alphabet too. */
const HUB_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

/** HTTP status text for the few responses written on a raw upgrade socket. */
const STATUS_TEXT = Object.freeze({
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
})

/** Write one JSON response (HEAD gets headers only). */
function sendJson(res, status, payload, headOnly = false) {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(headOnly ? undefined : body)
}

/** Write one HTTP response onto a socket that has not been upgraded. */
function rejectUpgrade(socket, status, payload) {
  if (socket === null || socket.destroyed === true) return
  const body = JSON.stringify(payload)
  const reason = STATUS_TEXT[status] ?? 'Error'
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
      'content-type: application/json; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      'connection: close\r\n\r\n' +
      body,
    )
    socket.end()
  } catch {
    socket.destroy()
  }
}

/** Strip an IPv4-mapped IPv6 prefix so one client maps to one bucket. */
function normalizeAddress(address) {
  if (typeof address !== 'string' || address === '') return 'unknown'
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/**
 * Read a request body with a hard buffering cap.
 *
 * Once `limit` is crossed the buffered chunks are dropped and the request keeps
 * being **drained without storing** up to `drainLimit` so the client can still
 * receive the 413 answer (an early reset would race the client's upload). If
 * even the drain cap is crossed, the socket is reset by the caller.
 *
 * @param {import('node:http').IncomingMessage} req - request to read.
 * @param {number} limit - buffered-body cap.
 * @param {number} drainLimit - total body bytes we are willing to discard.
 * @returns {Promise<Buffer>} the body.
 * @throws {Error & {code: string, hard?: boolean}} `payload_too_large`.
 */
function readBody(req, limit, drainLimit) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let total = 0
    let overflow = false
    let done = false

    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
    }
    const tooLarge = (hard) => {
      const error = new Error(`request body exceeds ${limit} B`)
      error.code = 'payload_too_large'
      if (hard) error.hard = true
      return error
    }
    const onData = (chunk) => {
      if (done) return
      total += chunk.length
      if (!overflow && total > limit) {
        // Crossed the cap: release what we buffered and stop retaining.
        overflow = true
        chunks.length = 0
      }
      if (overflow) {
        if (total > drainLimit) {
          done = true
          cleanup()
          req.pause()
          reject(tooLarge(true))
        }
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (done) return
      done = true
      cleanup()
      if (overflow) {
        reject(tooLarge(false))
        return
      }
      resolve(chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks))
    }
    const onError = (error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }
    const onAborted = () => {
      if (done) return
      done = true
      cleanup()
      const error = new Error('request aborted')
      error.code = 'aborted'
      reject(error)
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

/** Await stream drain (or settlement) before writing the next body chunk. */
function waitForDrain(stream) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      stream.off('drain', finish)
      stream.off('close', finish)
      resolve()
    }
    stream.once('drain', finish)
    stream.once('close', finish)
  })
}

/** Stream a (≤ 8 MiB) request body into the mux handle, honouring backpressure. */
async function writeRequestBody(stream, body) {
  for (let offset = 0; offset < body.length; offset += MAX_PAYLOAD_BYTES) {
    if (stream.settled) return false
    const slice = body.subarray(offset, Math.min(offset + MAX_PAYLOAD_BYTES, body.length))
    let writable = true
    try {
      writable = stream.write(slice) !== false
    } catch {
      return false
    }
    if (!writable) await waitForDrain(stream)
  }
  try {
    stream.end()
  } catch {
    return false
  }
  return true
}

/**
 * Create (but do not start) the standalone relay.
 *
 * @param {object} [options] - relay options.
 * @param {string} [options.host] - listen host (`0.0.0.0`).
 * @param {number} [options.port] - listen port (8787; `0` = ephemeral).
 * @param {(level: string, message: string) => void} [options.log] - optional logger.
 * @param {number} [options.maxRequestBodyBytes] - request body cap (8 MiB).
 * @param {number} [options.maxDrainedRequestBodyBytes] - discard cap after overflow (16 MiB).
 * @param {number} [options.maxStreamsPerHub] - per-hub stream cap (256).
 * @param {number} [options.maxWsMessageBytes] - WebSocket message cap (8 MiB).
 * @param {number} [options.requestTimeoutMs] - first-byte timeout (30 s).
 * @param {{capacity: number, refillPerSec: number}} [options.rateLimit] - per-IP bucket.
 * @returns {object} relay with `listen`, `close`, `address`, `hubIds`,
 *   `disconnectHub`, `stats` and the underlying `server`.
 */
export function createRelay(options = {}) {
  const {
    host = '0.0.0.0',
    port = 8787,
    log = null,
    maxRequestBodyBytes = RELAY_LIMITS.maxRequestBodyBytes,
    maxDrainedRequestBodyBytes = RELAY_LIMITS.maxDrainedRequestBodyBytes,
    maxStreamsPerHub = RELAY_LIMITS.maxStreamsPerHub,
    maxWsMessageBytes = RELAY_LIMITS.maxWsMessageBytes,
    requestTimeoutMs = RELAY_LIMITS.requestTimeoutMs,
    rateLimit = RELAY_LIMITS.rateLimit,
  } = options

  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 1) {
    throw new TypeError('maxRequestBodyBytes must be a positive integer')
  }
  if (!Number.isSafeInteger(maxDrainedRequestBodyBytes) || maxDrainedRequestBodyBytes < maxRequestBodyBytes) {
    throw new TypeError('maxDrainedRequestBodyBytes must be an integer >= maxRequestBodyBytes')
  }
  if (!Number.isSafeInteger(maxStreamsPerHub) || maxStreamsPerHub < 1) {
    throw new TypeError('maxStreamsPerHub must be a positive integer')
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new TypeError('requestTimeoutMs must be a positive integer')
  }
  const bucketCapacity = rateLimit?.capacity
  const bucketRefill = rateLimit?.refillPerSec
  if (!Number.isFinite(bucketCapacity) || bucketCapacity < 1 || !Number.isFinite(bucketRefill) || bucketRefill < 0) {
    throw new TypeError('rateLimit must be {capacity: >=1, refillPerSec: >=0}')
  }

  /** @type {Map<string, object>} live hub sockets, one per hub id. */
  const hubs = new Map()
  /** @type {Map<string, {tokens: number, last: number}>} per-IP token buckets. */
  const buckets = new Map()
  const counters = {
    forwarded: 0,
    rejected: 0,
    rateLimited: 0,
    hubDisconnects: 0,
    wsUpgrades: 0,
    rejectedUpgrades: 0,
  }

  /** Optional logger that can never throw into a request/socket callback. */
  function logLine(level, message) {
    if (log === null || typeof log !== 'function') return
    try {
      log(level, message)
    } catch {
      // ignore
    }
  }

  /** Consume one token for a new stream from `ip`; false = rate limited. */
  function takeToken(ip) {
    const now = Date.now()
    let bucket = buckets.get(ip)
    if (bucket === undefined) {
      // Bound the bucket table: evict the oldest entry when it grows too far.
      if (buckets.size >= 10000) {
        const oldest = buckets.keys().next().value
        buckets.delete(oldest)
      }
      bucket = { tokens: bucketCapacity, last: now }
      buckets.set(ip, bucket)
    } else {
      const elapsedSeconds = Math.max(0, now - bucket.last) / 1000
      bucket.tokens = Math.min(bucketCapacity, bucket.tokens + elapsedSeconds * bucketRefill)
      bucket.last = now
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return true
    }
    return false
  }

  /** Build the relay-side view of one hub socket. */
  function createHubConnection(hubId, peer, channel, socket, remoteAddress) {
    const conn = {
      hubId,
      peer,
      channel,
      socket,
      remoteAddress,
      connectedAt: Date.now(),
      pausedStreams: 0,
      /** Pause the shared hub socket when any client response is backpressured. */
      pause() {
        conn.pausedStreams += 1
        if (conn.pausedStreams === 1) peer.pause()
      },
      /** Resume once every backpressured response has drained. */
      resume() {
        if (conn.pausedStreams === 0) return
        conn.pausedStreams -= 1
        if (conn.pausedStreams === 0) peer.resume()
      },
    }
    return conn
  }

  /** Forward one browser/agent HTTP request through the hub link. */
  async function forwardRequest(req, res, rawUrl) {
    const match = /^\/r\/([^/?#]+)(.*)$/.exec(rawUrl)
    if (match === null) {
      sendJson(res, 404, { error: 'not_found', message: 'the route is /r/<hubId>/<path>' })
      return
    }
    let hubId
    try {
      hubId = decodeURIComponent(match[1])
    } catch {
      sendJson(res, 404, { error: 'not_found', message: 'invalid hub id encoding' })
      return
    }
    if (!HUB_ID_RE.test(hubId)) {
      sendJson(res, 404, { error: 'not_found', message: 'invalid hub id' })
      return
    }
    const rest = match[2] === '' ? '/' : match[2]
    const ip = normalizeAddress(req.socket?.remoteAddress)

    if (!takeToken(ip)) {
      counters.rateLimited += 1
      sendJson(res, 429, {
        error: 'rate_limited',
        message: 'too many new relay streams from this address; retry shortly',
      })
      return
    }

    const conn = hubs.get(hubId)
    if (conn === undefined || conn.peer.open !== true) {
      counters.rejected += 1
      sendJson(res, 502, { error: 'hub_offline', message: `hub ${hubId} is not connected` })
      return
    }

    let body
    try {
      body = await readBody(req, maxRequestBodyBytes, maxDrainedRequestBodyBytes)
    } catch (error) {
      if (error?.code === 'payload_too_large') {
        counters.rejected += 1
        res.setHeader('connection', 'close')
        sendJson(res, 413, {
          error: 'payload_too_large',
          message: `request body exceeds ${maxRequestBodyBytes} B`,
        })
        // The body was drained up to the discard cap so the 413 response can
        // still reach the client; beyond that cap the socket is reset instead.
        if (error.hard === true) req.destroy()
        return
      }
      counters.rejected += 1
      if (!res.headersSent) sendJson(res, 400, { error: 'bad_request', message: error?.message ?? 'request failed' })
      else res.destroy()
      return
    }

    // The hub may have vanished while the body was being read.
    if (conn.peer.open !== true) {
      counters.rejected += 1
      sendJson(res, 502, { error: 'hub_offline', message: `hub ${hubId} disconnected` })
      return
    }

    let stream
    try {
      // `Host` belongs to the local origin and is forced by the bridge; never
      // forward the client's Host header into the tunnel.
      const forwardedHeaders = filterHopByHopHeaders(req.headers)
      delete forwardedHeaders.host
      stream = conn.channel.openHttp({
        method: typeof req.method === 'string' ? req.method : 'GET',
        path: rest,
        headers: forwardedHeaders,
        bodyLen: body.length,
      })
    } catch (error) {
      counters.rejected += 1
      if (error?.code === 'too_many_streams') {
        sendJson(res, 503, {
          error: 'too_many',
          message: `hub ${hubId} already has ${maxStreamsPerHub} concurrent streams`,
        })
      } else {
        sendJson(res, 502, { error: 'hub_offline', message: `hub ${hubId} cannot accept the stream` })
      }
      return
    }
    counters.forwarded += 1

    let finished = false
    let headSent = false
    let responsePaused = false
    let timeoutTimer = null

    /** Release the per-request timer and any connection-level pause. */
    const release = () => {
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      if (responsePaused) {
        responsePaused = false
        conn.resume()
      }
    }

    /** End the client response once, whichever side spoke first. */
    const settle = (mode, errorStatus, errorCode, errorMessage) => {
      if (finished) return
      finished = true
      release()
      if (mode === 'end') {
        if (!res.writableEnded) res.end()
        return
      }
      if (mode === 'destroy') {
        if (!res.destroyed) res.destroy()
        return
      }
      if (!res.headersSent) {
        sendJson(res, errorStatus, { error: errorCode, message: errorMessage })
      } else if (!res.writableEnded && !res.destroyed) {
        // The head is already on the wire, so an error frame can no longer be
        // expressed as a status code. End the response cleanly (chunked/SSE
        // clients see a normal end; content-length truncation still terminates).
        try {
          res.end()
        } catch {
          res.destroy()
        }
      }
    }

    timeoutTimer = setTimeout(() => {
      timeoutTimer = null
      if (finished) return
      try {
        stream.reset('timeout', 'hub did not answer in time')
      } catch {
        // already settled
      }
      settle('error', 504, 'timeout', 'the hub did not respond in time')
    }, requestTimeoutMs)
    timeoutTimer.unref?.()

    stream.on('head', ({ status, headers }) => {
      if (finished || headSent) return
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      headSent = true
      const safeStatus = Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502
      const safeHeaders = filterHopByHopHeaders(headers)
      try {
        res.writeHead(safeStatus, safeHeaders)
        // SSE must not be held in Node's header buffer: flush immediately.
        if (String(safeHeaders['content-type'] ?? '').toLowerCase().includes('text/event-stream')) {
          res.flushHeaders()
        }
      } catch (error) {
        logLine('warn', `[relay] response head rejected: ${error?.message ?? error}`)
        try {
          stream.reset('bad_response', 'the hub sent an invalid response head')
        } catch {
          // already settled
        }
        settle('error', 502, 'bad_response', 'the hub sent an invalid response head')
      }
    })

    stream.on('data', (chunk) => {
      if (finished || res.destroyed) return
      let writable = true
      try {
        writable = res.write(chunk) !== false
      } catch {
        settle('destroy')
        return
      }
      if (!writable && !responsePaused) {
        responsePaused = true
        conn.pause()
        res.once('drain', () => {
          if (!responsePaused) return
          responsePaused = false
          conn.resume()
        })
      }
    })

    stream.on('end', () => {
      settle('end')
    })

    stream.on('reset', (info) => {
      const code = typeof info?.code === 'string' ? info.code : 'hub_error'
      const status = code === 'timeout' ? 504 : code === 'too_many_streams' ? 503 : 502
      settle('error', status, code, info?.reason || 'the hub failed the request')
    })

    stream.on('close', () => {
      if (finished) return
      settle('error', 502, 'hub_offline', 'the hub disconnected mid-request')
    })

    // Client went away before the response settled: abort the hub stream.
    res.on('close', () => {
      if (finished) return
      try {
        stream.reset('client_aborted', 'the client closed the connection')
      } catch {
        // already settled
      }
      settle('destroy')
    })

    await writeRequestBody(stream, body)
  }

  /** Main HTTP request router. */
  async function handleRequest(req, res) {
    const rawUrl = typeof req.url === 'string' && req.url !== '' ? req.url : '/'
    const pathname = rawUrl.split('?')[0]

    if (pathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD')
        sendJson(res, 405, { error: 'method_not_allowed', message: 'use GET' })
        return
      }
      sendJson(res, 200, { ok: true, hubs: [...hubs.keys()] }, req.method === 'HEAD')
      return
    }
    if (pathname === '/ws') {
      sendJson(res, 426, {
        error: 'upgrade_required',
        message: 'connect to /ws with a WebSocket upgrade (hub dial-in)',
      })
      return
    }
    if (pathname.startsWith('/r/')) {
      await forwardRequest(req, res, rawUrl)
      return
    }
    sendJson(res, 404, { error: 'not_found', message: `no route for ${pathname}` })
  }

  /** Hub dial-in upgrade: validate, enforce single-owner, register the link. */
  function upgradeHub(req, socket, head, rawUrl) {
    let url
    try {
      url = new URL(rawUrl, 'http://relay.local')
    } catch {
      counters.rejectedUpgrades += 1
      rejectUpgrade(socket, 400, { error: 'bad_request', message: 'malformed upgrade URL' })
      return
    }
    const key = req.headers['sec-websocket-key']
    const version = req.headers['sec-websocket-version']
    if (typeof key !== 'string' || key === '' || version !== '13') {
      counters.rejectedUpgrades += 1
      rejectUpgrade(socket, 400, {
        error: 'bad_handshake',
        message: 'a WebSocket v13 handshake (Sec-WebSocket-Key/Version) is required',
      })
      return
    }
    const hubId = url.searchParams.get('hub') ?? ''
    const role = url.searchParams.get('role') ?? ''
    if (!HUB_ID_RE.test(hubId)) {
      counters.rejectedUpgrades += 1
      rejectUpgrade(socket, 400, { error: 'bad_hub', message: 'hub must be a valid hub id' })
      return
    }
    if (role === 'client') {
      counters.rejectedUpgrades += 1
      rejectUpgrade(socket, 501, {
        error: 'not_implemented',
        message: 'role=client data sockets arrive in relay S2',
      })
      return
    }
    if (role !== 'hub') {
      counters.rejectedUpgrades += 1
      rejectUpgrade(socket, 400, { error: 'bad_role', message: "role must be 'hub'" })
      return
    }
    const existing = hubs.get(hubId)
    if (existing !== undefined && existing.peer.open === true) {
      counters.rejectedUpgrades += 1
      rejectUpgrade(socket, 409, {
        error: 'hub_taken',
        message: `hub ${hubId} already has a live socket`,
      })
      return
    }

    // Accept the handshake only after every check passed.
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${webSocketAccept(key)}\r\n\r\n`,
      )
    } catch {
      socket.destroy()
      return
    }
    try {
      socket.setNoDelay?.(true)
    } catch {
      // best effort
    }

    const peer = createWsPeer({
      socket,
      masked: false,
      expectMasked: true,
      maxMessageBytes: maxWsMessageBytes,
      log,
    })
    const channel = createLinkChannel({
      role: 'client',
      send: (bytes) => peer.send(bytes),
      maxStreams: maxStreamsPerHub,
      pause: () => peer.pause(),
      resume: () => peer.resume(),
      log,
    })
    const conn = createHubConnection(hubId, peer, channel, socket, normalizeAddress(req.socket?.remoteAddress))
    hubs.set(hubId, conn)
    counters.wsUpgrades += 1
    logLine('info', `[relay] hub ${hubId} connected from ${conn.remoteAddress}`)

    peer.on('message', (bytes) => channel.receive(bytes))
    peer.on('drain', () => channel.drain())
    peer.on('error', (error) => {
      logLine('warn', `[relay] hub ${hubId} socket error: ${error?.message ?? error}`)
    })
    peer.on('close', () => {
      if (hubs.get(hubId) === conn) {
        hubs.delete(hubId)
        counters.hubDisconnects += 1
      }
      channel.close('hub_disconnected')
      logLine('info', `[relay] hub ${hubId} disconnected`)
    })
    socket.on('drain', () => channel.drain())
    peer.feed(head)
  }

  /** HTTP upgrade dispatcher: `/ws` is the only upgrade route in S1. */
  function handleUpgrade(req, socket, head) {
    socket.on('error', () => {
      // A failed upgrade must never crash the server.
    })
    const rawUrl = typeof req.url === 'string' && req.url !== '' ? req.url : '/'
    const pathname = rawUrl.split('?')[0]
    if (pathname === '/ws') {
      upgradeHub(req, socket, head, rawUrl)
      return
    }
    if (pathname.startsWith('/r/')) {
      counters.rejectedUpgrades += 1
      rejectUpgrade(socket, 501, {
        error: 'not_implemented',
        message: 'WebSocket passthrough through /r/ is relay S2, not S1',
      })
      return
    }
    counters.rejectedUpgrades += 1
    rejectUpgrade(socket, 404, { error: 'not_found', message: 'unknown upgrade path' })
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      logLine('error', `[relay] request failed: ${error?.stack ?? error}`)
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error', message: 'the relay failed to handle the request' })
      } else if (!res.destroyed) {
        res.destroy()
      }
    })
  })
  server.on('upgrade', handleUpgrade)
  server.on('clientError', (error, socket) => {
    if (socket !== null && socket.writable === true && socket.destroyed !== true) {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      } catch {
        socket.destroy()
      }
    }
  })

  /** Resolve the externally usable address (wildcard listeners → loopback). */
  function address() {
    const bound = server.address()
    if (bound === null || typeof bound === 'string') return { host, port: null, url: null }
    const advertisedHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
    const formatted = advertisedHost.includes(':') ? `[${advertisedHost}]` : advertisedHost
    return { host: advertisedHost, port: bound.port, url: `http://${formatted}:${bound.port}` }
  }

  return {
    /** The underlying `node:http` server (escape hatch for tests/embedding). */
    server,

    /**
     * Start listening.
     * @returns {Promise<{host: string, port: number, url: string}>} bound address.
     */
    async listen() {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
      return address()
    },

    /**
     * Close the relay: drop every hub socket and stop accepting connections.
     * @returns {Promise<void>}
     */
    async close() {
      for (const conn of [...hubs.values()]) {
        try {
          conn.peer.destroy()
        } catch {
          // ignore
        }
      }
      hubs.clear()
      server.closeAllConnections?.()
      await new Promise((resolve) => {
        server.close(() => resolve())
      })
    },

    /** Bound address, or `{host, port: null, url: null}` before `listen()`. */
    address,

    /** Hub ids with a live socket. @returns {string[]} */
    hubIds() {
      return [...hubs.keys()]
    },

    /**
     * Drop one hub socket (used by tests and future admin endpoints).
     * @param {string} hubId - hub id.
     * @param {number} [code] - RFC 6455 close code.
     * @param {string} [reason] - close reason.
     * @returns {boolean} true when a live socket was dropped.
     */
    disconnectHub(hubId, code = 1011, reason = 'relay_disconnect') {
      const conn = hubs.get(hubId)
      if (conn === undefined) return false
      conn.peer.close(code, reason)
      return true
    },

    /** Counter snapshot. @returns {object} frozen counters. */
    stats() {
      let openStreams = 0
      for (const conn of hubs.values()) openStreams += conn.channel.stats().open
      return Object.freeze({
        hubs: hubs.size,
        openStreams,
        ...counters,
      })
    },
  }
}
