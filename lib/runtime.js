/**
 * Embedded runtime mode (PROTOCOL §10.2–§10.4).
 *
 * The plugin can also BE a controlled machine: this manager persists
 * `${stateDir}/runtime.json`, enrolls this machine with one hub, and drives
 * the agent's exported `startRuntime()` — it never reimplements the SSE/exec
 * wire protocol, it only owns the user's switch and the process lifecycle.
 *
 * Topology stays hub-and-spoke: the runtime half only ever dials out to the
 * single configured `serverUrl`, never to another machine.
 *
 * Node builtins only.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { arch, cpus, homedir, hostname, platform, totalmem } from 'node:os'

import { connectMetadata, enrollRequest, runtimeStatusPayload } from './contracts.js'
import { join } from 'node:path'

import { HttpError, postJson } from './http.js'
import { platformLabel } from './keys.js'

/** On-disk schema version for runtime.json. */
export const RUNTIME_STATE_VERSION = 1

/** File name inside the plugin state directory. */
export const RUNTIME_FILE_NAME = 'runtime.json'

/** Enroll POST timeout: the hub is a remote machine, so be patient but bounded. */
const ENROLL_TIMEOUT_MS = 10_000

/** Normalize an ISO-ish timestamp or null. */
const asIsoOrNull = (value) => {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

/**
 * Validate and normalize a hub server URL: absolute http(s), no trailing slash.
 * @param {unknown} raw - candidate from the config/route body.
 * @returns {string} canonical origin.
 */
export function normalizeServerUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new HttpError(400, 'bad-request', 'serverUrl is required')
  }
  let parsed
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new HttpError(400, 'bad-request', `serverUrl is not a valid URL: ${JSON.stringify(raw)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'bad-request', 'serverUrl must use http or https')
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

/**
 * Split the pasted one-address join form into its hub URL and fleet token
 * (v1.7.0).
 *
 * The token rides in the fragment (`https://relay/r/hub_x#join=dshf_…`), which
 * browsers and terminals never send to a server — that is the whole point, so
 * the credential cannot end up in a proxy/access log. This function is the only
 * place that reads it. A fragment that is not `join=…` is ignored: it has no
 * server meaning, and the address still works as a plain hub URL.
 * @param {unknown} raw - the pasted address (or any server URL).
 * @returns {{ serverUrl: string, joinToken: string }} fragment-free URL and the token ('' when absent).
 */
export function parseJoinAddress(raw) {
  if (typeof raw !== 'string') return { serverUrl: '', joinToken: '' }
  const hashAt = raw.indexOf('#')
  if (hashAt === -1) return { serverUrl: raw, joinToken: '' }
  const serverUrl = raw.slice(0, hashAt)
  const fragment = raw.slice(hashAt + 1)
  const prefix = 'join='
  if (!fragment.startsWith(prefix)) return { serverUrl, joinToken: '' }
  let token = fragment.slice(prefix.length)
  try {
    token = decodeURIComponent(token)
  } catch {
    // A malformed escape sequence is passed through verbatim; the hub decides.
  }
  return { serverUrl, joinToken: token.trim() }
}

/**
 * Coerce a parsed runtime.json into the documented shape, or null when it is
 * not a usable record. A corrupt file is set aside, never fatal.
 * @param {unknown} raw - parsed JSON.
 * @returns {object | null} normalized document.
 */
export function normalizeRuntimeState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.serverUrl !== 'string' || raw.serverUrl.trim() === '') return null
  if (typeof raw.computerId !== 'string' || raw.computerId.trim() === '') return null
  if (typeof raw.token !== 'string' || raw.token.trim() === '') return null
  return {
    version: RUNTIME_STATE_VERSION,
    serverUrl: raw.serverUrl.trim().replace(/\/+$/, ''),
    computerId: raw.computerId.trim(),
    token: raw.token.trim(),
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : null,
    enabled: raw.enabled === true,
    // v1.7.0: the fleet token from the pasted one-address form, kept so a later
    // re-enroll (e.g. after the hub's registry was reset) can join again. It is
    // never sent on the stream and never reported to the browser.
    joinToken: typeof raw.joinToken === 'string' && raw.joinToken !== '' ? raw.joinToken : null,
    enrolledAt: asIsoOrNull(raw.enrolledAt),
    lastConnectedAt: asIsoOrNull(raw.lastConnectedAt),
    lastError: typeof raw.lastError === 'string' && raw.lastError !== '' ? raw.lastError : null,
  }
}

