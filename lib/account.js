/**
 * Account-center identity + device self-registration (v1.8.0).
 *
 * The relay doubles as an account center: `POST /api/fleet/accounts` creates an
 * account and answers `{ accountId, secret }`, and every machine that logs into
 * the same account registers itself in the account's device directory. Two
 * machines in one account therefore find each other with no per-machine pairing
 * — the directory is the only shared state.
 *
 * What lives on this machine:
 * - `${stateDir}/account.json` — the LOGIN (`{ version: 1, relayUrl,
 *   accountId, secret, machineId, name }`, mode 0600, atomic write, corrupt
 *   tolerant). The secret is the account credential and never leaves the host:
 *   no route, log line or warning ever carries it, and every relay error message
 *   is scrubbed before it is stored or returned.
 * - `${stateDir}/machine.json` — the machine identity (`{ version: 1,
 *   machineId }`), minted once as `mach_` + 16 hex characters. It is a separate
 *   document on purpose, exactly like `relay.json` / `fleet.json`: logging out
 *   (or switching accounts) must not orphan the device row the relay already
 *   knows, and the relay upserts devices by `machineId`.
 *
 * Registration runs on login/create and then every 60 s from a timer owned by
 * this module. It is strictly best-effort: a failure is recorded in `lastError`
 * (which the settings page shows) and retried on the next tick — it never
 * throws into the host and never fails the browser request that triggered it.
 *
 * Discovery: `discoverRelayCandidates()` probes a small list of local ports for
 * a relay (`GET /health` answering `{ ok: true }`) so the settings page can
 * pre-fill the relay address instead of asking the operator to invent one. It
 * never throws and an empty list is a valid answer.
 *
 * Node builtins only — no `@deepseek-ai/*` imports.
 */

import { randomBytes } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { hostname as osHostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'

import { HttpError } from './http.js'
import { readJsonTolerant, writeJsonAtomic } from './state.js'

/** On-disk schema version of `account.json` / `machine.json`. */
export const ACCOUNT_VERSION = 1

/** The machineId alphabet the relay upserts by: `mach_` + 16 lowercase hex. */
export const MACHINE_ID_PREFIX = 'mach_'
export const MACHINE_ID_PATTERN = /^mach_[0-9a-f]{16}$/

/** How often a logged-in machine re-registers itself (the protocol's 60 s). */
export const ACCOUNT_HEARTBEAT_MS = 60_000

/** `/account` must answer quickly even when the relay hangs (PROTOCOL budget). */
export const DEVICES_TIMEOUT_MS = 2_000

/** How long one local relay health probe may take while discovering. */
export const DISCOVER_TIMEOUT_MS = 400

/** The relay's conventional local port, probed first by discovery. */
export const DEFAULT_RELAY_PORT = 8445

/** Ports discovery probes at most, so a hostile config cannot turn it into a scan. */
const MAX_DISCOVER_PORTS = 4

/** Cap on a relay JSON answer (200 devices + envelopes fits easily). */
const RELAY_MAX_BYTES = 256 * 1024

/** A placeholder address for messages and tests — never a real operator domain. */
export const RELAY_PLACEHOLDER_URL = 'https://relay.example.com'

/** Absolute path of the login document. */
export function accountFile(stateDir) {
  return join(stateDir, 'account.json')
}

/** Absolute path of the machine identity document. */
export function machineFile(stateDir) {
  return join(stateDir, 'machine.json')
}

/** Mint one stable machine id: `mach_` + 16 lowercase hex characters. */
export function mintMachineId() {
  return `${MACHINE_ID_PREFIX}${randomBytes(8).toString('hex')}`
}

/** True for a machineId this module would mint. */
export function isMachineId(value) {
  return typeof value === 'string' && MACHINE_ID_PATTERN.test(value)
}

/**
 * The device name reported for this machine: the configured relay name when the
 * operator set one, else the hostname (minus a trailing `.local`, which reads
 * like noise in another machine's device list).
 * @param {string} [configured] - `config.relay.name`.
 * @returns {string} 1-64 visible characters.
 */
export function machineNameOf(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim().slice(0, 64)
  try {
    const name = osHostname()
    if (typeof name === 'string' && name.trim() !== '') {
      return name.trim().replace(/\.local$/i, '').slice(0, 64)
    }
  } catch {
    // A host without a hostname still gets a usable label.
  }
  return 'this machine'
}

/**
 * Normalise the account center's relay address to an http(s) origin. The
 * settings page may receive the relay's ws(s) address (that is how `relay.url`
 * is stored), so both spellings are accepted; the account API is HTTP either
 * way. A path, credentials, query or fragment is refused, because the caller
 * splices `/api/fleet/...` onto this value.
 * @param {unknown} value - candidate address.
 * @returns {{ url: string, error: string | null }} normalised origin or an error.
 */
export function normalizeRelayBase(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { url: '', error: 'relayUrl is required' }
  }
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    return { url: '', error: `relayUrl must be an absolute address (for example ${RELAY_PLACEHOLDER_URL})` }
  }
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
  else if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: '', error: `relayUrl must use http(s):// or ws(s)://, got ${parsed.protocol}` }
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return { url: '', error: 'relayUrl must not carry a path; put the relay root in the address' }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { url: '', error: 'relayUrl must not carry credentials' }
  }
  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''
  return { url: parsed.toString().replace(/\/$/, ''), error: null }
}

