/**
 * Unit tests for the relay transport core (relay S0, docs/relay-design.md §7):
 * `lib/relay/wire.js` + `lib/relay/mux.js`.
 *
 * Run with: `node --test lib/relay/test/`.
 *
 * These are pure, in-process tests: no WebSocket, no HTTP. Every assertion
 * targets one invariant the S1 relay/hub-link code will rely on — frame
 * boundaries under arbitrary chunking, bounded frames, typed errors, id parity,
 * exactly-once settlement, stream caps and real backpressure.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FRAME_HEADER_BYTES,
  FrameDecoder,
  MAX_META_BYTES,
  MAX_PAYLOAD_BYTES,
  OPCODE_NAMES,
  OPCODES,
  WireError,
  decodeFrame,
  encodeFrame,
  isKnownOpcode,
  opcodeName,
} from '../wire.js'
import {
  DEFAULT_MAX_STREAMS,
  MAX_STREAM_ID,
  MuxError,
  createMux,
} from '../mux.js'

/** Assert `fn` throws a WireError with `code`. */
function assertWireError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof WireError, `expected WireError, got ${error?.constructor?.name}`)
    assert.equal(error.code, code)
    return true
  })
}

/** Assert `fn` throws a MuxError with `code`. */
function assertMuxError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof MuxError, `expected MuxError, got ${error?.constructor?.name}`)
    assert.equal(error.code, code)
    return true
  })
}

/** Build a raw frame header for hand-crafted malformed-frame tests. */
function rawHeader(opcode, metaLen, payloadLen) {
  const header = Buffer.alloc(FRAME_HEADER_BYTES)
  header.writeUInt8(opcode, 0)
  header.writeUInt32BE(metaLen, 1)
  header.writeUInt32BE(payloadLen, 5)
  return header
}

/** Create a mux whose sink records frames; `accept` can be flipped for backpressure tests. */
function recordingMux(options = {}) {
  const frames = []
  const sink = { accept: true, frames }
  const mux = createMux({
    ...options,
    send(frame) {
      if (!sink.accept) return false
      frames.push(frame)
      return true
    },
  })
  return { mux, frames, sink }
}

// ---------------------------------------------------------------------------
// wire.js — frame codec
// ---------------------------------------------------------------------------

test('wire: round-trips every opcode with meta and binary payload', () => {
  const payload = Buffer.from([0x00, 0x01, 0x02, 0xff])
  const names = Object.values(OPCODES)
  assert.equal(names.length, 11)
  for (const opcode of names) {
    const meta = { id: 7, opcodeName: OPCODE_NAMES[opcode], nested: { a: 1 } }
    const buffer = encodeFrame(opcode, meta, payload)
    assert.equal(buffer.readUInt8(0), opcode)
    assert.equal(buffer.length, FRAME_HEADER_BYTES + Buffer.byteLength(JSON.stringify(meta)) + payload.length)
    const frame = decodeFrame(buffer)
    assert.equal(frame.opcode, opcode)
    assert.equal(frame.name, OPCODE_NAMES[opcode])
    assert.deepEqual(frame.meta, meta)
    assert.deepEqual([...frame.payload], [...payload])
    assert.equal(isKnownOpcode(opcode), true)
    assert.equal(opcodeName(opcode), OPCODE_NAMES[opcode])
  }
})

test('wire: empty meta/payload defaults, string and Uint8Array payloads', () => {
  const empty = decodeFrame(encodeFrame(OPCODES.PING))
  assert.deepEqual(empty.meta, {})
  assert.equal(empty.payload.length, 0)
  assert.equal(empty.name, 'ping')

  assert.deepEqual(decodeFrame(encodeFrame(OPCODES.PONG, null)).meta, {})

  const text = decodeFrame(encodeFrame(OPCODES.HTTP_DATA, { id: 1 }, 'héllo'))
  assert.equal(text.payload.toString('utf8'), 'héllo')

  const typed = decodeFrame(encodeFrame(OPCODES.WS_FRAME, {}, new Uint8Array([9, 8, 7])))
  assert.deepEqual([...typed.payload], [9, 8, 7])

  // decoded payload is a copy, not a view of the caller's buffer
  const source = encodeFrame(OPCODES.GOAWAY, {}, Buffer.from('abc'))
  const decoded = decodeFrame(source)
  source.fill(0)
  assert.equal(decoded.payload.toString('utf8'), 'abc')
})

