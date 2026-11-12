/**
 * Every HTTP route dsh-computers serves (PROTOCOL §3 and §4).
 *
 * Two surfaces share `/api/dsh-computers`:
 * - machine routes (`/agent/*`) authenticate with a bearer token and never
 *   pass the browser gate;
 * - browser routes (state, keys, key-status, delete, rename) ask the host's
 *   request gate first, then answer JSON;
 * - public routes (join.sh, join.ps1, agent.mjs, health) are unauthenticated
 *   but key- or path-scoped.
 *
 * Node builtins only.
 */

import {
  HttpError, joinPs1, joinSh, jsonError, methodNotAllowed, readJsonBody,
  refuseBrowserRequest, resolveBaseUrl, sendJson, sendText, serveAgentScript,
} from './http.js'
import {
  bearerToken, isExpired, mintSecret, newComputerId, normalizeDisplayName,
  optionalCount, optionalString, platformLabel, sha256Hex, tokenMatches,
} from './keys.js'
import { resolveAddressPayload } from './addresses.js'
import { capsOf, normalizeCaps } from './policy.js'
import {
  API_BASE as CONTRACTS_API_BASE, decodeMetadataHeader, keyStatusPayload, keysPayload,
  pickKnown, statePayload,
} from './contracts.js'
import { normalizeSessionId } from './selection.js'
import { RELAY_URL_REQUIRED_MESSAGE, normalizeRelayUrl } from './relay-manager.js'
// v1.8.0: the account center — login/create/logout, device self-registration
// and local relay discovery. The manager owns the credential document and the
// heartbeat; this file only maps HTTP onto it.
import { deriveRelayPorts, discoverRelayCandidates, emptyAccountStatus } from './account.js'
// v1.7.0: the one-address form — `runtime/connect` accepts the pasted string
// with its `#join=` fragment, and the manager owns the parsing rules.
import { parseJoinAddress } from './runtime.js'
import { versionAtLeast, versionsDiffer } from './version.js'

/** Base path shared by every route (PROTOCOL §3). */
export const API_BASE = CONTRACTS_API_BASE

/** Enrollment bodies are small (PROTOCOL §3.1: max 16 KiB). */
const ENROLL_MAX_BYTES = 16 * 1024

/** Browser control bodies are tiny. */
const CONTROL_MAX_BYTES = 16 * 1024

/** Result posts carry two ≤1 MiB streams plus JSON escaping. */
const RESULT_MAX_BYTES = 8 * 1024 * 1024

/** Streaming chunk frames are small (≤32 KiB output, base64 + JSON). */
const CHUNK_MAX_BYTES = 1024 * 1024

/** File responses can carry 5 000 entries / 500 matches; stay generous but bounded. */
const FS_RESULT_MAX_BYTES = 16 * 1024 * 1024

/**
 * `/state.relay` states (v1.6.0). The link's own vocabulary says `open`; the
 * browser contract says `connected`, so the tunnel's internal states never leak
 * into the settings payload.
 */
const RELAY_STATES = Object.freeze(['disabled', 'idle', 'connecting', 'reconnecting', 'connected', 'failed', 'closed'])

/**
 * The `/state.relay` shape when no manager was mounted (and the fallback).
 * `enabledSource`/`urlSource` say where the effective switch/address came from;
 * `canEnable` is false only when there is no effective relay address at all, so
 * the UI can disable the switch with a reason instead of offering a toggle that
 * cannot work (v1.6.1). Both values can come from the UI (v1.7.1), which is why
 * an empty config is a valid deployment.
 */
const RELAY_DISABLED = Object.freeze({
  enabled: false,
  enabledSource: 'config',
  urlSource: 'config',
  canEnable: false,
  configured: false,
  hubId: '',
  url: '',
  publicUrl: '',
  state: 'disabled',
  connectedAt: null,
  lastError: null,
  streams: 0,
})

/** Map one link state onto the browser vocabulary (`open` → `connected`). */
function relayStateOf(value) {
  if (value === 'open') return 'connected'
  return typeof value === 'string' && RELAY_STATES.includes(value) ? value : 'idle'
}

/**
 * Rebuild one relay snapshot field by field into the browser contract shape.
 * @param {unknown} value - a manager `status()` snapshot.
 * @returns {object} the browser contract shape.
 */
function relayPayloadOf(value) {
  if (value === null || typeof value !== 'object') return { ...RELAY_DISABLED }
  return {
    enabled: value.enabled === true,
    // The switch is either a persisted UI override or the config default.
    enabledSource: value.enabledSource === 'ui' ? 'ui' : 'config',
    // Same for the address (v1.7.1): UI override or config `relay.url`.
    urlSource: value.urlSource === 'ui' ? 'ui' : 'config',
    canEnable: value.canEnable === true,
    configured: value.configured === true,
    hubId: typeof value.hubId === 'string' ? value.hubId : '',
    url: typeof value.url === 'string' ? value.url : '',
    publicUrl: typeof value.publicUrl === 'string' ? value.publicUrl : '',
    state: relayStateOf(value.state),
    connectedAt: Number.isFinite(value.connectedAt) ? value.connectedAt : null,
    lastError: typeof value.lastError === 'string' && value.lastError !== '' ? value.lastError : null,
    streams: Number.isSafeInteger(value.streams) && value.streams >= 0 ? value.streams : 0,
  }
}

/**
 * Build the `/state.relay` payload from a relay manager. Total: an absent or
 * throwing manager answers the documented disabled shape instead of failing
 * `/state`.
 * @param {object | null} relay - relay manager (`status()`), or null.
 * @returns {object} the browser contract shape.
 */
function relayStatusOf(relay) {
  try {
    return relayPayloadOf(relay?.status?.())
  } catch {
    return { ...RELAY_DISABLED }
  }
}

/**
 * Register the relay routes (v1.6.1, extended v1.7.1) on one browser surface.
 *
 * `POST /relay/enable { enabled?, url? }` is the only writer: it persists the
 * runtime overrides through the manager and applies them live, then answers the
 * same payload `GET /relay` and `/state.relay` carry (so the client can
 * reconcile without a second round trip). The settings page is now the normal
 * way to set the relay address, so a deployment needs no `relay.url` in config:
 * a `url` alone persists the override and makes `canEnable` true, and
 * `url: ''` clears it back to the config value. A bad url is a 400 carrying the
 * normaliser's own message. The browser gate runs first on both routes, exactly
 * like every other browser route.
 * @param {(suffix: string, handler: Function) => void} route - the surface's registrar.
 * @param {(req: object, res: object) => boolean} refuseBrowser - the host request gate.
 * @param {object | null} relay - relay manager, or null.
 */
function registerRelayRoutes(route, refuseBrowser, relay) {
  const statusOf = () => relayStatusOf(relay)

  route('/relay', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'GET')) return
    sendJson(res, 200, statusOf())
  })

  route('/relay/enable', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    // Drift tolerance: only the fields this endpoint knows are read.
    const known = pickKnown(body, ['enabled', 'url'])
    const hasEnabled = Object.prototype.hasOwnProperty.call(known, 'enabled')
    const hasUrl = Object.prototype.hasOwnProperty.call(known, 'url')
    if (!hasEnabled && !hasUrl) {
      throw new HttpError(400, 'bad-request', 'enabled or url is required')
    }
    if (hasEnabled && typeof known.enabled !== 'boolean') {
      throw new HttpError(400, 'bad-request', 'enabled must be a boolean')
    }
    if (hasUrl && typeof known.url !== 'string') {
      throw new HttpError(400, 'bad-request', 'url must be a string')
    }
    if (typeof relay?.setEnabled !== 'function' || typeof relay?.setUrl !== 'function') {
      throw new HttpError(503, 'relay-unavailable', 'the relay manager is not mounted in this deployment')
    }
    // Normalise before touching anything: a bad address must change nothing,
    // and the message is the normaliser's (it names the accepted forms).
    let nextUrl = null
    if (hasUrl) {
      const normalized = normalizeRelayUrl(known.url)
      if (normalized.error !== null) throw new HttpError(400, 'invalid-url', normalized.error)
      nextUrl = normalized.url
    }
    // Enabling without a relay address cannot work. A url in the same request
    // is about to provide one; clearing it (`url: ''`) may still fall back to
    // the config, which the manager decides — unless the effective address is
    // already the config's and there is none.
    const current = statusOf()
    const clearingToNothing = hasUrl && nextUrl === '' && current.urlSource === 'config' && current.canEnable !== true
    if (hasEnabled && known.enabled === true && (clearingToNothing || (!hasUrl && current.canEnable !== true))) {
      throw new HttpError(400, 'relay-not-configured', RELAY_URL_REQUIRED_MESSAGE)
    }
    let next = current
    if (hasUrl) next = await relay.setUrl(nextUrl)
    if (hasEnabled && known.enabled !== next.enabled) next = await relay.setEnabled(known.enabled)
    sendJson(res, 200, relayPayloadOf(next === undefined ? statusOf() : next))
  })
}

