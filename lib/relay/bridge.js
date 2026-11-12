/**
 * Hub side replayer for relayed HTTP requests and WebSocket upgrades
 * (docs/relay-design.md §6.1, §9, §13, S2).
 *
 * The relay never reaches into the hub's network: it opens an `http_open` or
 * `ws_open` mux stream, and this module turns that stream into **one** request
 * (or one WebSocket handshake) against the hub's own local web server. The
 * design calls this the SSRF boundary, so the rules are deliberately narrow:
 *
 * - the target must be path-only (`/…`), never an absolute URL, never
 *   protocol-relative (`//host`), never contain a `..` segment (raw or
 *   percent-encoded), never contain a backslash/NUL/control character;
 * - the resolved URL must still have the fixed local origin — a second,
 *   independent check on top of the textual rules;
 * - the `Host` header is always overwritten with the local listener authority,
 *   so a caller cannot point a virtual host or an internal service at the hub;
 * - only ordinary methods are allowed (`CONNECT`/`TRACE` are rejected).
 *
 * The response is streamed back as `http_head` / `http_data` / `http_end`
 * (SSE and large bodies are never buffered), with backpressure flowing the
 * other way through `stream.pause()`/`stream.resume()`. Every failure becomes
 * a single short `http_error` code (`bad_request`, `upstream_error`,
 * `timeout`) — or a truncated-but-clean end when the head was already sent.
 *
 * For a `ws_open` stream (S2) the bridge performs a **client-side** RFC 6455
 * handshake (`node:http` `upgrade`) against the same local origin, accepts the
 * stream with a `101` head, and then relays whole WebSocket messages in both
 * directions. Fragmentation is reassembled on both sides (a WebSocket message
 * is atomic to the browser and to the local server), and messages larger than
 * one 64 KiB wire payload are chunked by the link channel.
 *
 * Node builtins only.
 */

import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'

import { createWsPeer, filterHopByHopHeaders, webSocketAccept } from './hub-link.js'

/** Methods the bridge is willing to replay (no CONNECT/TRACE tunnelling). */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** Upper bound for a forwarded request target (defensive, not a protocol rule). */
const MAX_TARGET_LENGTH = 16 * 1024

/** Default first-byte timeout for the local origin (design §7.4). */
const DEFAULT_TIMEOUT_MS = 30000

/** Default largest reassembled WebSocket message (matches the relay cap). */
const DEFAULT_MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024

/** Format an authority for the `Host` header (brackets for IPv6 literals). */
function formatAuthority(host, port) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

/**
 * Validate the requested target against the fixed local origin.
 *
 * @param {unknown} rawPath - `meta.path` from `http_open`.
 * @param {unknown} rawMethod - `meta.method` from `http_open`.
 * @param {string} origin - `http://host:port` of the local listener.
 * @returns {{ok: true, method: string, url: URL, path: string} |
 *   {ok: false, code: string, message: string}} validation result.
 */
function validateTarget(rawPath, rawMethod, origin) {
  if (typeof rawMethod !== 'string') return { ok: false, code: 'bad_method', message: 'method must be a string' }
  const method = rawMethod.toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, code: 'bad_method', message: `method ${method} is not replayable` }
  }
  if (typeof rawPath !== 'string' || rawPath === '') {
    return { ok: false, code: 'bad_path', message: 'path must be a non-empty string' }
  }
  if (rawPath.length > MAX_TARGET_LENGTH) {
    return { ok: false, code: 'bad_path', message: 'path is too long' }
  }
  if (rawPath[0] !== '/') {
    return { ok: false, code: 'bad_path', message: 'path must start with /' }
  }
  if (rawPath.startsWith('//')) {
    return { ok: false, code: 'bad_path', message: 'protocol-relative URLs are not allowed' }
  }
  // `scheme:` prefix (http://, https://, file:, …) is an absolute URL.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawPath)) {
    return { ok: false, code: 'bad_path', message: 'absolute URLs are not allowed' }
  }
  if (/[\\\u0000-\u001f\u007f]/.test(rawPath)) {
    return { ok: false, code: 'bad_path', message: 'path contains forbidden characters' }
  }

  let decoded
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return { ok: false, code: 'bad_path', message: 'path is not valid percent-encoding' }
  }
  if (/[\\\u0000-\u001f\u007f]/.test(decoded)) {
    return { ok: false, code: 'bad_path', message: 'decoded path contains forbidden characters' }
  }
  const rawPathOnly = rawPath.split('?')[0]
  const decodedPathOnly = decoded.split('?')[0]
  const hasTraversal = (value) => value.split('/').some((segment) => segment === '..')
  if (hasTraversal(rawPathOnly) || hasTraversal(decodedPathOnly)) {
    return { ok: false, code: 'bad_path', message: 'path traversal is not allowed' }
  }

  let url
  try {
    url = new URL(rawPath, origin)
  } catch {
    return { ok: false, code: 'bad_path', message: 'path cannot be resolved' }
  }
  // Independent origin check: even if a textual rule above is ever loosened,
  // a path-only URL can never leave the fixed local origin.
  if (url.origin !== origin) {
    return { ok: false, code: 'bad_path', message: 'path escapes the local origin' }
  }
  if (!url.pathname.startsWith('/')) {
    return { ok: false, code: 'bad_path', message: 'resolved path must be absolute' }
  }
  return { ok: true, method, url, path: `${url.pathname}${url.search}` }
}

