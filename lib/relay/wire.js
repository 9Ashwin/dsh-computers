/**
 * Binary frame codec for the relay tunnel (docs/relay-design.md §7.3).
 *
 * One frame on the hub link is:
 *
 *   opcode(1) | metaLen(u32 BE) | payloadLen(u32 BE) | meta(JSON, metaLen B) | payload(payloadLen B)
 *
 * The design doc (§7.3) writes the header as `opcode | streamId | metaLen | flags`
 * and lets the WebSocket message boundary delimit the payload. This module is
 * deliberately transport-agnostic: it is also fed by a byte stream (tests, and
 * the hub-link reconnect buffer), where message boundaries are not available,
 * so the frame carries its own payload length. The stream id lives inside the
 * meta JSON (`{id}`) — the mux owns it, the codec stays dumb.
 *
 * Rules this file keeps:
 * - frames are bounded: meta ≤ 8 KiB, payload ≤ 64 KiB (both checked before
 *   a large buffer is retained, so a hostile length cannot make us allocate);
 * - an unknown opcode is rejected with a typed `WireError` (code
 *   `unknown-opcode`), never a bare `Error`/`TypeError`;
 * - `FrameDecoder` accepts arbitrary split/coalesced chunks: it buffers only
 *   the bytes of one incomplete frame, and copies decoded payloads so callers
 *   never alias the decoder's scratch buffer;
 * - `encodeFrame`/`decodeFrame` are pure and import nothing (Buffer is global).
 */

/** Frame opcodes for the hub data channel (S0 task list; supersedes §7.3's table). */
export const OPCODES = Object.freeze({
  HTTP_OPEN: 0x01,
  HTTP_HEAD: 0x02,
  HTTP_DATA: 0x03,
  HTTP_END: 0x04,
  HTTP_ERROR: 0x05,
  WS_OPEN: 0x06,
  WS_FRAME: 0x07,
  WS_CLOSE: 0x08,
  PING: 0x09,
  PONG: 0x0a,
  GOAWAY: 0x0b,
})

/** Reverse opcode → canonical wire name (`0x01 → 'http_open'`). */
export const OPCODE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(OPCODES).map(([name, opcode]) => [opcode, name.toLowerCase()])),
)

/** Fixed header size: opcode(1) + metaLen(4) + payloadLen(4). */
export const FRAME_HEADER_BYTES = 9

/** Maximum JSON meta size per frame (design §7.3, §13). */
export const MAX_META_BYTES = 8 * 1024

/** Maximum binary payload per frame (design §7.3, §13) — larger bodies are split. */
export const MAX_PAYLOAD_BYTES = 64 * 1024

const EMPTY = Buffer.alloc(0)

/**
 * Failure raised by the codec. Always carries a machine-readable `code` so a
 * caller can answer the peer with `http_error`/`goaway` instead of crashing.
 */