/** Platform names an agent may report → the label the settings page shows. */
const PLATFORM_LABELS = new Map([
  ['macos', 'macOS'],
  ['darwin', 'macOS'],
  ['osx', 'macOS'],
  ['linux', 'Linux'],
  ['windows', 'Windows'],
  ['win32', 'Windows'],
])

/** Enforce one method; answers 405 and returns false otherwise. */
function requireMethod(req, res, ...methods) {
  const method = typeof req.method === 'string' ? req.method.toUpperCase() : ''
  if (method === 'HEAD' && methods.includes('GET')) return true
  if (methods.includes(method)) return true
  methodNotAllowed(res, methods.join(' / '))
  return false
}

/** Parse an object body or throw the protocol's 400. */
async function readObjectBody(req, maxBytes) {
  const body = await readJsonBody(req, maxBytes)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'bad-request', 'request body must be a JSON object')
  }
  return body
}

/**
 * Build the exact-route registrar used by both route surfaces. Handlers own
 * the whole response lifecycle, which is what lets the SSE route stay open.
 */
function createRouteRegistrar(ctx, onWarn) {
  return (suffix, handler) => {
    const path = `${API_BASE}${suffix}`
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          if (res.headersSent) {
            try {
              res.end()
            } catch {
              // Client already gone.
            }
            return
          }
          if (error instanceof HttpError) {
            jsonError(res, error.status, error.code, error.message)
            return
          }
          onWarn(`dsh-computers: ${req.method} ${path} failed: ${error && error.stack ? error.stack : error}`)
          jsonError(res, 500, 'internal', 'the dsh-computers host failed to handle this request')
        }
      },
    }), `dsh-computers: ${path}`)
  }
}

