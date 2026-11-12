/**
 * Hub side of the relay tunnel (docs/relay-design.md §6.2, §7, S1).
 *
 * This module owns three things, all of them hub-side or transport-level:
 *
 * 1. **RFC 6455 framing** — the project is zero-dependency, so both ends of
 *    the WebSocket hand-rolled here: `encodeWsFrame`, `WsFrameParser`,
 *    `webSocketAccept` and `createWsPeer`. The relay server
 *    (`relay/main.mjs`) reuses the exact same code for the server half, so
 *    there is one framing implementation, not two.
 * 2. **The S0 ↔ HTTP stream adapter** — `createLinkChannel` binds
 *    `lib/relay/wire.js` (binary opcodes) to `lib/relay/mux.js` (stream
 *    lifecycle) and exposes the small HTTP-shaped stream interface the bridge
 *    consumes: `stream.meta`, `stream.on('data'|'end'|'reset'|'drain')`,
 *    `stream.writeHead(status, headers)`, `stream.write(chunk)`,
 *    `stream.end()`, `stream.reset(code, message)`.
 * 3. **The dialer** — `createHubLink` keeps an outbound `wss://…/ws?hub=…&role=hub`
 *    socket alive: exponential reconnect with jitter, an application-level
 *    wire `ping`/`pong` heartbeat, and stream dispatch to the bridge.
 *
 * Design decisions worth knowing (S1 write scope is five files, so the shared
 * pieces live here rather than in a sixth module):
 *
 * - the relay is the mux `client` (odd stream ids) and the hub is the mux
 *   `hub` (even ids); the hub never opens streams in S1;
 * - `http_head` is not a mux op (the mux vocabulary is open/data/end/reset/
 *   goaway), so `stream.writeHead()` writes one `HTTP_HEAD` frame directly.
 *   It is always sent before the first body byte of that stream, so ordering
 *   is preserved without a second queue;
 * - a mux `reset` is encoded as wire `HTTP_ERROR` (one frame, one settlement
 *   path); an inbound `HTTP_ERROR` is applied as a mux `reset`;
 * - `ws_*` opcodes are counted and ignored — S2 owns them.
 */

import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import { FrameDecoder, MAX_PAYLOAD_BYTES, OPCODES, encodeFrame } from './wire.js'
import { createMux } from './mux.js'

/** RFC 6455 handshake GUID (server: SHA-1 of key + this). */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** RFC 6455 opcodes (distinct from the relay wire opcodes in wire.js). */
export const WS_OPCODES = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
})

/** Control frames carry at most 125 bytes (RFC 6455 §5.5). */
export const MAX_CONTROL_PAYLOAD = 125

/** Default outbound WebSocket message ceiling (wire frames are ≤ 64 KiB). */
export const DEFAULT_MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024

/** Default reconnect backoff floor/ceiling (design §4.1, §7). */
export const DEFAULT_RECONNECT_BASE_MS = 1500
export const DEFAULT_RECONNECT_MAX_MS = 30000

/** Default application heartbeat: one wire ping every 10 s, two misses = dead. */
export const DEFAULT_PING_INTERVAL_MS = 10000
export const DEFAULT_MAX_MISSED_PONGS = 2

const EMPTY = Buffer.alloc(0)

/**
 * Small listener registry. A throwing listener never breaks the peer/channel;
 * the peer's only job is to keep framing and settlement honest.
 * @returns {{on: Function, once: Function, off: Function, clear: Function, emit: Function}}
 */
function createEmitter() {
  /** @type {Map<string, Array<{ fn: Function, once: boolean }>>} */
  const registry = new Map()
  const emitter = {
    on(event, fn) {
      if (typeof fn !== 'function') return emitter
      const list = registry.get(event) ?? []
      list.push({ fn, once: false })
      registry.set(event, list)
      return emitter
    },
    once(event, fn) {
      if (typeof fn !== 'function') return emitter
      const list = registry.get(event) ?? []
      list.push({ fn, once: true })
      registry.set(event, list)
      return emitter
    },
    off(event, fn) {
      const list = registry.get(event)
      if (list === undefined) return emitter
      const index = list.findIndex((entry) => entry.fn === fn)
      if (index !== -1) list.splice(index, 1)
      if (list.length === 0) registry.delete(event)
      return emitter
    },
    clear() {
      registry.clear()
    },
    emit(event, ...args) {
      const list = registry.get(event)
      if (list === undefined) return false
      for (const entry of [...list]) {
        if (entry.once) emitter.off(event, entry.fn)
        try {
          entry.fn(...args)
        } catch {
          // Never let a listener break framing/settlement for the other side.
        }
      }
      return true
    },
  }
  return emitter
}

/**
 * The `Sec-WebSocket-Accept` value for a client key.
 * @param {string} key - the `Sec-WebSocket-Key` header value.
 * @returns {string} base64(SHA-1(key + GUID)).
 */
export function webSocketAccept(key) {
  return createHash('sha1').update(`${String(key)}${WS_GUID}`).digest('base64')
}

/** Coerce a frame payload to a Buffer (no copy for Buffer). */
function asBuffer(payload) {
  if (payload === undefined || payload === null) return EMPTY
  if (Buffer.isBuffer(payload)) return payload
  if (payload instanceof Uint8Array) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8')
  throw new TypeError('WebSocket payload must be a Buffer, Uint8Array or string')
}

/**
 * Encode one RFC 6455 frame.
 *
 * @param {number} opcode - one of `WS_OPCODES`.
 * @param {Buffer|Uint8Array|string} [payload] - frame body.
 * @param {object} [options] - encoding options.
 * @param {boolean} [options.mask] - mask the payload (client → server frames
 *   MUST be masked; server → client frames MUST NOT be).
 * @returns {Buffer} the encoded frame (header + masked/unmasked payload).
 */