/** True for hosts that only mean "this machine" (`127.0.0.0/8`, `localhost`, `::1`). */
function isLoopbackHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127\./.test(host)
}

/**
 * Prefer a non-loopback spelling of one advertised URL: another machine in the
 * account cannot use `127.0.0.1`, so when the plugin only knows the loopback
 * origin, swap in this machine's first non-internal IPv4 (keeping protocol,
 * port and any path prefix). Total: an unusable input comes back unchanged (or
 * empty), never throws.
 * @param {unknown} value - advertised http(s) URL.
 * @returns {string} the best spelling, or '' when it is not a usable URL.
 */
export function preferNonLoopback(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  const suffix = parsed.pathname.replace(/\/+$/, '')
  if (!isLoopbackHost(parsed.hostname)) return `${parsed.origin}${suffix}`
  try {
    for (const entries of Object.values(networkInterfaces() ?? {})) {
      for (const entry of entries ?? []) {
        if (entry === null || typeof entry !== 'object') continue
        if (entry.family !== 'IPv4' && entry.family !== 4) continue
        if (entry.internal === true || typeof entry.address !== 'string') continue
        if (isLoopbackHost(entry.address)) continue
        parsed.hostname = entry.address
        return `${parsed.origin}${suffix}`
      }
    }
  } catch {
    // Fall through to the loopback spelling.
  }
  return `${parsed.origin}${suffix}`
}

/** Read the persisted machine id (never mints). */
export function readMachineId(stateDir, { onWarn = () => {}, now = Date.now } = {}) {
  const raw = readJsonTolerant(machineFile(stateDir), { onWarn, now })
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) && isMachineId(raw.machineId)
    ? raw.machineId
    : null
}

/**
 * Read the machine id, minting and persisting it once when it is missing.
 * A pre-v1.8.0 `account.json` that already carries a machineId is adopted (and
 * copied into `machine.json`) so upgrading does not change the device row.
 * A write failure still returns the in-memory id: this process can register,
 * it just cannot promise the id survives a restart.
 * @param {string} stateDir - resolved state directory.
 * @param {{ onWarn?: (message: string) => void, now?: () => number }} [options] - warning sink and clock.
 * @returns {string} the live machine id.
 */
export function ensureMachineId(stateDir, { onWarn = () => {}, now = Date.now } = {}) {
  const existing = readMachineId(stateDir, { onWarn, now })
  if (existing !== null) return existing
  // Adopt an id a hand-written/older account document already carries.
  const raw = readJsonTolerant(accountFile(stateDir), { onWarn, now })
  const adopted = raw !== null && typeof raw === 'object' && !Array.isArray(raw) && isMachineId(raw.machineId)
    ? raw.machineId
    : null
  const machineId = adopted ?? mintMachineId()
  if (!writeJsonAtomic(machineFile(stateDir), { version: ACCOUNT_VERSION, machineId }, { dir: stateDir, onWarn })) {
    onWarn('dsh-computers: could not persist the machine id; the account center will see a new device after a restart')
  }
  return machineId
}

/**
 * Read the persisted login. A missing/corrupt document — or one whose required
 * fields are unusable — reads as `null` (logged out), so a half-written file can
 * never brick the plugin.
 * @param {string} stateDir - resolved state directory.
 * @param {{ onWarn?: (message: string) => void, now?: () => number }} [options] - warning sink and clock.
 * @returns {{ version: number, relayUrl: string, accountId: string, secret: string, machineId: string, name: string } | null} the login or null.
 */
export function readAccountIdentity(stateDir, { onWarn = () => {}, now = Date.now } = {}) {
  const raw = readJsonTolerant(accountFile(stateDir), { onWarn, now })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const relay = normalizeRelayBase(raw.relayUrl)
  if (relay.error !== null || relay.url === '') return null
  const accountId = typeof raw.accountId === 'string' ? raw.accountId.trim() : ''
  const secret = typeof raw.secret === 'string' ? raw.secret.trim() : ''
  if (accountId === '' || secret === '') return null
  const machineId = isMachineId(raw.machineId) ? raw.machineId : (readMachineId(stateDir, { onWarn, now }) ?? '')
  if (machineId === '') return null
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 64) : ''
  return { version: ACCOUNT_VERSION, relayUrl: relay.url, accountId, secret, machineId, name }
}

