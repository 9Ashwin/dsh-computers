/**
 * Zero-dependency wire vocabulary for dsh-computers (refactor R1,
 * docs/refactor-plan.md §3).
 *
 * One leaf module owns every name and shape that travels between the host,
 * the machine agent and the browser client, so the other modules stop building
 * JSON literals inline. Nothing here imports anything, holds state, or has side
 * effects: it is safe to import from any file (including the smoke harness).
 *
 * This is a pure-extraction module: every constructor reproduces the exact
 * field names and field order that the call sites used before, and every guard
 * mirrors the tolerant parsing the endpoints already did. Behaviour, wire bytes
 * and error texts are unchanged.
 *
 * Sections below reference PROTOCOL.md (the host/agent contract).
 */

/** Wire protocol revision carried in `/state.version` and the handshake. */
export const PROTOCOL_VERSION = 2

/** On-disk registry document version (`state.json`). */
export const STATE_VERSION = 1

/** Base path shared by every route (PROTOCOL §3). */
export const API_BASE = '/api/dsh-computers'

/** Machine-authenticated paths (PROTOCOL §3). */
export const AGENT_PATHS = Object.freeze({
  ENROLL: '/agent/enroll',
  EVENTS: '/agent/events',
  HEARTBEAT: '/agent/heartbeat',
  RESULTS: '/agent/results',
  CHUNK: '/agent/results/chunk',
  FS_RESULT: '/agent/fs/result',
})

/** SSE event names the host writes (PROTOCOL §3.2, §11.2, §11.3). */
export const WIRE_EVENT = Object.freeze({
  HELLO: 'hello',
  EXEC: 'exec',
  CANCEL: 'cancel',
  PING: 'ping',
  CONFIG: 'config',
  FS: 'fs',
})

/** Streaming chunk frame types (PROTOCOL §11.2/§11.6.2). */
export const CHUNK_TYPE = Object.freeze({
  STDOUT: 'stdout',
  STDERR: 'stderr',
  HEARTBEAT: 'heartbeat',
})

/** Agent capabilities (PROTOCOL §11.1); additive, unknown flags are ignored. */
/**
 * Application-level presence lease (PROTOCOL §11.7).
 *
 * A socket that stays OPEN proves nothing: OS suspension, a dead proxy and a
 * half-open TCP connection all keep it around. Only a *validated inbound frame*
 * (hello, heartbeat, chunk, result, fs result) refreshes presence, so a silent
 * stream is declared offline once the lease runs out.
 */
export const LEASE_MS = 45_000
/** How often the hub sweeps expired leases. */
export const LEASE_CHECK_MS = 10_000

export const CAPABILITIES = Object.freeze(['exec', 'fs', 'jobs', 'pty', 'tunnel'])

/** Host features advertised in `hello` (PROTOCOL §11.1/§11.5). */
export const HOST_FEATURES = Object.freeze(['stream', 'fs'])

/** Typed terminal state for every execution (R3, PROTOCOL §5/§11). */
export const EXECUTION_STATUS = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
})

/** All terminal states, in documentation order. */
export const EXECUTION_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'timeout'])

/** Whether the computer can be reused after an execution (R3, PROTOCOL §11). */
export const DISPOSITION = Object.freeze({
  REUSABLE: 'reusable',
  BROKEN: 'broken',
})

/** All dispositions. */
export const DISPOSITIONS = Object.freeze(['reusable', 'broken'])

/** DSH job registry outcome vocabulary (JobHooks.done). */
export const JOB_STATUS = Object.freeze({
  COMPLETED: 'completed',
  KILLED: 'killed',
  FAILED: 'failed',
})

/** Error codes used by every host error envelope (PROTOCOL §4). */
export const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad-request',
  UNADMITTED: 'unadmitted',
  INVALID_TOKEN: 'invalid-token',
  INVALID_KEY: 'invalid-key',
  KEY_USED: 'key-used',
  KEY_EXPIRED: 'key-expired',
  HUB_UNREACHABLE: 'hub-unreachable',
  UNKNOWN_REQUEST: 'unknown-request',
  NOT_FOUND: 'not-found',
  FORBIDDEN: 'forbidden',
  METHOD_NOT_ALLOWED: 'method-not-allowed',
  PAYLOAD_TOO_LARGE: 'payload-too-large',
  INVALID: 'invalid',
  INTERNAL: 'internal',
  OFFLINE: 'offline',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
  DISPOSED: 'disposed',
})