export function encodeWsFrame(opcode, payload = EMPTY, options = {}) {
  const body = asBuffer(payload)
  const mask = options.mask === true
  const length = body.length
  const lengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8
  const headerBytes = 2 + lengthBytes + (mask ? 4 : 0)
  const frame = Buffer.allocUnsafe(headerBytes + length)
  frame[0] = 0x80 | (opcode & 0x0f)
  if (length < 126) {
    frame[1] = (mask ? 0x80 : 0) | length
  } else if (length <= 0xffff) {
    frame[1] = (mask ? 0x80 : 0) | 126
    frame.writeUInt16BE(length, 2)
  } else {
    frame[1] = (mask ? 0x80 : 0) | 127
    frame.writeBigUInt64BE(BigInt(length), 2)
  }
  let offset = 2 + lengthBytes
  if (mask) {
    const key = randomBytes(4)
    key.copy(frame, offset)
    offset += 4
    for (let index = 0; index < length; index += 1) {
      frame[offset + index] = body[index] ^ key[index & 3]
    }
  } else {
    body.copy(frame, offset)
  }
  return frame
}

/**
 * A WebSocket protocol violation. Carries the RFC close code the peer should
 * be told before the socket is torn down.
 */
export class WsProtocolError extends Error {
  /**
   * @param {string} code - stable machine-readable detail code.
   * @param {number} closeCode - RFC 6455 close code to send.
   * @param {string} message - human-readable detail (logged, not sent raw).
   */
  constructor(code, closeCode, message) {
    super(message)
    this.name = 'WsProtocolError'
    this.code = code
    this.closeCode = closeCode
  }
}

/**
 * Incremental RFC 6455 frame parser for arbitrary split/coalesced chunks.
 *
 * It returns whole frames only and retains at most one partial frame, so a
 * hostile length cannot make it allocate more than `maxFrameBytes`. Masking is
 * enforced by `expectMasked` (servers require masked client frames, clients
 * require unmasked server frames) and RSV bits must be zero (no extensions).
 */
export class WsFrameParser {
  /**
   * @param {object} [options] - parser options.
   * @param {boolean} [options.expectMasked] - true on the server side.
   * @param {number} [options.maxFrameBytes] - hard per-frame payload cap.
   */
  constructor(options = {}) {
    this.buffer = EMPTY
    this.expectMasked = options.expectMasked !== false
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_WS_MESSAGE_BYTES
    this.broken = false
  }

  /**
   * Feed one chunk and return every frame it completed.
   * @param {Buffer|Uint8Array} chunk - arbitrary slice of the socket stream.
   * @returns {Array<{fin: boolean, opcode: number, payload: Buffer}>} frames.
   * @throws {WsProtocolError} on a malformed/oversize/unmasked frame.
   */
  push(chunk) {
    if (this.broken) {
      throw new WsProtocolError('parser-broken', 1002, 'the WebSocket frame parser hit an error')
    }
    if (chunk === undefined || chunk === null) return []
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (bytes.length === 0) return []
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes])
    const frames = []
    try {
      for (;;) {
        const frame = this.readFrame()
        if (frame === null) break
        frames.push(frame)
      }
    } catch (error) {
      this.broken = true
      this.buffer = EMPTY
      throw error
    }
    return frames
  }

  /** Parse one frame from the buffer, or return null when more bytes are needed. */
  readFrame() {
    const buffer = this.buffer
    if (buffer.length < 2) return null
    const first = buffer[0]
    const second = buffer[1]
    const fin = (first & 0x80) !== 0
    const rsv = first & 0x70
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    if (rsv !== 0) throw new WsProtocolError('bad-rsv', 1002, 'reserved WebSocket bits must be zero')
    if (masked !== this.expectMasked) {
      throw new WsProtocolError(
        'bad-masking',
        1002,
        this.expectMasked ? 'client frames must be masked' : 'server frames must not be masked',
      )
    }
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return null
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return null
      const big = buffer.readBigUInt64BE(2)
      if (big > BigInt(this.maxFrameBytes)) {
        throw new WsProtocolError('frame-too-large', 1009, `frame payload ${big} B exceeds the limit`)
      }
      length = Number(big)
      offset = 10
    }
    if (length > this.maxFrameBytes) {
      throw new WsProtocolError('frame-too-large', 1009, `frame payload ${length} B exceeds the limit`)
    }
    let maskKey = null
    if (masked) {
      if (buffer.length < offset + 4) return null
      maskKey = buffer.subarray(offset, offset + 4)
      offset += 4
    }
    if (buffer.length < offset + length) return null
    let payload
    if (masked) {
      payload = Buffer.allocUnsafe(length)
      for (let index = 0; index < length; index += 1) {
        payload[index] = buffer[offset + index] ^ maskKey[index & 3]
      }
    } else {
      payload = Buffer.from(buffer.subarray(offset, offset + length))
    }
    const end = offset + length
    this.buffer = end === buffer.length ? EMPTY : Buffer.from(buffer.subarray(end))
    return { fin, opcode, payload }
  }
}

/** Parse a close-frame payload into `{code, reason}` (defaults 1000/''). */
function parseClosePayload(payload) {
  if (payload.length < 2) return { code: 1000, reason: '' }
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') }
}

/** Build a close-frame payload: 2-byte code + UTF-8 reason (≤ 123 B). */
function closePayload(code, reason) {
  const text = Buffer.from(String(reason ?? ''), 'utf8').subarray(0, MAX_CONTROL_PAYLOAD - 2)
  const payload = Buffer.allocUnsafe(2 + text.length)
  payload.writeUInt16BE(Number.isInteger(code) ? code : 1000, 0)
  text.copy(payload, 2)
  return payload
}