/**
 * Persist one login atomically (0600). The machine id is never taken from the
 * caller's document alone: it is the stable identity, so a missing one is
 * minted/read here rather than silently changing the device row.
 * @param {string} stateDir - resolved state directory.
 * @param {object} identity - login fields (`relayUrl`, `accountId`, `secret`, `name`).
 * @param {{ onWarn?: (message: string) => void, now?: () => number }} [options] - warning sink and clock.
 * @returns {boolean} whether the write succeeded.
 */
export function writeAccountIdentity(stateDir, identity, { onWarn = () => {}, now = Date.now } = {}) {
  const relay = normalizeRelayBase(identity?.relayUrl)
  const accountId = typeof identity?.accountId === 'string' ? identity.accountId.trim() : ''
  const secret = typeof identity?.secret === 'string' ? identity.secret.trim() : ''
  if (relay.error !== null || accountId === '' || secret === '') return false
  const machineId = isMachineId(identity?.machineId) ? identity.machineId : ensureMachineId(stateDir, { onWarn, now })
  return writeJsonAtomic(accountFile(stateDir), {
    version: ACCOUNT_VERSION,
    relayUrl: relay.url,
    accountId,
    secret,
    machineId,
    name: typeof identity?.name === 'string' ? identity.name.trim().slice(0, 64) : '',
  }, { dir: stateDir, onWarn })
}

/**
 * Delete the login document (logout). The machine identity in `machine.json`
 * deliberately survives: the device row the relay knows is keyed by machineId.
 * @param {string} stateDir - resolved state directory.
 * @param {{ onWarn?: (message: string) => void }} [options] - warning sink.
 * @returns {boolean} whether the document is gone.
 */
export function clearAccountIdentity(stateDir, { onWarn = () => {} } = {}) {
  try {
    unlinkSync(accountFile(stateDir))
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return true
    onWarn(`dsh-computers: cannot remove ${accountFile(stateDir)}: ${error && error.message ? error.message : error}`)
    return false
  }
}

/**
 * The logged-out status shape (also the total fallback when no manager is
 * mounted). Keeping one shape for both makes `/state.account` and `/account`
 * interchangeable for the client.
 * @param {string} [machineId] - this machine's id, when known.
 * @returns {object} the account status payload.
 */
export function emptyAccountStatus(machineId = '') {
  return {
    loggedIn: false,
    relayUrl: '',
    accountId: '',
    name: '',
    machineId: typeof machineId === 'string' ? machineId : '',
    devices: [],
    lastError: null,
    registeredAt: null,
  }
}

// ---------------------------------------------------------------------------
// Outbound relay HTTP (the plugin dials the relay; nothing listens here)
// ---------------------------------------------------------------------------

/**
 * One JSON request to the relay. Transport failures become
 * `HttpError(502, 'relay-unreachable')`; any HTTP answer resolves so the caller
 * can map the relay's own error codes. The URL is always built from a value that
 * passed {@link normalizeRelayBase}, so it cannot become an SSRF primitive.
 * @param {string} urlString - absolute http(s) URL.
 * @param {object} [options] - request options.
 * @param {string} [options.method] - HTTP method (default GET).
 * @param {Record<string, string>} [options.headers] - extra headers.
 * @param {unknown} [options.body] - JSON-serialisable body (sent only when defined).
 * @param {number} [options.timeoutMs] - whole-exchange budget.
 * @param {number} [options.maxBytes] - response cap.
 * @returns {Promise<{ status: number, headers: object, text: string, data: unknown }>} the answer.
 */
async function relayRequest(urlString, {
  method = 'GET', headers = {}, body, timeoutMs = 10_000, maxBytes = RELAY_MAX_BYTES,
} = {}) {
  let url
  try {
    url = new URL(String(urlString))
  } catch {
    throw new HttpError(502, 'relay-unreachable', 'the relay address is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(502, 'relay-unreachable', 'the relay address must use http or https')
  }
  let payload
  if (body !== undefined) {
    try {
      payload = Buffer.from(JSON.stringify(body), 'utf8')
    } catch {
      throw new HttpError(400, 'bad-request', 'request body is not JSON-serializable')
    }
  }
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
  return await new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const request = transport(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(payload === undefined
          ? {}
          : { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length }),
        ...headers,
      },
    }, (response) => {
      const chunks = []
      let size = 0
      let overLimit = false
      response.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > maxBytes) {
          overLimit = true
          chunks.length = 0
          response.resume()
          return
        }
        chunks.push(buffer)
      })
      response.on('end', () => {
        if (overLimit) {
          finish(new HttpError(502, 'relay-unreachable', `the relay response exceeded ${maxBytes} bytes`))
          return
        }
        const text = Buffer.concat(chunks).toString('utf8')
        let data
        try {
          data = text === '' ? undefined : JSON.parse(text)
        } catch {
          data = undefined
        }
        finish(undefined, { status: response.statusCode ?? 0, headers: response.headers, text, data })
      })
      response.on('error', (error) => {
        finish(new HttpError(502, 'relay-unreachable', `the relay response failed: ${error.message}`))
      })
    })
    request.on('error', (error) => {
      finish(new HttpError(502, 'relay-unreachable', `cannot reach the relay at ${url.origin}: ${error.message}`))
    })
    timer = setTimeout(() => {
      request.destroy(new Error('timeout'))
      finish(new HttpError(502, 'relay-unreachable', `the relay at ${url.origin} did not answer within ${timeoutMs}ms`))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    request.end(payload)
  })
}

