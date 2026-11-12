/**
 * Owned relay link (v1.6.0).
 *
 * A hub behind NAT/loopback cannot be reached by another machine. The relay
 * inverts that: the hub dials OUT to a relay, and clients reach it at
 * `<relay>/r/<hubId>/…`. Nothing here listens for inbound connections.
 *
 * Behaviour (docs/relay-design.md §5, §6.2, §10):
 * - deployment facts live in config (`relay.url`, `relay.accessKey`,
 *   `relay.publicUrl`); the on/off decision is a runtime override persisted by
 *   the caller (`relay.json`, v1.6.1) so the settings page can toggle the relay
 *   without editing `cordis.patch.yml` and without a plugin reload;
 * - the effective value is the override when one exists, else `config.enabled`
 *   (the pre-v1.6.1 behaviour: default disabled, so an existing deployment is
 *   untouched until someone flips the switch);
 * - after the web server binds, dial `wss://<relay>/ws?hub=<hubId>&role=hub`
 *   with the shared backoff, and bridge every inbound stream to this plugin's
 *   own listener only (`127.0.0.1:<port>`), so the tunnel can never be turned
 *   into a general SSRF proxy;
 * - expose `{ enabled, enabledSource, canEnable, configured, hubId, url,
 *   publicUrl, state, connectedAt, lastError, streams }` for `/state.relay`,
 *   `GET /relay` and the switch route;
 * - never throw into the host, and release every socket on dispose so a plugin
 *   reload cannot leak a link.
 *
 * Node builtins only.
 */

import { randomBytes } from 'node:crypto'

import { createBridge } from './relay/bridge.js'
import { createHubLink } from './relay/hub-link.js'

/** How long to wait for the web server to bind before giving up (ms). */
const PORT_POLL_MS = 50

/** Total budget for activation: bind wait + first dial (ms). */
const TOTAL_TIMEOUT_MS = 15_000

/** `hub_` + 20 base32-ish characters: enough entropy, URL-safe, greppable. */
const HUB_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/**
 * The actionable message shared by the manager (`lastError`) and the switch
 * route (400 body): enabling is impossible without a relay address, and the
 * operator has to add one to the plugin config.
 */
export const RELAY_URL_REQUIRED_MESSAGE = "relay.url is not configured: set relay.url (for example wss://dsh-relay.nextai.show) in the dsh-computers plugin config, then enable the relay again"

/**
 * Mint a hub id. Generated once and persisted by the caller, because it is the
 * address other machines (and the browser bookmark) keep using.
 * @returns {string} `hub_…` identifier.
 */
export function mintHubId() {
  return `hub_${randomBytes(16).toString('hex')}`
}

/**
 * Normalise a relay URL: accept `https://`/`http://` and convert to `wss://`/
 * `ws://`, strip a trailing slash.
 * @param {unknown} value - configured value.
 * @returns {{ url: string, error: string|null }} normalised url or an error.
 */
export function normalizeRelayUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return { url: '', error: null }
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    return { url: '', error: 'url must be an absolute ws(s):// or http(s):// address' }
  }
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:'
  else if (parsed.protocol === 'http:') parsed.protocol = 'ws:'
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return { url: '', error: `url must be ws:// or wss://, got ${parsed.protocol}` }
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return { url: '', error: 'url must not carry a path; put the relay root in the address' }
  }
  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''
  return { url: parsed.toString().replace(/\/$/, ''), error: null }
}

/**
 * The public base URL clients should use for this hub through the relay.
 * @param {string} publicUrl - configured value (may be empty).
 * @param {string} relayUrl - normalised relay url.
 * @param {string} hubId - hub identifier.
 * @returns {string} `https://<relay>/r/<hubId>` or the configured override.
 */