/**
 * One WebSocket connection (either side of the handshake) with framing,
 * fragmentation, control-frame handling and an exactly-once close event.
 *
 * Events: `'message'` (Buffer), `'pong'` (Buffer), `'drain'` (socket writable),
 * `'error'` (Error), `'close'` (`{code, reason, remote}`), emitted once.
 *
 * @param {object} options - peer options.
 * @param {import('node:net').Socket} options.socket - the upgraded TCP socket.
 * @param {boolean} [options.masked] - mask outbound frames (client side).
 * @param {boolean} [options.expectMasked] - require masked inbound frames (server side).
 * @param {number} [options.maxMessageBytes] - reassembled message cap.
 * @param {(level: string, message: string) => void} [options.log] - optional logger.
 * @returns {object} peer with `send`, `close`, `destroy`, `feed`, `pause`,
 *   `resume`, `on`, `once`, `off` and an `open` getter.
 */
export function createWsPeer(options) {
  const {
    socket,
    masked = false,
    expectMasked = true,
    maxMessageBytes = DEFAULT_MAX_WS_MESSAGE_BYTES,
    log = null,
  } = options
  if (socket === undefined || socket === null || typeof socket.on !== 'function') {
    throw new TypeError('createWsPeer requires a socket')
  }

  const emitter = createEmitter()
  const parser = new WsFrameParser({ expectMasked, maxFrameBytes: maxMessageBytes })
  /** @type {Buffer[]} */
  const fragments = []
  let fragmentBytes = 0
  let fragmentOpen = false
  let closeSent = false
  let closeEmitted = false
  let destroyed = false
  let closeTimer = null

  const peer = {
    /** True while the connection can still carry messages. @returns {boolean} */
    get open() {
      return !destroyed && !closeEmitted
    },

    /**
     * Send one binary message (one wire frame) over the socket.
     * @param {Buffer|Uint8Array|string} payload - message bytes.
     * @returns {boolean} false when the socket buffer is full or the peer is closed.
     */
    send(payload) {
      if (destroyed || closeSent) return false
      try {
        return socket.write(encodeWsFrame(WS_OPCODES.BINARY, payload, { mask: masked }))
      } catch (error) {
        emitError(error)
        return false
      }
    },

    /**
     * Send one control frame (ping/pong/close).
     * @param {number} opcode - `WS_OPCODES.PING|PONG|CLOSE`.
     * @param {Buffer|Uint8Array|string} [payload] - control payload (≤ 125 B).
     * @returns {boolean} whether the frame was queued.
     */
    sendControl(opcode, payload = EMPTY) {
      if (destroyed) return false
      const body = asBuffer(payload)
      if (body.length > MAX_CONTROL_PAYLOAD) {
        emitError(new WsProtocolError('control-too-large', 1002, 'control frame payload exceeds 125 B'))
        return false
      }
      try {
        return socket.write(encodeWsFrame(opcode, body, { mask: masked }))
      } catch (error) {
        emitError(error)
        return false
      }
    },

    /**
     * Start the closing handshake and tear the socket down shortly after
     * (the peer may be gone and never echo the close frame).
     * @param {number} [code] - RFC 6455 close code.
     * @param {string} [reason] - short close reason.
     * @returns {void}
     */
    close(code = 1000, reason = '') {
      if (closeSent || destroyed) return
      closeSent = true
      try {
        socket.write(encodeWsFrame(WS_OPCODES.CLOSE, closePayload(code, reason), { mask: masked }))
      } catch {
        // The socket may already be dead; destroy() below settles the state.
      }
      try {
        socket.end()
      } catch {
        // ignore: destroy() is the fallback
      }
      scheduleDestroy()
    },

    /**
     * Tear the socket down immediately (idempotent). Emits `'close'` once.
     * @param {Error} [error] - optional cause reported through `'error'`.
     * @returns {void}
     */
    destroy(error = undefined) {
      if (error !== undefined) emitError(error)
      if (destroyed) return
      destroyed = true
      if (closeTimer !== null) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      try {
        socket.destroy()
      } catch {
        // already gone
      }
      emitClose({ code: 1006, reason: 'socket destroyed', remote: false })
    },

    /**
     * Feed already-read bytes (the `head` buffer of an HTTP upgrade) into the
     * frame parser without waiting for a socket `'data'` event.
     * @param {Buffer} chunk - bytes received after the handshake.
     * @returns {void}
     */
    feed(chunk) {
      if (chunk === undefined || chunk === null || chunk.length === 0) return
      onData(chunk)
    },

    /** Pause the underlying socket (link-wide backpressure). @returns {void} */
    pause() {
      try {
        socket.pause()
      } catch {
        // ignore
      }
    },

    /** Resume the underlying socket. @returns {void} */
    resume() {
      try {
        socket.resume()
      } catch {
        // ignore
      }
    },

    /** Listen on `'message'`, `'pong'`, `'drain'`, `'error'` or `'close'`. */
    on(event, fn) {
      emitter.on(event, fn)
      return peer
    },
    /** One-shot `on()`. */
    once(event, fn) {
      emitter.once(event, fn)
      return peer
    },
    /** Remove one listener. */
    off(event, fn) {
      emitter.off(event, fn)
      return peer
    },
  }

  /** Deliver one reassembled binary message. */
  function deliver(payload) {
    emitter.emit('message', payload)
  }

  /** Drop fragment state (after delivery or protocol error). */
  function resetFragments() {
    fragments.length = 0
    fragmentBytes = 0
    fragmentOpen = false
  }

  /** Emit `'error'` unless the peer is already torn down. */
  function emitError(error) {
    if (destroyed) return
    if (log !== null && typeof log === 'function') {
      try {
        log('warn', `[relay-ws] ${error?.message ?? error}`)
      } catch {
        // logging must never throw into the socket callbacks
      }
    }
    emitter.emit('error', error)
  }

  /** Emit `'close'` exactly once. */
  function emitClose(info) {
    if (closeEmitted) return
    closeEmitted = true
    emitter.emit('close', info)
  }

  /** Force-destroy the socket after the close frame had a chance to flush. */
  function scheduleDestroy() {
    if (closeTimer !== null || destroyed) return
    closeTimer = setTimeout(() => {
      closeTimer = null
      if (!destroyed) peer.destroy()
    }, 250)
    closeTimer.unref?.()
  }

  /** Send a close frame and destroy (used for protocol violations). */
  function protocolClose(closeCode, message) {
    emitError(new WsProtocolError('protocol-error', closeCode, message))
    if (!closeSent) {
      closeSent = true
      try {
        socket.write(encodeWsFrame(WS_OPCODES.CLOSE, closePayload(closeCode, message), { mask: masked }))
      } catch {
        // fall through to destroy
      }
    }
    peer.destroy()
  }

  /** Dispatch one parsed frame (control, fragmentation, message). */
  function handleFrame(frame) {
    const { fin, opcode, payload } = frame
    if (opcode === WS_OPCODES.PING) {
      if (!fin || payload.length > MAX_CONTROL_PAYLOAD) return protocolClose(1002, 'malformed ping frame')
      peer.sendControl(WS_OPCODES.PONG, payload)
      return
    }
    if (opcode === WS_OPCODES.PONG) {
      if (!fin || payload.length > MAX_CONTROL_PAYLOAD) return protocolClose(1002, 'malformed pong frame')
      emitter.emit('pong', payload)
      return
    }
    if (opcode === WS_OPCODES.CLOSE) {
      if (!fin || payload.length > MAX_CONTROL_PAYLOAD) return protocolClose(1002, 'malformed close frame')
      const { code, reason } = parseClosePayload(payload)
      emitClose({ code, reason, remote: true })
      if (!closeSent) {
        closeSent = true
        try {
          socket.write(encodeWsFrame(WS_OPCODES.CLOSE, closePayload(code, ''), { mask: masked }))
        } catch {
          // ignore
        }
        try {
          socket.end()
        } catch {
          // ignore
        }
        scheduleDestroy()
      }
      return
    }
    if (opcode === WS_OPCODES.TEXT) {
      return protocolClose(1003, 'text frames are not supported by the relay wire protocol')
    }
    if (opcode === WS_OPCODES.BINARY) {
      if (fragmentOpen) return protocolClose(1002, 'new data frame while a fragmented message is open')
      if (payload.length > maxMessageBytes) return protocolClose(1009, 'message too large')
      if (fin) return deliver(payload)
      fragmentOpen = true
      fragments.push(payload)
      fragmentBytes = payload.length
      return
    }
    if (opcode === WS_OPCODES.CONTINUATION) {
      if (!fragmentOpen) return protocolClose(1002, 'continuation frame without an open message')
      fragments.push(payload)
      fragmentBytes += payload.length
      if (fragmentBytes > maxMessageBytes) return protocolClose(1009, 'message too large')
      if (!fin) return
      const message = Buffer.concat(fragments)
      resetFragments()
      return deliver(message)
    }
    return protocolClose(1002, `unknown WebSocket opcode 0x${opcode.toString(16)}`)
  }

  /** Socket data handler: parse frames, never throw out of the callback. */
  function onData(chunk) {
    if (destroyed) return
    let frames
    try {
      frames = parser.push(chunk)
    } catch (error) {
      return protocolClose(error.closeCode ?? 1002, error.message)
    }
    for (const frame of frames) {
      if (destroyed) return
      handleFrame(frame)
    }
  }

  socket.on('data', onData)
  socket.on('drain', () => emitter.emit('drain'))
  socket.on('error', (error) => {
    emitError(error)
    peer.destroy()
  })
  socket.on('end', () => {
    peer.destroy()
  })
  socket.on('close', () => {
    peer.destroy()
  })

  return peer
}

