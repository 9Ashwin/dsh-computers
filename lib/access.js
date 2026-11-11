/**
 * Per-session and per-computer access control (the two access dialogs).
 *
 * Two independent rules that AND together:
 * - `sessions[sessionId].allow` — which computers one conversation may use
 *   (absent = every computer);
 * - `computers[computerId].presets` — which Agent presets ("Bots") may use one
 *   computer (absent = every preset).
 *
 * Persisted at `${stateDir}/access.json` (atomic, mode 0600, corrupt tolerant).
 * The store below is pure persistence; `createAccessControl` adds the DSH
 * preset/agent lookups and the effective-allow helper every enforcement point
 * shares, so the routes and the tools can never disagree.
 *
 * Node builtins only.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeSessionId } from './selection.js'

/** On-disk schema version. */
export const ACCESS_STATE_VERSION = 1

/** File name inside the plugin state directory. */
export const ACCESS_FILE_NAME = 'access.json'

/** Session entries kept (most recently updated win), same budget as selections. */
export const MAX_ACCESS_SESSIONS = 200

/** Preset id used for a session whose Agent has no (or an unknown) preset. */
export const DEFAULT_PRESET_ID = 'default'

/** Roster used when the host has no `agentPresets` service. */
export const FALLBACK_PRESETS = Object.freeze([{ id: DEFAULT_PRESET_ID, name: 'Default' }])

/** A fresh, empty access document. */
export function emptyAccessState() {
  return { version: ACCESS_STATE_VERSION, sessions: {}, computers: {} }
}

/** Normalize a list of ids: trimmed, non-empty, deduplicated, order kept. */
export function normalizeIdList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Coerce an arbitrary parsed value into a usable access document.
 * @param {unknown} raw - parsed JSON (or undefined when the file was missing).
 * @returns {object} a valid document.
 */
export function normalizeAccessState(raw) {
  const doc = emptyAccessState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return doc
  const sessions = raw.sessions !== null && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions) ? raw.sessions : {}
  for (const [rawSessionId, entry] of Object.entries(sessions)) {
    const sessionId = normalizeSessionId(rawSessionId)
    if (sessionId === null || entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    doc.sessions[sessionId] = {
      allow: normalizeIdList(entry.allow),
      updatedAt: typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt))
        ? new Date(Date.parse(entry.updatedAt)).toISOString()
        : null,
    }
  }
  const computers = raw.computers !== null && typeof raw.computers === 'object' && !Array.isArray(raw.computers) ? raw.computers : {}
  for (const [computerId, entry] of Object.entries(computers)) {
    if (computerId.trim() === '' || entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    doc.computers[computerId.trim()] = {
      presets: normalizeIdList(entry.presets),
      updatedAt: typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt))
        ? new Date(Date.parse(entry.updatedAt)).toISOString()
        : null,
    }
  }
  return doc
}

/**
 * Keep only the `max` most recently updated session rules (missing timestamps
 * sort last). Mutates in place.
 * @param {object} doc - access document.
 * @param {number} [max] - entry budget.
 * @returns {number} how many entries were dropped.
 */
export function pruneAccessSessions(doc, max = MAX_ACCESS_SESSIONS) {
  const entries = Object.entries(doc.sessions)
  if (entries.length <= max) return 0
  const age = ([, entry]) => {
    const parsed = typeof entry?.updatedAt === 'string' ? Date.parse(entry.updatedAt) : Number.NaN
    return Number.isFinite(parsed) ? parsed : 0
  }
  entries.sort((left, right) => age(right) - age(left))
  const keep = new Set(entries.slice(0, max).map(([sessionId]) => sessionId))
  let dropped = 0
  for (const sessionId of Object.keys(doc.sessions)) {
    if (keep.has(sessionId)) continue
    delete doc.sessions[sessionId]
    dropped += 1
  }
  return dropped
}

/**
 * Create the access store for one plugin mount.
 * @param {object} options - store options.
 * @param {string} options.stateDir - directory holding access.json.
 * @param {() => number} [options.now] - epoch-millisecond clock (testable).
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 * @returns {object} the store.
 */
