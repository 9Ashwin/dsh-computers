/**
 * Stream multiplexer for the relay tunnel (docs/relay-design.md §7.3).
 *
 * One hub link carries many concurrent HTTP requests and WebSocket sessions.
 * This module owns only the multiplexing concerns:
 *
 * - monotonic `streamId` allocation with **client/hub parity** (HTTP/2 style):
 *   the `client` role allocates odd ids (1, 3, 5 …), the `hub` role allocates
 *   even ids (2, 4, 6 …), so two peers can both open streams without a
 *   round-trip and without collisions;
 * - stream lifecycle: `openStream(kind)` hands back a handle with
 *   `write(chunk)` / `end()` / `reset(code)`; streams settle exactly once
 *   (`'close'` fires once) on end-of-stream, reset, or `closeAll`;
 * - a hard `maxStreams` cap (default 256) with a typed `too_many_streams`
 *   error/rejection instead of silent corruption;
 * - real backpressure: frames are queued behind a `send(frame)` sink that may
 *   return false; `write()` returns false once a stream has `highWaterMark`
 *   bytes queued or the shared outbox holds `globalHighWaterMark` bytes, and
 *   the handle emits `'drain'` when its queue is flushed;
 * - `stats()` counters for admission control and for S1/S2 assertions.
 *
 * The mux is transport- and codec-agnostic: `send()` receives **semantic
 * frames** (`{op:'open'|'data'|'end'|'reset'|'goaway', id, …}`) and S1's bridge
 * maps them to `lib/relay/wire.js` opcodes in exactly one place. Likewise
 * inbound wire frames are mapped to the same semantic shape and passed to
 * `receive(frame)`. That keeps this file free of imports (the leaf rule in
 * docs/refactor-plan.md §3/§4) and keeps one opcode authority.
 *
 * Roles are not symmetric: the hub side must be created with `role: 'hub'`
 * (even ids), the dialing side (relay or hub-link client) with
 * `role: 'client'` (odd ids). A frame arriving with the wrong parity, an
 * unknown stream id, or a duplicate open is dropped and counted, never trusted.
 */

/** Default concurrent stream cap per link (design §7.4 `too_many`). */
export const DEFAULT_MAX_STREAMS = 256

/** Default per-stream queued-byte threshold before `write()` asks for a pause. */
export const DEFAULT_HIGH_WATER_MARK = 64 * 1024

/** Default shared outbox threshold across all streams (memory guard). */
export const DEFAULT_GLOBAL_HIGH_WATER_MARK = 4 * 1024 * 1024

/** Largest allocatable stream id (uint32). */
export const MAX_STREAM_ID = 0xffffffff

/**
 * Private per-handle state. A WeakMap keeps the public handle read-only (no
 * writable internals leaked to callers) without turning the handle into a class.
 * @type {WeakMap<object, { state: string, settled: boolean, localEnded: boolean,
 *   remoteEnded: boolean, pendingBytes: number, needDrain: boolean }>}
 */
const INTERNALS = new WeakMap()

/** Private per-handle capability: apply the peer's `end` (one settlement path). */
const REMOTE_END = new WeakMap()

/**
 * Failure raised by the mux. Always carries a machine-readable `code`.
 */