/** Header names that must never cross the relay (RFC 7230 hop-by-hop). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Copy a header object into a bounded, wire-safe plain object.
 *
 * The wire frame meta is capped at 8 KiB, so a hostile origin cannot be
 * allowed to make `encodeFrame` throw (that would tear down the whole link
 * for one bad response). Arrays (set-cookie) are preserved.
 *
 * @param {object|undefined|null} headers - inbound header bag.
 * @returns {object} sanitized headers (≤ 100 entries, ≤ 6 KiB of names+values).
 */
function sanitizeHeaders(headers) {
  if (headers === null || headers === undefined || typeof headers !== 'object') return {}
  /** @type {Record<string, string|string[]>} */
  const out = {}
  let count = 0
  let total = 0
  for (const [name, value] of Object.entries(headers)) {
    if (count >= 100) break
    if (typeof name !== 'string' || name === '' || /[\r\n]/.test(name)) continue
    const values = (Array.isArray(value) ? value : [value])
      .map((entry) => String(entry))
      .filter((entry) => !/[\r\n]/.test(entry))
    if (values.length === 0) continue
    const size = name.length + values.reduce((sum, entry) => sum + entry.length, 0)
    if (total + size > 6 * 1024) continue
    total += size
    out[name] = Array.isArray(value) ? values : values[0]
    count += 1
  }
  return out
}

/**
 * Strip hop-by-hop headers and bound the result (used by relay + bridge).
 * @param {object|undefined|null} headers - header bag.
 * @returns {Record<string, string|string[]>} forwarded headers.
 */