test('wire: meta boundary is exactly MAX_META_BYTES', () => {
  const pad = 'a'.repeat(MAX_META_BYTES - 8)
  const meta = { p: pad }
  assert.equal(Buffer.byteLength(JSON.stringify(meta)), MAX_META_BYTES)
  const frame = decodeFrame(encodeFrame(OPCODES.HTTP_OPEN, meta))
  assert.equal(Buffer.byteLength(JSON.stringify(frame.meta)), MAX_META_BYTES)

  assertWireError(() => encodeFrame(OPCODES.HTTP_OPEN, { p: `${pad}a` }), 'meta-too-large')
})

test('wire: payload boundary is exactly MAX_PAYLOAD_BYTES', () => {
  const max = Buffer.alloc(MAX_PAYLOAD_BYTES, 0x61)
  assert.equal(decodeFrame(encodeFrame(OPCODES.HTTP_DATA, { id: 1 }, max)).payload.length, MAX_PAYLOAD_BYTES)
  assertWireError(() => encodeFrame(OPCODES.HTTP_DATA, { id: 1 }, Buffer.alloc(MAX_PAYLOAD_BYTES + 1)), 'payload-too-large')
  // decode side rejects a declared oversize before the body arrives
  assertWireError(() => decodeFrame(rawHeader(OPCODES.HTTP_DATA, 0, MAX_PAYLOAD_BYTES + 1)), 'payload-too-large')
  assertWireError(() => decodeFrame(rawHeader(OPCODES.HTTP_DATA, MAX_META_BYTES + 1, 0)), 'meta-too-large')
})

test('wire: unknown opcodes are typed errors on encode and decode', () => {
  assertWireError(() => encodeFrame(0x7f), 'unknown-opcode')
  assertWireError(() => encodeFrame(-1), 'unknown-opcode')
  assertWireError(() => encodeFrame('1'), 'unknown-opcode')
  assertWireError(() => decodeFrame(rawHeader(0x7f, 0, 0)), 'unknown-opcode')
  assert.equal(isKnownOpcode(0x7f), false)
  assert.equal(isKnownOpcode(OPCODES.HTTP_OPEN), true)
  assert.equal(opcodeName(0x7f), null)
})

test('wire: malformed frames are typed errors, never raw throws', () => {
  const valid = encodeFrame(OPCODES.HTTP_HEAD, { id: 3 }, Buffer.from('x'))
  assertWireError(() => decodeFrame(valid.subarray(0, valid.length - 1)), 'truncated')
  assertWireError(() => decodeFrame(Buffer.alloc(4)), 'truncated')
  assertWireError(() => decodeFrame(Buffer.concat([valid, Buffer.from([0])])), 'trailing-bytes')
  assertWireError(() => decodeFrame(42), 'bad-frame')
  assertWireError(() => encodeFrame(OPCODES.PING, 'not-an-object'), 'bad-meta')
  const circular = {}
  circular.self = circular
  assertWireError(() => encodeFrame(OPCODES.PING, circular), 'bad-meta')
  // meta that is not a JSON object
  const badJson = Buffer.concat([rawHeader(OPCODES.HTTP_OPEN, 1, 0), Buffer.from('{')])
  assertWireError(() => decodeFrame(badJson), 'bad-meta')
  const badShape = Buffer.concat([rawHeader(OPCODES.HTTP_OPEN, 2, 0), Buffer.from('[]')])
  assertWireError(() => decodeFrame(badShape), 'bad-meta')
})

test('wire: FrameDecoder handles every split point of two coalesced frames', () => {
  const one = encodeFrame(OPCODES.HTTP_OPEN, { id: 1, path: '/a' }, Buffer.from('first'))
  const two = encodeFrame(OPCODES.HTTP_DATA, { id: 1 }, Buffer.from('second'))
  const both = Buffer.concat([one, two])

  // one chunk → both frames
  const whole = new FrameDecoder()
  assert.equal(whole.push(both).length, 2)
  assert.equal(whole.buffered, 0)

  // every split point → still exactly two frames, in order
  let splitChecks = 0
  for (let split = 0; split <= both.length; split += 1) {
    const decoder = new FrameDecoder()
    const frames = [...decoder.push(both.subarray(0, split)), ...decoder.push(both.subarray(split))]
    assert.equal(frames.length, 2, `split at ${split}`)
    assert.equal(frames[0].meta.path, '/a')
    assert.equal(frames[1].payload.toString('utf8'), 'second')
    assert.equal(decoder.buffered, 0)
    splitChecks += 1
  }
  assert.equal(splitChecks, both.length + 1)

  // one byte at a time
  const bytewise = new FrameDecoder()
  const frames = []
  for (const byte of both) frames.push(...bytewise.push(Buffer.from([byte])))
  assert.equal(frames.length, 2)
  assert.equal(bytewise.buffered, 0)
})