/**
 * Copy request headers for the local origin: hop-by-hop removed and `Host`
 * forced to the listener authority.
 *
 * @param {object|undefined|null} rawHeaders - relayed request headers.
 * @param {string} authority - `host:port` of the local listener.
 * @param {number|undefined} bodyLen - declared body length, if the relay knew it.
 * @returns {Record<string, string|string[]>} headers for the origin request.
 */
function buildRequestHeaders(rawHeaders, authority, bodyLen) {
  const headers = filterHopByHopHeaders(rawHeaders)
  delete headers.host
  delete headers.Host
  headers.host = authority
  // Trust the relay's declared length over a stale client header, but never
  // invent a length: Node falls back to chunked encoding when it is absent.
  if (Number.isSafeInteger(bodyLen) && bodyLen >= 0 && headers['content-length'] !== undefined) {
    headers['content-length'] = String(bodyLen)
  }
  return headers
}

/**
 * Create the hub side replayer.
 *
 * @param {object} options - bridge options.
 * @param {number} options.port - local DSH web server port.
 * @param {string} [options.host] - local listener host (`127.0.0.1`).
 * @param {number} [options.timeoutMs] - first-byte timeout for the origin (30000).
 * @param {number} [options.maxWsMessageBytes] - largest reassembled WebSocket
 *   message (8 MiB, matching the relay ingress cap).
 * @param {(level: string, message: string) => void} [options.log] - optional logger.
 * @returns {{handle: (stream: object) => void}} the bridge.
 */