/** Machine facts sent in the §3.1 enroll body. */
function machineInfo(version) {
  const osName = platform()
  return {
    hostname: hostname(),
    name: hostname(),
    os: osName,
    arch: arch(),
    platform: platformLabel(osName),
    cpuModel: cpus()[0]?.model ?? null,
    memoryBytes: totalmem(),
    nodeVersion: process.version,
    agentVersion: version,
  }
}

/** Map a hub enroll answer onto the §10.5 error vocabulary. */
function mapEnrollFailure(response) {
  const data = response.data !== null && typeof response.data === 'object' ? response.data : {}
  const hubError = typeof data.error === 'string' ? data.error : ''
  const message = typeof data.message === 'string' && data.message !== ''
    ? data.message
    : hubError !== ''
      ? hubError
      : `the hub answered ${response.status}`
  switch (hubError) {
    case 'invalid-key': return new HttpError(401, 'invalid-key', message)
    // v1.7.0: the one-address form's refusal; the browser shows the hub's text.
    case 'invalid-join': return new HttpError(401, 'invalid-join', message)
    case 'key-expired': return new HttpError(410, 'key-expired', message)
    case 'key-used': return new HttpError(409, 'key-used', message)
    case 'bad-request': return new HttpError(400, 'bad-request', message)
    default: break
  }
  switch (response.status) {
    case 401: return new HttpError(401, 'invalid-key', message)
    case 409: return new HttpError(409, 'key-used', message)
    case 410: return new HttpError(410, 'key-expired', message)
    case 400: return new HttpError(400, 'bad-request', message)
    default: return new HttpError(502, 'hub-unreachable', `the hub answered ${response.status}: ${message}`)
  }
}

/**
 * Create the runtime manager for one plugin mount.
 *
 * All methods are total for lifecycle paths (they never throw into the host);
 * only `configure()`/`enable()` throw `HttpError`s that the routes translate,
 * because those are direct answers to a user action.
 *
 * @param {object} options - manager options.
 * @param {object} options.config - resolved plugin config (heartbeatMs).
 * @param {string} options.stateDir - directory holding runtime.json.
 * @param {string} [options.version] - plugin version reported at enroll.
 * @param {URL} [options.agentModuleUrl] - agent bundle (default: ../agent/...).
 * @param {(message: string) => void} [options.onWarn] - host warning sink.
 * @returns {object} the manager.
 */