test('wire: FrameDecoder buffers a partial trailing frame and completes it later', () => {
  const one = encodeFrame(OPCODES.HTTP_END, { id: 1 })
  const two = encodeFrame(OPCODES.WS_FRAME, { id: 2 }, Buffer.from('payload'))
  const split = two.length - 5
  const decoder = new FrameDecoder()
  const first = decoder.push(Buffer.concat([one, two.subarray(0, split)]))
  assert.equal(first.length, 1)
  assert.equal(decoder.buffered, split)
  const rest = decoder.push(two.subarray(split))
  assert.equal(rest.length, 1)
  assert.equal(rest[0].payload.toString('utf8'), 'payload')
  assert.equal(decoder.buffered, 0)
  assert.deepEqual(decoder.push(Buffer.alloc(0)), [])
})

test('wire: FrameDecoder poisons itself on a framing violation and reset() recovers', () => {
  const decoder = new FrameDecoder()
  assertWireError(() => decoder.push(rawHeader(OPCODES.HTTP_DATA, MAX_META_BYTES + 1, 0)), 'meta-too-large')
  assert.equal(decoder.broken, true)
  assertWireError(() => decoder.push(Buffer.alloc(1)), 'decoder-broken')
  decoder.reset()
  assert.equal(decoder.broken, false)
  const buffer = encodeFrame(OPCODES.PING, { t: 1 })
  assert.equal(decoder.push(buffer).length, 1)
})

// ---------------------------------------------------------------------------
// mux.js — stream multiplexing
// ---------------------------------------------------------------------------

test('mux: validates options and role parity of allocated ids', () => {
  assertMuxError(() => createMux({ role: 'server' }), 'invalid-role')
  assertMuxError(() => createMux({ maxStreams: 0 }), 'invalid-options')
  assertMuxError(() => createMux({ highWaterMark: 0 }), 'invalid-options')
  assertMuxError(() => createMux({ globalHighWaterMark: -1 }), 'invalid-options')
  assertMuxError(() => createMux({ role: 'client', startId: 2 }), 'invalid-stream-id')

  const client = recordingMux({ role: 'client' }).mux
  const hub = recordingMux({ role: 'hub' }).mux
  assert.equal(client.role, 'client')
  assert.equal(client.maxStreams, DEFAULT_MAX_STREAMS)
  assert.deepEqual([1, 3, 5], [client.openStream('http').id, client.openStream('http').id, client.openStream('ws').id])
  assert.deepEqual([2, 4], [hub.openStream('http').id, hub.openStream('http').id])
})

test('mux: openStream queues an open frame and write/end queue data/end frames', () => {
  const { mux, frames } = recordingMux({ role: 'client' })
  const handle = mux.openStream('http', { meta: { path: '/api/x', method: 'GET' } })
  assert.deepEqual(frames[0], { op: 'open', id: 1, kind: 'http', meta: { path: '/api/x', method: 'GET' } })
  assert.equal(handle.state, 'open')
  assert.equal(handle.local, true)

  assert.equal(handle.write(Buffer.from('hello')), true)
  assert.deepEqual(frames[1].op, 'data')
  assert.equal(frames[1].chunk.toString('utf8'), 'hello')
  assert.equal(handle.write(''), true) // empty chunks are ignored
  assert.equal(handle.end(), true)
  assert.deepEqual(frames[2], { op: 'end', id: 1 })
  assert.equal(handle.end(), true) // idempotent, no extra frame
  assert.equal(frames.length, 3)
  assert.equal(handle.state, 'local-ended')
  assert.equal(handle.localEnded, true)
  assertMuxError(() => handle.write(Buffer.from('late')), 'stream_closed')
  assert.equal(mux.stats().bytesOut, 5)
  assert.equal(mux.stats().opened, 1)
})