export function filterHopByHopHeaders(headers) {
  if (headers === null || headers === undefined || typeof headers !== 'object') return {}
  /** @type {Record<string, string|string[]>} */
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(String(name).toLowerCase())) continue
    out[name] = value
  }
  return out
}

/**
 * Bind `wire.js` frames, `mux.js` streams and the HTTP-shaped stream interface
 * used by `bridge.js` / `relay/main.mjs`.
 *
 * The channel is transport-agnostic: `send(bytes)` writes one encoded wire
 * frame to the peer and returns the transport's backpressure signal. The mux
 * queues behind a false return; call `drain()` when the socket is writable
 * again (typically on the socket's `'drain'` event).
 *
 * Events: `'pong'` (`{t}`), `'error'` (Error), `'close'` (`{reason}`),
 * `'unsupported'` (`{opcode}`) for S2 opcodes.
 *
 * @param {object} options - channel options.
 * @param {'client'|'hub'} options.role - mux id parity (relay = client, hub = hub).
 * @param {(bytes: Buffer) => boolean} options.send - transport sink.
 * @param {(stream: object) => void} [options.onStream] - inbound `http_open` handler.
 * @param {number} [options.maxStreams] - concurrent stream cap (default 256).
 * @param {number} [options.highWaterMark] - per-stream backpressure threshold.
 * @param {number} [options.globalHighWaterMark] - shared outbox threshold.
 * @param {() => void} [options.pause] - pause the underlying transport (inbound backpressure).
 * @param {() => void} [options.resume] - resume the underlying transport.
 * @param {(level: string, message: string) => void} [options.log] - optional logger.
 * @returns {object} the channel.
 */