export class MuxError extends Error {
  /**
   * @param {string} code - `too_many_streams` | `stream_closed` |
   *   `stream_id_exhausted` | `closed` | `goaway` | `invalid-role` |
   *   `invalid-options` | `invalid-stream-id` | `invalid-stream-kind` |
   *   `unknown-frame-op` | `bad-frame` | `bad_chunk`.
   * @param {string} message - human-readable detail.
   * @param {object} [detail] - structured context (id, limit, …).
   */
  constructor(code, message, detail = undefined) {
    super(message)
    this.name = 'MuxError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

/** Small listener registry; listener exceptions never corrupt the mux. */
function createEmitter() {
  /** @type {Map<string, Array<{ fn: Function, once: boolean }>>} */
  const registry = new Map()
  const emitter = {
    /** Add a persistent listener. @returns {object} the emitter (chainable). */
    on(event, fn) {
      if (typeof fn !== 'function') return emitter
      const list = registry.get(event) ?? []
      list.push({ fn, once: false })
      registry.set(event, list)
      return emitter
    },
    /** Add a one-shot listener. @returns {object} the emitter (chainable). */
    once(event, fn) {
      if (typeof fn !== 'function') return emitter
      const list = registry.get(event) ?? []
      list.push({ fn, once: true })
      registry.set(event, list)
      return emitter
    },
    /** Remove one listener (by function identity). @returns {object} the emitter. */
    off(event, fn) {
      const list = registry.get(event)
      if (list === undefined) return emitter
      const index = list.findIndex((entry) => entry.fn === fn)
      if (index !== -1) list.splice(index, 1)
      if (list.length === 0) registry.delete(event)
      return emitter
    },
    /** Drop every listener (used when a stream settles). @returns {void} */
    clear() {
      registry.clear()
    },
    /** Emit an event; returns true when at least one listener ran. @returns {boolean} */
    emit(event, ...args) {
      const list = registry.get(event)
      if (list === undefined) return false
      for (const entry of [...list]) {
        if (entry.once) emitter.off(event, entry.fn)
        try {
          entry.fn(...args)
        } catch {
          // A broken bridge/listener callback must not break framing or
          // settlement for every other stream.
        }
      }
      return true
    },
  }
  return emitter
}

/** Coerce one data chunk to a Buffer (no copy for Buffer/Uint8Array). */
function chunkBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8')
  throw new MuxError('bad_chunk', `chunk must be a Buffer, Uint8Array or string, got ${typeof chunk}`)
}

/** True for a positive safe integer that fits in a uint32 stream id. */
function isValidStreamId(id) {
  return Number.isSafeInteger(id) && id > 0 && id <= MAX_STREAM_ID
}

/** Validate the options and derive role parity. */
function normalizeOptions(options) {
  const {
    role = 'client',
    maxStreams = DEFAULT_MAX_STREAMS,
    highWaterMark = DEFAULT_HIGH_WATER_MARK,
    globalHighWaterMark = DEFAULT_GLOBAL_HIGH_WATER_MARK,
    startId,
    send = () => true,
    onStream = () => {},
  } = options ?? {}

  if (role !== 'client' && role !== 'hub') {
    throw new MuxError('invalid-role', `role must be 'client' or 'hub', got ${String(role)}`)
  }
  if (!Number.isSafeInteger(maxStreams) || maxStreams < 1) {
    throw new MuxError('invalid-options', `maxStreams must be a positive integer, got ${String(maxStreams)}`)
  }
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1) {
    throw new MuxError('invalid-options', `highWaterMark must be a positive integer, got ${String(highWaterMark)}`)
  }
  if (!Number.isSafeInteger(globalHighWaterMark) || globalHighWaterMark < 1) {
    throw new MuxError('invalid-options', `globalHighWaterMark must be a positive integer, got ${String(globalHighWaterMark)}`)
  }
  if (typeof send !== 'function' || typeof onStream !== 'function') {
    throw new MuxError('invalid-options', 'send and onStream must be functions')
  }
  const parity = role === 'client' ? 1 : 2
  if (startId !== undefined && (!isValidStreamId(startId) || startId % 2 !== parity % 2)) {
    throw new MuxError('invalid-stream-id', `startId must be a positive ${parity === 1 ? 'odd' : 'even'} stream id`)
  }
  return {
    role, parity, maxStreams, highWaterMark, globalHighWaterMark,
    startId: startId ?? parity, send, onStream,
  }
}

/**
 * Create one multiplexer for one hub link.
 *
 * @param {object} [options] - mux options.
 * @param {'client'|'hub'} [options.role] - id parity; `client` = odd ids.
 * @param {number} [options.maxStreams] - concurrent stream cap (default 256).
 * @param {number} [options.highWaterMark] - per-stream queued-byte threshold (64 KiB).
 * @param {number} [options.globalHighWaterMark] - shared outbox threshold (4 MiB).
 * @param {number} [options.startId] - first id to allocate (tests/exhaustion; must match parity).
 * @param {(frame: object) => boolean} [options.send] - transport sink for semantic
 *   frames; return false to apply backpressure. Must not throw.
 * @param {(handle: object) => void} [options.onStream] - peer-opened stream callback.
 * @returns {object} the mux.
 */
