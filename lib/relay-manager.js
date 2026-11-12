/**
 * Owned relay link (v1.6.0).
 *
 * A hub behind NAT/loopback cannot be reached by another machine. The relay
 * inverts that: the hub dials OUT to a relay, and clients reach it at
 * `<relay>/r/<hubId>/…`. Nothing here listens for inbound connections.
 *
 * Behaviour (docs/relay-design.md §5, §6.2, §10):
 * - config carries deployment facts (`relay.url`, `relay.accessKey`,
 *   `relay.publicUrl`); both the on/off decision AND the relay address are
 *   runtime overrides persisted by the caller (`relay.json`, v1.6.1/v1.7.1) so
 *   the settings page can set up the relay without editing `cordis.patch.yml`
 *   and without a plugin reload. A deployment with an EMPTY config works: the
 *   UI supplies the address, the manager mints the hubId;
 * - each effective value is the override when one exists, else the config value
 *   (the pre-v1.6.1 behaviour: default disabled, so an existing deployment is
 *   untouched until someone flips the switch);
 * - after the web server binds, dial `wss://<relay>/ws?hub=<hubId>&role=hub`
 *   with the shared backoff, and bridge every inbound stream to this plugin's
 *   own listener only (`127.0.0.1:<port>`), so the tunnel can never be turned
 *   into a general SSRF proxy;
 * - changing the address while connected disposes the link and dials the new
 *   one with the SAME hubId (the identity survives an address change);
 * - expose `{ enabled, enabledSource, urlSource, canEnable, configured, hubId,
 *   url, publicUrl, state, connectedAt, lastError, streams }` for `/state.relay`,
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
 * route (400 body): enabling is impossible without a relay address. Both the
 * settings page and the plugin config can supply one, so the message names the
 * UI first — the normal path is "no config at all".
 */
export const RELAY_URL_REQUIRED_MESSAGE = "no relay address is configured: open 设置 → 电脑 → 高级 → 中继 and enter one (for example wss://relay.example.com), then enable it"

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
 * @param {object} options.config - resolved `relay` config (`enabled`/`url` are the defaults).
 * @param {boolean | null} [options.enabledOverride] - persisted UI switch; null = follow the config default.
 * @param {string | null} [options.urlOverride] - persisted UI relay address; null/'' = follow `config.url`.
 * @param {(hubId: string) => void} [options.onHubId] - called when an id was minted, so the caller persists it.
 * @param {(enabled: boolean, hubId: string) => boolean | void} [options.onEnabled] - persists the UI switch; return `false` on failure.
 * @param {(url: string, hubId: string) => boolean | void} [options.onUrl] - persists the address override ('' clears it); return `false` on failure.
 * @param {(level: string, message: string) => void} [options.log] - logger.
 * @returns {object} manager with `start()`, `setEnabled()`, `setUrl()`, `dispose()`, `status()`.
 */