export function createAccessStore({ stateDir, now = Date.now, onWarn = () => {} }) {
  const file = join(stateDir, ACCESS_FILE_NAME)
  let doc = emptyAccessState()

  /** Read the document; a corrupt file is set aside, never fatal. */
  const load = () => {
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      if (error && error.code !== 'ENOENT') onWarn(`dsh-computers: cannot read ${file}: ${error.message}`)
      return emptyAccessState()
    }
    try {
      return normalizeAccessState(JSON.parse(raw))
    } catch {
      const aside = `${file}.corrupt-${now()}`
      try {
        renameSync(file, aside)
        onWarn(`dsh-computers: ${file} was not valid JSON; moved to ${aside}`)
      } catch {
        onWarn(`dsh-computers: ${file} was not valid JSON`)
      }
      return emptyAccessState()
    }
  }

  /** Write the document atomically (tmp file in the same directory, then rename). */
  const persist = () => {
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const tmp = join(stateDir, `.access.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        chmodSync(tmp, 0o600)
      } catch {
        // Platforms without POSIX modes (Windows) skip this.
      }
      renameSync(tmp, file)
    } catch (error) {
      onWarn(`dsh-computers: cannot write ${file}: ${error && error.message ? error.message : error}`)
    }
  }

  doc = load()
  pruneAccessSessions(doc)
  if (Object.keys(doc.sessions).length > 0 || Object.keys(doc.computers).length > 0) persist()

  /** Store (or reset with null) one session's allow-list. */
  const setSessionAllow = (sessionId, ids) => {
    const key = normalizeSessionId(sessionId)
    if (key === null) throw new TypeError('dsh-computers access: sessionId must be a non-empty string')
    if (ids === null) {
      delete doc.sessions[key]
    } else {
      doc.sessions[key] = { allow: normalizeIdList(ids), updatedAt: new Date(now()).toISOString() }
    }
    pruneAccessSessions(doc)
    persist()
  }

  /** Drop one session's rule outright (used by tests/tooling). */
  const clearSession = (sessionId) => {
    const key = normalizeSessionId(sessionId)
    if (key === null) return
    if (doc.sessions[key] === undefined) return
    delete doc.sessions[key]
    persist()
  }

  return {
    /** Absolute access.json path (diagnostics + smoke assertions). */
    file,
    /**
     * The session's allow-list, or null when the session may use every
     * computer (no rule). An empty array means "none".
     * @param {string} sessionId - session identity.
     * @returns {string[] | null} raw ids.
     */
    sessionAllow(sessionId) {
      const key = normalizeSessionId(sessionId)
      if (key === null) return null
      const entry = doc.sessions[key]
      return entry === undefined ? null : [...entry.allow]
    },
    /** Store the session allow-list (`null` removes the rule = all allowed). */
    setSessionAllow,
    /** Remove one session's rule. */
    clearSession,
    /**
     * The computer's allowed preset ids, or null when every preset may use it.
     * @param {string} computerId - computer id.
     * @returns {string[] | null} raw ids.
     */
    computerPresets(computerId) {
      if (typeof computerId !== 'string' || computerId.trim() === '') return null
      const entry = doc.computers[computerId.trim()]
      return entry === undefined ? null : [...entry.presets]
    },
    /** Store the computer's allowed presets (`null` removes the rule = all). */
    setComputerPresets(computerId, ids) {
      if (typeof computerId !== 'string' || computerId.trim() === '') {
        throw new TypeError('dsh-computers access: computerId must be a non-empty string')
      }
      const key = computerId.trim()
      if (ids === null) {
        delete doc.computers[key]
      } else {
        doc.computers[key] = { presets: normalizeIdList(ids), updatedAt: new Date(now()).toISOString() }
      }
      persist()
    },
    /** Drop every rule attached to one computer (called when it is deleted). */
    forgetComputer(computerId) {
      if (typeof computerId !== 'string' || computerId.trim() === '') return
      const key = computerId.trim()
      if (doc.computers[key] === undefined) return
      delete doc.computers[key]
      persist()
    },
    /** Copy of the whole document (diagnostics). */
    all() {
      return JSON.parse(JSON.stringify(doc))
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Preset / agent identity resolution (ctx-bound, not persisted)              */
/* ------------------------------------------------------------------------- */

/**
 * The live `agentPresets` service, if this host has one.
 * @param {object} ctx - Cordis context.
 * @returns {object | undefined} the service.
 */
function agentPresetsOf(ctx) {
  try {
    const service = ctx.get('agentPresets')
    return service === undefined || service === null ? undefined : service
  } catch {
    return undefined
  }
}

/**
 * The preset id bound to an Agent. An unset/unknown preset counts as the
 * literal `default` (the dialog's roster has that id even without a service).
 * @param {object} ctx - Cordis context.
 * @param {object | undefined} agent - live Agent (from `exec.agent`).
 * @returns {string} preset id.
 */
export function presetIdForAgent(ctx, agent) {
  try {
    const service = agentPresetsOf(ctx)
    if (service !== undefined && typeof service.presetForSession === 'function') {
      const fromAgent = agent?.session
      if (fromAgent !== undefined && fromAgent !== null) {
        const preset = service.presetForSession(fromAgent)
        if (typeof preset === 'string' && preset !== '') return preset
        return DEFAULT_PRESET_ID
      }
    }
  } catch {
    // A broken preset service must not change authorization: default it.
  }
  return DEFAULT_PRESET_ID
}

/**
 * The preset id bound to a session *id* (browser routes have no Agent object).
 * Looks the live Agent up in the `agents` registry; a non-live session counts
 * as `default`.
 * @param {object} ctx - Cordis context.
 * @param {string} sessionId - session identity.
 * @returns {string} preset id.
 */
export function presetIdForSession(ctx, sessionId) {
  try {
    const agents = ctx.get('agents')
    const agent = agents !== undefined && agents !== null && typeof agents.get === 'function'
      ? agents.get(sessionId)
      : undefined
    if (agent !== undefined && agent !== null) return presetIdForAgent(ctx, agent)
  } catch {
    // Unknown session or broken registry: fall back to the default preset.
  }
  return DEFAULT_PRESET_ID
}

/**
 * The deployment's Agent-preset roster, or the single `default` fallback when
 * the host has no `agentPresets` service.
 * @param {object} ctx - Cordis context.
 * @returns {Promise<Array<{ id: string, name: string }>>} ordered roster.
 */
export async function listPresets(ctx) {
  try {
    const service = agentPresetsOf(ctx)
    if (service !== undefined && typeof service.list === 'function') {
      const rows = await service.list()
      if (Array.isArray(rows)) {
        const presets = []
        const seen = new Set()
        for (const row of rows) {
          if (row === null || typeof row !== 'object') continue
          const id = typeof row.id === 'string' ? row.id.trim() : ''
          if (id === '' || seen.has(id)) continue
          seen.add(id)
          presets.push({ id, name: typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : id })
        }
        if (presets.length > 0) return presets
      }
    }
  } catch {
    // Fall through to the single-preset roster.
  }
  return FALLBACK_PRESETS.map((preset) => ({ ...preset }))
}

/**
 * The authorization helpers shared by the routes and the tools.
 * @param {object} options - wiring.
 * @param {object} options.ctx - Cordis context (agentPresets/agents lookups).
 * @param {object} options.store - access store.
 * @returns {object} the access control.
 */
export function createAccessControl({ ctx, store }) {
  /** Whether the session's allow-list permits one computer (absent rule = all). */
  const sessionAllows = (sessionId, computerId) => {
    if (sessionId === null || sessionId === undefined) return true
    const allow = store.sessionAllow(sessionId)
    if (allow === null) return true
    return allow.includes(computerId)
  }

  /** Whether the computer's preset rule permits one preset (absent rule = all). */
  const presetAllows = (computerId, presetId) => {
    const presets = store.computerPresets(computerId)
    if (presets === null) return true
    return presets.includes(presetId)
  }

  /** The effective answer: both rules must permit the pair. */
  const isAllowed = ({ sessionId, presetId, computerId }) => {
    if (typeof computerId !== 'string' || computerId === '') return false
    return presetAllows(computerId, presetId) && sessionAllows(sessionId, computerId)
  }

  /** Only the computers this caller may use, order preserved. */
  const filterComputers = (computers, { sessionId, presetId }) =>
    computers.filter((computer) => isAllowed({ sessionId, presetId, computerId: computer.id }))

  /** Actionable denial text the model can relay to the user. */
  const denialMessage = (computer, presetId) => {
    const name = computer !== null && typeof computer === 'object' && typeof computer.name === 'string'
      ? computer.name
      : 'that computer'
    return `computer '${name}' is not accessible to this conversation (Agent preset '${presetId}'). `
      + 'Ask the user to grant access in 管理访问权 (Access management) for this conversation and this computer, then retry.'
  }

  return {
    store,
    presetIdForAgent: (agent) => presetIdForAgent(ctx, agent),
    presetIdForSession: (sessionId) => presetIdForSession(ctx, sessionId),
    presets: () => listPresets(ctx),
    sessionAllows,
    presetAllows,
    isAllowed,
    filterComputers,
    denialMessage,
  }
}