test('mux: maxStreams rejects locally with a typed error and does not burn ids', () => {
  const { mux } = recordingMux({ role: 'client', maxStreams: 2 })
  const first = mux.openStream('http')
  mux.openStream('http')
  assertMuxError(() => mux.openStream('http'), 'too_many_streams')
  assert.equal(mux.stats().open, 2)
  assert.equal(mux.stats().rejected, 1)
  first.reset('done')
  assert.equal(mux.stats().open, 1)
  assert.equal(mux.openStream('http').id, 5)
})

test('mux: peer opens are routed, wrong parity and unknown ids are dropped', () => {
  const opened = []
  const { mux } = recordingMux({ role: 'client', onStream: (handle) => opened.push(handle) })
  assert.equal(mux.receive({ op: 'open', id: 2, kind: 'http', meta: { path: '/r' } }), true)
  assert.equal(opened.length, 1)
  assert.equal(opened[0].id, 2)
  assert.equal(opened[0].local, false)
  assert.deepEqual(opened[0].meta, { path: '/r' })
  assert.equal(mux.stats().open, 1)

  // same parity as the client's own ids → collision risk → dropped
  assert.equal(mux.receive({ op: 'open', id: 3 }), false)
  assert.equal(mux.stats().dropped, 1)
  // duplicate id → dropped
  assert.equal(mux.receive({ op: 'open', id: 2 }), false)
  assert.equal(mux.stats().dropped, 2)

  const received = []
  opened[0].on('data', (chunk) => received.push(chunk.toString('utf8')))
  assert.equal(mux.receive({ op: 'data', id: 2, chunk: Buffer.from('body') }), true)
  assert.deepEqual(received, ['body'])
  assert.equal(mux.stats().bytesIn, 4)
  // unknown stream id → dropped + counted
  assert.equal(mux.receive({ op: 'data', id: 99, chunk: Buffer.from('x') }), false)
  assert.equal(mux.stats().dropped, 3)
  assert.equal(mux.stats().bytesIn, 4)
})

test('mux: peer open over maxStreams is rejected with a reset frame', () => {
  const { mux, frames } = recordingMux({ role: 'client', maxStreams: 1 })
  mux.openStream('http')
  assert.equal(mux.receive({ op: 'open', id: 2, kind: 'http' }), false)
  assert.equal(mux.stats().rejected, 1)
  assert.deepEqual(frames.at(-1), { op: 'reset', id: 2, code: 'too_many_streams', reason: 'maxStreams' })
  assert.equal(mux.stats().open, 1)
})

test('mux: end-of-stream settles each stream exactly once', () => {
  const { mux } = recordingMux({ role: 'client' })
  const handle = mux.openStream('http')
  const events = []
  handle.on('end', () => events.push('end'))
  handle.on('close', (info) => events.push(`close:${info.reason}`))
  handle.end()
  assert.equal(handle.state, 'local-ended')
  assert.equal(mux.receive({ op: 'end', id: handle.id }), true)
  assert.deepEqual(events, ['end', 'close:end'])
  assert.equal(handle.state, 'closed')
  assert.equal(handle.settled, true)
  assert.equal(mux.stats().open, 0)
  assert.equal(mux.stats().closed, 1)
  // double end from the peer is a dropped frame, not a second close
  assert.equal(mux.receive({ op: 'end', id: handle.id }), false)
  assert.equal(events.length, 2)
  assert.equal(mux.stats().dropped, 1)
})

test('mux: a peer-opened stream can be half-closed from this side', () => {
  const opened = []
  const { mux } = recordingMux({ role: 'hub', onStream: (handle) => opened.push(handle) })
  mux.receive({ op: 'open', id: 1, kind: 'ws' }) // client-parity id on the hub side
  const handle = opened[0]
  const events = []
  handle.on('end', () => events.push('remote-end'))
  handle.on('close', () => events.push('close'))
  assert.equal(mux.receive({ op: 'data', id: 1, chunk: 'frame' }), true)
  assert.equal(mux.receive({ op: 'end', id: 1 }), true)
  assert.equal(handle.state, 'remote-ended')
  assert.deepEqual(events, ['remote-end'])
  assert.equal(handle.end(), true)
  assert.deepEqual(events, ['remote-end', 'close'])
  assert.equal(handle.settled, true)
})

