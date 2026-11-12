/**
 * Per-session target-computer selection (task-9).
 *
 * The settings page pins which machine the agent should act on for one chat
 * session; `computer_exec` without an explicit `computer` argument uses that
 * pin. The store is a tiny persisted map `sessionId → computerId` at
 * `${stateDir}/selections.json` (atomic write, mode 0600, corrupt-file
 * tolerant), pruned to the 200 most recently updated entries so a long-lived
 * deployment cannot grow it without bound.
 *
 * Node builtins only.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** On-disk schema version. */
export const SELECTION_STATE_VERSION = 1

/** File name inside the plugin state directory. */
export const SELECTION_FILE_NAME = 'selections.json'

/** How many session selections survive pruning (most recently updated win). */
export const MAX_SELECTIONS = 200

/** Session ids are opaque GUI identifiers; 256 chars is already generous. */
export const MAX_SESSION_ID_CHARS = 256

/**
 * Normalize a session id: non-empty, trimmed, no control characters, bounded
 * length. Returns null for anything else so routes answer 400.
 * @param {unknown} value - candidate (route query/body, agent id).
 * @returns {string | null} the normalized id.
 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_SESSION_ID_CHARS) return null
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

/** A fresh, empty selection document. */
export function emptySelectionState() {
  return { version: SELECTION_STATE_VERSION, selections: {} }
}

/**
 * Coerce an arbitrary parsed value into a usable selection document.
 * Invalid session keys and malformed entries are dropped, never fatal.
 * @param {unknown} raw - parsed JSON (or undefined when the file was missing).
 * @returns {object} a valid document.
 */
export function normalizeSelectionState(raw) {
  const doc = emptySelectionState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return doc
  const source = raw.selections !== null && typeof raw.selections === 'object' && !Array.isArray(raw.selections)
    ? raw.selections
    : {}
  for (const [rawSessionId, entry] of Object.entries(source)) {
    const sessionId = normalizeSessionId(rawSessionId)
    if (sessionId === null) continue
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const computerId = typeof entry.computerId === 'string' ? entry.computerId.trim() : ''
    if (computerId === '') continue
    const parsed = typeof entry.updatedAt === 'string' ? Date.parse(entry.updatedAt) : Number.NaN
    doc.selections[sessionId] = {
      computerId,
      updatedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
    }
  }
  return doc
}

/**
 * Keep only the `max` most recently updated selections (missing timestamps
 * sort last). Mutates in place.
 * @param {object} doc - selection document.
 * @param {number} [max] - entry budget.
 * @returns {number} how many entries were dropped.
 */
export function pruneSelections(doc, max = MAX_SELECTIONS) {
  const entries = Object.entries(doc.selections)
  if (entries.length <= max) return 0
  const age = (entry) => {
    const parsed = typeof entry?.[1]?.updatedAt === 'string' ? Date.parse(entry[1].updatedAt) : Number.NaN
    return Number.isFinite(parsed) ? parsed : 0
  }
  entries.sort((left, right) => age(right) - age(left))
  const keep = new Set(entries.slice(0, max).map(([sessionId]) => sessionId))
  let dropped = 0
  for (const sessionId of Object.keys(doc.selections)) {
    if (keep.has(sessionId)) continue
    delete doc.selections[sessionId]
    dropped += 1
  }
  return dropped
}

/**
 * Create the selection store for one plugin mount.
 * @param {object} options - store options.
 * @param {string} options.stateDir - directory holding selections.json.
 * @param {() => number} [options.now] - epoch-millisecond clock (testable).
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 * @returns {object} the store.
 */
export function createSelectionStore({ stateDir, now = Date.now, onWarn = () => {} }) {
  const file = join(stateDir, SELECTION_FILE_NAME)
  let doc = emptySelectionState()

  /** Read the document; a corrupt file is set aside, never fatal. */
  const load = () => {
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      if (error && error.code !== 'ENOENT') onWarn(`dsh-computers: cannot read ${file}: ${error.message}`)
      return emptySelectionState()
    }
    try {
      return normalizeSelectionState(JSON.parse(raw))
    } catch {
      const aside = `${file}.corrupt-${now()}`
      try {
        renameSync(file, aside)
        onWarn(`dsh-computers: ${file} was not valid JSON; moved to ${aside}`)
      } catch {
        onWarn(`dsh-computers: ${file} was not valid JSON`)
      }
      return emptySelectionState()
    }
  }

  /** Write the document atomically: tmp file in the same directory, then rename. */
  const persist = () => {
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const tmp = join(stateDir, `.selections.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
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
  pruneSelections(doc)
  if (Object.keys(doc.selections).length > 0) persist()

  /**
   * Store one selection (or clear it with null), prune and persist.
   * @param {string} sessionId - session identity.
   * @param {string | null} computerId - target computer or null to clear.
   * @param {string | null} [computerName] - display name snapshot, so a deleted
   *   target can still be named in an error instead of "no computer selected".
   */
  const set = (sessionId, computerId, computerName = null) => {
    const key = normalizeSessionId(sessionId)
    if (key === null) throw new TypeError('dsh-computers selection: sessionId must be a non-empty string')
    if (computerId === null) {
      delete doc.selections[key]
    } else {
      if (typeof computerId !== 'string' || computerId.trim() === '') {
        throw new TypeError('dsh-computers selection: computerId must be a non-empty string or null')
      }
      const entry = { computerId: computerId.trim(), updatedAt: new Date(now()).toISOString() }
      if (typeof computerName === 'string' && computerName.trim() !== '') entry.name = computerName.trim().slice(0, 120)
      doc.selections[key] = entry
    }
    pruneSelections(doc)
    persist()
  }

  return {
    /** Absolute selections.json path (diagnostics + smoke assertions). */
    file,
    /**
     * The selected computer id for one session, or null.
     * @param {string} sessionId - session identity.
     * @returns {string | null} the computer id.
     */
    get(sessionId) {
      const key = normalizeSessionId(sessionId)
      if (key === null) return null
      return doc.selections[key]?.computerId ?? null
    },
    /**
     * The full selection entry for one session: the pinned id plus the display
     * name captured when it was pinned (v1.8.1). A target that has since been
     * deleted can still be named, instead of looking like "nothing selected".
     * @param {string} sessionId - session identity.
     * @returns {{ computerId: string, name: string | null, updatedAt: string | null } | null}
     */
    entry(sessionId) {
      const key = normalizeSessionId(sessionId)
      if (key === null) return null
      const stored = doc.selections[key]
      if (stored === undefined || typeof stored.computerId !== 'string') return null
      return {
        computerId: stored.computerId,
        name: typeof stored.name === 'string' && stored.name !== '' ? stored.name : null,
        updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
      }
    },
    /** Store one selection. */
    set,
    /** Clear one session's selection. */
    clear(sessionId) {
      set(sessionId, null)
    },
    /** Copy of every selection (diagnostics). */
    all() {
      return JSON.parse(JSON.stringify(doc.selections))
    },
    /** Re-read the file (tooling). */
    reload() {
      doc = load()
    },
  }
}