export function createRelay({
  ctx, config, enabledOverride = null, urlOverride: urlOverrideRaw = null,
  onHubId = () => {}, onEnabled = () => true, onUrl = () => true, log = () => {},
}) {
  const configEnabled = config?.enabled === true
  /** Persisted switch decision; null means "follow the config default". */
  let override = enabledOverride === true || enabledOverride === false ? enabledOverride : null
  const normalized = normalizeRelayUrl(config?.url)
  const accessKey = typeof config?.accessKey === 'string' ? config.accessKey : ''
  let hubId = typeof config?.hubId === 'string' && HUB_ID_PATTERN.test(config.hubId) ? config.hubId : ''

  /** One log line that can never throw into the host. */
  const logLine = (level, message) => {
    try {
      log(level, message)
    } catch {
      // A broken logger must not break the plugin.
    }
  }

  /**
   * Persisted address override (v1.7.1); null means "follow `config.url`".
   * A value written by the settings page always passed `normalizeRelayUrl`, so
   * an invalid one can only come from a hand-edited document: ignore it (with
   * a warning) rather than let a corrupt field wedge the plugin.
   */
  let urlOverride = null
  if (typeof urlOverrideRaw === 'string' && urlOverrideRaw.trim() !== '') {
    const candidate = normalizeRelayUrl(urlOverrideRaw)
    if (candidate.error === null) urlOverride = candidate.url
    else logLine('warn', `relay url override ignored: ${candidate.error}`)
  }

  /** The effective switch: the UI override wins, the config default otherwise. */
  const effective = () => (override === null ? configEnabled : override)

  /** The effective relay address: the UI override wins, `config.url` otherwise. */
  const effectiveUrl = () => (urlOverride === null ? normalized.url : urlOverride)

  /** The config url's validation error, but only while it is the effective value. */
  const effectiveUrlError = () => (urlOverride === null ? normalized.error : null)

  if (effective() && hubId === '') {
    hubId = mintHubId()
    onHubId(hubId)
  }

  const state = {
    enabled: effective(),
    configured: false,
    state: effective() ? 'idle' : 'disabled',
    connectedAt: null,
    lastError: effectiveUrlError(),
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

  /**
   * Persist the address override (v1.7.1); the in-memory override is the live
   * intent. `null` clears it (the caller passes `''` to the persistence hook).
   * Unlike the switch this is allowed before a hubId exists: the settings page
   * can set the relay address first and enable afterwards.
   */
  const persistUrl = (next) => {
    urlOverride = next
    let ok = true
    try {
      ok = onUrl(next === null ? '' : next, hubId) !== false
    } catch (error) {
      ok = false
      logLine('warn', `relay address could not be persisted: ${error && error.message ? error.message : error}`)
    }
    if (!ok) {
      state.lastError = 'the relay address could not be persisted; check that the state directory is writable'
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
    const relayUrl = effectiveUrl()
    if (relayUrl === '') {
      // Only reachable from a stale call: start()/setEnabled()/setUrl() guard it.
      state.lastError = RELAY_URL_REQUIRED_MESSAGE
      state.state = 'failed'
      return
    }
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
        relayUrl,
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
      logLine('info', `relay enabled: ${relayUrl} (hub ${hubId})`)
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
    // Where the effective address came from (v1.7.1): the settings page can
    // set it without touching the config.
    urlSource: urlOverride === null ? 'config' : 'ui',
    canEnable: effectiveUrl() !== '',
    configured: state.configured,
    hubId,
    url: effectiveUrl(),
    publicUrl: deriveRelayPublicUrl(config?.publicUrl, effectiveUrl(), hubId),
    state: state.state,
    connectedAt: state.connectedAt,
    lastError: state.lastError,
    streams: state.streams,
  })

  return {
    /** Start waiting for the bind, then dial — only when the effective switch is on. */
    start() {
      if (stopped || !state.enabled) return
      if (effectiveUrl() === '') {
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
        if (effectiveUrl() === '') {
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
    /**
     * Set or clear the relay address live (v1.7.1). The settings page owns the
     * address now, so this must work with an EMPTY config: `''` clears the
     * override and falls back to `config.relay.url`.
     *
     * When the relay is (or stays) enabled the live link is disposed and a
     * fresh one dialled against the new address — with the SAME hubId, because
     * the address others bookmarked is the identity, not the relay host.
     * @param {string} value - raw relay address (normalised here), or '' to clear.
     * @returns {object} the fresh `/state.relay` snapshot.
     * @throws {TypeError} when the value is not a normalisable relay address.
     */
    setUrl(value) {
      if (typeof value !== 'string') throw new TypeError('relay.setUrl expects a string')
      const candidate = normalizeRelayUrl(value)
      if (candidate.error !== null) {
        const error = new TypeError(candidate.error)
        error.code = 'invalid-url'
        throw error
      }
      const next = candidate.url === '' ? null : candidate.url
      if (stopped) {
        // Shutting down: record the intent, never dial.
        urlOverride = next
        return snapshot()
      }
      // Only a real change re-dials: posting the current address again (a
      // double click, a poll-driven save) must not disturb the live link.
      const changed = next !== urlOverride
      persistUrl(next)
      state.lastError = effectiveUrlError()
      if (state.enabled && changed) {
        // Re-dial: dispose the old link first, then dial the effective address.
        teardownLink()
        state.configured = false
        state.connectedAt = null
        state.streams = 0
        if (effectiveUrl() === '') {
          state.state = 'failed'
          state.lastError = RELAY_URL_REQUIRED_MESSAGE
          logLine('warn', state.lastError)
        } else {
          state.state = 'idle'
          begin()
        }
      }
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