export class WireError extends Error {
  /**
   * @param {string} code - `unknown-opcode` | `meta-too-large` |
   *   `payload-too-large` | `truncated` | `trailing-bytes` | `bad-meta` |
   *   `bad-frame` | `decoder-broken`.
   * @param {string} message - human-readable detail (logged, not sent raw).
   * @param {object} [detail] - structured context (opcode, lengths, offset).
   */
  constructor(code, message, detail = undefined) {
    super(message)
    this.name = 'WireError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

/** True when `opcode` is one of the opcodes above. @returns {boolean} */
export function isKnownOpcode(opcode) {
  return typeof opcode === 'number' && Object.prototype.hasOwnProperty.call(OPCODE_NAMES, opcode)
}

/**
 * Canonical wire name for an opcode.
 * @param {number} opcode - one of `OPCODES`.
 * @returns {string|null} `'http_open'` … or null when unknown.
 */
export function opcodeName(opcode) {
  return isKnownOpcode(opcode) ? OPCODE_NAMES[opcode] : null
}

/** Coerce an accepted payload representation to a Buffer (no copy for Buffer). */
function payloadBuffer(payload, opcode) {
  if (payload === undefined || payload === null) return EMPTY
  if (Buffer.isBuffer(payload)) return payload
  if (payload instanceof Uint8Array) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8')
  throw new WireError('bad-frame', `payload for opcode 0x${opcode.toString(16)} must be a Buffer, Uint8Array or string`)
}

/**
 * Encode one frame.
 *
 * @param {number} opcode - one of `OPCODES`; unknown values throw.
 * @param {object|null} [meta] - JSON-serializable frame metadata (`{id, ...}`);
 *   `undefined`/`null` encode as `{}`.
 * @param {Buffer|Uint8Array|string} [payload] - raw bytes (string is UTF-8).
 * @returns {Buffer} the encoded frame.
 * @throws {WireError} `unknown-opcode` | `bad-meta` | `meta-too-large` |
 *   `payload-too-large` | `bad-frame`.
 */
export function encodeFrame(opcode, meta = {}, payload = EMPTY) {
  if (!isKnownOpcode(opcode)) {
    throw new WireError('unknown-opcode', `unknown frame opcode ${describeOpcode(opcode)}`, { opcode })
  }
  const source = meta === undefined || meta === null ? {} : meta
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new WireError('bad-meta', `meta for opcode 0x${opcode.toString(16)} must be an object`, { opcode })
  }
  let json
  try {
    json = JSON.stringify(source)
  } catch (error) {
    throw new WireError('bad-meta', `meta for opcode 0x${opcode.toString(16)} is not JSON-serializable: ${error.message}`, { opcode })
  }
  if (typeof json !== 'string') {
    throw new WireError('bad-meta', `meta for opcode 0x${opcode.toString(16)} is not JSON-serializable`, { opcode })
  }
  const metaBytes = Buffer.from(json, 'utf8')
  if (metaBytes.length > MAX_META_BYTES) {
    throw new WireError('meta-too-large', `meta is ${metaBytes.length} B, limit ${MAX_META_BYTES} B`, {
      opcode, metaLen: metaBytes.length, limit: MAX_META_BYTES,
    })
  }
  const body = payloadBuffer(payload, opcode)
  if (body.length > MAX_PAYLOAD_BYTES) {
    throw new WireError('payload-too-large', `payload is ${body.length} B, limit ${MAX_PAYLOAD_BYTES} B`, {
      opcode, payloadLen: body.length, limit: MAX_PAYLOAD_BYTES,
    })
  }

  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + metaBytes.length + body.length)
  frame.writeUInt8(opcode, 0)
  frame.writeUInt32BE(metaBytes.length, 1)
  frame.writeUInt32BE(body.length, 5)
  metaBytes.copy(frame, FRAME_HEADER_BYTES)
  body.copy(frame, FRAME_HEADER_BYTES + metaBytes.length)
  return frame
}

/**
 * Decode exactly one complete frame.
 *
 * @param {Buffer|Uint8Array} buffer - bytes of exactly one frame (no trailing data).
 * @returns {{ opcode: number, name: string, meta: object, payload: Buffer }} the frame;
 *   `payload` is a copy, so mutating `buffer` afterwards is safe.
 * @throws {WireError} `unknown-opcode` | `meta-too-large` | `payload-too-large` |
 *   `truncated` | `trailing-bytes` | `bad-meta` | `bad-frame`.
 */
export function decodeFrame(buffer) {
  const bytes = normalizeBytes(buffer)
  const view = readHeader(bytes)
  const { opcode, metaLen, payloadLen } = view
  const total = FRAME_HEADER_BYTES + metaLen + payloadLen
  if (bytes.length < total) {
    throw new WireError('truncated', `frame needs ${total} B, got ${bytes.length} B`, {
      opcode, metaLen, payloadLen, total, received: bytes.length,
    })
  }
  if (bytes.length > total) {
    throw new WireError('trailing-bytes', `frame is ${total} B, buffer has ${bytes.length} B`, {
      opcode, total, received: bytes.length,
    })
  }
  const meta = decodeMeta(bytes.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + metaLen), opcode)
  const payload = Buffer.from(bytes.subarray(FRAME_HEADER_BYTES + metaLen, total))
  return { opcode, name: OPCODE_NAMES[opcode], meta, payload }
}

/**
 * Streaming frame decoder for split/coalesced byte chunks.
 *
 * `push(chunk)` returns every frame completed by that chunk (zero or more) and
 * retains only the bytes of an incomplete frame. A header that declares an
 * oversize meta/payload, or a meta that is not a JSON object, throws a typed
 * `WireError`; after a throw the decoder is poisoned (`decoder-broken`) until
 * `reset()` — a framing violation means the channel must be torn down.
 */