/** The relay's `{ error, message }` answer as an HttpError (5xx → 502). */
function errorFromResponse(response) {
  const data = response.data !== null && typeof response.data === 'object' && !Array.isArray(response.data)
    ? response.data
    : {}
  const code = typeof data.error === 'string' && data.error !== '' ? data.error : 'relay-error'
  const message = typeof data.message === 'string' && data.message !== ''
    ? data.message
    : `the relay answered HTTP ${response.status}`
  // A 5xx relay is "unreachable enough": the browser should retry, not treat
  // the relay's internal error as a client mistake.
  return response.status >= 500
    ? new HttpError(502, 'relay-error', message)
    : new HttpError(response.status, code, message)
}

/** One device row from the relay, normalised for the browser contract. */
function normalizeDevice(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const machineId = typeof raw.machineId === 'string' ? raw.machineId.trim() : ''
  if (machineId === '') return null
  return {
    machineId,
    name: typeof raw.name === 'string' ? raw.name : '',
    platform: typeof raw.platform === 'string' ? raw.platform : '',
    hubId: typeof raw.hubId === 'string' ? raw.hubId : '',
    entryUrl: typeof raw.entryUrl === 'string' ? raw.entryUrl : '',
    online: raw.online === true,
    lastSeenAt: typeof raw.lastSeenAt === 'string' && Number.isFinite(Date.parse(raw.lastSeenAt)) ? raw.lastSeenAt : null,
  }
}

/** `…/api/fleet/accounts/<id>` for one normalised relay origin. */
function accountApi(relayUrl, accountId) {
  return `${relayUrl}/api/fleet/accounts/${encodeURIComponent(accountId)}`
}

// ---------------------------------------------------------------------------
// Local relay discovery (pre-fill the settings input)
// ---------------------------------------------------------------------------

/**
 * The local ports discovery should probe: the relay's conventional 8445 plus
 * every port explicitly named by the effective relay address (config or the
 * settings-page override). A default 443/80 is not probed — that is a public
 * proxy port, not a local listener — so only an explicit `:port` is added.
 * @param {{ configUrl?: string, effectiveUrl?: string }} [options] - relay addresses.
 * @returns {number[]} deduped ports, 8445 first.
 */
export function deriveRelayPorts({ configUrl = '', effectiveUrl = '' } = {}) {
  const ports = [DEFAULT_RELAY_PORT]
  for (const value of [configUrl, effectiveUrl]) {
    if (typeof value !== 'string' || value.trim() === '') continue
    try {
      const parsed = new URL(value.trim())
      if (parsed.port === '') continue
      const port = Number(parsed.port)
      if (Number.isSafeInteger(port) && port > 0 && port <= 65535 && !ports.includes(port)) ports.push(port)
    } catch {
      // An unusable address contributes no port.
    }
  }
  return ports.slice(0, MAX_DISCOVER_PORTS)
}

/**
 * Probe `http://127.0.0.1:<port>/health` for a relay. A JSON body with
 * `ok: true` is the relay's health contract; an `accounts` count is a bonus
 * signal, not a requirement. Never throws and never outlives its budget.
 * @param {number} port - local port to probe.
 * @param {{ timeoutMs?: number, host?: string }} [options] - probe knobs.
 * @returns {Promise<{ port: number, accounts: number | null } | null>} the hit, or null.
 */
export function probeRelayHealth(port, { timeoutMs = DISCOVER_TIMEOUT_MS, host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (hit) => {
      if (settled) return
      settled = true
      resolve(hit)
    }
    let request
    try {
      request = httpRequest({
        host,
        port,
        path: '/health',
        method: 'GET',
        timeout: timeoutMs,
        headers: { accept: 'application/json' },
      }, (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > 64 * 1024) {
            request.destroy()
            finish(null)
            return
          }
          chunks.push(buffer)
        })
        response.on('end', () => {
          if (response.statusCode !== 200) {
            finish(null)
            return
          }
          let data
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            data = null
          }
          if (data !== null && typeof data === 'object' && !Array.isArray(data) && data.ok === true) {
            finish({ port, accounts: Number.isSafeInteger(data.accounts) ? data.accounts : null })
          } else {
            finish(null)
          }
        })
        response.on('error', () => finish(null))
      })
      request.on('timeout', () => {
        request.destroy()
        finish(null)
      })
      request.on('error', () => finish(null))
      request.end()
    } catch {
      finish(null)
    }
  })
}