test('mux: reset settles immediately and drops queued data for that stream', () => {
  const { mux, frames, sink } = recordingMux({ role: 'client' })
  sink.accept = false // force the frames to queue so purging is observable
  const handle = mux.openStream('http')
  handle.write(Buffer.from('abc'))
  const closes = []
  handle.on('close', (info) => closes.push(info))
  assert.equal(handle.reset('cancelled', 'caller went away'), true)
  assert.equal(handle.state, 'closed')
  assert.equal(handle.settled, true)
  assert.deepEqual(closes, [{ reason: 'reset', code: 'cancelled', remote: false }])
  // only the reset frame survives the purge (open + data were dropped)
  sink.accept = true
  assert.equal(mux.drain(), true)
  assert.deepEqual(frames.map((frame) => frame.op), ['reset'])
  assert.deepEqual(frames[0], { op: 'reset', id: 1, code: 'cancelled', reason: 'caller went away' })
  assert.equal(handle.reset(), false)
  assert.equal(mux.stats().closed, 1)
  assert.equal(mux.stats().buffered, 0)
})

test('mux: peer reset settles without echoing a reset frame', () => {
  const opened = []
  const { mux, frames } = recordingMux({ role: 'client', onStream: (handle) => opened.push(handle) })
  mux.receive({ op: 'open', id: 2, kind: 'http' })
  const handle = opened[0]
  const events = []
  handle.on('reset', (info) => events.push(`reset:${info.code}`))
  handle.on('close', (info) => events.push(`close:${info.remote}`))
  assert.equal(mux.receive({ op: 'reset', id: 2, code: 'timeout', reason: 'upstream' }), true)
  assert.deepEqual(events, ['reset:timeout', 'close:true'])
  assert.equal(handle.settled, true)
  assert.equal(frames.length, 0) // no outbound frames for a peer reset
  assert.equal(mux.stats().open, 0)
})

test('mux: closeAll sends one goaway and settles every pending stream once', () => {
  const opened = []
  const { mux, frames } = recordingMux({ role: 'client', onStream: (handle) => opened.push(handle) })
  const local = [mux.openStream('http'), mux.openStream('http'), mux.openStream('ws')]
  mux.receive({ op: 'open', id: 2 })
  mux.receive({ op: 'open', id: 4 })
  const closeCounts = new Map()
  for (const handle of [...local, ...opened]) {
    handle.on('close', () => closeCounts.set(handle.id, (closeCounts.get(handle.id) ?? 0) + 1))
  }
  assert.equal(mux.stats().open, 5)
  assert.equal(mux.closeAll('shutdown'), 5)
  assert.equal(frames.filter((frame) => frame.op === 'goaway').length, 1)
  assert.equal(frames.at(-1).op, 'goaway')
  assert.equal(frames.at(-1).code, 'shutdown')
  for (const id of [1, 3, 5, 2, 4]) assert.equal(closeCounts.get(id), 1)
  assert.equal(mux.stats().open, 0)
  assert.equal(mux.stats().closed, 5)
  assert.equal(mux.closeAll('again'), 0)
  assert.equal(frames.filter((frame) => frame.op === 'goaway').length, 1)
  assertMuxError(() => mux.openStream('http'), 'closed')
  assert.equal(mux.receive({ op: 'data', id: 1, chunk: 'x' }), false)
})

test('mux: peer goaway blocks new streams but leaves settlement to the caller', () => {
  const { mux } = recordingMux({ role: 'client' })
  const handle = mux.openStream('http')
  let code = null
  mux.on('goaway', (info) => { code = info.code })
  assert.equal(mux.receive({ op: 'goaway', code: 'maintenance' }), true)
  assert.equal(code, 'maintenance')
  assert.equal(mux.stats().open, 1) // existing stream still open
  assertMuxError(() => mux.openStream('http'), 'goaway')
  assert.equal(mux.closeAll('client-close'), 1)
  assert.equal(handle.settled, true)
})