/**
 * Register every route on the host web server.
 * @param {object} options - route wiring.
 * @param {object} options.ctx - Cordis context (webServer + optional connection).
 * @param {object} options.config - resolved plugin config.
 * @param {object} options.store - registry store.
 * @param {object} options.hub - SSE/exec hub.
 * @param {string} options.version - plugin version reported by /health.
 * @param {URL} options.agentUrl - machine agent bundle location.
 * @param {object} [options.tunnel] - Tailscale Serve manager (`status()`).
 * @param {object} [options.relay] - relay link manager (`status()`), v1.6.0.
 * @param {object} [options.fleet] - fleet join identity (`token()`, `rotate()`), v1.7.0.
 * @param {object} [options.account] - account-center manager (`status()`, `create()`, …), v1.8.0.
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 */
export function createRoutes({ ctx, config, store, hub, selections, access, fsOps = null, version, agentUrl, role = 'both', tunnel = null, relay = null, fleet = null, account = null, onWarn = () => {} }) {
  /** Current clock as ISO text. */
  const nowIso = () => new Date().toISOString()
  /** Parsed request URL (pathname + query). */
  const urlOf = (req) => new URL(typeof req.url === 'string' && req.url !== '' ? req.url : '/', 'http://dsh-computers.invalid')
  /** Exact-route registrar shared with the runtime surface. */
  const route = createRouteRegistrar(ctx, onWarn)

  /** Agent features reported by the computer (v1 agents report none = exec). */
  const capabilitiesOf = (computer) => (Array.isArray(computer.capabilities) && computer.capabilities.length > 0
    ? computer.capabilities.filter((entry) => typeof entry === 'string')
    : ['exec'])

  /** How the agent runs on the machine (v1.3.2): an embedded plugin runtime or a
   * standalone service/one-liner install. Absent = 'service' (older agents). */
  const cleanMode = (value) => (value === 'embedded' || value === 'service' ? value : null)

  /** The computer's reported run mode, defaulting to 'service'. */
  const modeOf = (computer) => (computer.mode === 'embedded' ? 'embedded' : 'service')

  /** The computer's default working directory, when its agent reported one. */
  const workspaceBaseOf = (computer) => (typeof computer.workspaceBase === 'string' && computer.workspaceBase !== ''
    ? computer.workspaceBase
    : null)

  /** §11.6.4: an enrollment is pending until its first successful stream. */
  const isActivated = (computer) => typeof computer.activatedAt === 'string'

  /** Computers the browser/tools may see (activated only). */
  const visibleComputers = () => store.read().computers.filter(isActivated)

  /** Whether the computer's agentVersion is behind this plugin's. */
  const isDrift = (computer) => versionsDiffer(computer.agentVersion, version)

  /** §11.6.5: whether the agent is older than the configured minimum. */
  const needsUpdate = (computer) => !versionAtLeast(computer.agentVersion, config.minAgentVersion)

  /** Coerce one reported capability list. */
  /** Normalize a reported `caps` object (R2); null when absent/malformed. */
  const cleanCaps = (value) => normalizeCaps(value)

  const cleanCapabilities = (value) => (Array.isArray(value)
    ? [...new Set(value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter((entry) => ['exec', 'fs', 'pty'].includes(entry)))]
    : null)

  /** Coerce a reported workspace base (absolute POSIX or Windows path). */
  const cleanWorkspaceBase = (value) => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    if (trimmed === '' || trimmed.length > 1024) return null
    return /^(\/|[A-Za-z]:[\\/])/.test(trimmed) ? trimmed : null
  }

  /**
   * Handshake metadata from a stream open (§11.6.1): query `?meta=<json>` and/or
   * `x-dsh-*` headers. Unknown fields are ignored.
   */
  const handshakeFromRequest = (req) => {
    let meta = {}
    // The agent's own transport (§11.6.1): base64url JSON in one header.
    // v1.4.0 handshake transport (PROTOCOL §11.6.1): base64url JSON header.
    const headerMeta = decodeMetadataHeader(req.headers?.['x-dsh-computers-metadata'])
    if (headerMeta !== null) meta = headerMeta
    const rawMeta = urlOf(req).searchParams.get('meta')
    if (rawMeta !== null && rawMeta !== '') {
      try {
        const parsed = JSON.parse(rawMeta)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed
      } catch {
        // A malformed meta blob simply contributes nothing.
      }
    }
    const headerField = {
      'x-dsh-agent-version': 'agentVersion',
      'x-dsh-hostname': 'hostname',
      'x-dsh-os': 'os',
      'x-dsh-arch': 'arch',
      'x-dsh-workspace-base': 'workspaceBase',
      'x-dsh-capabilities': 'capabilities',
      'x-dsh-mode': 'mode',
    }
    for (const [header, field] of Object.entries(headerField)) {
      const raw = req.headers?.[header]
      const text = Array.isArray(raw) ? raw[0] : raw
      if (typeof text !== 'string' || text.trim() === '') continue
      meta[field] = field === 'capabilities'
        ? text.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
        : text.trim()
    }
    return meta
  }

  /** The §3.1 enrollment metadata fields present in one body. */
  const enrollMetadata = (body, machine) => {
    const source = machine !== null && typeof machine === 'object' ? machine : {}
    const metadata = body.metadata !== null && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {}
    const capabilities = cleanCapabilities(body.capabilities)
      ?? cleanCapabilities(metadata.capabilities)
      ?? cleanCapabilities(source.capabilities)
    const workspaceBase = cleanWorkspaceBase(body.workspaceBase)
      ?? cleanWorkspaceBase(metadata.workspaceBase)
      ?? cleanWorkspaceBase(source.workspaceBase)
    const mode = cleanMode(body.mode) ?? cleanMode(metadata.mode) ?? cleanMode(source.mode)
    const caps = cleanCaps(body.caps) ?? cleanCaps(metadata.caps) ?? cleanCaps(source.caps)
    return {
      ...(capabilities === null ? {} : { capabilities }),
      ...(workspaceBase === null ? {} : { workspaceBase }),
      ...(mode === null ? {} : { mode }),
      ...(caps === null ? {} : { caps }),
    }
  }

  /** Ask the host's browser gate; true when the request was already refused. */
  const refuseBrowser = (req, res) => refuseBrowserRequest(ctx, req, res)

  /** Resolve the bearer token to a registry computer, or undefined. */
  const authenticate = (req) => {
    const token = bearerToken(req)
    if (token === null) return undefined
    for (const computer of store.read().computers) {
      if (tokenMatches(token, computer.tokenHash)) return computer
    }
    return undefined
  }

  /** Refuse a machine route without valid credentials. */
  const requireComputer = (req, res) => {
    const computer = authenticate(req)
    if (computer === undefined) {
      jsonError(res, 401, 'invalid-token', 'authorization: Bearer <agent token> is required')
      return undefined
    }
    return computer
  }

  /** The pending key the browser should show, if any. */
  const currentPendingKey = (doc, nowMs) => {
    for (let index = doc.pendingKeys.length - 1; index >= 0; index -= 1) {
      const entry = doc.pendingKeys[index]
      if (typeof entry.usedAt === 'string') continue
      if (isExpired(entry.expiresAt, nowMs)) continue
      return entry
    }
    return null
  }

  /** Protocol §4.1 + §11.1 projection of one registry record. */
  const publicComputer = (computer) => {
    const online = hub.isOnline(computer)
    const capabilities = capabilitiesOf(computer)
    return {
      id: computer.id,
      name: computer.name,
      hostname: computer.hostname,
      os: computer.os,
      platformLabel: computer.platformLabel,
      online,
      // R5b: when presence stops counting, so the UI/tools can explain an
      // imminent offline instead of guessing.
      leaseExpiresAt: online ? hub.leaseExpiresAt(computer.id) : null,
      lastSeenAt: computer.lastSeenAt ?? null,
      createdAt: computer.createdAt ?? null,
      activatedAt: computer.activatedAt ?? null,
      agentVersion: computer.agentVersion ?? null,
      capabilities,
      caps: capsOf(computer),
      capabilitiesUpdatedAt: computer.capabilitiesUpdatedAt ?? null,
      workspaceBase: workspaceBaseOf(computer),
      mode: modeOf(computer),
      drift: isDrift(computer),
      updateRequired: needsUpdate(computer),
      cpuModel: computer.cpuModel ?? null,
      memoryBytes: computer.memoryBytes ?? null,
      // Display sugar for the "1/1 Bot" badge (PROTOCOL §4.1).
      bots: { used: online ? 1 : 0, total: 1 },
    }
  }

  /** Key-validated installer scripts share one refusal rule. */
  const installerKey = (req, res, requiredSearchParam) => {
    const keyValue = urlOf(req).searchParams.get(requiredSearchParam)
    if (keyValue === null || keyValue === '') {
      sendText(res, 410, 'missing enrollment key — open the Computers settings page and copy a fresh command\n')
      return null
    }
    const entry = store.read().pendingKeys.find((candidate) => candidate.key === keyValue)
    if (entry === undefined) {
      sendText(res, 410, 'unknown enrollment key — create a new one on the Computers settings page\n')
      return null
    }
    if (typeof entry.usedAt === 'string') {
      sendText(res, 410, 'this enrollment key was already used — create a new one on the Computers settings page\n')
      return null
    }
    if (isExpired(entry.expiresAt, Date.now())) {
      sendText(res, 410, 'this enrollment key expired — create a new one on the Computers settings page\n')
      return null
    }
    return entry
  }

  // ---------------------------------------------------------------------------
  // Machine routes (bearer token, no browser gate)
  // ---------------------------------------------------------------------------

  route('/agent/enroll', async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, ENROLL_MAX_BYTES)
    const keyValue = typeof body.key === 'string' ? body.key.trim() : ''
    const joinValue = typeof body.join === 'string' ? body.join.trim() : ''
    // v1.7.0: two ways in. A one-time `key` keeps its single-use semantics;
    // `join` is the fleet token from `<advertisedBase>#join=…`, the one string a
    // new machine pastes. When both are present the key wins, so an older
    // installer that also forwards the address behaves exactly as before.
    if (keyValue === '' && joinValue === '') {
      throw new HttpError(400, 'bad-request', 'key or join is required (a dshc_ enrollment key or a dshf_ fleet token)')
    }
    const viaJoin = keyValue === ''
    if (!viaJoin && !/^dshc_[A-Za-z0-9_-]{20,}$/.test(keyValue)) {
      throw new HttpError(400, 'bad-request', 'key must be a dshc_ enrollment key')
    }
    // A malformed token is answered exactly like a wrong one: the refusal must
    // not become a shape oracle for guessing.
    if (viaJoin && !joinTokenMatches(joinValue)) {
      throw new HttpError(401, 'invalid-join', 'unknown join token; copy a fresh join address from the Computers settings page')
    }
    const nowMs = Date.now()
    const doc = store.read()
    /** @type {object | null} the pending key this enroll consumes, or null for a join. */
    let pendingKey = null
    if (!viaJoin) {
      pendingKey = doc.pendingKeys.find((entry) => entry.key === keyValue)
      // Order matters: an unknown key is 401, a consumed one 409, a stale one 410.
      if (pendingKey === undefined) {
        throw new HttpError(401, 'invalid-key', 'unknown enrollment key; create a new one on the Computers settings page')
      }
      if (typeof pendingKey.usedAt === 'string') {
        throw new HttpError(409, 'key-used', 'this enrollment key was already used; create a new one')
      }
      if (isExpired(pendingKey.expiresAt, nowMs)) {
        throw new HttpError(410, 'key-expired', 'this enrollment key expired; create a new one')
      }
    }

    const machine = body.machine !== null && typeof body.machine === 'object' && !Array.isArray(body.machine)
      ? body.machine
      : null
    const hostname = optionalString(machine?.hostname, 255)
    if (hostname === null) throw new HttpError(400, 'bad-request', 'machine.hostname is required')
    const osName = optionalString(machine?.os, 64)
    // A key can carry the user's chosen name; a join has no key, so the machine
    // reports its own name and falls back to the hostname.
    const explicitName = (pendingKey === null ? null : normalizeDisplayName(pendingKey.label))
      ?? normalizeDisplayName(optionalString(machine?.name, 255))
    const displayName = explicitName ?? hostname
    const requestedPlatform = optionalString(machine?.platform, 64)
    const label = requestedPlatform !== null
      ? PLATFORM_LABELS.get(requestedPlatform.toLowerCase()) ?? (osName === null ? null : platformLabel(osName))
      : (osName === null ? null : platformLabel(osName))

    // Only fields the agent actually reported are merged. A re-enroll on a
    // reconnecting stream must not downgrade unknown fields to "unknown".
    const fields = {
      name: displayName,
      hostname,
      os: osName,
      arch: optionalString(machine?.arch, 64),
      platformLabel: label,
      cpuModel: optionalString(machine?.cpuModel, 256),
      memoryBytes: optionalCount(machine?.memoryBytes),
      nodeVersion: optionalString(machine?.nodeVersion, 64),
      agentVersion: optionalString(body.agentVersion, 64) ?? optionalString(machine?.agentVersion, 64),
    }
    const definedFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null))
    const metadata = enrollMetadata(body, machine)
    const nowEnroll = nowIso()
    const token = mintSecret()
    const tokenHash = sha256Hex(token)
    // Re-enroll in place when the key asked for it (PROTOCOL §3.1) or when
    // this still-pending key is already bound to a computer (retry before the
    // first successful stream, §11.6.4). A join has no key to bind: the
    // hostname/name IS the machine's identity, so re-pasting the address
    // replaces that record instead of stacking duplicates.
    const boundId = pendingKey !== null && typeof pendingKey.computerId === 'string' ? pendingKey.computerId : null
    const replaceTarget = boundId !== null
      ? doc.computers.find((computer) => computer.id === boundId)
      : pendingKey === null || pendingKey.replace === true
        ? doc.computers.find((computer) => computer.hostname === hostname
          || computer.name.toLowerCase() === displayName.toLowerCase())
        : undefined

    const enrolled = store.mutate((document) => {
      let computer
      if (replaceTarget !== undefined) {
        computer = document.computers.find((entry) => entry.id === replaceTarget.id)
      }
      if (computer !== undefined) {
        // Same id: replace the token so the previous install stops working.
        // A re-enroll that reports no machine.name must NOT rename the record
        // to the hostname (the user's chosen name survives reconnects).
        const previousName = computer.name
        Object.assign(computer, definedFields, metadata, {
          tokenHash,
          lastSeenAt: nowEnroll,
          capabilities: metadata.capabilities ?? computer.capabilities ?? ['exec'],
          capabilitiesUpdatedAt: nowEnroll,
        })
        if (explicitName === null) computer.name = previousName
      } else {
        computer = {
          id: newComputerId(),
          version: 1,
          name: displayName,
          hostname,
          os: osName ?? 'unknown',
          arch: optionalString(machine?.arch, 64) ?? 'unknown',
          platformLabel: label ?? 'Unknown',
          cpuModel: optionalString(machine?.cpuModel, 256),
          memoryBytes: optionalCount(machine?.memoryBytes),
          nodeVersion: optionalString(machine?.nodeVersion, 64),
          agentVersion: optionalString(body.agentVersion, 64) ?? optionalString(machine?.agentVersion, 64) ?? 'unknown',
          ...metadata,
          capabilities: metadata.capabilities ?? ['exec'],
          capabilitiesUpdatedAt: nowEnroll,
          workspaceBase: metadata.workspaceBase ?? null,
          mode: metadata.mode ?? 'service',
          tokenHash,
          createdAt: nowEnroll,
          lastSeenAt: nowEnroll,
          // §11.6.4: hidden from the list until the first successful stream.
          activatedAt: null,
        }
        document.computers.push(computer)
      }
      // A keyed enroll stays pending until the agent's first stream activates
      // it; a join enroll has no key to consume, so there is nothing to mark.
      if (pendingKey !== null) {
        const keyEntry = document.pendingKeys.find((entry) => entry.key === keyValue)
        if (keyEntry === undefined) {
          throw new HttpError(401, 'invalid-key', 'unknown enrollment key; create a new one on the Computers settings page')
        }
        keyEntry.computerId = computer.id
        keyEntry.enrolledAt = nowEnroll
      }
      return { computerId: computer.id, name: computer.name, replaced: replaceTarget !== undefined }
    })

    if (enrolled.replaced) {
      // The old agent's token no longer authenticates; drop its session.
      hub.closeStream(enrolled.computerId)
    }
    // The agent persists this as its upstream, so it must be the address the
    // hub ADVERTISES (relay / public / LAN), never the request origin: a request
    // that arrived through the relay carries a forced Host of 127.0.0.1:<port>,
    // and echoing that back would make the machine dial its own loopback.
    let enrolledServerUrl = ''
    try {
      enrolledServerUrl = (await addressPayload(req)).serverUrl
    } catch {
      enrolledServerUrl = ''
    }
    sendJson(res, 200, {
      computerId: enrolled.computerId,
      token,
      name: enrolled.name,
      serverUrl: enrolledServerUrl !== '' ? enrolledServerUrl : resolveBaseUrl({ ctx, config, req }),
    })
  })

  route('/agent/events', async (req, res) => {
    // Authenticate before anything else on machine routes (PROTOCOL §3).
    const computer = requireComputer(req, res)
    if (computer === undefined) return
    if (!requireMethod(req, res, 'GET')) return
    const handshake = handshakeFromRequest(req)
    const capabilities = cleanCapabilities(handshake.capabilities)
    const workspaceBase = cleanWorkspaceBase(handshake.workspaceBase)
    const reportedMode = cleanMode(handshake.mode)
    const reportedCaps = cleanCaps(handshake.caps)
    const agentVersion = optionalString(handshake.agentVersion, 64)
    const handshakeHost = optionalString(handshake.hostname, 255)
    const handshakeOs = optionalString(handshake.os, 64)
    const handshakeArch = optionalString(handshake.arch, 64)
    const activated = store.mutate((document) => {
      const record = document.computers.find((entry) => entry.id === computer.id)
      if (record === undefined) return null
      const now = nowIso()
      record.lastSeenAt = now
      // §11.6.1: every reconnect refreshes the stored handshake metadata.
      if (agentVersion !== null) record.agentVersion = agentVersion
      if (handshakeHost !== null) record.hostname = handshakeHost
      if (handshakeOs !== null) record.os = handshakeOs
      if (handshakeArch !== null) record.arch = handshakeArch
      if (capabilities !== null) {
        record.capabilities = capabilities
        record.capabilitiesUpdatedAt = now
      }
      if (workspaceBase !== null) record.workspaceBase = workspaceBase
      if (reportedMode !== null) record.mode = reportedMode
      if (reportedCaps !== null) record.caps = reportedCaps
      const firstStream = typeof record.activatedAt !== 'string'
      if (firstStream) record.activatedAt = now
      // §11.6.4: the first successful stream activates the enrollment.
      if (firstStream) {
        for (const key of document.pendingKeys) {
          if (key.computerId === record.id && typeof key.usedAt !== 'string') key.usedAt = now
        }
      }
      return {
        name: record.name,
        capabilities: Array.isArray(record.capabilities) && record.capabilities.length > 0 ? record.capabilities : ['exec'],
      }
    })
    if (activated === null) {
      jsonError(res, 401, 'invalid-token', 'authorization: Bearer <agent token> is required')
      return
    }
    hub.openStream(computer.id, activated.name, req, res, { capabilities: activated.capabilities })
    if (fsOps !== null) {
      // Abandon file requests whose stream died (but not one replaced by a
      // reconnecting stream for the same computer).
      res.on('close', () => {
        if (!hub.isLive(computer.id)) fsOps.failComputer(computer.id)
      })
    }
  })

  route('/agent/results', async (req, res) => {
    // Authenticate before anything else on machine routes (PROTOCOL §3).
    const computer = requireComputer(req, res)
    if (computer === undefined) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, RESULT_MAX_BYTES)
    store.touch(computer.id)
    if (!hub.settle(computer.id, body)) {
      // The server already settled/timed out this request (PROTOCOL §3.3);
      // the agent ignores this answer.
      jsonError(res, 404, 'unknown-request', 'this execution is no longer pending (already settled or timed out)')
      return
    }
    sendJson(res, 200, { ok: true })
  })

  route('/agent/results/chunk', async (req, res) => {
    const computer = requireComputer(req, res)
    if (computer === undefined) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, CHUNK_MAX_BYTES)
    store.touch(computer.id)
    if (!hub.settleChunk(computer.id, body)) {
      jsonError(res, 404, 'unknown-request', 'this execution is no longer pending (already settled or timed out)')
      return
    }
    sendJson(res, 200, { ok: true })
  })

  route('/agent/fs/result', async (req, res) => {
    const computer = requireComputer(req, res)
    if (computer === undefined) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, FS_RESULT_MAX_BYTES)
    store.touch(computer.id)
    hub.touch(computer.id)
    if (fsOps === null || !fsOps.settle(computer.id, body)) {
      jsonError(res, 404, 'unknown-request', 'this file request is no longer pending')
      return
    }
    sendJson(res, 200, { ok: true })
  })

  route('/agent/heartbeat', async (req, res) => {
    // Authenticate before anything else on machine routes (PROTOCOL §3).
    const computer = requireComputer(req, res)
    if (computer === undefined) return
    if (!requireMethod(req, res, 'POST')) return
    let body = {}
    try {
      body = await readObjectBody(req, 256 * 1024)
    } catch (error) {
      // An empty heartbeat body is legal; anything else is still a 400.
      if (!(error instanceof HttpError) || error.code !== 'bad-request' || !/empty/.test(error.message)) throw error
    }
    hub.touch(computer.id)
    const meta = body.meta !== null && typeof body.meta === 'object' && !Array.isArray(body.meta) ? body.meta : null
    const reportedCapabilities = cleanCapabilities(body.capabilities) ?? cleanCapabilities(meta?.capabilities)
    const reportedWorkspaceBase = cleanWorkspaceBase(body.workspaceBase) ?? cleanWorkspaceBase(meta?.workspaceBase)
    const reportedMode = cleanMode(body.mode) ?? cleanMode(meta?.mode)
    const reportedCaps = cleanCaps(body.caps) ?? cleanCaps(meta?.caps)
    const name = store.mutate((document) => {
      const record = document.computers.find((entry) => entry.id === computer.id)
      if (record === undefined) return computer.name
      const now = nowIso()
      record.lastSeenAt = now
      if (reportedCapabilities !== null) {
        record.capabilities = reportedCapabilities
        record.capabilitiesUpdatedAt = now
      }
      if (reportedWorkspaceBase !== null) record.workspaceBase = reportedWorkspaceBase
      if (reportedMode !== null) record.mode = reportedMode
      if (reportedCaps !== null) record.caps = reportedCaps
      const agentVersion = optionalString(body.agentVersion, 64) ?? optionalString(meta?.agentVersion, 64)
      if (agentVersion !== null) record.agentVersion = agentVersion
      if (meta !== null) {
        const cpuModel = optionalString(meta.cpuModel, 256)
        const memoryBytes = optionalCount(meta.memoryBytes)
        if (cpuModel !== null) record.cpuModel = cpuModel
        if (memoryBytes !== null) record.memoryBytes = memoryBytes
      }
      return record.name
    })
    sendJson(res, 200, { ok: true, name })
  })

  // ---------------------------------------------------------------------------
  // Browser routes (host request gate first)
  // ---------------------------------------------------------------------------

  /**
   * Reachable-address payload for a browser request. `ctx.addressDeps` is an
   * optional diagnostics/test seam for the probe (interfaces, hostname,
   * probeTailscale); production contexts do not set it.
   */
  /** The Tailscale Serve tunnel status (v1.4.0), safe when the manager is absent. */
  const tunnelStatus = () => {
    try {
      const value = tunnel?.status?.()
      if (value !== null && typeof value === 'object') return value
    } catch {
      // Fall through to the disabled shape.
    }
    return { enabled: false, configured: false, url: '', targetPort: null, error: null }
  }

  /**
   * The relay link status (v1.6.0), safe when the manager is absent or throws.
   * The shape is part of the browser contract (design §6.4/§10).
   */
  const relayStatus = () => relayStatusOf(relay)

  /**
   * The account-center status (v1.8.0), safe when the manager is absent or
   * throws. This is the CACHED view: `/state` must never wait on the relay, so
   * the device list there is whatever the last registration/list refresh saw.
   * `GET /account` refreshes it explicitly with a bounded budget.
   */
  const accountStatus = () => {
    try {
      const value = account?.status?.()
      if (value !== null && typeof value === 'object') return value
    } catch {
      // Fall through to the logged-out shape.
    }
    return emptyAccountStatus()
  }

  /**
   * The best address other machines in the account could use to reach this
   * machine, from the same candidate list `/state` publishes: a reachable
   * non-loopback route, preferring the recommended/public ones. Loopback is
   * returned only when nothing else exists (it is this machine's own entry and
   * is what the manager's fallback would pick anyway).
   * @param {{ serverUrl?: string, serverUrls?: Array<object> }} address - `resolveAddressPayload()`.
   * @returns {string} the entry URL, or '' when unknown.
   */
  const entryUrlOf = (address) => {
    const list = Array.isArray(address?.serverUrls) ? address.serverUrls : []
    const usable = list.filter((candidate) => candidate !== null && typeof candidate === 'object' && candidate.reachable === true)
    const nonLoopback = usable.filter((candidate) => candidate.kind !== 'loopback')
    const preferred = nonLoopback.find((candidate) => candidate.recommended === true)
      ?? nonLoopback.find((candidate) => candidate.kind === 'public' || candidate.kind === 'forwarded')
      ?? nonLoopback.find((candidate) => candidate.kind === 'lan' || candidate.kind === 'tailscale')
      ?? nonLoopback[0]
      ?? usable.find((candidate) => candidate.kind === 'loopback')
    if (preferred !== undefined && typeof preferred.url === 'string') return preferred.url
    return typeof address?.serverUrl === 'string' ? address.serverUrl : ''
  }

  /**
   * Feed the advertised address to the account heartbeat. The 60 s timer has no
   * request to read proxy headers from, so a browser request is the only place
   * that can observe the address the user actually reached. Guarded: this must
   * never affect a response.
   */
  const noteAccountEntry = (address) => {
    try {
      account?.noteEntryUrl?.(entryUrlOf(address))
    } catch {
      // The heartbeat falls back to its own advertised-address resolver.
    }
  }

  /**
   * The live fleet join token, safe when no identity was mounted (role
   * `runtime`, or a caller that built the routes directly).
   */
  const fleetToken = () => {
    try {
      const value = fleet?.token?.()
      return typeof value === 'string' ? value : ''
    } catch {
      return ''
    }
  }

  /**
   * The copyable capability URL: the ADVERTISED base plus the token as a
   * fragment. A fragment never reaches a server, so the token cannot leak into
   * proxy/access logs; `hasToken` tells the UI whether the block is real.
   * @param {string} serverUrl - the advertised address (`addressPayload().serverUrl`).
   * @returns {{ joinUrl: string, hasToken: boolean }} the `/state.fleet` shape.
   */
  const fleetPayloadOf = (address) => {
    const token = fleetToken()
    const candidates = Array.isArray(address?.serverUrls) ? address.serverUrls : []
    // Never hand out a LOOPBACK join address: it exists to be pasted on another
    // machine, and `127.0.0.1` there means that other machine. Prefer the
    // recommended reachable non-loopback candidate (relay > public > LAN).
    const usable = candidates.filter((candidate) => candidate.reachable === true && candidate.kind !== 'loopback')
    const preferred = usable.find((candidate) => candidate.recommended === true) ?? usable[0] ?? null
    const base = preferred === null ? '' : preferred.url
    return {
      joinUrl: token === '' || base === '' ? '' : `${base}#join=${token}`,
      hasToken: token !== '',
      // Why there is no address, so the UI can say what to do instead of
      // showing a loopback string that cannot work.
      reason: base === '' ? 'loopback-only' : null,
    }
  }

  /** Constant-time compare of a presented join token against the live one. */
  const joinTokenMatches = (presented) => {
    const current = fleetToken()
    if (current === '') return false
    // tokenMatches hashes the presented value and compares the two digests with
    // timingSafeEqual; neither value is ever a direct comparison operand.
    return tokenMatches(presented, sha256Hex(current))
  }

  const addressPayload = (req) => {
    let deps = {}
    try {
      const value = ctx?.addressDeps
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) deps = value
    } catch {
      deps = {}
    }
    const serve = tunnelStatus()
    const tunnelUrl = serve.configured === true && typeof serve.url === 'string' && serve.url !== '' ? serve.url : ''
    const relayInfo = relayStatus()
    return resolveAddressPayload({
      ctx,
      config,
      req,
      ...(tunnelUrl === '' ? {} : { tunnel: tunnelUrl }),
      // v1.6.0: the relay address is only a candidate while the link is up — a
      // dead address is worse than no address. When connected it is added first
      // and wins the recommendation over the tunnel/public candidates.
      relay: { publicUrl: relayInfo.publicUrl, connected: relayInfo.state === 'connected' },
      ...deps,
    })
  }

  route('/state', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'GET')) return
    const doc = store.read()
    const pendingKey = currentPendingKey(doc, Date.now())
    // Reachable-address candidates (v1.3.3): `serverUrl` stays the recommended
    // one so older clients keep working; `serverUrls` feeds the address picker.
    const address = await addressPayload(req)
    // v1.8.0: the 5 s settings poll is also what teaches the account heartbeat
    // the address other machines should use to reach this one.
    noteAccountEntry(address)
    sendJson(res, 200, {
      ...statePayload({
        role,
        serverUrl: address.serverUrl,
        serverUrls: address.serverUrls,
        loopbackOnly: address.loopbackOnly,
        // v1.4.0: where the listener is actually bound, so the UI can explain
        // why a candidate is or is not reachable.
        listener: address.listener,
        tunnel: tunnelStatus(),
        heartbeatMs: config.heartbeatMs,
        // §11.6.4: a computer appears only after its first successful stream.
        computers: visibleComputers().map(publicComputer),
        pendingKey: pendingKey === null
          ? null
          : { key: pendingKey.key, expiresAt: pendingKey.expiresAt ?? null, os: pendingKey.os ?? 'macos' },
      }),
      // v1.6.0: the relay link (address, hubId, live state) for the settings
      // page. Additive, so a client that predates it simply ignores it.
      relay: relayStatus(),
      // v1.7.0: the ONE copyable join address — the advertised base with the
      // fleet token as a fragment. Additive; a client that predates it ignores it.
      fleet: fleetPayloadOf(address),
      // v1.8.0: the account-center login + this account's device directory.
      // Additive and CACHED (no relay round trip here), so a relay outage can
      // never slow down or break the settings page; `GET /account` refreshes.
      account: accountStatus(),
    })
  })

  // ---- account center (v1.8.0) ------------------------------------------
  // Every route below is browser-gated first, exactly like the rest of §4.

  // The live status: refreshes the device directory from the relay with the
  // protocol's 2 s budget. A relay failure is not an HTTP failure — the page
  // still loads, with `lastError` and an empty list (the manager records it).
  route('/account', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'GET')) return
    if (account === null || typeof account?.status !== 'function') {
      throw new HttpError(503, 'account-unavailable', 'the account center is not mounted in this deployment')
    }
    // This request is the only place that can observe the advertised address
    // (proxy headers), so hand it to the heartbeat before answering.
    const address = await addressPayload(req)
    noteAccountEntry(address)
    await account.refreshDevices()
    sendJson(res, 200, accountStatus())
  })

  // Create a fresh account on the relay, persist the login and register this
  // machine. `adminKey` is forwarded as `x-admin-key` for a relay that requires
  // one; a first-run relay needs none.
  route('/account/create', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    if (account === null || typeof account?.create !== 'function') {
      throw new HttpError(503, 'account-unavailable', 'the account center is not mounted in this deployment')
    }
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    const known = pickKnown(body, ['relayUrl', 'adminKey', 'name'])
    if (typeof known.relayUrl !== 'string' || known.relayUrl.trim() === '') {
      throw new HttpError(400, 'bad-request', 'relayUrl is required')
    }
    if (known.adminKey !== undefined && known.adminKey !== null && typeof known.adminKey !== 'string') {
      throw new HttpError(400, 'bad-request', 'adminKey must be a string')
    }
    if (known.name !== undefined && known.name !== null) {
      if (typeof known.name !== 'string') throw new HttpError(400, 'bad-request', 'name must be a string')
      if (known.name.trim().length > 64) throw new HttpError(400, 'bad-request', 'name must be at most 64 characters')
    }
    const address = await addressPayload(req)
    noteAccountEntry(address)
    const status = await account.create({
      relayUrl: known.relayUrl,
      adminKey: typeof known.adminKey === 'string' ? known.adminKey : '',
      name: typeof known.name === 'string' ? known.name : '',
    })
    sendJson(res, 200, status)
  })

  // Log into an existing account. The secret is verified against the relay
  // before anything is persisted, so a typo cannot leave a half-login behind.
  route('/account/login', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    if (account === null || typeof account?.login !== 'function') {
      throw new HttpError(503, 'account-unavailable', 'the account center is not mounted in this deployment')
    }
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    const known = pickKnown(body, ['relayUrl', 'accountId', 'secret'])
    if (typeof known.relayUrl !== 'string' || known.relayUrl.trim() === '') {
      throw new HttpError(400, 'bad-request', 'relayUrl is required')
    }
    if (typeof known.accountId !== 'string' || known.accountId.trim() === '') {
      throw new HttpError(400, 'bad-request', 'accountId is required')
    }
    if (typeof known.secret !== 'string' || known.secret.trim() === '') {
      throw new HttpError(400, 'bad-request', 'secret is required')
    }
    const address = await addressPayload(req)
    noteAccountEntry(address)
    const status = await account.login({
      relayUrl: known.relayUrl,
      accountId: known.accountId,
      secret: known.secret,
    })
    sendJson(res, 200, status)
  })

  // Forget the login (and stop the heartbeat). The machine identity survives, so
  // logging back in does not create a second device row on the relay.
  route('/account/logout', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    if (account === null || typeof account?.logout !== 'function') {
      throw new HttpError(503, 'account-unavailable', 'the account center is not mounted in this deployment')
    }
    // Body is optional; drain it so keep-alive sockets are not reset.
    try {
      req.resume()
    } catch {
      // Nothing to drain.
    }
    sendJson(res, 200, account.logout())
  })

  // Pre-fill helper: probe this machine for a running relay and propose the
  // account-center URLs it could be reached at. An empty list is a valid answer
  // (the operator types their own domain), and this route never throws — a
  // discovery probe must not be able to break the settings page.
  route('/account/discover', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'GET')) return
    let payload = { candidates: [], configured: { relayUrl: '' } }
    try {
      const address = await addressPayload(req)
      noteAccountEntry(address)
      const relayInfo = relayStatus()
      payload = await discoverRelayCandidates({
        candidates: Array.isArray(address.serverUrls) ? address.serverUrls : [],
        ports: deriveRelayPorts({ configUrl: config.relay.url, effectiveUrl: relayInfo.url }),
        configuredUrl: relayInfo.url,
      })
    } catch {
      payload = { candidates: [], configured: { relayUrl: '' } }
    }
    sendJson(res, 200, payload)
  })

  // v1.7.0: mint a fresh fleet token. Every address already handed out stops
  // working; the relay hubId is a separate document and is deliberately kept
  // (rotating the join credential must not change the hub's address).
  route('/fleet/rotate', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    if (typeof fleet?.rotate !== 'function') {
      throw new HttpError(503, 'fleet-unavailable', 'the fleet join identity is not mounted in this deployment')
    }
    const identity = fleet.rotate()
    if (identity === null) {
      throw new HttpError(500, 'fleet-rotate-failed', 'could not persist a new join token; check the state directory')
    }
    const address = await addressPayload(req)
    sendJson(res, 200, fleetPayloadOf(address))
  })

  // v1.6.1: the relay on/off switch (persisted override, applied live).
  registerRelayRoutes(route, refuseBrowser, relay)

  route('/keys', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    // Drift tolerance (R1): only the keys this endpoint knows are read.
    const known = pickKnown(body, ['os', 'label', 'replace'])
    const osName = typeof known.os === 'string' ? known.os.trim().toLowerCase() : 'macos'
    if (!['macos', 'windows', 'linux'].includes(osName)) {
      throw new HttpError(400, 'bad-request', 'os must be one of macos, windows, linux')
    }
    let label = null
    if (known.label !== undefined && known.label !== null) {
      label = normalizeDisplayName(known.label)
      if (label === null) throw new HttpError(400, 'bad-request', 'label must be 1-64 visible characters')
    }
    const replace = known.replace === true
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + config.keyTtlMinutes * 60_000).toISOString()
    const keyValue = mintSecret()

    store.mutate((document) => {
      // Only one pending key at a time: creating a new one invalidates the
      // earlier ones (PROTOCOL §4.2).
      for (const entry of document.pendingKeys) {
        if (typeof entry.usedAt !== 'string') entry.usedAt = createdAt
      }
      document.pendingKeys.push({
        key: keyValue,
        createdAt,
        expiresAt,
        os: osName,
        label,
        usedAt: null,
        computerId: null,
        replace,
      })
    })

    // v1.3.3: generate the one-liner from the RECOMMENDED reachable address
    // (Tailscale/LAN/public), not from the loopback origin the desktop app used
    // to reach this route. The command must work on the OTHER machine.
    const address = await addressPayload(req)
    const serverUrl = address.serverUrl
    const installUrl = `${serverUrl}${API_BASE}/join.sh?key=${encodeURIComponent(keyValue)}`
    const windowsUrl = `${serverUrl}${API_BASE}/join.ps1?key=${encodeURIComponent(keyValue)}`
    sendJson(res, 200, keysPayload({
      key: keyValue,
      os: osName,
      expiresAt,
      serverUrl,
      serverUrls: address.serverUrls,
      loopbackOnly: address.loopbackOnly,
      listener: address.listener,
      command: `curl -fsSL '${installUrl}' | sh`,
      windowsCommand: `irm '${windowsUrl}' | iex`,
      installUrl,
    }))
  })

  route('/key-status', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'GET')) return
    const keyValue = urlOf(req).searchParams.get('key')
    const doc = store.read()
    const entry = keyValue === null
      ? undefined
      : doc.pendingKeys.find((candidate) => candidate.key === keyValue)
    let status = 'unknown'
    let computer = null
    if (entry !== undefined) {
      const linked = typeof entry.computerId === 'string'
        ? doc.computers.find((candidate) => candidate.id === entry.computerId)
        : undefined
      if (linked !== undefined && !isActivated(linked)) {
        // Enrolled but the agent never completed a stream: the dialog keeps
        // polling (§11.6.4).
        status = 'waiting'
      } else if (linked !== undefined) {
        status = 'connected'
        computer = { id: linked.id, name: linked.name, online: hub.isOnline(linked) }
      } else if (typeof entry.usedAt === 'string') {
        status = 'used'
      } else if (isExpired(entry.expiresAt, Date.now())) {
        status = 'expired'
      } else {
        status = 'waiting'
      }
    }
    sendJson(res, 200, keyStatusPayload({ status, computer }))
  })

  route('/delete', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') throw new HttpError(400, 'bad-request', 'id is required')
    const found = store.read().computers.some((computer) => computer.id === id)
    if (!found) throw new HttpError(404, 'not-found', `no computer with id ${JSON.stringify(id)}`)
    hub.closeStream(id)
    if (fsOps !== null) fsOps.failComputer(id, 'the computer was deleted')
    store.mutate((document) => {
      document.computers = document.computers.filter((computer) => computer.id !== id)
    })
    access.store.forgetComputer(id)
    sendJson(res, 200, { ok: true })
  })

  route('/rename', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') throw new HttpError(400, 'bad-request', 'id is required')
    const name = normalizeDisplayName(body.name)
    if (name === null) throw new HttpError(400, 'bad-request', 'name must be 1-64 visible characters')
    const found = store.read().computers.some((computer) => computer.id === id)
    if (!found) throw new HttpError(404, 'not-found', `no computer with id ${JSON.stringify(id)}`)
    store.mutate((document) => {
      const record = document.computers.find((computer) => computer.id === id)
      if (record !== undefined) record.name = name
    })
    // Optional `config` event (PROTOCOL §3.2): the agent picks up the new name.
    hub.send(id, 'config', { name, execEnabled: config.execEnabled })
    sendJson(res, 200, { ok: true, name })
  })

  // ---------------------------------------------------------------------------
  // Access control (the two access dialogs)
  // ---------------------------------------------------------------------------

  /**
   * Payload for the conversation-level dialog ("它可以使用哪些电脑?"): every
   * computer with the EFFECTIVE answer for this session's preset + allow-list.
   * `sessionAllowed` is the raw rule (null = "all"), so the client can tell a
   * customized list from the default.
   */
  const accessPayload = async (sessionId) => {
    const presetId = access.presetIdForSession(sessionId)
    const presets = await access.presets()
    const sessionAllowed = access.store.sessionAllow(sessionId)
    return {
      sessionId,
      presetId,
      presets,
      computers: visibleComputers().map((computer) => {
        const presetOk = access.presetAllows(computer.id, presetId)
        const sessionOk = access.sessionAllows(sessionId, computer.id)
        return {
          id: computer.id,
          name: computer.name,
          online: hub.isOnline(computer),
          platformLabel: computer.platformLabel ?? 'Unknown',
          allowed: presetOk && sessionOk,
          sessionAllowed: sessionOk,
          presetAllowed: presetOk,
        }
      }),
      sessionAllowed,
    }
  }

  /** Payload for the computer-level dialog ("哪些 Bot 可以使用它?"). */
  const accessComputerPayload = async (computerId) => {
    const computer = visibleComputers().find((candidate) => candidate.id === computerId)
    if (computer === undefined) {
      throw new HttpError(404, 'not-found', `no computer with id ${JSON.stringify(computerId)}`)
    }
    const presets = await access.presets()
    const allowedPresets = access.store.computerPresets(computerId)
    return {
      computer: {
        id: computer.id,
        name: computer.name,
        online: hub.isOnline(computer),
        platformLabel: computer.platformLabel ?? 'Unknown',
      },
      presets: presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        allowed: allowedPresets === null || allowedPresets.includes(preset.id),
      })),
      allowedPresets,
    }
  }

  route('/access', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : ''
    if (method === 'GET' || method === 'HEAD') {
      const sessionId = normalizeSessionId(urlOf(req).searchParams.get('sessionId'))
      if (sessionId === null) {
        throw new HttpError(400, 'bad-request', 'sessionId must be a non-empty string (max 256 characters)')
      }
      sendJson(res, 200, await accessPayload(sessionId))
      return
    }
    if (method === 'POST') {
      const body = await readObjectBody(req, CONTROL_MAX_BYTES)
      const sessionId = normalizeSessionId(body.sessionId)
      if (sessionId === null) {
        throw new HttpError(400, 'bad-request', 'sessionId must be a non-empty string (max 256 characters)')
      }
      if (!Object.hasOwn(body, 'allowedComputers')) {
        throw new HttpError(400, 'bad-request', 'allowedComputers is required (an array of computer ids or null)')
      }
      if (body.allowedComputers !== null) {
        if (!Array.isArray(body.allowedComputers)) {
          throw new HttpError(400, 'bad-request', 'allowedComputers must be an array of computer ids or null')
        }
        const known = new Set(visibleComputers().map((computer) => computer.id))
        for (const entry of body.allowedComputers) {
          if (typeof entry !== 'string' || !known.has(entry.trim())) {
            throw new HttpError(400, 'bad-request', `unknown computer id ${JSON.stringify(entry)}`)
          }
        }
      }
      access.store.setSessionAllow(sessionId, body.allowedComputers)
      sendJson(res, 200, await accessPayload(sessionId))
      return
    }
    methodNotAllowed(res, 'GET / POST')
  })

  route('/access/computer', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : ''
    if (method === 'GET' || method === 'HEAD') {
      const computerId = typeof urlOf(req).searchParams.get('computerId') === 'string'
        ? urlOf(req).searchParams.get('computerId').trim()
        : ''
      if (computerId === '') {
        throw new HttpError(400, 'bad-request', 'computerId is required')
      }
      sendJson(res, 200, await accessComputerPayload(computerId))
      return
    }
    if (method === 'POST') {
      const body = await readObjectBody(req, CONTROL_MAX_BYTES)
      const computerId = typeof body.computerId === 'string' ? body.computerId.trim() : ''
      if (computerId === '') {
        throw new HttpError(400, 'bad-request', 'computerId is required')
      }
      const known = visibleComputers().some((computer) => computer.id === computerId)
      if (!known) throw new HttpError(404, 'not-found', `no computer with id ${JSON.stringify(computerId)}`)
      if (!Object.hasOwn(body, 'allowedPresets')) {
        throw new HttpError(400, 'bad-request', 'allowedPresets is required (an array of preset ids or null)')
      }
      if (body.allowedPresets !== null) {
        if (!Array.isArray(body.allowedPresets)) {
          throw new HttpError(400, 'bad-request', 'allowedPresets must be an array of preset ids or null')
        }
        const roster = await access.presets()
        const knownPresets = new Set(roster.map((preset) => preset.id))
        for (const entry of body.allowedPresets) {
          if (typeof entry !== 'string' || !knownPresets.has(entry.trim())) {
            throw new HttpError(400, 'bad-request', `unknown Agent preset id ${JSON.stringify(entry)}`)
          }
        }
      }
      access.store.setComputerPresets(computerId, body.allowedPresets)
      sendJson(res, 200, await accessComputerPayload(computerId))
      return
    }
    methodNotAllowed(res, 'GET / POST')
  })

  // ---------------------------------------------------------------------------
  // Per-session target selection (task-9)
  // ---------------------------------------------------------------------------

  /**
   * Protocol shape shared by GET and POST /selection. A stored id whose
   * computer no longer exists is reported as "no selection" so the client can
   * render the unselected state instead of a dangling target.
   */
  const selectionPayload = (sessionId, selectedId) => {
    const computer = selectedId === null
      ? undefined
      : visibleComputers().find((candidate) => candidate.id === selectedId)
    return {
      sessionId,
      computerId: computer === undefined ? null : computer.id,
      computer: computer === undefined
        ? null
        : {
            id: computer.id,
            name: computer.name,
            online: hub.isOnline(computer),
            platformLabel: computer.platformLabel ?? 'Unknown',
          },
    }
  }

  route('/selection', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : ''
    if (method === 'GET' || method === 'HEAD') {
      const sessionId = normalizeSessionId(urlOf(req).searchParams.get('sessionId'))
      if (sessionId === null) {
        throw new HttpError(400, 'bad-request', 'sessionId must be a non-empty string (max 256 characters)')
      }
      sendJson(res, 200, selectionPayload(sessionId, selections.get(sessionId)))
      return
    }
    if (method === 'POST') {
      const body = await readObjectBody(req, CONTROL_MAX_BYTES)
      const sessionId = normalizeSessionId(body.sessionId)
      if (sessionId === null) {
        throw new HttpError(400, 'bad-request', 'sessionId must be a non-empty string (max 256 characters)')
      }
      if (!Object.hasOwn(body, 'computerId')) {
        throw new HttpError(400, 'bad-request', 'computerId is required (a computer id or null)')
      }
      if (body.computerId === null) {
        selections.clear(sessionId)
        sendJson(res, 200, selectionPayload(sessionId, null))
        return
      }
      if (typeof body.computerId !== 'string' || body.computerId.trim() === '') {
        throw new HttpError(400, 'bad-request', 'computerId must be a non-empty string or null')
      }
      const computerId = body.computerId.trim()
      const computer = visibleComputers().find((candidate) => candidate.id === computerId)
      if (computer === undefined) throw new HttpError(404, 'not-found', `no computer with id ${JSON.stringify(computerId)}`)
      // Pinning is itself an authorization decision: a conversation may not
      // pin a machine its preset rule or allow-list denies.
      const presetId = access.presetIdForSession(sessionId)
      if (!access.isAllowed({ sessionId, presetId, computerId })) {
        throw new HttpError(403, 'forbidden', access.denialMessage(computer, presetId))
      }
      selections.set(sessionId, computerId, typeof computer.name === 'string' ? computer.name : null)
      sendJson(res, 200, selectionPayload(sessionId, computerId))
      return
    }
    methodNotAllowed(res, 'GET / POST')
  })

  // ---------------------------------------------------------------------------
  // Public routes
  // ---------------------------------------------------------------------------

  route('/join.sh', async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    const entry = installerKey(req, res, 'key')
    if (entry === null) return
    const serverUrl = resolveBaseUrl({ ctx, config, req })
    sendText(res, 200, joinSh(serverUrl, entry.key), 'text/x-shellscript; charset=utf-8')
  })

  route('/join.ps1', async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    const entry = installerKey(req, res, 'key')
    if (entry === null) return
    const serverUrl = resolveBaseUrl({ ctx, config, req })
    sendText(res, 200, joinPs1(serverUrl, entry.key), 'text/plain; charset=utf-8')
  })

  route('/agent.mjs', async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    await serveAgentScript(res, agentUrl)
  })

  route('/health', async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    const computers = visibleComputers()
    sendJson(res, 200, {
      ok: true,
      version,
      computers: computers.length,
      online: computers.filter((computer) => hub.isOnline(computer)).length,
      // §11.1: expose each agent's version/capabilities + drift inline.
      agents: computers.map((computer) => ({
        id: computer.id,
        name: computer.name,
        agentVersion: computer.agentVersion ?? null,
        capabilities: capabilitiesOf(computer),
        caps: capsOf(computer),
        mode: modeOf(computer),
        drift: isDrift(computer),
        updateRequired: needsUpdate(computer),
      })),
    })
  })
}