/**
 * The host spellings a discovered local relay could be reached at, best first:
 * the non-loopback advertised candidates (public/forwarded, then LAN/Tailscale,
 * then any other non-loopback), and only as a last resort loopback — which is
 * still a valid account-center address for THIS machine, just not for others.
 * @param {Array<{ url?: string, kind?: string, reachable?: boolean }>} candidates - address payload list.
 * @returns {Array<{ host: string, scheme: string }>} up to three host spellings.
 */
function relayHostCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates : []
  const preferredKinds = ['public', 'forwarded', 'lan', 'tailscale', 'host', 'mdns']
  const out = []
  const seen = new Set()
  const add = (candidate) => {
    if (candidate === null || typeof candidate !== 'object') return
    if (typeof candidate.url !== 'string' || candidate.url.trim() === '') return
    let parsed
    try {
      parsed = new URL(candidate.url.trim())
    } catch {
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    const host = parsed.hostname
    if (host === '' || seen.has(host)) return
    seen.add(host)
    out.push({ host, scheme: parsed.protocol === 'https:' ? 'https' : 'http' })
  }
  // 1. The advertised, reachable, non-loopback candidates in preference order.
  for (const kind of preferredKinds) {
    for (const candidate of list) {
      if (candidate?.kind !== kind || candidate?.reachable !== true) continue
      add(candidate)
    }
  }
  // 2. Any other reachable non-loopback spelling (e.g. the bind address).
  for (const candidate of list) {
    if (candidate?.reachable !== true) continue
    if (candidate.kind === 'loopback' || candidate.kind === 'relay' || candidate.kind === 'tunnel') continue
    add(candidate)
  }
  // 3. Last resort: loopback, so a single-machine setup still gets a usable
  //    account-center address. Another machine cannot use it, which is why it
  //    is never preferred.
  if (out.length === 0) {
    for (const candidate of list) {
      if (candidate?.kind === 'loopback') add(candidate)
    }
  }
  return out.slice(0, 3)
}

/**
 * Discover account-center candidates on this machine: probe the local ports,
 * then spell each hit with the machine's own advertised host. Never throws; an
 * empty `candidates` list is a valid answer (the operator then types a domain).
 * @param {object} [options] - discovery inputs.
 * @param {Array<object>} [options.candidates] - `resolveAddressPayload().serverUrls`.
 * @param {number[]} [options.ports] - ports to probe (see {@link deriveRelayPorts}).
 * @param {string} [options.configuredUrl] - the effective `relay.url` (may be ws(s)).
 * @param {(port: number, options: object) => Promise<object | null>} [options.probe] - probe seam.
 * @param {number} [options.timeoutMs] - per-probe budget.
 * @returns {Promise<{ candidates: Array<{ url: string, source: string, reachable: boolean }>, configured: { relayUrl: string } }>} the proposal.
 */
export async function discoverRelayCandidates({
  candidates = [], ports = [DEFAULT_RELAY_PORT], configuredUrl = '', probe = probeRelayHealth, timeoutMs = DISCOVER_TIMEOUT_MS,
} = {}) {
  const configured = normalizeRelayBase(configuredUrl).url
  const probes = []
  try {
    for (const port of Array.isArray(ports) ? ports : []) {
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) continue
      probes.push((async () => {
        try {
          const hit = await probe(port, { timeoutMs })
          if (hit === null || hit === undefined) return null
          return { port: Number.isSafeInteger(hit.port) ? hit.port : port }
        } catch {
          return null
        }
      })())
    }
  } catch {
    // No probes: the answer is just "nothing found".
  }
  let hits = []
  try {
    hits = (await Promise.all(probes)).filter((hit) => hit !== null)
  } catch {
    hits = []
  }
  const hosts = relayHostCandidates(candidates)
  const result = []
  const seen = new Set()
  const push = (url, source) => {
    if (typeof url !== 'string' || url === '' || seen.has(url)) return
    seen.add(url)
    result.push({ url, source, reachable: true })
  }
  for (const hit of hits) {
    for (const { host, scheme } of hosts) push(`${scheme}://${host}:${hit.port}`, 'local-relay')
  }
  // The currently configured relay is a candidate too (source 'configured'), so
  // the settings page can show "use what is already set up" alongside local hits.
  if (configured !== '') push(configured, 'configured')
  return { candidates: result, configured: { relayUrl: configured } }
}

