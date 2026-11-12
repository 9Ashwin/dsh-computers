/**
 * dsh-computers — connect the user's own Macs (and other machines) to a
 * DSH Web deployment so the agent can run shell commands on them.
 *
 * This is the Host half: a persisted registry, the SSE hub the machine agents
 * connect to, the browser settings API, and the two model-facing tools. The
 * wire contract lives in PROTOCOL.md; the machine agent is served from
 * `agent/dsh-computers-agent.mjs` and the settings page from `client.js`.
 *
 * Plain ESM, Node builtins only — no `@deepseek-ai/*` imports, so the bundle
 * loads in any profile.
 */

import { createAccessControl, createAccessStore } from './lib/access.js'
import { createHub } from './lib/hub.js'
import { createRoutes, createRuntimeRoutes, createRuntimeStatusRoutes } from './lib/routes.js'
import { createRuntimeManager } from './lib/runtime.js'
import { createFsOps } from './lib/fs-ops.js'
import { PREFER_ADDRESS_VALUES } from './lib/addresses.js'
import { createTunnel } from './lib/tunnel.js'
import { createRelay, normalizeRelayUrl } from './lib/relay-manager.js'
import { HUB_ID_PATTERN, isHubId, readRelayIdentity, writeRelayIdentity } from './lib/relay-identity.js'
import { createFleetIdentity } from './lib/fleet-identity.js'
import { createAccountManager, machineNameOf, preferNonLoopback } from './lib/account.js'
import { resolveBaseUrl } from './lib/http.js'
import { createComputerSkills } from './lib/skills.js'
import { createSelectionStore } from './lib/selection.js'
import { majorMinor } from './lib/version.js'
import { resolveStateDir, createStore } from './lib/state.js'
import { createTools } from './lib/tools.js'

/** Cordis plugin name. */
export const name = 'dsh-computers'

/** Required host capabilities; `systemPrompt` and `connection` are optional. */
export const inject = ['tools', 'webServer']

/** Version reported by `/api/dsh-computers/health` (and asserted by the smoke harness). */
export const PLUGIN_VERSION = '1.9.0'

/** The machine agent bundle, served at request time (never imported). */
const AGENT_URL = new URL('./agent/dsh-computers-agent.mjs', import.meta.url)

/**
 * `role` is an ADVANCED escape hatch, not part of the normal setup: the plugin
 * mounts everything (`both`) with an empty config, and the settings page owns
 * the relay/runtime setup. The key stays accepted so an operator who wants a
 * pure controller (`hub`) or a pure controlled machine (`runtime`) can say so.
 */
const ROLES = Object.freeze(['hub', 'runtime', 'both'])

const DEFAULTS = Object.freeze({
  role: 'both',
  publicUrl: '',
  promoteOnTimeout: true,
  minAgentVersion: '',
  stateDir: '',
  keyTtlMinutes: 15,
  heartbeatMs: 20_000,
  execTimeoutMs: 120_000,
  execEnabled: true,
  preferAddress: 'auto',
  tailscaleServe: Object.freeze({ enabled: false, httpsPort: 8443 }),
  relay: Object.freeze({ enabled: false, url: '', publicUrl: '', accessKey: '', hubId: '', name: '' }),
  maxOutputBytes: 1_048_576,
})

/** Bounds that keep a hand-edited config from producing an unusable host. */
const LIMITS = Object.freeze({
  keyTtlMinutes: [1, 10_080], // 1 minute .. 7 days
  heartbeatMs: [100, 3_600_000], // 100 ms .. 1 hour
  execTimeoutMs: [100, 86_400_000], // 100 ms .. 24 hours
  maxOutputBytes: [64, 64 * 1024 * 1024], // 64 B .. 64 MiB
})

/** Throw a clear TypeError instead of letting a bad value surface as a 500 later. */
function configError(message) {
  return new TypeError(`dsh-computers: ${message}`)
}

/** Validate one bounded integer option. */
function boundedInteger(raw, key, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = typeof raw === 'number' ? raw : Number(raw)
  const [min, max] = LIMITS[key]
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw configError(`${key} must be an integer between ${min} and ${max} (received ${JSON.stringify(raw)})`)
  }
  return value
}