export function createLinkChannel(options) {
  const {
    role,
    send,
    onStream = () => {},
    maxStreams = 256,
    highWaterMark,
    globalHighWaterMark,
    pause = null,
    resume = null,
    log = null,
  } = options
  if (typeof send !== 'function') throw new TypeError('createLinkChannel requires send(bytes)')

  const emitter = createEmitter()
  const decoder = new FrameDecoder()
  /** @type {Map<number, object>} */
  const handles = new Map()
  const counters = {
    framesIn: 0,
    framesOut: 0,
    unsupported: 0,
    protocolErrors: 0,
  }
  let closed = false

  /** Encode and write one wire frame. Returns the transport backpressure flag. */
  function writeFrame(opcode, meta, payload = EMPTY) {
    if (closed) return false
    try {
      const frame = encodeFrame(opcode, meta, payload)
      counters.framesOut += 1
      return send(frame) !== false
    } catch (error) {
      counters.protocolErrors += 1
      emitter.emit('error', error)
      return false
    }
  }

  /** Split one payload into ≤64 KiB wire frames (design §7.3). */
  function writeChunks(opcode, meta, chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (bytes.length <= MAX_PAYLOAD_BYTES) return writeFrame(opcode, meta, bytes)
    let writable = true
    for (let offset = 0; offset < bytes.length; offset += MAX_PAYLOAD_BYTES) {
      const slice = bytes.subarray(offset, Math.min(offset + MAX_PAYLOAD_BYTES, bytes.length))
      if (writeFrame(opcode, meta, slice) === false) writable = false
    }
    return writable
  }

  /** Map one semantic mux frame to its wire opcode. */
  function sendSemantic(frame) {
    switch (frame.op) {
      case 'open':
        if (frame.kind !== 'http') {
          // WS streams are S2; refuse to put an unknown stream on the wire.
          counters.unsupported += 1
          return true
        }
        return writeFrame(OPCODES.HTTP_OPEN, { id: frame.id, ...frame.meta })
      case 'data':
        return writeChunks(OPCODES.HTTP_DATA, { id: frame.id }, frame.chunk)
      case 'end':
        return writeFrame(OPCODES.HTTP_END, { id: frame.id })
      case 'reset':
        return writeFrame(OPCODES.HTTP_ERROR, {
          id: frame.id,
          code: frame.code,
          message: frame.reason ?? '',
        })
      case 'goaway':
        return writeFrame(OPCODES.GOAWAY, { code: frame.code })
      default:
        counters.unsupported += 1
        return true
    }
  }

  const mux = createMux({
    role,
    maxStreams,
    highWaterMark,
    globalHighWaterMark,
    send: sendSemantic,
    onStream(handle) {
      attach(handle)
      try {
        onStream(handle)
      } catch (error) {
        // The bridge failing to even start must not desynchronize the mux.
        handle.reset('bridge_error', error?.message ?? 'stream handler failed')
      }
    },
  })

  /**
   * Decorate one mux handle with the HTTP-shaped interface. All helpers settle
   * through the mux (reset) so every stream has exactly one close path.
   */
  function attach(handle) {
    handles.set(handle.id, handle)
    /**
     * Write the response head (relay side) / request head helper.
     * @param {number} status - HTTP status code.
     * @param {object} headers - response headers.
     * @returns {boolean} transport writability.
     */
    handle.writeHead = (status, headers) => {
      if (handle.settled) return false
      return writeFrame(OPCODES.HTTP_HEAD, { id: handle.id, status, headers: sanitizeHeaders(headers) })
    }
    /**
     * Fail the stream with a short code; the peer sees one `http_error`.
     * @param {string} code - stable short code.
     * @param {string} [message] - human-readable detail.
     * @returns {boolean} true when this call settled the stream.
     */
    handle.fail = (code, message = '') => handle.reset(String(code), String(message))
    /** Pause the shared transport (bounded inbound buffering). */
    handle.pause = () => {
      if (pause !== null) {
        try {
          pause()
        } catch {
          // ignore
        }
      }
    }
    /** Resume the shared transport. */
    handle.resume = () => {
      if (resume !== null) {
        try {
          resume()
        } catch {
          // ignore
        }
      }
    }
    handle.once('close', () => handles.delete(handle.id))
  }

  /** Apply one decoded wire frame. */
  function dispatch(frame) {
    counters.framesIn += 1
    const { opcode, meta, payload } = frame
    const id = Number(meta.id)
    switch (opcode) {
      case OPCODES.HTTP_OPEN: {
        if (!Number.isSafeInteger(id) || id <= 0) {
          counters.protocolErrors += 1
          return
        }
        const streamMeta = { ...meta }
        delete streamMeta.id
        mux.receive({ op: 'open', id, kind: 'http', meta: streamMeta })
        return
      }
      case OPCODES.HTTP_HEAD: {
        const handle = handles.get(id)
        if (handle === undefined) {
          counters.protocolErrors += 1
          return
        }
        handle.emitter.emit('head', {
          status: Number(meta.status),
          headers: meta.headers ?? {},
        })
        return
      }
      case OPCODES.HTTP_DATA:
        mux.receive({ op: 'data', id, chunk: payload })
        return
      case OPCODES.HTTP_END:
        mux.receive({ op: 'end', id })
        return
      case OPCODES.HTTP_ERROR:
        mux.receive({
          op: 'reset',
          id,
          code: typeof meta.code === 'string' ? meta.code : 'upstream_error',
          reason: typeof meta.message === 'string' ? meta.message : '',
        })
        return
      case OPCODES.PING:
        writeFrame(OPCODES.PONG, { t: meta.t })
        return
      case OPCODES.PONG:
        emitter.emit('pong', { t: meta.t })
        return
      case OPCODES.GOAWAY:
        mux.receive({ op: 'goaway', code: typeof meta.code === 'string' ? meta.code : 'goaway' })
        return
      default:
        // ws_* opcodes belong to S2; count them instead of misrouting them.
        counters.unsupported += 1
        emitter.emit('unsupported', { opcode })
    }
  }

  const channel = {
    /** The underlying mux (for stats/tests). @returns {object} */
    mux,

    /**
     * Feed inbound WebSocket message bytes into the frame decoder.
     * @param {Buffer|Uint8Array} bytes - one or more wire frames.
     * @returns {void}
     */
    receive(bytes) {
      if (closed) return
      let frames
      try {
        frames = decoder.push(bytes)
      } catch (error) {
        counters.protocolErrors += 1
        emitter.emit('error', error)
        return
      }
      for (const frame of frames) {
        if (closed) return
        dispatch(frame)
      }
    },

    /**
     * Open one outbound HTTP stream.
     * @param {object} meta - `{method, path, headers, bodyLen}`.
     * @returns {object} the stream handle.
     * @throws {import('./mux.js').MuxError} `too_many_streams` etc.
     */
    openHttp(meta) {
      const handle = mux.openStream('http', { meta })
      // Local opens do not go through the mux `onStream` callback, so decorate
      // them here as well; the relay needs `'head'` dispatch on its own handle.
      attach(handle)
      return handle
    },

    /**
     * Send one application heartbeat (`wire ping`).
     * @param {object} [meta] - `{t}` timestamp payload.
     * @returns {boolean} transport writability.
     */
    ping(meta = {}) {
      return writeFrame(OPCODES.PING, { t: meta.t ?? Date.now() })
    },

    /**
     * Retry the mux outbox after transport backpressure cleared.
     * @returns {boolean} true when the outbox is empty.
     */
    drain() {
      return mux.drain()
    },

    /**
     * Close the channel: one `goaway`, then settle every open stream once.
     * @param {string} [reason] - close reason / goaway code.
     * @returns {void}
     */
    close(reason = 'closed') {
      if (closed) return
      closed = true
      mux.closeAll(reason)
      handles.clear()
      emitter.emit('close', { reason })
    },

    /**
     * Counter snapshot (mux counters + frame counters).
     * @returns {object} frozen counters.
     */
    stats() {
      return Object.freeze({ ...mux.stats(), ...counters })
    },

    /** Listen on `'pong'`, `'error'`, `'close'` or `'unsupported'`. */
    on(event, fn) {
      emitter.on(event, fn)
      return channel
    },
    /** One-shot `on()`. */
    once(event, fn) {
      emitter.once(event, fn)
      return channel
    },
    /** Remove one listener. */
    off(event, fn) {
      emitter.off(event, fn)
      return channel
    },
  }

  return channel
}

/** Compute one reconnect delay: `min(base * 2^failures, max)` ± jitter. */
function reconnectDelay(failures, baseMs, maxMs, jitter) {
  const exponential = Math.min(baseMs * 2 ** failures, maxMs)
  const spread = exponential * jitter
  return Math.max(0, Math.round(exponential - spread + Math.random() * spread * 2))
}

/** Zero-valued stream stats used when the link is down. */
function emptyStreamStats() {
  return Object.freeze({
    open: 0,
    bytesIn: 0,
    bytesOut: 0,
    rejected: 0,
    dropped: 0,
    opened: 0,
    closed: 0,
    buffered: 0,
    maxStreams: 0,
    framesIn: 0,
    framesOut: 0,
    unsupported: 0,
    protocolErrors: 0,
  })
}