// ---------------------------------------------------------------------------
// The manager: login/create/logout + the 60 s self-registration loop
// ---------------------------------------------------------------------------

/**
 * Create the account-center manager for one plugin mount.
 *
 * `describe()` supplies the device facts that depend on the host wiring (the
 * relay manager and the advertised address); it is called on every
 * registration, so a relay that connects later is picked up without a reload.
 * It must return `{ hubId?, entryUrl?, name?, platform? }`; `entryUrl` wins when
 * non-empty, else the address last noted by a browser request, else
 * `fallbackEntryUrl()`.
 *
 * @param {object} options - manager options.
 * @param {string} options.stateDir - resolved state directory.
 * @param {() => { hubId?: string, entryUrl?: string, name?: string, platform?: string }} [options.describe] - device facts.
 * @param {() => string} [options.fallbackEntryUrl] - last-resort advertised address.
 * @param {number} [options.heartbeatMs] - re-registration interval (default 60 s).
 * @param {number} [options.devicesTimeoutMs] - device-list budget (default 2 s).
 * @param {number} [options.requestTimeoutMs] - other relay calls' budget.
 * @param {() => number} [options.now] - epoch-millisecond clock.
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 * @param {(level: string, message: string) => void} [options.log] - logger.
 * @returns {object} the manager (`start`, `dispose`, `status`, `refreshDevices`, `create`, `login`, `logout`, `register`, `noteEntryUrl`).
 */