export class FrameDecoder {
  constructor() {
    /** @type {Buffer} */
    this.buffer = EMPTY
    this.broken = false
  }

  /** Bytes currently buffered for the next (incomplete) frame. @returns {number} */
  get buffered() {
    return this.buffer.length
  }

  /**
   * Feed one chunk and return the frames it completed.
   * @param {Buffer|Uint8Array|string} chunk - arbitrary slice of the byte stream.
   * @returns {Array<{opcode: number, name: string, meta: object, payload: Buffer}>}
   * @throws {WireError} on a malformed/oversize frame (see class docs).
   */
  push(chunk) {
    if (this.broken) {
      throw new WireError('decoder-broken', 'the frame decoder hit a framing error and must be reset()')
    }
    const bytes = normalizeBytes(chunk)
    if (bytes.length === 0) return []
    const combined = this.buffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.buffer, bytes])

    const frames = []
    let offset = 0
    while (combined.length - offset >= FRAME_HEADER_BYTES) {
      // Header-first validation: reject an oversize declaration before waiting
      // for (and retaining) the rest of the frame. Any framing error poisons
      // the decoder: the channel must be torn down, not kept in sync.
      let declared
      try {
        declared = readHeader(combined, offset)
      } catch (error) {
        this.broken = true
        this.buffer = EMPTY
        throw error
      }
      const { metaLen, payloadLen } = declared
      const total = FRAME_HEADER_BYTES + metaLen + payloadLen
      if (combined.length - offset < total) break
      try {
        frames.push(decodeFrame(combined.subarray(offset, offset + total)))
      } catch (error) {
        this.broken = true
        this.buffer = EMPTY
        throw error
      }
      offset += total
    }

    this.buffer = offset === 0
      ? combined
      : (offset < combined.length ? Buffer.from(combined.subarray(offset)) : EMPTY)
    return frames
  }

  /** Drop buffered bytes and clear the poisoned flag (new channel/stream). */
  reset() {
    this.buffer = EMPTY
    this.broken = false
  }
}

/** Validate the fixed header at `offset` and return its declared lengths. */
function readHeader(bytes, offset = 0) {
  if (bytes.length - offset < FRAME_HEADER_BYTES) {
    throw new WireError('truncated', `need ${FRAME_HEADER_BYTES} B of header, got ${bytes.length - offset} B`)
  }
  const opcode = bytes.readUInt8(offset)
  if (!isKnownOpcode(opcode)) {
    throw new WireError('unknown-opcode', `unknown frame opcode ${describeOpcode(opcode)}`, { opcode })
  }
  const metaLen = bytes.readUInt32BE(offset + 1)
  const payloadLen = bytes.readUInt32BE(offset + 5)
  if (metaLen > MAX_META_BYTES) {
    throw new WireError('meta-too-large', `meta is ${metaLen} B, limit ${MAX_META_BYTES} B`, {
      opcode, metaLen, limit: MAX_META_BYTES,
    })
  }
  if (payloadLen > MAX_PAYLOAD_BYTES) {
    throw new WireError('payload-too-large', `payload is ${payloadLen} B, limit ${MAX_PAYLOAD_BYTES} B`, {
      opcode, payloadLen, limit: MAX_PAYLOAD_BYTES,
    })
  }
  return { opcode, metaLen, payloadLen }
}

/** Decode a frame's meta JSON; an empty meta is `{}`, anything else must be an object. */
function decodeMeta(bytes, opcode) {
  if (bytes.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new WireError('bad-meta', `meta is not valid JSON: ${error.message}`, { opcode, metaLen: bytes.length })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WireError('bad-meta', 'meta must be a JSON object', { opcode, metaLen: bytes.length })
  }
  return parsed
}

/** Accept Buffer/Uint8Array/string; anything else is a typed frame error. */
function normalizeBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  throw new WireError('bad-frame', `expected a Buffer/Uint8Array/string, got ${typeof value}`)
}

/** Human-readable opcode for error messages: `0x07`, or the invalid value. */
function describeOpcode(opcode) {
  if (typeof opcode === 'number' && Number.isInteger(opcode)) return `0x${opcode.toString(16)}`
  return String(opcode)
}