export function createBridge(options) {
  const {
    port,
    host = '127.0.0.1',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxWsMessageBytes = DEFAULT_MAX_WS_MESSAGE_BYTES,
    log = null,
  } = options ?? {}

  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`createBridge requires a port between 1 and 65535, got ${String(port)}`)
  }
  if (typeof host !== 'string' || host === '') {
    throw new TypeError('createBridge requires a host string')
  }
  // A wildcard listener cannot be dialed; the loopback address can.
  const connectHost = host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host
  const authority = formatAuthority(connectHost, port)
  const origin = `http://${authority}`

  /** Optional logger that can never throw into a request callback. */
  function logLine(level, message) {
    if (log === null || typeof log !== 'function') return
    try {
      log(level, message)
    } catch {
      // ignore
    }
  }

  /**
   * Handle one inbound relay stream: replay an HTTP request, or open a
   * WebSocket against the local origin. This is the single entry point the hub
   * link hands every `http_open`/`ws_open` stream to.
   *
   * @param {object} stream - inbound mux stream (kind `'http'` or `'ws'`).
   * @returns {void}
   */
  function handle(stream) {
    if (stream === null || typeof stream !== 'object') return
    if (typeof stream.on !== 'function' || typeof stream.write !== 'function') {
      throw new TypeError('bridge.handle requires a relay stream handle')
    }
    if (stream.kind === 'http') {
      replayHttp(stream)
      return
    }
    if (stream.kind === 'ws') {
      openWebSocket(stream)
      return
    }
    stream.fail?.('unsupported_stream', `bridge cannot replay a '${String(stream.kind)}' stream`)
  }

  /**
   * Replay one inbound `http` stream against the local origin.
   *
   * The stream contract is the one `createLinkChannel` attaches:
   * `stream.meta` (`{method, path, headers, bodyLen}`), `stream.kind`,
   * `stream.on('data'|'end'|'reset'|'drain'|'close')`, `stream.write(chunk)`,
   * `stream.writeHead(status, headers)`, `stream.end()`, `stream.fail(code)`.
   *
   * @param {object} stream - inbound mux stream (kind `'http'`).
   * @returns {void}
   */
  function replayHttp(stream) {
    const meta = stream.meta !== null && typeof stream.meta === 'object' ? stream.meta : {}
    const target = validateTarget(meta.path, meta.method, origin)
    if (!target.ok) {
      stream.fail('bad_request', target.message)
      return
    }

    const headers = buildRequestHeaders(meta.headers, authority, meta.bodyLen)
    let settled = false
    let headSent = false
    let timedOut = false
    let bodyPaused = false
    let upstream = null
    let request = null
    let headTimer = null

    /** Clear timers, abort the origin request/response, and unpause the link. */
    function cleanup() {
      if (headTimer !== null) {
        clearTimeout(headTimer)
        headTimer = null
      }
      // A request-body backpressure pause is link-wide; never leave it on when
      // this stream settles (the origin or the client may have gone away).
      if (bodyPaused) {
        bodyPaused = false
        try {
          stream.resume?.()
        } catch {
          // ignore
        }
      }
      if (upstream !== null) {
        try {
          upstream.destroy()
        } catch {
          // ignore
        }
        upstream = null
      }
      if (request !== null) {
        try {
          request.destroy()
        } catch {
          // ignore
        }
        request = null
      }
    }

    /** Fail the stream with one short code (no-op after settlement). */
    function fail(code, message) {
      if (settled) return
      settled = true
      cleanup()
      try {
        stream.fail(code, message)
      } catch {
        // The peer may already be gone; settlement is still ours to record.
      }
    }

    /** Finish the response body cleanly (used after the head was sent). */
    function finish() {
      if (settled) return
      settled = true
      cleanup()
      try {
        stream.end()
      } catch {
        // stream already closed by the peer
      }
    }

    try {
      request = httpRequest({
        host: connectHost,
        port,
        method: target.method,
        path: target.path,
        headers,
      })
    } catch (error) {
      fail('upstream_error', error?.message ?? 'origin request failed')
      return
    }

    // First-byte timeout: an origin that accepts the connection but never
    // answers must not pin a relay stream forever.
    headTimer = setTimeout(() => {
      headTimer = null
      if (settled) return
      timedOut = true
      fail('timeout', 'the local origin did not respond in time')
    }, timeoutMs)
    headTimer.unref?.()

    request.on('response', (response) => {
      if (settled) {
        response.destroy()
        return
      }
      if (headTimer !== null) {
        clearTimeout(headTimer)
        headTimer = null
      }
      upstream = response
      const status = Number(response.statusCode)
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        fail('upstream_error', `origin returned an invalid status ${String(response.statusCode)}`)
        return
      }
      headSent = true
      try {
        stream.writeHead(status, filterHopByHopHeaders(response.headers))
      } catch (error) {
        fail('upstream_error', error?.message ?? 'could not write the response head')
        return
      }

      response.on('data', (chunk) => {
        if (settled) return
        let writable = true
        try {
          writable = stream.write(chunk) !== false
        } catch {
          fail('stream_closed', 'the relay stream closed while streaming the body')
          return
        }
        // Per-stream backpressure: pause the origin, resume on mux drain.
        if (!writable) response.pause()
      })
      stream.on('drain', () => {
        if (!settled && upstream !== null) upstream.resume()
      })
      response.on('end', () => finish())
      response.on('aborted', () => {
        if (settled) return
        // Head already sent: end the relay stream rather than emit an error
        // frame after a head (which the relay would have to discard).
        if (headSent) finish()
        else fail('upstream_error', 'the origin aborted the response')
      })
      response.on('error', (error) => {
        if (settled) return
        logLine('warn', `[relay-bridge] origin response error: ${error?.message ?? error}`)
        if (headSent) finish()
        else fail(timedOut ? 'timeout' : 'upstream_error', error?.message ?? 'origin response failed')
      })
    })

    request.on('error', (error) => {
      if (settled) return
      logLine('warn', `[relay-bridge] origin request error: ${error?.message ?? error}`)
      if (headSent) finish()
      else fail(timedOut ? 'timeout' : 'upstream_error', error?.message ?? 'origin request failed')
    })

    // Request body: stream it through with backpressure, bounded by the relay's
    // 8 MiB ingress cap (the relay never opens a stream without that cap).
    stream.on('data', (chunk) => {
      if (settled) return
      let writable = true
      try {
        writable = request.write(chunk) !== false
      } catch {
        fail('stream_closed', 'the relay stream closed while forwarding the body')
        return
      }
      if (!writable) {
        bodyPaused = true
        stream.pause()
        request.once('drain', () => {
          if (!bodyPaused) return
          bodyPaused = false
          if (!settled) stream.resume()
        })
      }
    })
    stream.on('end', () => {
      if (settled) return
      try {
        request.end()
      } catch (error) {
        fail('upstream_error', error?.message ?? 'could not finish the origin request')
      }
    })
    // Peer cancellation (relay timeout/client abort) aborts the origin request.
    stream.on('reset', () => {
      if (settled) return
      settled = true
      cleanup()
    })
    // Link teardown: nothing to answer, just release the origin socket.
    stream.on('close', () => {
      if (settled) return
      settled = true
      cleanup()
    })
  }

  /**
   * Open one inbound `ws` stream against the local origin (S2).
   *
   * The bridge is the **client** of the local handshake: it generates its own
   * `Sec-WebSocket-Key`, verifies the origin's `Sec-WebSocket-Accept`, and only
   * then accepts the relay stream (one `101` head). The relay writes its own
   * 101 to the browser — it knows the browser key — so the accept value never
   * crosses the wire.
   *
   * Messages are atomic at both ends: the local peer reassembles fragmented
   * frames, and the link channel chunks anything over 64 KiB on the wire. A
   * close from either end is forwarded as one `ws_close`; a refusal from the
   * local origin (e.g. 401) is forwarded as a `rejectWs` head so the browser
   * sees the real status instead of a generic 502.
   *
   * @param {object} stream - inbound mux stream (kind `'ws'`).
   * @returns {void}
   */
  function openWebSocket(stream) {
    const meta = stream.meta !== null && typeof stream.meta === 'object' ? stream.meta : {}
    const target = validateTarget(meta.path, 'GET', origin)
    if (!target.ok) {
      stream.fail('bad_request', target.message)
      return
    }

    // The local handshake is generated here; only application headers are
    // forwarded (the relay already dropped hop-by-hop/websocket-specific ones).
    const key = randomBytes(16).toString('base64')
    const headers = buildRequestHeaders(meta.headers, authority, undefined)
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
    headers['sec-websocket-version'] = '13'
    headers['sec-websocket-key'] = key

    let settled = false
    let peer = null
    let request = null
    let originSocket = null
    let headTimer = null
    let originPaused = false
    let relayPaused = false

    /** Clear the handshake timer and destroy every local socket/peer. */
    function cleanup() {
      if (headTimer !== null) {
        clearTimeout(headTimer)
        headTimer = null
      }
      // A relay→local backpressure pause is link-wide; never leave it on when
      // this stream settles. (The local-side pause dies with the peer below.)
      if (relayPaused) {
        relayPaused = false
        try {
          stream.resume?.()
        } catch {
          // ignore
        }
      }
      originPaused = false
      if (peer !== null) {
        try {
          peer.destroy()
        } catch {
          // ignore
        }
        peer = null
      }
      if (originSocket !== null) {
        try {
          originSocket.destroy()
        } catch {
          // ignore
        }
        originSocket = null
      }
      if (request !== null) {
        try {
          request.destroy()
        } catch {
          // ignore
        }
        request = null
      }
    }

    /** Fail the stream once (the relay turns this into a 502/504). */
    function fail(code, message) {
      if (settled) return
      settled = true
      cleanup()
      try {
        stream.fail(code, message)
      } catch {
        // peer already gone; settlement is recorded either way
      }
    }

    // Registered before the handshake starts: a relay-side timeout or link
    // teardown must abort the local connection too, not leave it pending.
    stream.on('reset', () => {
      if (settled) return
      settled = true
      cleanup()
    })
    stream.on('close', () => {
      if (settled) return
      settled = true
      cleanup()
    })

    try {
      request = httpRequest({
        host: connectHost,
        port,
        method: 'GET',
        path: target.path,
        headers,
      })
    } catch (error) {
      fail('upstream_error', error?.message ?? 'origin upgrade request failed')
      return
    }

    // The local origin may accept the TCP connection and never answer the
    // upgrade; a relay stream must not be pinned by that.
    headTimer = setTimeout(() => {
      headTimer = null
      if (settled) return
      fail('timeout', 'the local origin did not accept the WebSocket upgrade in time')
    }, timeoutMs)
    headTimer.unref?.()

    request.on('upgrade', (response, socket, head) => {
      if (settled) {
        try {
          socket.destroy()
        } catch {
          // ignore
        }
        return
      }
      if (headTimer !== null) {
        clearTimeout(headTimer)
        headTimer = null
      }
      if (response.headers['sec-websocket-accept'] !== webSocketAccept(key)) {
        try {
          socket.destroy()
        } catch {
          // ignore
        }
        fail('upstream_error', 'the local origin sent an invalid Sec-WebSocket-Accept')
        return
      }
      originSocket = socket
      try {
        socket.setNoDelay?.(true)
      } catch {
        // best effort
      }

      // Pass through the only 101 headers a browser cares about.
      const acceptHeaders = {}
      const protocol = response.headers['sec-websocket-protocol']
      if (typeof protocol === 'string' && protocol !== '') acceptHeaders['sec-websocket-protocol'] = protocol
      const cookies = response.headers['set-cookie']
      if (cookies !== undefined) acceptHeaders['set-cookie'] = cookies
      try {
        stream.acceptWs(acceptHeaders)
      } catch (error) {
        fail('upstream_error', error?.message ?? 'could not accept the relay stream')
        return
      }

      peer = createWsPeer({
        socket,
        masked: true,
        expectMasked: false,
        maxMessageBytes: maxWsMessageBytes,
        allowText: true,
        log,
      })

      // Local origin → relay: one whole message per `ws_frame` (chunked by the
      // channel when it is larger than 64 KiB).
      peer.on('message', (payload, kind) => {
        if (settled) return
        let writable = true
        try {
          writable = stream.writeWs(kind, payload) !== false
        } catch {
          fail('stream_closed', 'the relay stream closed while forwarding a frame')
          return
        }
        if (!writable) {
          originPaused = true
          peer.pause()
        }
      })
      stream.on('drain', () => {
        if (!originPaused) return
        originPaused = false
        if (!settled && peer !== null) peer.resume()
      })

      // Relay → local origin: a whole message, as one unfragmented frame.
      stream.on('message', ({ kind, data }) => {
        if (settled || peer === null) return
        let writable = true
        try {
          writable = peer.send(data, kind) !== false
        } catch {
          fail('stream_closed', 'the local origin closed while forwarding a frame')
          return
        }
        if (!writable) {
          relayPaused = true
          stream.pause?.()
          peer.once('drain', () => {
            if (!relayPaused) return
            relayPaused = false
            if (!settled) stream.resume?.()
          })
        }
      })

      // The browser side closed: forward the close code to the local origin.
      stream.on('ws_close', ({ code, reason }) => {
        if (settled) return
        settled = true
        if (headTimer !== null) {
          clearTimeout(headTimer)
          headTimer = null
        }
        // Release a link-wide pause before the stream goes away, otherwise the
        // whole hub socket would stay paused.
        if (relayPaused) {
          relayPaused = false
          try {
            stream.resume?.()
          } catch {
            // ignore
          }
        }
        const closing = peer
        peer = null
        if (closing !== null) {
          try {
            closing.close(code, reason)
          } catch {
            // ignore
          }
        }
      })

      // Local origin closed: one clean close frame back through the tunnel.
      peer.on('close', ({ code, reason }) => {
        if (settled) return
        settled = true
        cleanup()
        try {
          stream.closeWs(code, reason)
        } catch {
          // stream already settled by the peer
        }
      })

      peer.on('error', (error) => {
        logLine('warn', `[relay-bridge] local WebSocket error: ${error?.message ?? error}`)
      })

      peer.feed(head)
    })

    request.on('response', (response) => {
      // The local origin refused the upgrade with an ordinary HTTP response.
      if (settled) {
        response.destroy()
        return
      }
      if (headTimer !== null) {
        clearTimeout(headTimer)
        headTimer = null
      }
      const status = Number(response.statusCode)
      const safe = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502
      try {
        stream.rejectWs(safe, filterHopByHopHeaders(response.headers))
      } catch {
        // ignore: the fail() below settles the stream
      }
      // Discard the (bounded) rejection body; the relay writes its own JSON.
      response.resume()
      fail('upgrade_rejected', `the local origin answered HTTP ${status}`)
    })

    request.on('error', (error) => {
      if (settled) return
      logLine('warn', `[relay-bridge] local upgrade error: ${error?.message ?? error}`)
      fail('upstream_error', error?.message ?? 'origin upgrade request failed')
    })

    request.end()
  }

  return { handle }
}