/** True for a non-null, non-array plain object. */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** True for a non-empty (after trim) string. */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** The `requestId` of a wire frame, or null when malformed. */
export function requestIdOf(payload) {
  if (!isPlainObject(payload) || typeof payload.requestId !== 'string') return null
  return payload.requestId
}

/**
 * Drift-tolerant optional field accessor.
 *
 * Two forms, both tolerant of absent/null input:
 *   optional(guard)            → (value) => parsed | undefined
 *   optional(guard, fallback)  → (value) => parsed | fallback
 *   optional({field: guard})   → (source) => plain object with only the fields
 *                                present and valid; null when source is not an object
 *
 * A guard that throws, or returns undefined, degrades to the fallback instead of
 * failing the request: an older/newer peer must never break the host.
 */
export function optional(schemaLike, fallback = undefined) {
  if (typeof schemaLike === 'function') {
    return (value) => {
      if (value === undefined || value === null) return fallback
      try {
        const parsed = schemaLike(value)
        return parsed === undefined ? fallback : parsed
      } catch {
        return fallback
      }
    }
  }
  // Object-schema form: keep only known keys that pass their guard.
  const fields = isPlainObject(schemaLike) ? schemaLike : {}
  return (source) => {
    if (!isPlainObject(source)) return null
    const out = {}
    for (const [key, guard] of Object.entries(fields)) {
      if (source[key] === undefined || source[key] === null) continue
      try {
        const parsed = typeof guard === 'function' ? guard(source[key]) : source[key]
        if (parsed !== undefined) out[key] = parsed
      } catch {
        // Unknown/invalid field: omit it rather than reject the body.
      }
    }
    return out
  }
}

/**
 * Copy only the known keys that are actually present (`undefined` dropped).
 * Used where request bodies used to be spread wholesale.
 */