/**
 * Validate the plugin config by hand (schemastery is available only to some
 * host compositions, so this file must not depend on it).
 * @param {unknown} raw - config passed by cordis.patch.yml.
 * @returns {object} resolved config with defaults applied.
 */
export function resolveConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw configError('config must be an object')

  let publicUrl = DEFAULTS.publicUrl
  if (raw.publicUrl !== undefined && raw.publicUrl !== null && raw.publicUrl !== '') {
    if (typeof raw.publicUrl !== 'string') throw configError('publicUrl must be a string')
    const trimmed = raw.publicUrl.trim().replace(/\/+$/, '')
    let parsed
    try {
      parsed = new URL(trimmed)
    } catch {
      throw configError(`publicUrl must be an absolute http(s) URL (received ${JSON.stringify(raw.publicUrl)})`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw configError('publicUrl must use http or https')
    }
    publicUrl = trimmed
  }

  let stateDir = DEFAULTS.stateDir
  if (raw.stateDir !== undefined && raw.stateDir !== null && raw.stateDir !== '') {
    if (typeof raw.stateDir !== 'string') throw configError('stateDir must be a string')
    stateDir = raw.stateDir.trim()
  }

  let role = DEFAULTS.role
  if (raw.role !== undefined && raw.role !== null) {
    if (typeof raw.role !== 'string' || !ROLES.includes(raw.role)) {
      throw configError(`role must be one of ${ROLES.join(', ')} (received ${JSON.stringify(raw.role)})`)
    }
    role = raw.role
  }

  let promoteOnTimeout = DEFAULTS.promoteOnTimeout
  if (raw.promoteOnTimeout !== undefined && raw.promoteOnTimeout !== null) {
    if (typeof raw.promoteOnTimeout !== 'boolean') throw configError('promoteOnTimeout must be a boolean')
    promoteOnTimeout = raw.promoteOnTimeout
  }

  let minAgentVersion = DEFAULTS.minAgentVersion
  if (raw.minAgentVersion !== undefined && raw.minAgentVersion !== null && raw.minAgentVersion !== '') {
    if (typeof raw.minAgentVersion !== 'string') throw configError('minAgentVersion must be a string')
    const trimmed = raw.minAgentVersion.trim()
    if (!/^v?\d+(\.\d+){0,2}$/.test(trimmed)) {
      throw configError(`minAgentVersion must look like 1.2 or 1.2.3 (received ${JSON.stringify(raw.minAgentVersion)})`)
    }
    minAgentVersion = trimmed
  }
  // '' means "no version gate": an older agent keeps working for everything it
  // advertises (capability gating covers fs/pty). Operators opt in with an
  // explicit minAgentVersion when they want to force upgrades.

  let preferAddress = DEFAULTS.preferAddress
  if (raw.preferAddress !== undefined && raw.preferAddress !== null && raw.preferAddress !== '') {
    if (typeof raw.preferAddress !== 'string' || !PREFER_ADDRESS_VALUES.includes(raw.preferAddress.trim())) {
      throw configError(`preferAddress must be one of ${PREFER_ADDRESS_VALUES.join(', ')} (received ${JSON.stringify(raw.preferAddress)})`)
    }
    preferAddress = raw.preferAddress.trim()
  }

  let tailscaleServe = {
    enabled: DEFAULTS.tailscaleServe.enabled,
    httpsPort: DEFAULTS.tailscaleServe.httpsPort,
  }
  if (raw.tailscaleServe !== undefined && raw.tailscaleServe !== null) {
    const value = raw.tailscaleServe
    if (typeof value === 'boolean') {
      tailscaleServe = { enabled: value, httpsPort: DEFAULTS.tailscaleServe.httpsPort }
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      if (value.enabled !== undefined && value.enabled !== null) {
        if (typeof value.enabled !== 'boolean') throw configError('tailscaleServe.enabled must be a boolean')
        tailscaleServe.enabled = value.enabled
      }
      if (value.httpsPort !== undefined && value.httpsPort !== null) {
        if (!Number.isSafeInteger(value.httpsPort) || value.httpsPort < 1 || value.httpsPort > 65535) {
          throw configError('tailscaleServe.httpsPort must be an integer between 1 and 65535')
        }
        tailscaleServe.httpsPort = value.httpsPort
      }
    } else {
      throw configError('tailscaleServe must be an object ({ enabled, httpsPort }) or a boolean')
    }
  }

  let execEnabled = DEFAULTS.execEnabled
  if (raw.execEnabled !== undefined && raw.execEnabled !== null) {
    if (typeof raw.execEnabled !== 'boolean') throw configError('execEnabled must be a boolean')
    execEnabled = raw.execEnabled
  }

  // ---- relay (v1.6.0, docs/relay-design.md §5, §10) ----------------------
  // Opt-in only: a deployment that never sets `relay.enabled` behaves exactly
  // as before. `url` is required when enabled — there is deliberately no
  // default relay host, the operator names the service (e.g.
  // `wss://relay.example.com`). `hubId` is usually minted and persisted by the
  // manager; setting it here pins the address explicitly.
  const relay = { ...DEFAULTS.relay }
  if (raw.relay !== undefined && raw.relay !== null) {
    const value = raw.relay
    if (typeof value === 'boolean') {
      relay.enabled = value
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      if (value.enabled !== undefined && value.enabled !== null) {
        if (typeof value.enabled !== 'boolean') throw configError('relay.enabled must be a boolean')
        relay.enabled = value.enabled
      }
      if (value.url !== undefined && value.url !== null && value.url !== '') {
        if (typeof value.url !== 'string') throw configError('relay.url must be a string')
        const normalized = normalizeRelayUrl(value.url)
        if (normalized.error !== null) throw configError(`relay.${normalized.error}`)
        relay.url = normalized.url
      }
      if (value.publicUrl !== undefined && value.publicUrl !== null && value.publicUrl !== '') {
        if (typeof value.publicUrl !== 'string') throw configError('relay.publicUrl must be a string')
        const trimmed = value.publicUrl.trim().replace(/\/+$/, '')
        let parsed
        try {
          parsed = new URL(trimmed)
        } catch {
          throw configError(`relay.publicUrl must be an absolute http(s) URL (received ${JSON.stringify(value.publicUrl)})`)
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw configError('relay.publicUrl must use http or https')
        }
        relay.publicUrl = trimmed
      }
      if (value.accessKey !== undefined && value.accessKey !== null) {
        if (typeof value.accessKey !== 'string') throw configError('relay.accessKey must be a string')
        const trimmed = value.accessKey.trim()
        if (trimmed.length > 256) throw configError('relay.accessKey must be at most 256 characters')
        relay.accessKey = trimmed
      }
      if (value.hubId !== undefined && value.hubId !== null) {
        if (typeof value.hubId !== 'string') throw configError('relay.hubId must be a string')
        const trimmed = value.hubId.trim()
        if (trimmed !== '' && !isHubId(trimmed)) {
          throw configError(`relay.hubId must match ${HUB_ID_PATTERN} (received ${JSON.stringify(value.hubId)})`)
        }
        relay.hubId = trimmed
      }
      if (value.name !== undefined && value.name !== null) {
        if (typeof value.name !== 'string') throw configError('relay.name must be a string')
        const trimmed = value.name.trim()
        if (trimmed.length > 64) throw configError('relay.name must be at most 64 characters')
        relay.name = trimmed
      }
    } else {
      throw configError('relay must be an object ({ enabled, url, … }) or a boolean')
    }
  }
  if (relay.enabled && relay.url === '') {
    throw configError("relay.url is required when relay is enabled (e.g. relay: { enabled: true, url: 'wss://relay.example.com' })")
  }

  return Object.freeze({
    role,
    publicUrl,
    promoteOnTimeout,
    minAgentVersion,
    preferAddress,
    tailscaleServe: Object.freeze({ ...tailscaleServe }),
    relay: Object.freeze({ ...relay }),
    stateDir,
    keyTtlMinutes: boundedInteger(raw.keyTtlMinutes, 'keyTtlMinutes', DEFAULTS.keyTtlMinutes),
    heartbeatMs: boundedInteger(raw.heartbeatMs, 'heartbeatMs', DEFAULTS.heartbeatMs),
    execTimeoutMs: boundedInteger(raw.execTimeoutMs, 'execTimeoutMs', DEFAULTS.execTimeoutMs),
    execEnabled,
    maxOutputBytes: boundedInteger(raw.maxOutputBytes, 'maxOutputBytes', DEFAULTS.maxOutputBytes),
  })
}

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context with `tools` and `webServer`.
 * @param {unknown} [config] - plugin config (PROTOCOL §8).
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  // Test seam: the smoke harness injects a clock and a short presence lease so
  // the 45 s expiry is assertable without sleeping. Production never sets it.
  // The read is guarded because Cordis throws on undeclared context properties
  // (the same reason lib/routes.js guards `ctx.addressDeps`).
  let hubDeps = {}
  try {
    const value = ctx === null || typeof ctx !== 'object' ? undefined : ctx.hubDeps
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) hubDeps = value
  } catch {
    hubDeps = {}
  }
  // Account-center seam (v1.8.0): the smoke harness injects a short heartbeat
  // so the 60 s re-registration is assertable without waiting a minute.
  // Guarded for the same reason as `ctx.hubDeps` above.
  let accountDeps = {}
  try {
    const value = ctx === null || typeof ctx !== 'object' ? undefined : ctx.accountDeps
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) accountDeps = value
  } catch {
    accountDeps = {}
  }
  const onWarn = (message) => {
    try {
      // The host's logger is not part of the injected contract; a warning on
      // stderr is enough and never fatal.
      console.warn(message)
    } catch {
      // A host with a broken console must not lose the plugin.
    }
  }

  const stateDir = resolveStateDir(resolved.stateDir)

  // ---- Tailscale Serve tunnel (v1.4.0) ----------------------------------
  // Owns the Serve mapping so the random desktop port re-points on every load.
  // Created for every role: it is about this plugin's own web server.
  const tunnel = createTunnel({ ctx, config: resolved.tailscaleServe, onWarn })
  ctx.effect(() => {
    void tunnel.start()
    return () => tunnel.dispose()
  }, 'dsh-computers: tailscale serve tunnel')

  // ---- relay link (v1.6.0, docs/relay-design.md §5) ---------------------
  // A hub behind NAT/loopback cannot be reached, so the relay inverts the
  // direction: this plugin dials OUT and clients arrive at
  // `<relay>/r/<hubId>/…`. No port is opened. Created for every role — like the
  // tunnel above it is about this plugin's own web server, not about the role.
  //
  // The hubId is the address other machines bookmark, so it lives in its own
  // relay.json (never state.json: resetting the computer registry must not
  // orphan an address already handed out). The same document carries the UI
  // on/off override (v1.6.1) and the UI relay address (v1.7.1): config keeps
  // optional deployment facts, and the normal path is to set both up from the
  // settings page with an EMPTY plugin config. It is read unconditionally — a
  // deployment that sets `relay: { url }` and leaves `enabled` off must still
  // see a persisted "on", and a UI address must still be used when the config
  // has none.
  const persistedIdentity = readRelayIdentity(stateDir, { onWarn })
  const relayConfig = Object.freeze({
    ...resolved.relay,
    hubId: resolved.relay.hubId !== ''
      ? resolved.relay.hubId
      : (persistedIdentity === null ? '' : persistedIdentity.hubId),
  })
  const enabledOverride = persistedIdentity === null || typeof persistedIdentity.enabled !== 'boolean'
    ? null
    : persistedIdentity.enabled
  // null = follow `relay.url` from the config; a string is the persisted UI address.
  const urlOverride = persistedIdentity === null ? null : persistedIdentity.url
  const effectiveRelayEnabled = enabledOverride === null ? resolved.relay.enabled : enabledOverride
  const relay = createRelay({
    ctx,
    config: relayConfig,
    // null = follow the config default; a boolean is the persisted UI switch.
    enabledOverride,
    // null = follow the config `relay.url`; a string is the persisted UI address.
    urlOverride,
    // Fired when the manager mints an id: persist it before the first dial so
    // the published address survives a restart (the write keeps the overrides).
    onHubId: (hubId) => {
      writeRelayIdentity(stateDir, { hubId }, { onWarn })
    },
    // The settings switch: persist the override so it survives a plugin reload,
    // then the manager applies it live (dial or dispose) without one.
    onEnabled: (enabled, hubId) => writeRelayIdentity(stateDir, { hubId, enabled }, { onWarn }),
    // The settings address (v1.7.1): `''` clears the override so the config
    // value applies again. Persisted before the re-dial, so a reload keeps it.
    onUrl: (url, hubId) => writeRelayIdentity(stateDir, { hubId, url: url === '' ? null : url }, { onWarn }),
    log: (level, message) => {
      // The link is chatty about reconnects; only surface warnings/errors, and
      // never let the relay's logging take the plugin down.
      if (level === 'warn' || level === 'error') onWarn(`dsh-computers relay: ${message}`)
    },
  })
  // An explicitly configured hubId is just as persistent as a minted one: a
  // later config edit that drops it must not change the published address.
  const identityChanged = persistedIdentity === null || persistedIdentity.hubId !== relayConfig.hubId
  if (effectiveRelayEnabled && relayConfig.hubId !== '' && identityChanged) {
    writeRelayIdentity(stateDir, { hubId: relayConfig.hubId }, { onWarn })
  }
  ctx.effect(() => {
    relay.start()
    return () => relay.dispose()
  }, 'dsh-computers: relay link')

  // ---- hub half (PROTOCOL §1-§5, §8) ------------------------------------
  // role 'runtime' is the controlled machine only: it must not serve the hub
  // API, register computer_* tools or contribute a prompt section.
  if (resolved.role !== 'runtime') {
    const store = createStore({ stateDir, onWarn })
    const selections = createSelectionStore({ stateDir, onWarn })
    const access = createAccessControl({ ctx, store: createAccessStore({ stateDir, onWarn }) })
    const hub = createHub({
      store,
      heartbeatMs: resolved.heartbeatMs,
      maxOutputBytes: resolved.maxOutputBytes,
      onWarn,
      ...hubDeps,
    })
    const fsOps = createFsOps({ hub, onWarn })

    // v1.7.0: the fleet join identity — the ONE credential a new machine needs.
    // The hub publishes `<advertisedBase>#join=<token>` from /state.fleet and a
    // pasted address enrolls without a one-time key. It lives in its own
    // fleet.json (never state.json: resetting the computer registry must not
    // invalidate an address already handed out). Created only for the hub
    // surface, which is the only place that can serve enroll/join; no ctx read
    // is involved (the state directory comes from the resolved config).
    const fleet = createFleetIdentity({ stateDir, onWarn })

    // v1.8.0: the account center. The relay doubles as an account server: this
    // machine logs in (or creates an account), registers itself in the
    // account's device directory, and every machine in the same account can
    // therefore see the others with no per-machine pairing. The credential
    // document (`account.json`, 0600) and the stable machineId (`machine.json`)
    // live beside relay.json/fleet.json; the secret never leaves this host.
    //
    // Device facts are resolved lazily on every registration, so a relay that
    // connects later (or a settings-page address change) is picked up without a
    // reload: prefer the relay's public entry while the link is enabled, else
    // the address the browser most recently used, else the advertised origin
    // with a non-loopback spelling when one exists.
    const account = createAccountManager({
      stateDir,
      heartbeatMs: Number.isSafeInteger(accountDeps.heartbeatMs) && accountDeps.heartbeatMs > 0
        ? accountDeps.heartbeatMs
        : undefined,
      describe: () => {
        let info = null
        try {
          info = relay.status()
        } catch {
          info = null
        }
        if (info !== null && info.enabled === true && typeof info.publicUrl === 'string' && info.publicUrl !== '') {
          return {
            hubId: typeof info.hubId === 'string' ? info.hubId : '',
            entryUrl: info.publicUrl,
            name: machineNameOf(resolved.relay.name),
          }
        }
        // No relay: the heartbeat uses the browser-observed advertised address,
        // falling back to this plugin's own origin resolution.
        return { hubId: '', entryUrl: '', name: machineNameOf(resolved.relay.name) }
      },
      fallbackEntryUrl: () => preferNonLoopback(resolveBaseUrl({ ctx, config: resolved })),
      onWarn,
    })
    ctx.effect(() => {
      account.start()
      return () => account.dispose()
    }, 'dsh-computers: account center heartbeat')

    // Routes first (the browser page and the agents can arrive immediately),
    // then the tools and the prompt section.
    createRoutes({
      ctx,
      config: resolved,
      store,
      hub,
      selections,
      access,
      fsOps,
      role: resolved.role,
      version: PLUGIN_VERSION,
      agentUrl: AGENT_URL,
      tunnel,
      relay,
      fleet,
      account,
      onWarn,
    })
    createTools({ ctx, config: resolved, store, hub, selections, access, fsOps, version: PLUGIN_VERSION, onWarn })

    // ---- remote skills in the slash menu (v1.9.0) ----------------------
    // Every connected computer's own skills become DSH skills named
    // `<machineSlug>-<skillName>`; loading one reads that machine's SKILL.md
    // over the existing fs channel. The `skills` service is OPTIONAL (a headless
    // composition may not load it), so it is read through a guarded ctx.get and
    // a missing service simply means no provider. Registration happens
    // synchronously during apply, through ctx.effect so a reload unregisters it.
    const computerSkills = createComputerSkills({
      hub,
      fsOps,
      computers: () => store.read().computers,
      onWarn,
    })
    try {
      const skillsService = ctx.get('skills')
      if (skillsService !== undefined && skillsService !== null && typeof skillsService.registerProvider === 'function') {
        ctx.effect(() => {
          try {
            return skillsService.registerProvider((control) => {
              computerSkills.attachControl(control)
              return computerSkills.provider
            })
          } catch (error) {
            // A duplicate/reserved provider name or a broken registry must not
            // take the whole plugin down: the computers keep working, only the
            // slash-menu entries are missing.
            onWarn(`dsh-computers: could not register the remote skills provider: ${error && error.message ? error.message : error}`)
            return () => {}
          }
        }, 'dsh-computers: remote skills provider')
      }
    } catch (error) {
      onWarn(`dsh-computers: the skills service is unavailable: ${error && error.message ? error.message : error}`)
    }

    // Every registered route is its own effect; this one owns the timers and
    // the in-flight exec promises so a plugin reload cannot leak either.
    ctx.effect(() => () => {
      fsOps.dispose()
      hub.dispose()
    }, 'dsh-computers: dispose hub and pending executions')
  } else {
    // role 'runtime': the settings client still learns its role from /state
    // and can probe /health; the hub API itself stays unregistered.
    createRuntimeStatusRoutes({
      ctx,
      config: resolved,
      role: resolved.role,
      version: PLUGIN_VERSION,
      tunnel,
      relay,
      onWarn,
    })
  }

  // ---- runtime half (PROTOCOL §10) --------------------------------------
  // role 'hub' is a controller only: it must never dial out as a computer.
  if (resolved.role !== 'hub') {
    const runtime = createRuntimeManager({
      config: resolved,
      stateDir,
      version: PLUGIN_VERSION,
      agentModuleUrl: AGENT_URL,
      onWarn,
    })
    createRuntimeRoutes({ ctx, config: resolved, runtime, role: resolved.role, onWarn })

    // Starting DSH starts the runtime: the switch survives restarts, so an
    // enabled runtime.json reconnects on load without any user action.
    void runtime.autoStart()

    ctx.effect(() => () => runtime.dispose(), 'dsh-computers: dispose embedded runtime')
  }
}