export function createRuntimeManager({ config, stateDir, version = '1.0.0', agentModuleUrl, onWarn = () => {} }) {
  const file = join(stateDir, RUNTIME_FILE_NAME)
  const moduleUrl = agentModuleUrl ?? new URL('../agent/dsh-computers-agent.mjs', import.meta.url)

  /** @type {object | null} */
  let doc = null
  /** @type {{ stop: () => Promise<void>, status?: () => object } | null} */
  let handle = null
  let connected = false
  let since = null
  let lastError = null
  let disposed = false
  let agentModulePromise = null
  let warnedLine = null

  /** Warn once per distinct line so a flapping runtime cannot spam the host. */
  const warnOnce = (message) => {
    if (message === warnedLine) return
    warnedLine = message
    try {
      onWarn(message)
    } catch {
      // A broken log sink must not break the runtime.
    }
  }

  const log = (level, message) => {
    // Embedded mode: agent info stays quiet; warnings/errors go to the host
    // sink, deduped until the next different line.
    if (level === 'warn' || level === 'error') warnOnce(`dsh-computers runtime: ${message}`)
  }

  /** Read runtime.json; corrupt files are set aside and treated as unconfigured. */
  const load = () => {
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      if (error && error.code !== 'ENOENT') warnOnce(`dsh-computers: cannot read ${file}: ${error.message}`)
      return null
    }
    try {
      return normalizeRuntimeState(JSON.parse(raw))
    } catch {
      const aside = `${file}.corrupt-${Date.now()}`
      try {
        renameSync(file, aside)
        warnOnce(`dsh-computers: ${file} was not valid JSON; moved to ${aside}`)
      } catch {
        warnOnce(`dsh-computers: ${file} was not valid JSON`)
      }
      return null
    }
  }

  /** Write runtime.json atomically (tmp + rename, 0600). */
  const persist = () => {
    if (doc === null) return
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const tmp = join(stateDir, `.runtime.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        chmodSync(tmp, 0o600)
      } catch {
        // Platforms without POSIX modes simply skip this.
      }
      renameSync(tmp, file)
    } catch (error) {
      warnOnce(`dsh-computers: cannot write ${file}: ${error && error.message ? error.message : error}`)
    }
  }

  /** Track one agent state transition; persistence only on real changes. */
  const applyAgentState = (state) => {
    if (state === null || typeof state !== 'object') return
    const nextConnected = state.connected === true
    const nextSince = asIsoOrNull(state.since)
    const nextError = typeof state.lastError === 'string' && state.lastError !== '' ? state.lastError : null
    const changed = nextConnected !== connected
    connected = nextConnected
    since = nextConnected ? (nextSince ?? since ?? new Date().toISOString()) : null
    if (nextError !== null) lastError = nextError
    else if (nextConnected) lastError = null
    if (changed && doc !== null) {
      if (connected) {
        doc.lastConnectedAt = since
        doc.lastError = null
        warnedLine = null
      } else if (lastError !== null) {
        doc.lastError = lastError
        warnOnce(`dsh-computers runtime: disconnected (${lastError})`)
      }
      persist()
    }
  }

  /** Import the agent bundle once; it must stay side-effect free when imported. */
  const loadAgentModule = async () => {
    if (agentModulePromise === null) {
      agentModulePromise = import(moduleUrl.href)
        .catch((error) => {
          agentModulePromise = null
          throw error
        })
    }
    return await agentModulePromise
  }

  /** Start the embedded runtime if the user enabled it. Never throws. */
  const start = async () => {
    if (disposed) return
    if (doc === null || doc.enabled !== true) return
    if (handle !== null) return
    let startRuntime
    try {
      const module = await loadAgentModule()
      startRuntime = module.startRuntime
    } catch (error) {
      lastError = `the embedded runtime module could not be loaded: ${error && error.message ? error.message : error}`
      warnOnce(`dsh-computers runtime: ${lastError}`)
      return
    }
    if (typeof startRuntime !== 'function') {
      // Older agent bundle (or a partial install): the enrollment still
      // succeeded, so keep the configuration and explain the missing piece.
      lastError = 'the embedded runtime is unavailable: the agent bundle does not export startRuntime'
      warnOnce(`dsh-computers runtime: ${lastError}`)
      if (doc !== null) {
        doc.lastError = lastError
        persist()
      }
      return
    }
    try {
      const live = startRuntime({
        serverUrl: doc.serverUrl,
        token: doc.token,
        computerId: doc.computerId,
        name: doc.name ?? undefined,
        heartbeatMs: config.heartbeatMs,
        // v1.3.2: only the plugin's embedded runtime may claim this mode; the
        // standalone CLI/service path reports 'service' on its own.
        mode: 'embedded',
        log,
        onState: applyAgentState,
      })
      if (live === null || typeof live !== 'object' || typeof live.stop !== 'function') {
        throw new Error('startRuntime() did not return { stop(), status() }')
      }
      handle = live
      // A synchronous initial status keeps `connected` honest even when the
      // agent only reports transitions later.
      try {
        applyAgentState(live.status?.() ?? { connected: false })
      } catch {
        // A status() that throws is the agent's bug; the loop still runs.
      }
    } catch (error) {
      handle = null
      lastError = `the embedded runtime could not start: ${error && error.message ? error.message : error}`
      warnOnce(`dsh-computers runtime: ${lastError}`)
    }
  }

  /** Stop the embedded runtime; keeps runtime.json and the user's switch. */
  const stop = async () => {
    const current = handle
    handle = null
    connected = false
    since = null
    if (current === null) return
    try {
      await current.stop()
    } catch (error) {
      warnOnce(`dsh-computers runtime: stop() failed: ${error && error.message ? error.message : error}`)
    }
  }

  /** Current §10.3 status object. */
  const status = () => {
    const live = (() => {
      try {
        return handle?.status?.() ?? null
      } catch {
        return null
      }
    })()
    const liveConnected = typeof live?.connected === 'boolean' ? live.connected : connected
    const liveSince = asIsoOrNull(live?.since) ?? (liveConnected ? since : null)
    const liveError = typeof live?.lastError === 'string' && live.lastError !== '' ? live.lastError : lastError
    // The client contract (§10.6, implemented by ui-dev) reads `serverUrl` as a
    // string even when unconfigured, so the three identity fields are always
    // strings and only the timestamps are nullable.
    return runtimeStatusPayload({
      configured: doc !== null,
      enabled: doc !== null && doc.enabled === true,
      connected: liveConnected === true,
      serverUrl: doc?.serverUrl ?? '',
      computerId: doc?.computerId ?? '',
      name: doc?.name ?? '',
      since: liveConnected === true ? liveSince : null,
      lastError: liveError ?? doc?.lastError ?? null,
    })
  }

  /**
   * §11.6 handshake metadata for the enrollment POST (v1.3.2): the hub must
   * store `mode: 'embedded'` BEFORE the first stream, otherwise the settings
   * page would show the one-line upgrade instructions for an embedded install.
   * The agent's own export supplies its version when available; capabilities
   * are the embedded runtime's fixed set (exec + fs).
   */
  const embeddedMetadata = async () => {
    let agentVersion = version
    let capabilities = ['exec', 'fs']
    try {
      const module = await loadAgentModule()
      if (typeof module.AGENT_VERSION === 'string' && module.AGENT_VERSION.trim() !== '') {
        agentVersion = module.AGENT_VERSION.trim()
      }
      if (Array.isArray(module.AGENT_CAPABILITIES) && module.AGENT_CAPABILITIES.length > 0) {
        capabilities = module.AGENT_CAPABILITIES.filter((entry) => typeof entry === 'string')
      }
    } catch {
      // A bundle without the export still reports the plugin version + embedded caps.
    }
    return connectMetadata({
      version: 1,
      agentVersion,
      mode: 'embedded',
      hostname: hostname(),
      os: platform(),
      arch: arch(),
      capabilities,
      workspaceBase: homedir(),
    })
  }

  doc = load()
  if (doc !== null) {
    lastError = doc.lastError ?? null
    // A persisted `lastError` describes the previous process; it is diagnostic
    // only and must not look like a live failure before we try again.
    if (doc.enabled === true) lastError = null
  }

  return {
    /** Absolute runtime.json path (diagnostics + smoke assertions). */
    file,
    /**
     * Enroll this machine with `serverUrl` using a hub-minted key, persist the
     * result enabled, and start the runtime (PROTOCOL §10.3).
     *
     * v1.7.0: `serverUrl` may be the ONE pasted join address
     * (`…#join=dshf_…`), in which case the fragment is stripped before anything
     * is stored or dialled and the enroll body carries `{ join }` instead of a
     * one-time key. A `key` still wins when both are supplied.
     * @param {{ serverUrl: string, key?: string }} input - hub address (optionally with `#join=`) and key.
     * @returns {Promise<object>} the new status.
     */
    async configure({ serverUrl, key }) {
      const address = parseJoinAddress(serverUrl)
      const hubUrl = normalizeServerUrl(address.serverUrl)
      const enrollmentKey = typeof key === 'string' ? key.trim() : ''
      const joinToken = enrollmentKey === '' ? address.joinToken : ''
      if (enrollmentKey === '' && joinToken === '') {
        throw new HttpError(400, 'bad-request', 'a join address (…#join=dshf_…) or an enrollment key is required')
      }
      // Release the previous runtime first: its token is about to be replaced.
      await stop()
      const metadata = await embeddedMetadata()
      const enrollBody = enrollRequest({
        // A present key still wins: it is the single-use credential the user
        // minted on purpose, so the join fragment is ignored.
        key: enrollmentKey === '' ? undefined : enrollmentKey,
        agentVersion: metadata.agentVersion,
        capabilities: metadata.capabilities,
        metadata,
        machine: machineInfo(version),
      })
      if (enrollmentKey === '') enrollBody.join = joinToken
      const response = await postJson(`${hubUrl}/api/dsh-computers/agent/enroll`, enrollBody, { timeoutMs: ENROLL_TIMEOUT_MS })
      if (response.status !== 200) throw mapEnrollFailure(response)
      const data = response.data !== null && typeof response.data === 'object' ? response.data : {}
      const computerId = typeof data.computerId === 'string' ? data.computerId.trim() : ''
      const token = typeof data.token === 'string' ? data.token.trim() : ''
      if (computerId === '' || token === '') {
        throw new HttpError(502, 'hub-unreachable', 'the hub returned an unexpected enrollment response')
      }
      const enrolledName = typeof data.name === 'string' && data.name.trim() !== ''
        ? data.name.trim()
        : (machineInfo(version).hostname ?? 'this machine')
      // Keep the fleet token for a later re-enroll; the previous one survives a
      // key-based reconfigure so switching back to the address form still works.
      const previousJoinToken = doc !== null && typeof doc.joinToken === 'string' ? doc.joinToken : null
      doc = {
        version: RUNTIME_STATE_VERSION,
        // Prefer the server URL the hub reported (it knows how clients reach it).
        // Never a fragment: the hub address is stored clean.
        serverUrl: typeof data.serverUrl === 'string' && data.serverUrl.trim() !== ''
          ? data.serverUrl.trim().replace(/#.*$/, '').replace(/\/+$/, '')
          : hubUrl,
        computerId,
        token,
        name: enrolledName,
        enabled: true,
        joinToken: joinToken !== '' ? joinToken : previousJoinToken,
        enrolledAt: new Date().toISOString(),
        lastConnectedAt: null,
        lastError: null,
      }
      connected = false
      since = null
      lastError = null
      warnedLine = null
      persist()
      await start()
      return status()
    },
    /** Start the embedded runtime when configured and enabled (never throws). */
    async start() {
      await start()
      return status()
    },
    /** Stop the runtime but keep the configuration and the switch (never throws). */
    async stop() {
      await stop()
      return status()
    },
    /** Persist and apply the user's `启用` switch (PROTOCOL §10.3). */
    async enable(enabled) {
      if (typeof enabled !== 'boolean') throw new HttpError(400, 'bad-request', 'enabled must be a boolean')
      if (doc === null) {
        if (enabled === true) throw new HttpError(400, 'bad-request', 'connect this computer to a hub first')
        return status()
      }
      doc.enabled = enabled
      if (enabled) doc.lastError = null
      persist()
      if (enabled) await start()
      else await stop()
      return status()
    },
    /** Stop and forget the configuration (deletes runtime.json). */
    async disconnect() {
      await stop()
      if (doc !== null) {
        try {
          unlinkSync(file)
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            warnOnce(`dsh-computers: cannot remove ${file}: ${error && error.message ? error.message : error}`)
          }
        }
      }
      doc = null
      connected = false
      since = null
      lastError = null
      warnedLine = null
      return status()
    },
    /** Protocol status object (§10.3). */
    status,
    /** Start automatically when the persisted switch says enabled. */
    async autoStart() {
      if (doc === null || doc.enabled !== true) return status()
      try {
        await start()
      } catch (error) {
        // start() is total, but a future refactor must not crash the host load.
        warnOnce(`dsh-computers runtime: auto-start failed: ${error && error.message ? error.message : error}`)
      }
      return status()
    },
    /** Plugin unload: stop the loop, keep runtime.json for the next load. */
    async dispose() {
      disposed = true
      await stop()
    },
    /** What the agent currently reports (diagnostics). */
    get connected() {
      return connected
    },
  }
}