/**
 * Create the hub side dialer for one relay/hub pair.
 *
 * The dialer is deliberately self-healing: `start()` begins a dial loop that
 * never throws, reconnects with `min(1500·2^n, 30000)` ±20 % jitter, and sends
 * a wire `ping` every 10 s; two consecutive missed `pong`s tear the socket
 * down and trigger a reconnect. `stop()` is terminal for the current object.
 *
 * Inbound `http_open` streams are handed to the `onStream(handler)` callbacks;
 * the usual handler is `createBridge({port}).handle`.
 *
 * @param {object} options - dialer options.
 * @param {string} options.relayUrl - `ws://` or `wss://` relay base URL.
 * @param {string} options.hubId - relay hub id (`hub_…`).
 * @param {string} [options.token] - relay access key (`k` query parameter).
 * @param {(level: string, message: string) => void} [options.log] - optional logger.
 * @param {number} [options.reconnectBaseMs] - backoff floor (1500).
 * @param {number} [options.reconnectMaxMs] - backoff ceiling (30000).
 * @param {number} [options.reconnectJitter] - ± fraction of the delay (0.2).
 * @param {number} [options.pingIntervalMs] - heartbeat interval (10000).
 * @param {number} [options.maxMissedPongs] - misses before teardown (2).
 * @param {number} [options.connectTimeoutMs] - handshake timeout (10000).
 * @param {number} [options.maxStreams] - per-link concurrent stream cap (256).
 * @param {number} [options.maxMessageBytes] - WebSocket message cap.
 * @returns {{ start: () => object, stop: () => Promise<void>,
 *   status: () => object, onStream: (handler: Function) => Function }} the link.
 */