export function createAccountManager({
  stateDir,
  describe = () => ({}),
  fallbackEntryUrl = () => '',
  heartbeatMs = ACCOUNT_HEARTBEAT_MS,
  devicesTimeoutMs = DEVICES_TIMEOUT_MS,
  requestTimeoutMs = 10_000,
  now = Date.now,
  onWarn = () => {},
  log = () => {},
} = {}) {
  const file = accountFile(stateDir)
  const machineDocument = machineFile(stateDir)
  const machineId = ensureMachineId(stateDir, { onWarn, now })
  let identity = readAccountIdentity(stateDir, { onWarn, now })
  // Two failure slots, because they are fixed by different successes: the
  // device-directory read (fixed by a successful GET) and the self-registration
  // (fixed by a successful POST). Reporting only the last one would hide a
  // registration failure behind a successful list — the exact bug where the
  // machine silently stops updating its own row.
  let lastError = null
  let registrationError = null
  let registeredAt = null
  let devices = []
  let advertisedUrl = ''
  let timer = null
  let kickoff = null
  let ticking = false
  let disposed = false

  /** One log line that can never throw into the host. */
  const logLine = (level, message) => {
    try {
      log(level, message)
    } catch {
      // A broken logger must not break the plugin.
    }
  }

  /**
   * Scrub the account secret out of anything that could be surfaced. The relay
   * should never echo it, but a stored/returned message is attacker-adjacent
   * input, so this is belt-and-braces.
   */
  const redact = (value) => {
    let text = typeof value === 'string' ? value : String(value ?? '')
    if (identity !== null && identity.secret !== '') text = text.split(identity.secret).join('[redacted]')
    return text
  }

  /** Record a failure for the settings page; never throws. */
  const rememberError = (error) => {
    lastError = redact(error && error.message ? error.message : error)
    logLine('warn', `account center: ${lastError}`)
    return lastError
  }

  /** Record a registration failure (cleared only by a successful registration). */
  const rememberRegistrationError = (error) => {
    registrationError = redact(error && error.message ? error.message : error)
    logLine('warn', `account center: ${registrationError}`)
    return registrationError
  }

  /** `describe()` that cannot throw. */
  const safeDescribe = () => {
    try {
      const value = describe()
      return value !== null && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  /** `fallbackEntryUrl()` that cannot throw. */
  const safeFallback = () => {
    try {
      const value = fallbackEntryUrl()
      return typeof value === 'string' ? value : ''
    } catch {
      return ''
    }
  }

  /** One absolute http(s) entry URL, or '' when unusable. */
  const entryUrlOf = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return ''
    try {
      const parsed = new URL(value.trim())
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
      return parsed.toString().replace(/\/$/, '')
    } catch {
      return ''
    }
  }

  /** True when an absolute http(s) URL points at loopback. */
  const loopbackUrl = (value) => {
    try {
      return isLoopbackHost(new URL(value).hostname)
    } catch {
      return false
    }
  }

  /** The device row this machine registers: identity facts + live entry. */
  const deviceOf = () => {
    const described = safeDescribe()
    // Relay entry first (it is the only address that works from anywhere), then
    // a non-loopback spelling (another machine cannot use 127.0.0.1), then
    // whatever is left. `fallbackEntryUrl` already swaps in a LAN address when
    // the plugin only knows its loopback origin.
    const relayEntry = entryUrlOf(described.entryUrl)
    const options = [entryUrlOf(advertisedUrl), entryUrlOf(safeFallback())].filter((url) => url !== '')
    const entryUrl = relayEntry || options.find((url) => !loopbackUrl(url)) || options[0] || ''
    if (entryUrl === '') return null
    return {
      machineId,
      name: typeof described.name === 'string' && described.name.trim() !== ''
        ? described.name.trim().slice(0, 64)
        : machineNameOf(''),
      platform: typeof described.platform === 'string' && described.platform.trim() !== ''
        ? described.platform.trim().slice(0, 32)
        : process.platform,
      hubId: typeof described.hubId === 'string' ? described.hubId : '',
      entryUrl,
    }
  }

  /** Persist a login, keeping the stable machine id. Throws when the write fails. */
  const persist = (next) => {
    const document = {
      version: ACCOUNT_VERSION,
      relayUrl: next.relayUrl,
      accountId: next.accountId,
      secret: next.secret,
      machineId,
      name: typeof next.name === 'string' ? next.name : '',
    }
    if (!writeAccountIdentity(stateDir, document, { onWarn, now })) {
      throw new HttpError(500, 'account-persist-failed', 'could not write account.json; check that the state directory is writable')
    }
    identity = document
  }

  /** The browser payload; the secret is never a field. */
  const status = () => ({
    loggedIn: identity !== null,
    relayUrl: identity === null ? '' : identity.relayUrl,
    accountId: identity === null ? '' : identity.accountId,
    name: identity === null ? '' : identity.name,
    machineId,
    devices: devices.map((device) => ({ ...device })),
    // Registration failures are the more important signal (this machine's row
    // is stale), so they win over a device-list failure.
    lastError: registrationError ?? lastError,
    registeredAt,
  })

  /** Stop the heartbeat and any pending first tick. */
  const stopTimers = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (kickoff !== null) {
      clearTimeout(kickoff)
      kickoff = null
    }
  }

  /** (Re)start the 60 s loop; a logged-out manager keeps no timer at all. */
  const startHeartbeat = () => {
    stopTimers()
    if (disposed || identity === null) return
    if (Number.isSafeInteger(heartbeatMs) && heartbeatMs > 0) {
      timer = setInterval(() => {
        void tick()
      }, heartbeatMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
    // Register once shortly after login/mount instead of waiting a full tick.
    // The delay lets the web server bind (the advertised address is unreadable
    // before that); the first browser poll also feeds the entry URL.
    kickoff = setTimeout(() => {
      kickoff = null
      void tick()
    }, 250)
    if (typeof kickoff.unref === 'function') kickoff.unref()
  }

  /**
   * Fetch the account's device list with a bounded budget. On failure the list
   * is emptied and `lastError` is set (the protocol's contract for `/account`).
   */
  const refreshDevices = async ({ timeoutMs = devicesTimeoutMs } = {}) => {
    if (identity === null) {
      devices = []
      return status()
    }
    try {
      const response = await relayRequest(`${accountApi(identity.relayUrl, identity.accountId)}/devices`, {
        headers: { 'x-fleet-secret': identity.secret },
        timeoutMs,
      })
      if (response.status !== 200) throw errorFromResponse(response)
      const list = response.data !== null && typeof response.data === 'object' && Array.isArray(response.data.devices)
        ? response.data.devices
        : []
      devices = list.map(normalizeDevice).filter((device) => device !== null)
      lastError = null
    } catch (error) {
      devices = []
      rememberError(error)
    }
    return status()
  }

  /**
   * Register (upsert) this machine in the account's device directory. Best
   * effort: a failure is recorded and retried on the next tick, never thrown.
   */
  const register = async () => {
    if (identity === null) return status()
    const device = deviceOf()
    if (device === null) {
      rememberRegistrationError(new Error('this machine has no advertised address yet, so it cannot register with the account center'))
      return status()
    }
    try {
      const response = await relayRequest(`${accountApi(identity.relayUrl, identity.accountId)}/devices`, {
        method: 'POST',
        // The relay contract accepts the secret in the body for a device upsert.
        body: { secret: identity.secret, device },
        timeoutMs: requestTimeoutMs,
      })
      if (response.status < 200 || response.status >= 300) throw errorFromResponse(response)
      registeredAt = new Date(now()).toISOString()
      registrationError = null
    } catch (error) {
      rememberRegistrationError(error)
    }
    return status()
  }

  /** One heartbeat tick: register, then refresh the directory. */
  const tick = async () => {
    if (ticking || disposed || identity === null) return
    ticking = true
    try {
      await register()
      await refreshDevices()
    } finally {
      ticking = false
    }
  }

  return {
    /** Absolute `account.json` path (diagnostics + smoke assertions). */
    file,
    /** Absolute `machine.json` path (diagnostics + smoke assertions). */
    machineFile: machineDocument,
    /** This machine's stable id (minted once, never exposed as a secret). */
    machineId: () => machineId,
    /** Whether a login is persisted. */
    loggedIn: () => identity !== null,
    /** Record the advertised address the browser just used, for the heartbeat. */
    noteEntryUrl(url) {
      const normalized = entryUrlOf(url)
      if (normalized !== '') advertisedUrl = normalized
    },
    /** The browser payload (never includes the secret). */
    status,
    /** Re-read the device directory from the relay (bounded; never throws). */
    refreshDevices,
    /** Start the heartbeat for a persisted login (call on mount). */
    start() {
      if (!disposed) startHeartbeat()
    },
    /** Stop the heartbeat and refuse further ticks (plugin unload). */
    dispose() {
      disposed = true
      stopTimers()
    },
    /** Create an account on the relay, persist it and register this machine. */
    async create({ relayUrl, adminKey = '', name = '' } = {}) {
      const normalized = normalizeRelayBase(relayUrl)
      if (normalized.error !== null) throw new HttpError(400, 'invalid-relay-url', normalized.error)
      const headers = {}
      if (typeof adminKey === 'string' && adminKey.trim() !== '') headers['x-admin-key'] = adminKey.trim().slice(0, 256)
      const body = {}
      if (typeof name === 'string' && name.trim() !== '') body.name = name.trim().slice(0, 64)
      let response
      try {
        response = await relayRequest(`${normalized.url}/api/fleet/accounts`, {
          method: 'POST', headers, body, timeoutMs: requestTimeoutMs,
        })
      } catch (error) {
        rememberError(error)
        throw error
      }
      if (response.status < 200 || response.status >= 300) {
        const error = errorFromResponse(response)
        rememberError(error)
        throw error
      }
      const data = response.data !== null && typeof response.data === 'object' ? response.data : {}
      const accountId = typeof data.accountId === 'string' ? data.accountId.trim() : ''
      const secret = typeof data.secret === 'string' ? data.secret.trim() : ''
      if (accountId === '' || secret === '') {
        throw new HttpError(502, 'relay-error', 'the relay created an account but returned no accountId/secret pair')
      }
      const accountName = typeof data.name === 'string' && data.name.trim() !== ''
        ? data.name.trim().slice(0, 64)
        : (typeof body.name === 'string' ? body.name : '')
      persist({ relayUrl: normalized.url, accountId, secret, name: accountName })
      devices = []
      registeredAt = null
      lastError = null
      registrationError = null
      await register()
      await refreshDevices()
      startHeartbeat()
      // The account secret is shown to the user EXACTLY once, here: it is the
      // only way to log the other machines in, and `status()` never carries it.
      return { ...status(), secret }
    },
    /**
     * Log into an existing account: verify the secret by listing the account's
     * devices, then persist and register this machine.
     */
    async login({ relayUrl, accountId, secret } = {}) {
      const normalized = normalizeRelayBase(relayUrl)
      if (normalized.error !== null) throw new HttpError(400, 'invalid-relay-url', normalized.error)
      const id = typeof accountId === 'string' ? accountId.trim() : ''
      if (id === '' || id.length > 128) throw new HttpError(400, 'bad-request', 'accountId is required (1-128 characters)')
      const key = typeof secret === 'string' ? secret.trim() : ''
      if (key === '' || key.length > 512) throw new HttpError(400, 'bad-request', 'secret is required (1-512 characters)')
      let response
      try {
        response = await relayRequest(`${accountApi(normalized.url, id)}/devices`, {
          headers: { 'x-fleet-secret': key },
          timeoutMs: requestTimeoutMs,
        })
      } catch (error) {
        rememberError(error)
        throw error
      }
      if (response.status === 401 || response.status === 403) {
        const error = new HttpError(401, 'invalid-secret', 'the relay rejected this account secret')
        rememberError(error)
        throw error
      }
      if (response.status === 404) {
        const error = new HttpError(404, 'account-not-found', 'the relay does not know this account')
        rememberError(error)
        throw error
      }
      if (response.status !== 200) {
        const error = errorFromResponse(response)
        rememberError(error)
        throw error
      }
      const list = response.data !== null && typeof response.data === 'object' && Array.isArray(response.data.devices)
        ? response.data.devices
        : []
      persist({ relayUrl: normalized.url, accountId: id, secret: key, name: '' })
      devices = list.map(normalizeDevice).filter((device) => device !== null)
      registeredAt = null
      lastError = null
      registrationError = null
      await register()
      await refreshDevices()
      startHeartbeat()
      return status()
    },
    /** Forget the login. The machine id (and the relay's device row) survive. */
    logout() {
      stopTimers()
      clearAccountIdentity(stateDir, { onWarn })
      identity = null
      devices = []
      registeredAt = null
      lastError = null
      registrationError = null
      return status()
    },
  }
}