/**
 * Register the runtime-mode routes (PROTOCOL §10.5) on the host web server.
 *
 * These are browser-gated exactly like §4 and every answer carries the full
 * §10.3 status object (plus `role`, so a pure `role: 'runtime'` deployment —
 * which registers no `/state` route — can still tell the client what to render).
 *
 * @param {object} options - route wiring.
 * @param {object} options.ctx - Cordis context.
 * @param {object} options.config - resolved plugin config.
 * @param {object} options.runtime - runtime manager (lib/runtime.js).
 * @param {string} options.role - 'hub' | 'runtime' | 'both' (echoed in answers).
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 */
export function createRuntimeRoutes({ ctx, config, runtime, role = 'both', onWarn = () => {} }) {
  const route = createRouteRegistrar(ctx, onWarn)
  const refuseBrowser = (req, res) => refuseBrowserRequest(ctx, req, res)
  /** Every answer is the status object plus the role the client is talking to. */
  const respond = (res, status) => sendJson(res, 200, { ...status, role })

  route('/runtime', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'GET')) return
    respond(res, runtime.status())
  })

  route('/runtime/connect', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    const serverUrl = typeof body.serverUrl === 'string' ? body.serverUrl.trim() : ''
    if (serverUrl === '') throw new HttpError(400, 'bad-request', 'serverUrl is required')
    // The client may send `key` (spec) or `enrollmentKey` (older drafts).
    const key = typeof body.key === 'string'
      ? body.key.trim()
      : typeof body.enrollmentKey === 'string'
        ? body.enrollmentKey.trim()
        : ''
    // v1.7.0: the one-address form. The pasted string carries the fleet token in
    // its fragment (`…#join=dshf_…`), which never reaches a server; a key is
    // then optional. Only "neither form" is a 400 — a present-but-wrong token is
    // the hub's 401 invalid-join, mapped by configure().
    const hasJoin = parseJoinAddress(serverUrl).joinToken !== ''
    if (key === '' && !hasJoin) {
      throw new HttpError(400, 'bad-request', 'a join address (…#join=dshf_…) or an enrollment key is required')
    }
    // configure() validates the URL, strips the fragment before storing it,
    // enrolls against the hub and maps the hub's 401/409/410 onto the protocol's
    // invalid-key/invalid-join/key-used/key-expired codes; a transport failure
    // becomes 502 hub-unreachable.
    respond(res, await runtime.configure({ serverUrl, key }))
  })

  route('/runtime/enable', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'bad-request', 'enabled must be a boolean')
    }
    respond(res, await runtime.enable(body.enabled))
  })

  route('/runtime/disconnect', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    // Body is optional on disconnect: nothing to read, nothing to validate.
    // Drain it anyway so keep-alive sockets are not reset between requests.
    try {
      req.resume()
    } catch {
      // Nothing to drain.
    }
    respond(res, await runtime.disconnect())
  })
}