export function createHubLink(options) {
  const {
    relayUrl,
    hubId,
    token = '',
    log = null,
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
    reconnectJitter = 0.2,
    pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
    maxMissedPongs = DEFAULT_MAX_MISSED_PONGS,
    connectTimeoutMs = 10000,
    maxStreams = 256,
    maxMessageBytes = DEFAULT_MAX_WS_MESSAGE_BYTES,
  } = options ?? {}

  if (typeof relayUrl !== 'string' || relayUrl === '') {
    throw new TypeError('createHubLink requires relayUrl')
  }
  if (typeof hubId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(hubId)) {
    throw new TypeError('createHubLink requires a hubId matching /^[A-Za-z0-9._-]{1,128}$/')
  }
  const base = new URL(relayUrl)
  if (base.protocol !== 'ws:' && base.protocol !== 'wss:') {
    throw new TypeError(`relayUrl must be ws:// or wss://, got ${base.protocol}`)
  }

  const handlers = new Set()
  let started = false
  let stopped = false
  let state = 'idle'
  let stateSince = Date.now()
  let failures = 0
  let attempts = 0
  let reconnects = 0
  let everConnected = false
  let connectedAt = null
  let lastError = null
  let reconnectTimer = null
  let pingTimer = null
  let socket = null
  let peer = null
  let channel = null
  let missedPongs = 0
  let pings = 0
  let pongs = 0

  /** Move to a new state and stamp `since`. */
  function setState(next) {
    if (state === next) return
    state = next
    stateSince = Date.now()
  }

  /** Optional logger that can never throw into the dial loop. */
  function logLine(level, message) {
    if (log === null || typeof log !== 'function') return
    try {
      log(level, message)
    } catch {
      // ignore
    }
  }

  /** Build the upgrade request path (`/ws?hub=…&role=hub[&k=…]`). */
  function buildRequestPath() {
    const params = new URLSearchParams(base.search)
    params.set('hub', hubId)
    params.set('role', 'hub')
    if (token !== '' && token !== undefined && token !== null) params.set('k', String(token))
    const basePath = base.pathname.replace(/\/+$/, '')
    return `${basePath}/ws?${params.toString()}`
  }

  /** Drop the live peer/channel without scheduling anything. */
  function teardown(reason) {
    if (pingTimer !== null) {
      clearInterval(pingTimer)
      pingTimer = null
    }
    const closingPeer = peer
    const closingChannel = channel
    peer = null
    channel = null
    socket = null
    if (closingChannel !== null) {
      try {
        closingChannel.close(reason)
      } catch (error) {
        logLine('warn', `[relay-link] channel close failed: ${error?.message ?? error}`)
      }
    }
    if (closingPeer !== null) {
      try {
        closingPeer.destroy()
      } catch (error) {
        logLine('warn', `[relay-link] peer destroy failed: ${error?.message ?? error}`)
      }
    }
  }

  /** Schedule one reconnect attempt with jittered exponential backoff. */
  function scheduleReconnect() {
    // One timer at a time: a request can report both a response and an error.
    if (stopped || reconnectTimer !== null) return
    const delay = reconnectDelay(failures, reconnectBaseMs, reconnectMaxMs, reconnectJitter)
    failures += 1
    setState('reconnecting')
    logLine('info', `[relay-link] reconnecting in ${delay} ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      dial()
    }, delay)
    reconnectTimer.unref?.()
  }

  /** Start the heartbeat timer for the live channel. */
  function startHeartbeat() {
    if (pingTimer !== null) clearInterval(pingTimer)
    pingTimer = setInterval(() => {
      if (channel === null || state !== 'open') return
      if (missedPongs >= maxMissedPongs) {
        lastError = 'heartbeat timeout: no pong received'
        logLine('warn', '[relay-link] heartbeat timed out; tearing down the socket')
        teardown('heartbeat_timeout')
        scheduleReconnect()
        return
      }
      missedPongs += 1
      pings += 1
      channel.ping({ t: Date.now() })
    }, pingIntervalMs)
    pingTimer.unref?.()
  }

  /** Handle a live peer closing: settle, then reconnect unless stopped. */
  function handlePeerClosed(info) {
    if (peer === null && channel === null) return
    lastError = info?.reason !== undefined ? String(info.reason) : 'link closed'
    teardown('link_closed')
    if (stopped) {
      setState('closed')
      return
    }
    scheduleReconnect()
  }

  /** Dial the relay once; all failures end in `scheduleReconnect()`. */
  function dial() {
    if (stopped) return
    setState(everConnected ? 'reconnecting' : 'connecting')
    attempts += 1
    if (everConnected) reconnects += 1

    const key = randomBytes(16).toString('base64')
    const expectedAccept = webSocketAccept(key)
    const isSecure = base.protocol === 'wss:'
    const transport = isSecure ? httpsRequest : httpRequest
    const requestOptions = {
      host: base.hostname,
      port: base.port !== '' ? Number(base.port) : (isSecure ? 443 : 80),
      path: buildRequestPath(),
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': key,
      },
    }

    let request
    try {
      request = transport.request(requestOptions)
    } catch (error) {
      lastError = error?.message ?? String(error)
      scheduleReconnect()
      return
    }

    request.setTimeout(connectTimeoutMs, () => {
      request.destroy(new Error('relay handshake timed out'))
    })

    request.on('upgrade', (response, upgradedSocket, head) => {
      // The handshake is over: the request timeout must not kill the live socket.
      request.setTimeout(0)
      if (stopped) {
        try {
          upgradedSocket.destroy()
        } catch {
          // ignore
        }
        return
      }
      if (response.headers['sec-websocket-accept'] !== expectedAccept) {
        try {
          upgradedSocket.destroy()
        } catch {
          // ignore
        }
        lastError = 'relay sent an invalid Sec-WebSocket-Accept'
        scheduleReconnect()
        return
      }
      adoptSocket(upgradedSocket, head)
    })

    request.on('response', (response) => {
      // A non-101 answer (e.g. 409 hub_taken) is a failed dial, not a crash.
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        if (body.length < 2048) body += chunk
      })
      response.on('end', () => {
        lastError = `relay rejected the upgrade: HTTP ${response.statusCode} ${body.slice(0, 200)}`.trim()
        scheduleReconnect()
      })
      response.on('error', () => scheduleReconnect())
    })

    request.on('error', (error) => {
      if (stopped) return
      lastError = error?.message ?? String(error)
      scheduleReconnect()
    })

    request.end()
  }

  /** Wrap a successfully upgraded socket in a peer + channel. */
  function adoptSocket(upgradedSocket, head) {
    socket = upgradedSocket
    try {
      upgradedSocket.setTimeout(0)
      upgradedSocket.setNoDelay?.(true)
    } catch {
      // best effort
    }
    failures = 0
    everConnected = true
    connectedAt = Date.now()
    lastError = null
    missedPongs = 0
    setState('open')
    logLine('info', `[relay-link] connected to ${base.origin}/ws as ${hubId}`)

    const livePeer = createWsPeer({
      socket: upgradedSocket,
      masked: true,
      expectMasked: false,
      maxMessageBytes,
      log,
    })
    peer = livePeer

    const liveChannel = createLinkChannel({
      role: 'hub',
      send: (bytes) => livePeer.send(bytes),
      onStream: (stream) => {
        for (const handler of [...handlers]) {
          try {
            const result = handler(stream)
            if (result !== null && typeof result?.then === 'function') {
              result.then(undefined, (error) => {
                stream.fail('bridge_error', error?.message ?? 'stream handler failed')
              })
            }
          } catch (error) {
            stream.fail('bridge_error', error?.message ?? 'stream handler failed')
          }
        }
      },
      maxStreams,
      pause: () => livePeer.pause(),
      resume: () => livePeer.resume(),
      log,
    })
    channel = liveChannel

    livePeer.on('message', (bytes) => liveChannel.receive(bytes))
    livePeer.on('drain', () => liveChannel.drain())
    livePeer.on('error', (error) => {
      lastError = error?.message ?? String(error)
    })
    livePeer.on('close', (info) => handlePeerClosed(info))
    liveChannel.on('pong', () => {
      missedPongs = 0
      pongs += 1
    })
    liveChannel.on('error', (error) => {
      lastError = error?.message ?? String(error)
      logLine('warn', `[relay-link] channel error: ${lastError}`)
    })

    startHeartbeat()
    livePeer.feed(head)
  }

  const link = {
    /** Start dialing (idempotent; safe after `stop()`). @returns {object} the link. */
    start() {
      if (started && !stopped) return link
      started = true
      stopped = false
      failures = 0
      everConnected = false
      setState('connecting')
      dial()
      return link
    },

    /**
     * Stop dialing and close the live socket. Resolves once the socket is gone
     * (or after a short grace period) and leaves `status().state === 'closed'`.
     * @returns {Promise<void>}
     */
    async stop() {
      stopped = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      const closingPeer = peer
      const done = new Promise((resolve) => {
        if (closingPeer === null) {
          resolve()
          return
        }
        const timer = setTimeout(resolve, 200)
        timer.unref?.()
        closingPeer.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      teardown('stopped')
      setState('closed')
      await done
    },

    /**
     * Register an inbound stream handler (typically `bridge.handle`).
     * @param {(stream: object) => void} handler - called for every `http_open`.
     * @returns {() => void} unsubscribe function.
     */
    onStream(handler) {
      if (typeof handler !== 'function') throw new TypeError('onStream requires a function')
      handlers.add(handler)
      return () => handlers.delete(handler)
    },

    /**
     * Live status snapshot (frozen copy; safe to log or render).
     * @returns {object} `{state, hubId, relayUrl, attempts, reconnects,
     *   connectedAt, since, lastError, pings, pongs, missedPongs, streams}`.
     */
    status() {
      return Object.freeze({
        state,
        hubId,
        relayUrl,
        attempts,
        reconnects,
        connectedAt,
        since: stateSince,
        lastError,
        pings,
        pongs,
        missedPongs,
        streams: channel === null ? emptyStreamStats() : channel.stats(),
      })
    },
  }

  return link
}