export function createMux(options = {}) {
  const {
    role, parity, maxStreams, highWaterMark, globalHighWaterMark, startId, send, onStream,
  } = normalizeOptions(options)

  const muxEmitter = createEmitter()
  /** @type {Map<number, object>} */
  const streams = new Map()
  /** Outbound queue: `{ frame, stream, bytes }`; `stream` is null for control frames. */
  const outbox = []
  const counters = { open: 0, bytesIn: 0, bytesOut: 0, rejected: 0, dropped: 0, opened: 0, closed: 0 }

  let nextId = startId
  let buffered = 0
  let flushing = false
  let shutdown = false
  let peerGone = false

  /** Attempt to flush the outbox; stop at the first sink backpressure signal. */
  function flush() {
    if (flushing) return
    flushing = true
    try {
      let sent = 0
      while (sent < outbox.length) {
        if (send(outbox[sent].frame) === false) break
        sent += 1
      }
      if (sent > 0) {
        for (const entry of outbox.splice(0, sent)) {
          if (entry.bytes <= 0) continue
          buffered -= entry.bytes
          const inner = entry.stream === null ? undefined : INTERNALS.get(entry.stream)
          if (inner !== undefined) inner.pendingBytes -= entry.bytes
        }
      }
    } finally {
      flushing = false
    }
    if (outbox.length > 0) return
    for (const handle of streams.values()) {
      const inner = INTERNALS.get(handle)
      if (inner === undefined || !inner.needDrain || inner.pendingBytes > 0) continue
      inner.needDrain = false
      handle.emitter.emit('drain')
    }
  }

  /** Queue one semantic frame and try to send it. */
  function emitFrame(frame, stream) {
    const bytes = frame.op === 'data' ? frame.chunk.length : 0
    outbox.push({ frame, stream, bytes })
    buffered += bytes
    if (stream !== null) {
      const inner = INTERNALS.get(stream)
      if (inner !== undefined) inner.pendingBytes += bytes
    }
    flush()
  }

  /** Drop queued frames belonging to a settled stream (no data after reset). */
  function purgeStream(handle) {
    if (outbox.length > 0) {
      for (let index = outbox.length - 1; index >= 0; index -= 1) {
        const entry = outbox[index]
        if (entry.stream !== handle) continue
        if (entry.bytes > 0) buffered -= entry.bytes
        outbox.splice(index, 1)
      }
    }
    const inner = INTERNALS.get(handle)
    if (inner !== undefined) {
      inner.pendingBytes = 0
      inner.needDrain = false
    }
  }

  /** Settle one stream exactly once and release it. */
  function settleStream(handle, info) {
    if (handle.settled) return false
    const inner = INTERNALS.get(handle)
    if (inner !== undefined) {
      inner.settled = true
      inner.state = 'closed'
    }
    streams.delete(handle.id)
    counters.open -= 1
    counters.closed += 1
    purgeStream(handle)
    handle.emitter.emit('close', info)
    handle.emitter.clear()
    return true
  }

  /** Build one stream handle (local-open or peer-open). */
  function createHandle({ id, kind, meta, local }) {
    const emitter = createEmitter()
    const inner = {
      state: 'open',
      settled: false,
      localEnded: false,
      remoteEnded: false,
      pendingBytes: 0,
      needDrain: false,
    }

    const handle = {
      /** Stream id allocated by one of the two peers. @returns {number} */
      id,
      /** Caller-supplied stream kind (`'http'`, `'ws'`, …). @returns {string} */
      kind,
      /** Frozen frame metadata (`{id}` lives here on the wire). @returns {object} */
      meta: Object.freeze({ ...meta }),
      /** True when this side called `openStream`. @returns {boolean} */
      local,
      /** `'open' | 'local-ended' | 'remote-ended' | 'closed'`. @returns {string} */
      get state() { return inner.state },
      /** True once the stream settled (close fired). @returns {boolean} */
      get settled() { return inner.settled },
      /** Outbound payload bytes still queued for this stream. @returns {number} */
      get pendingBytes() { return inner.pendingBytes },
      /** True after `end()` was called locally. @returns {boolean} */
      get localEnded() { return inner.localEnded },
      /** True after the peer's end/reset arrived. @returns {boolean} */
      get remoteEnded() { return inner.remoteEnded },

      /**
       * Queue one payload chunk.
       * @param {Buffer|Uint8Array|string} chunk - bytes; must not be mutated until flushed.
       * @returns {boolean} false = stop writing until the handle emits `'drain'`.
       * @throws {MuxError} `stream_closed` after end/reset, `bad_chunk` otherwise.
       */
      write(chunk) {
        if (inner.settled) throw new MuxError('stream_closed', `stream ${id} is closed`, { id })
        if (inner.localEnded) throw new MuxError('stream_closed', `stream ${id} ended locally`, { id })
        const bytes = chunkBuffer(chunk)
        if (bytes.length === 0) return true
        counters.bytesOut += bytes.length
        emitFrame({ op: 'data', id, chunk: bytes }, handle)
        const paused = inner.pendingBytes >= highWaterMark || buffered >= globalHighWaterMark
        if (paused) inner.needDrain = true
        return !paused
      },

      /**
       * Half-close the local direction (queues one `end` frame).
       * @returns {boolean} false when already settled, true otherwise (idempotent).
       */
      end() {
        if (inner.settled) return false
        if (inner.localEnded) return true
        inner.localEnded = true
        emitFrame({ op: 'end', id }, handle)
        if (inner.remoteEnded) settleStream(handle, { reason: 'end', remote: false })
        else inner.state = 'local-ended'
        return true
      },

      /**
       * Abort the stream in both directions (queues one `reset` frame).
       * @param {string} [code] - peer-facing reason code.
       * @param {string} [reason] - human-readable detail.
       * @returns {boolean} true when this call settled the stream.
       */
      reset(code = 'reset', reason = '') {
        if (inner.settled) return false
        emitFrame({ op: 'reset', id, code: String(code), reason: String(reason) }, null)
        settleStream(handle, { reason: 'reset', code: String(code), remote: false })
        return true
      },

      /**
       * Listen on `'data'` (Buffer), `'end'`, `'reset'` (`{code, reason}`),
       * `'drain'`, or `'close'` (`{reason, code?, remote?}`); close fires once.
       * @returns {object} the handle (chainable).
       */
      on(event, fn) { emitter.on(event, fn); return handle },
      /** One-shot variant of `on()`. @returns {object} the handle. */
      once(event, fn) { emitter.once(event, fn); return handle },
      /** Remove a listener. @returns {object} the handle. */
      off(event, fn) { emitter.off(event, fn); return handle },
      /** @internal used by the mux for drain/close events. */
      emitter,
    }
    INTERNALS.set(handle, inner)
    REMOTE_END.set(handle, () => {
      if (inner.remoteEnded || inner.settled) return false
      inner.remoteEnded = true
      emitter.emit('end')
      if (inner.localEnded) settleStream(handle, { reason: 'end', remote: true })
      else inner.state = 'remote-ended'
      return true
    })
    return handle
  }

  /** Allocate the next local id; throws a typed error instead of wrapping. */
  function allocateId() {
    if (nextId > MAX_STREAM_ID) {
      throw new MuxError('stream_id_exhausted', `no stream ids left after ${MAX_STREAM_ID}`, { limit: MAX_STREAM_ID })
    }
    const id = nextId
    nextId += 2
    return id
  }

  const mux = {
    /** Local role (`'client'` odd ids / `'hub'` even ids). @returns {string} */
    role,
    /** Configured concurrent stream cap. @returns {number} */
    maxStreams,

    /**
     * Open one locally-initiated stream (queues an `open` frame).
     * @param {string} kind - `'http'` | `'ws'` | any non-empty label.
     * @param {object} [streamOptions] - `{ meta }` extra frame metadata (no `id`).
     * @returns {object} the stream handle.
     * @throws {MuxError} `too_many_streams` | `stream_id_exhausted` | `closed` | `goaway`.
     */
    openStream(kind, streamOptions = {}) {
      if (shutdown) throw new MuxError('closed', 'the mux was closed with closeAll()')
      if (peerGone) throw new MuxError('goaway', 'the peer sent goaway; no new streams')
      if (typeof kind !== 'string' || kind === '') {
        throw new MuxError('invalid-stream-kind', 'kind must be a non-empty string')
      }
      if (streams.size >= maxStreams) {
        counters.rejected += 1
        throw new MuxError('too_many_streams', `at most ${maxStreams} concurrent streams`, { limit: maxStreams })
      }
      const meta = streamOptions?.meta ?? {}
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
        throw new MuxError('bad-frame', 'stream meta must be an object')
      }
      const id = allocateId()
      const handle = createHandle({ id, kind, meta, local: true })
      streams.set(id, handle)
      counters.open += 1
      counters.opened += 1
      emitFrame({ op: 'open', id, kind, meta: handle.meta }, handle)
      return handle
    },

    /**
     * Apply one inbound semantic frame (`open`/`data`/`end`/`reset`/`goaway`).
     * Unknown ids and wrong-parity/double opens are dropped and counted.
     * @param {object} frame - `{op, id?, kind?, meta?, chunk?, code?, reason?}`.
     * @returns {boolean} true when the frame was applied to a stream/peer state.
     * @throws {MuxError} `bad-frame` | `unknown-frame-op` | `bad_chunk`.
     */
    receive(frame) {
      if (frame === null || typeof frame !== 'object' || typeof frame.op !== 'string') {
        throw new MuxError('bad-frame', 'inbound frame must be an object with a string op')
      }
      if (shutdown) {
        counters.dropped += 1
        return false
      }
      switch (frame.op) {
        case 'open': {
          if (peerGone) { counters.dropped += 1; return false }
          const id = frame.id
          // The peer owns the opposite parity; same-parity ids would collide.
          if (!isValidStreamId(id) || id % 2 === parity % 2) {
            counters.dropped += 1
            return false
          }
          if (streams.has(id)) { counters.dropped += 1; return false }
          if (streams.size >= maxStreams) {
            counters.rejected += 1
            emitFrame({ op: 'reset', id, code: 'too_many_streams', reason: 'maxStreams' }, null)
            return false
          }
          const kind = typeof frame.kind === 'string' && frame.kind !== '' ? frame.kind : 'unknown'
          const meta = typeof frame.meta === 'object' && frame.meta !== null && !Array.isArray(frame.meta) ? frame.meta : {}
          const handle = createHandle({ id, kind, meta, local: false })
          streams.set(id, handle)
          counters.open += 1
          counters.opened += 1
          try {
            onStream(handle)
          } catch {
            // The owner's callback failing must not desynchronize the mux.
          }
          return true
        }
        case 'data': {
          const handle = streams.get(frame.id)
          if (handle === undefined || handle.remoteEnded) { counters.dropped += 1; return false }
          const bytes = chunkBuffer(frame.chunk)
          counters.bytesIn += bytes.length
          if (bytes.length > 0) handle.emitter.emit('data', bytes)
          return true
        }
        case 'end': {
          const handle = streams.get(frame.id)
          const applyEnd = handle === undefined ? undefined : REMOTE_END.get(handle)
          if (applyEnd === undefined || !applyEnd()) { counters.dropped += 1; return false }
          return true
        }
        case 'reset': {
          const handle = streams.get(frame.id)
          if (handle === undefined) { counters.dropped += 1; return false }
          const code = typeof frame.code === 'string' ? frame.code : 'reset'
          const reason = typeof frame.reason === 'string' ? frame.reason : ''
          handle.emitter.emit('reset', { code, reason })
          settleStream(handle, { reason: 'reset', code, remote: true })
          return true
        }
        case 'goaway': {
          peerGone = true
          muxEmitter.emit('goaway', { code: typeof frame.code === 'string' ? frame.code : 'goaway' })
          return true
        }
        default:
          throw new MuxError('unknown-frame-op', `unknown mux frame op '${frame.op}'`, { op: frame.op })
      }
    },

    /**
     * Retry the outbox after the transport signalled it is writable again
     * (typically the WebSocket `'drain'` event).
     * @returns {boolean} true when the outbox is empty.
     */
    drain() {
      flush()
      return outbox.length === 0
    },

    /**
     * Close the link: queue one `goaway`, settle every open stream exactly once,
     * drop their queued frames, and refuse further opens.
     * @param {string} [reason] - goaway code / close reason.
     * @returns {number} number of streams settled by this call (0 when already closed).
     */
    closeAll(reason = 'closed') {
      if (shutdown) return 0
      shutdown = true
      const code = String(reason)
      emitFrame({ op: 'goaway', code }, null)
      let settled = 0
      for (const handle of [...streams.values()]) {
        if (settleStream(handle, { reason: 'closed', code, remote: false })) settled += 1
      }
      muxEmitter.emit('close', { reason: code, streams: settled })
      return settled
    },

    /**
     * Frozen counter snapshot.
     * @returns {{ open: number, bytesIn: number, bytesOut: number, rejected: number,
     *   dropped: number, opened: number, closed: number, buffered: number,
     *   maxStreams: number }} counters.
     */
    stats() {
      return Object.freeze({
        open: counters.open,
        bytesIn: counters.bytesIn,
        bytesOut: counters.bytesOut,
        rejected: counters.rejected,
        dropped: counters.dropped,
        opened: counters.opened,
        closed: counters.closed,
        buffered,
        maxStreams,
      })
    },

    /**
     * Listen on mux-level `'goaway'` (`{code}`) or `'close'` (`{reason, streams}`).
     * @returns {object} the mux (chainable).
     */
    on(event, fn) { muxEmitter.on(event, fn); return mux },
    /** One-shot variant of `on()`. @returns {object} the mux. */
    once(event, fn) { muxEmitter.once(event, fn); return mux },
    /** Remove a mux-level listener. @returns {object} the mux. */
    off(event, fn) { muxEmitter.off(event, fn); return mux },
  }

  return mux
}