/**
 * Register the minimal read-only routes a `role: 'runtime'` deployment still
 * needs (PROTOCOL §10.1, client contract in §10.6).
 *
 * A runtime is not a controller, so the hub API stays unregistered — no
 * `/agent/*`, no keys/join scripts, no served agent bundle. But the settings
 * client learns its role from `GET /state`; without it the page can only show
 * a load-error card. `/state` therefore answers with `role` and an empty
 * computer list (a runtime owns no registry), and `/health` stays for probes.
 *
 * @param {object} options - route wiring.
 * @param {object} options.ctx - Cordis context.
 * @param {object} options.config - resolved plugin config.
 * @param {string} options.role - always 'runtime' here; echoed in /state.
 * @param {string} options.version - plugin version reported by /health.
 * @param {object} [options.tunnel] - Tailscale Serve manager (`status()`).
 * @param {object} [options.relay] - relay link manager (`status()`), v1.6.0.
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 */
export function createRuntimeStatusRoutes({ ctx, config, role = 'runtime', version, tunnel = null, relay = null, onWarn = () => {} }) {
  const route = createRouteRegistrar(ctx, onWarn)
  const refuseBrowser = (req, res) => refuseBrowserRequest(ctx, req, res)
  /** The relay link status, safe when the manager is absent. */
  const relayStatus = () => relayStatusOf(relay)

  route('/state', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'GET')) return
    let tunnelState = { enabled: false, configured: false, url: '', targetPort: null, error: null }
    try {
      const value = tunnel?.status?.()
      if (value !== null && typeof value === 'object') tunnelState = value
    } catch {
      // Keep the disabled shape.
    }
    sendJson(res, 200, {
      version: 2,
      role,
      serverUrl: resolveBaseUrl({ ctx, config, req }),
      tunnel: tunnelState,
      // v1.6.0: a runtime-role deployment can still be a relay hub, so it
      // reports the same link shape the hub surface does.
      relay: relayStatus(),
      heartbeatMs: config.heartbeatMs,
      // This deployment only follows a hub; it has no computer registry.
      computers: [],
      pendingKey: null,
    })
  })

  // v1.6.1: a runtime-role deployment can be a relay hub too, so it serves the
  // same on/off switch (the relay manager is created for every role).
  registerRelayRoutes(route, refuseBrowser, relay)

  route('/health', async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    sendJson(res, 200, { ok: true, version, computers: 0, online: 0, agents: [] })
  })
}