export function deriveRelayPublicUrl(publicUrl, relayUrl, hubId) {
  if (typeof publicUrl === 'string' && publicUrl.trim() !== '') return publicUrl.trim().replace(/\/$/, '')
  if (relayUrl === '' || hubId === '') return ''
  try {
    const parsed = new URL(relayUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    return `${parsed.toString().replace(/\/$/, '')}/r/${hubId}`
  } catch {
    return ''
  }
}

/**
 * Create the relay manager.
 * @param {object} options - manager options.
 * @param {object} options.ctx - Cordis context (only `webServer` is read).
 * @param {object} options.config - resolved `relay` config (`enabled` is the default).
 * @param {boolean | null} [options.enabledOverride] - persisted UI switch; null = follow the config default.
 * @param {(hubId: string) => void} [options.onHubId] - called when an id was minted, so the caller persists it.
 * @param {(enabled: boolean, hubId: string) => boolean | void} [options.onEnabled] - persists the UI switch; return `false` on failure.
 * @param {(level: string, message: string) => void} [options.log] - logger.
 * @returns {object} manager with `start()`, `setEnabled()`, `dispose()`, `status()`.
 */
export function createRelay({
  ctx, config, enabledOverride = null, onHubId = () => {}, onEnabled = () => true, log = () => {},
}) {
  const configEnabled = config?.enabled === true
  /** Persisted switch decision; null means "follow the config default". */
  let override = enabledOverride === true || enabledOverride === false ? enabledOverride : null
  const normalized = normalizeRelayUrl(config?.url)
  const accessKey = typeof config?.accessKey === 'string' ? config.accessKey : ''
  let hubId = typeof config?.hubId === 'string' && HUB_ID_PATTERN.test(config.hubId) ? config.hubId : ''

  /** The effective switch: the UI override wins, the config default otherwise. */
  const effective = () => (override === null ? configEnabled : override)

  if (effective() && hubId === '') {
    hubId = mintHubId()
    onHubId(hubId)
  }

  const state = {
    enabled: effective(),
    configured: false,
    state: effective() ? 'idle' : 'disabled',
    connectedAt: null,
    lastError: normalized.error,
    streams: 0,
  }

  let link = null
  let bridge = null
  let stopped = false
  let bindTimer = null
  let pollTimer = null

  /**
   * Test seam (host-smoke): `ctx.relayDeps.createHubLink` replaces the dialer so
   * the link state machine is assertable without a relay process. The read is
   * guarded because Cordis throws on context properties the plugin did not
   * `inject`, and the smoke fake context reproduces that with a strict Proxy.
   */
  let linkFactory = createHubLink
  try {
    const deps = ctx === null || typeof ctx !== 'object' ? undefined : ctx.relayDeps
    if (deps !== null && typeof deps === 'object' && typeof deps.createHubLink === 'function') {
      linkFactory = deps.createHubLink
    }
  } catch {
    linkFactory = createHubLink
  }

  /** One log line that can never throw into the host. */
  const logLine = (level, message) => {
    try {
      log(level, message)
    } catch {
      // A broken logger must not break the plugin.
    }
  }

  /** Read the port this plugin's web server actually bound. */
  const boundPort = () => {
    try {
      const port = ctx?.webServer?.port
      return Number.isSafeInteger(port) && port > 0 ? port : null
    } catch {
      return null
    }
  }

  const clearBindTimer = () => {
    if (bindTimer !== null) clearInterval(bindTimer)
    bindTimer = null
  }

  const clearPollTimer = () => {
    if (pollTimer !== null) clearInterval(pollTimer)
    pollTimer = null
  }

  /** Persist the switch decision; the in-memory override is the live intent. */
  const persistOverride = (enabled) => {
    // Nothing to pin until an address exists; enabling mints one first.
    if (hubId === '') return
    override = enabled
    let ok = true
    try {
      ok = onEnabled(enabled, hubId) !== false
    } catch (error) {
      ok = false
      logLine('warn', `relay switch could not be persisted: ${error && error.message ? error.message : error}`)
    }
    if (!ok) {
      state.lastError = 'the relay switch could not be persisted; check that the state directory is writable'
      logLine('warn', state.lastError)
    }
  }

  /** Release the live link (and the timers that observe it) without touching the override. */
  const teardownLink = () => {
    clearBindTimer()
    clearPollTimer()
    try {
      if (link !== null) link.stop()
    } catch {
      // Already gone.
    }
    link = null
    bridge = null
  }

  /** Attach the bridge once the port exists, then dial the relay. */
  const activate = () => {
    if (stopped || link !== null) return
    const port = boundPort()
    if (port === null) return
    clearBindTimer()
    let host = '127.0.0.1'
    try {
      const configuredHost = ctx?.webServer?.host
      if (typeof configuredHost === 'string' && configuredHost !== '') host = configuredHost
    } catch {
      host = '127.0.0.1'
    }
    try {
      bridge = createBridge({
        port,
        host,
        // hub-link/bridge call `log(level, message)` (the S1 contract).
        log: (level, message) => logLine(level, `relay bridge: ${message}`),
      })
      link = linkFactory({
        relayUrl: normalized.url,
        hubId,
        token: accessKey,
        log: (level, message) => logLine(level, `relay link: ${message}`),
      })
      link.onStream((stream) => {
        try {
          bridge.handle(stream)
        } catch (error) {
          logLine('warn', `relay bridge rejected a stream: ${error && error.message ? error.message : error}`)
        }
      })
      link.start()
      state.configured = true
      state.state = 'connecting'
      logLine('info', `relay enabled: ${normalized.url} (hub ${hubId})`)
      // Poll the link state into the snapshot the routes serve.
      clearPollTimer()
      pollTimer = setInterval(() => {
        if (stopped || link === null) return
        try {
          const snapshot = link.status()
          state.state = snapshot.state
          state.connectedAt = snapshot.connectedAt
          state.lastError = snapshot.lastError
          state.streams = snapshot.streams?.open ?? 0
        } catch {
          // Status reads must never break the timer.
        }
      }, 1_000)
      if (typeof pollTimer.unref === 'function') pollTimer.unref()
    } catch (error) {
      state.lastError = error && error.message ? error.message : String(error)
      state.state = 'failed'
      logLine('warn', `relay could not start: ${state.lastError}`)
    }
  }

  /** Dial now when the server is bound, else wait for the bind (bounded). */
  const begin = () => {
    if (stopped || link !== null || bindTimer !== null) return
    if (boundPort() !== null) {
      activate()
      return
    }
    const startedAt = Date.now()
    bindTimer = setInterval(() => {
      if (stopped) {
        clearBindTimer()
        return
      }
      if (boundPort() !== null) {
        clearBindTimer()
        activate()
        return
      }
      if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) {
        clearBindTimer()
        state.lastError = 'the web server did not bind in time'
        state.state = 'failed'
        logLine('warn', `relay could not start: ${state.lastError}`)
      }
    }, PORT_POLL_MS)
    if (typeof bindTimer.unref === 'function') bindTimer.unref()
  }

  /** Snapshot for /state.relay, GET /relay and the switch route. */
  const snapshot = () => ({
    enabled: state.enabled,
    enabledSource: override === null ? 'config' : 'ui',
    canEnable: normalized.url !== '',
    configured: state.configured,
    hubId,
    url: normalized.url,
    publicUrl: deriveRelayPublicUrl(config?.publicUrl, normalized.url, hubId),
    state: state.state,
    connectedAt: state.connectedAt,
    lastError: state.lastError,
    streams: state.streams,
  })

  return {
    /** Start waiting for the bind, then dial — only when the effective switch is on. */
    start() {
      if (stopped || !state.enabled) return
      if (normalized.url === '') {
        state.lastError = RELAY_URL_REQUIRED_MESSAGE
        state.state = 'failed'
        logLine('warn', state.lastError)
        return
      }
      begin()
    },
    /**
     * Flip the switch live (v1.6.1): persist the override, then dial or dispose
     * immediately. No plugin reload, and the address identity survives.
     * @param {boolean} enabled - the desired state.
     * @returns {object} the fresh `/state.relay` snapshot.
     */
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new TypeError('relay.setEnabled expects a boolean')
      if (stopped) {
        // Shutting down: record the intent, never dial.
        override = enabled
        state.enabled = enabled
        state.state = 'disabled'
        return snapshot()
      }
      if (enabled) {
        // The address is minted on first enable and then reused forever.
        if (hubId === '') {
          hubId = mintHubId()
          onHubId(hubId)
        }
        state.enabled = true
        state.lastError = null
        persistOverride(true)
        if (normalized.url === '') {
          state.lastError = RELAY_URL_REQUIRED_MESSAGE
          state.state = 'failed'
          logLine('warn', state.lastError)
          return snapshot()
        }
        begin()
        return snapshot()
      }
      // Off: dispose the link, return to the documented disabled snapshot.
      teardownLink()
      state.enabled = false
      state.configured = false
      state.state = 'disabled'
      state.connectedAt = null
      state.streams = 0
      state.lastError = null
      persistOverride(false)
      return snapshot()
    },
    /** Snapshot for /state.relay, GET /relay and the switch route. */
    status() {
      return snapshot()
    },
    /** Release every socket (a plugin reload starts a fresh manager). */
    dispose() {
      stopped = true
      teardownLink()
    },
  }
}