export function pickKnown(source, keys) {
  const out = {}
  if (!isPlainObject(source)) return out
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

/** Host→agent `hello` event (PROTOCOL §3.2, §11.1, §11.5). */
export function helloFrame({ computerId, name, heartbeatMs, capabilities = [], features = HOST_FEATURES }) {
  return {
    computerId,
    name,
    heartbeatMs,
    capabilities: Array.isArray(capabilities) ? [...capabilities] : ['exec'],
    features: Array.isArray(features) ? [...features] : [...HOST_FEATURES],
  }
}

/** Host→agent `exec` request (PROTOCOL §3.2, §11.2). */
export function execFrame({ requestId, command, cwd = null, timeoutMs, shell = 'sh', stream = true }) {
  return { requestId, command, cwd: cwd ?? null, timeoutMs, shell, stream }
}

/** Host→agent `cancel` request (PROTOCOL §3.2). */
export function cancelFrame(requestId) {
  return { requestId }
}

/** Host→agent `fs` request (PROTOCOL §11.3): `{requestId, op, ...payload}`. */
export function fsFrame({ requestId, op, payload = {} }) {
  const body = isPlainObject(payload) ? payload : {}
  return { requestId, op, ...body }
}

/** Host→agent `ping` keep-alive (PROTOCOL §3.2). */
export function pingFrame(nowMs) {
  return { t: typeof nowMs === 'number' ? nowMs : Date.now() }
}

/** Agent→host streaming chunk frame (PROTOCOL §11.2/§11.6.2). */
export function chunkFrame({ requestId, seq, type, data = '' }) {
  return { requestId, seq, type, data }
}

/** Agent→host final result frame (PROTOCOL §3.3). */
export function resultFrame({
  requestId, ok = false, exitCode = null, signal = null, stdout = '', stderr = '',
  durationMs = 0, truncated = false, timedOut = false, error = null,
}) {
  return { requestId, ok, exitCode, signal, stdout, stderr, durationMs, truncated, timedOut, error }
}

/** Agent→host heartbeat body (PROTOCOL §3.4): `{meta}` plus optional top-level fields. */
export function heartbeatBody({ meta = {}, extra = {} } = {}) {
  return { meta: isPlainObject(meta) ? meta : {}, ...pickKnown(extra, ['agentVersion', 'capabilities', 'workspaceBase', 'mode', 'caps']) }
}

/** §11.6 handshake metadata, carried in the enroll body and the connect header. */
export function connectMetadata({
  version = 1, agentVersion = null, mode = null, hostname = '', os = '', arch = '',
  capabilities = [], workspaceBase = null, caps = null,
}) {
  const metadata = {
    version,
    agentVersion,
    hostname,
    os,
    arch,
    capabilities: Array.isArray(capabilities) ? [...capabilities] : [],
    workspaceBase,
  }
  if (mode !== null) metadata.mode = mode
  if (caps !== null && isPlainObject(caps)) metadata.caps = { ...caps }
  return metadata
}

/** Encode the handshake metadata as the header value the agent sends. */
export function encodeMetadataHeader(metadata) {
  return Buffer.from(JSON.stringify(metadata ?? {}), 'utf8').toString('base64url')
}

/**
 * Decode the `x-dsh-computers-metadata` header (base64url JSON).
 * @returns {object|null} the payload, or null when absent/malformed.
 */
export function decodeMetadataHeader(value) {
  const text = Array.isArray(value) ? value[0] : value
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(text.trim(), 'base64url').toString('utf8'))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Agent→host enroll request body (PROTOCOL §3.1). */
export function enrollRequest({ key, agentVersion, capabilities = [], metadata, machine }) {
  return { key, agentVersion, capabilities: [...capabilities], metadata, machine }
}

/** Error envelope shared by every JSON error response (PROTOCOL §4). */
export function errorEnvelope(code, message, detail = undefined) {
  const envelope = { error: code, message }
  if (detail !== undefined) envelope.detail = detail
  return envelope
}

/** `GET /state` browser payload shape (PROTOCOL §4.1). */
export function statePayload({
  version = PROTOCOL_VERSION, role, serverUrl, serverUrls, loopbackOnly, listener,
  tunnel, heartbeatMs, computers, pendingKey,
}) {
  return {
    version,
    role,
    serverUrl,
    serverUrls,
    loopbackOnly,
    listener,
    tunnel,
    heartbeatMs,
    computers,
    pendingKey,
  }
}

/** `POST /keys` browser payload shape (PROTOCOL §4.2). */
export function keysPayload({
  key, os, expiresAt, serverUrl, serverUrls, loopbackOnly, listener,
  command, windowsCommand, installUrl,
}) {
  return {
    key,
    os,
    expiresAt,
    serverUrl,
    serverUrls,
    loopbackOnly,
    listener,
    command,
    windowsCommand,
    installUrl,
  }
}

/** `GET /key-status` payload shape (PROTOCOL §4.3). */
export function keyStatusPayload({ status, computer = null }) {
  return { status, computer }
}

/** `GET /runtime` payload shape (PROTOCOL §10.5). */
export function runtimeStatusPayload({
  configured, enabled, connected, serverUrl, computerId, name, since, lastError,
}) {
  return { configured, enabled, connected, serverUrl, computerId, name, since, lastError }
}

/** Empty on-disk registry document (PROTOCOL §2). */
export function emptyStateDocument() {
  return { version: STATE_VERSION, computers: [], pendingKeys: [] }
}

/** True for a `hello` frame payload. */
export function isHello(payload) {
  return isPlainObject(payload) && typeof payload.computerId === 'string'
}

/** True for an `exec` request payload. */
export function isExecRequest(payload) {
  return isPlainObject(payload) && typeof payload.requestId === 'string' && typeof payload.command === 'string'
}

/**
 * True for a streaming chunk frame (PROTOCOL §11.2): a v2
 * `{requestId, seq, type, data}` frame, a heartbeat, or the v1.3
 * `{requestId, seq, stdout, stderr}` pair.
 */
export function isChunkFrame(payload) {
  if (!isPlainObject(payload) || typeof payload.requestId !== 'string') return false
  const type = payload.type
  if (type === CHUNK_TYPE.HEARTBEAT) return true
  if (type === CHUNK_TYPE.STDOUT || type === CHUNK_TYPE.STDERR) {
    return Number.isSafeInteger(payload.seq) && payload.seq >= 0
  }
  if (type !== undefined) return false
  return Number.isSafeInteger(payload.seq)
    && (typeof payload.stdout === 'string' || typeof payload.stderr === 'string')
}

/** True for an agent final-result frame (PROTOCOL §3.3). */
export function isResultFrame(payload) {
  return isPlainObject(payload) && typeof payload.requestId === 'string'
}

/** True for an agent file-operation result (PROTOCOL §11.3). */
export function isFsResult(payload) {
  return isPlainObject(payload) && typeof payload.requestId === 'string'
}

/** True for a host file-operation request (PROTOCOL §11.3). */
export function isFsRequest(payload) {
  return isPlainObject(payload) && typeof payload.requestId === 'string' && typeof payload.op === 'string'
}

/** True for a heartbeat body (PROTOCOL §3.4): an object (possibly empty). */
export function isHeartbeat(payload) {
  return isPlainObject(payload)
}

/** True when `value` is one of the capability names. */
export function isCapability(value) {
  return typeof value === 'string' && CAPABILITIES.includes(value)
}
