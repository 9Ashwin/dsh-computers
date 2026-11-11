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
import { createSelectionStore } from './lib/selection.js'
import { resolveStateDir, createStore } from './lib/state.js'
import { createTools } from './lib/tools.js'

/** Cordis plugin name. */
export const name = 'dsh-computers'

/** Required host capabilities; `systemPrompt` and `connection` are optional. */
export const inject = ['tools', 'webServer']

/** Version reported by `/api/dsh-computers/health` (and asserted by the smoke harness). */
export const PLUGIN_VERSION = '1.1.0'

/** The machine agent bundle, served at request time (never imported). */
const AGENT_URL = new URL('./agent/dsh-computers-agent.mjs', import.meta.url)

/** Protocol defaults (PROTOCOL §8); `''` means "use the default". */
const ROLES = Object.freeze(['hub', 'runtime', 'both'])

const DEFAULTS = Object.freeze({
  role: 'both',
  publicUrl: '',
  stateDir: '',
  keyTtlMinutes: 15,
  heartbeatMs: 20_000,
  execTimeoutMs: 120_000,
  execEnabled: true,
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

  let execEnabled = DEFAULTS.execEnabled
  if (raw.execEnabled !== undefined && raw.execEnabled !== null) {
    if (typeof raw.execEnabled !== 'boolean') throw configError('execEnabled must be a boolean')
    execEnabled = raw.execEnabled
  }

  return Object.freeze({
    role,
    publicUrl,
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
    })

    // Routes first (the browser page and the agents can arrive immediately),
    // then the tools and the prompt section.
    createRoutes({
      ctx,
      config: resolved,
      store,
      hub,
      selections,
      access,
      role: resolved.role,
      version: PLUGIN_VERSION,
      agentUrl: AGENT_URL,
      onWarn,
    })
    createTools({ ctx, config: resolved, store, hub, selections, access, onWarn })

    // Every registered route is its own effect; this one owns the timers and
    // the in-flight exec promises so a plugin reload cannot leak either.
    ctx.effect(() => () => {
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