test('mux: per-stream highWaterMark produces pause() then a single drain', () => {
  const { mux, frames, sink } = recordingMux({ role: 'client', highWaterMark: 8 })
  sink.accept = false
  const handle = mux.openStream('http')
  const drains = []
  handle.on('drain', () => drains.push('drain'))
  assert.equal(handle.write(Buffer.alloc(4)), true) // 4 queued < 8
  assert.equal(handle.pendingBytes, 4)
  assert.equal(handle.write(Buffer.alloc(4)), false) // 8 queued == highWaterMark → pause
  assert.equal(handle.pendingBytes, 8)
  assert.equal(mux.stats().buffered, 8)
  assert.equal(mux.drain(), false) // sink still blocked

  sink.accept = true
  assert.equal(mux.drain(), true)
  assert.equal(handle.pendingBytes, 0)
  assert.equal(mux.stats().buffered, 0)
  assert.deepEqual(drains, ['drain'])
  assert.equal(handle.write(Buffer.from('ok')), true) // writable again
  assert.deepEqual(frames.filter((frame) => frame.op === 'data').map((frame) => frame.chunk.length), [4, 4, 2])
})

test('mux: globalHighWaterMark pauses across streams', () => {
  const { mux, sink } = recordingMux({ role: 'client', highWaterMark: 1024, globalHighWaterMark: 8 })
  sink.accept = false
  const a = mux.openStream('http')
  const b = mux.openStream('http')
  assert.equal(a.write(Buffer.alloc(4)), true) // 4 < global 8
  assert.equal(b.write(Buffer.alloc(4)), false) // 8 == global HWM
  assert.equal(mux.stats().buffered, 8)
  assert.equal(a.pendingBytes, 4)
  assert.equal(b.pendingBytes, 4)
  sink.accept = true
  assert.equal(mux.drain(), true)
  assert.equal(mux.stats().buffered, 0)
})

test('mux: stream id parity exhaustion is a typed error', () => {
  const { mux } = recordingMux({ role: 'client', startId: MAX_STREAM_ID - 2 })
  assert.equal(mux.openStream('http').id, MAX_STREAM_ID - 2)
  assert.equal(mux.openStream('http').id, MAX_STREAM_ID)
  assertMuxError(() => mux.openStream('http'), 'stream_id_exhausted')
})

test('mux: stats snapshot is frozen, complete, and counts rejected/dropped', () => {
  const { mux } = recordingMux({ role: 'client', maxStreams: 1 })
  const handle = mux.openStream('http')
  assertMuxError(() => mux.openStream('http'), 'too_many_streams')
  mux.receive({ op: 'data', id: 42, chunk: 'x' })
  const stats = mux.stats()
  assert.equal(Object.isFrozen(stats), true)
  for (const key of ['open', 'bytesIn', 'bytesOut', 'rejected', 'dropped', 'opened', 'closed', 'buffered', 'maxStreams']) {
    assert.equal(typeof stats[key], 'number', key)
  }
  assert.equal(stats.rejected, 1)
  assert.equal(stats.dropped, 1)
  assert.equal(stats.maxStreams, 1)
  // the snapshot is a copy: later changes do not mutate it
  handle.end()
  assert.equal(stats.open, 1)
  assert.equal(mux.stats().open, 1)
  assert.equal(mux.stats().closed, 0)
})

test('mux: malformed inbound frames and bad chunks are typed errors', () => {
  const { mux } = recordingMux({ role: 'client' })
  assertMuxError(() => mux.receive(null), 'bad-frame')
  assertMuxError(() => mux.receive({ op: 1 }), 'bad-frame')
  assertMuxError(() => mux.receive({ op: 'ping' }), 'unknown-frame-op')
  const opened = []
  const peerMux = createMux({ role: 'hub', onStream: (handle) => opened.push(handle) })
  peerMux.receive({ op: 'open', id: 1 })
  assertMuxError(() => peerMux.receive({ op: 'data', id: 1, chunk: 42 }), 'bad_chunk')
  assertMuxError(() => mux.openStream(''), 'invalid-stream-kind')
})

test('mux: a throwing listener cannot break data delivery or settlement', () => {
  const opened = []
  const { mux } = recordingMux({ role: 'client', onStream: (handle) => opened.push(handle) })
  mux.receive({ op: 'open', id: 2 })
  const handle = opened[0]
  const seen = []
  handle.on('data', () => { throw new Error('boom') })
  handle.on('data', (chunk) => seen.push(chunk.toString('utf8')))
  assert.equal(mux.receive({ op: 'data', id: 2, chunk: 'still-delivered' }), true)
  assert.deepEqual(seen, ['still-delivered'])
  const closes = []
  handle.on('close', () => closes.push('closed'))
  handle.reset()
  assert.deepEqual(closes, ['closed'])
})
