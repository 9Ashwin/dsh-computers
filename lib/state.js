/**
 * Host-side persisted registry (PROTOCOL §2).
 *
 * One JSON document under `${stateDir || $DSH_HOME/computers}/state.json`,
 * written atomically (same-directory tmp file + rename) with mode 0600. The
 * loaded document is the single source of truth in memory; every mutation goes
 * through `mutate()` so prune + persist cannot be forgotten.
 *
 * Node builtins only.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** On-disk schema version (the browser API reports its own version 2). */
export const STATE_VERSION = 1

/** A consumed key and an expired key are both dropped one hour after the fact. */
export const PENDING_KEY_PRUNE_MS = 60 * 60 * 1000

/**
 * Resolve the state directory: explicit config first, then `$DSH_HOME`, then
 * `~/.dsh` (the harness default).
 * @param {string | undefined} configured - `config.stateDir`.
 * @returns {string} absolute directory path.
 */
export function resolveStateDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'computers')
}

/** A fresh, empty registry document. */
export function emptyState() {
  return { version: STATE_VERSION, computers: [], pendingKeys: [] }
}

/**
 * Drop pending keys the protocol lets us forget: one whose `usedAt` is older
 * than an hour, or whose `expiresAt` passed more than an hour ago.
 * @param {object} doc - registry document, mutated in place.
 * @param {number} nowMs - current epoch milliseconds.
 * @returns {number} how many entries were dropped.
 */
export function prunePendingKeys(doc, nowMs) {
  const before = doc.pendingKeys.length
  doc.pendingKeys = doc.pendingKeys.filter((entry) => {
    if (entry === null || typeof entry !== 'object') return false
    const usedAt = typeof entry.usedAt === 'string' ? Date.parse(entry.usedAt) : Number.NaN
    if (typeof entry.usedAt === 'string' && Number.isFinite(usedAt)) return nowMs - usedAt <= PENDING_KEY_PRUNE_MS
    const expiresAt = typeof entry.expiresAt === 'string' ? Date.parse(entry.expiresAt) : Number.NaN
    if (!Number.isFinite(expiresAt)) return false
    return nowMs - expiresAt <= PENDING_KEY_PRUNE_MS
  })
  return before - doc.pendingKeys.length
}

/**
 * Coerce an arbitrary parsed value into a registry document we can trust
 * enough to serve. Unknown shapes are dropped rather than crashing the host.
 * @param {unknown} raw - parsed JSON (or undefined when the file was missing).
 * @returns {object} a valid registry document.
 */
export function normalizeState(raw, now = undefined) {
  const doc = emptyState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return doc
  if (Array.isArray(raw.computers)) {
    doc.computers = raw.computers.filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    for (const computer of doc.computers) {
      // §11.6.4 migration: records written before the activation lifecycle have
      // no `activatedAt` property at all. They were activated by definition, so
      // backfill it from createdAt instead of hiding a working machine. A v1.1
      // enrollment sets `activatedAt: null` explicitly and stays pending.
      if (computer.activatedAt === undefined) {
        computer.activatedAt = typeof computer.createdAt === 'string' ? computer.createdAt : new Date(now ?? Date.now()).toISOString()
      }
    }
  }
  if (Array.isArray(raw.pendingKeys)) {
    doc.pendingKeys = raw.pendingKeys.filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
  }
  return doc
}

/**
 * Create the registry store for one plugin mount.
 *
 * `now` is injectable so expiry/prune rules are testable without a clock.
 * @param {object} options - store options.
 * @param {string} options.stateDir - resolved directory (see {@link resolveStateDir}).
 * @param {() => number} [options.now] - epoch-millisecond clock.
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 * @returns {object} the store.
 */
export function createStore({ stateDir, now = Date.now, onWarn = () => {} }) {
  const file = join(stateDir, 'state.json')
  let doc = emptyState()

  /** Read and parse the document; a corrupt file is set aside, never fatal. */
  const load = () => {
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        onWarn(`dsh-computers: cannot read ${file}: ${error.message}`)
      }
      doc = emptyState()
      return
    }
    try {
      doc = normalizeState(JSON.parse(raw), now())
    } catch {
      // A half-written legacy file must not brick the plugin: keep it for
      // inspection and start from an empty registry.
      const aside = `${file}.corrupt-${now()}`
      try {
        renameSync(file, aside)
        onWarn(`dsh-computers: ${file} was not valid JSON; moved to ${aside}`)
      } catch {
        onWarn(`dsh-computers: ${file} was not valid JSON`)
      }
      doc = emptyState()
    }
  }

  /** Write the document atomically: tmp file in the same directory, then rename. */
  const persist = () => {
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const tmp = join(stateDir, `.state.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        chmodSync(tmp, 0o600)
      } catch {
        // Platforms without POSIX modes (Windows) simply skip this.
      }
      renameSync(tmp, file)
    } catch (error) {
      onWarn(`dsh-computers: cannot write ${file}: ${error && error.message ? error.message : error}`)
    }
  }

  load()
  prunePendingKeys(doc, now())
  persist()

  return {
    /** Absolute state directory. */
    dir: stateDir,
    /** Absolute state file path. */
    file,
    /** Read-only view of the live document (callers must not mutate it). */
    read: () => doc,
    /** Deep copy for responses that must not alias live state. */
    snapshot: () => JSON.parse(JSON.stringify(doc)),
    /**
     * Run one atomic read-modify-write: prune, apply `change`, persist.
     * @param {(document: object) => unknown} change - mutation callback.
     * @returns {unknown} whatever `change` returned.
     */
    mutate(change) {
      const result = change(doc)
      prunePendingKeys(doc, now())
      persist()
      return result
    },
    /**
     * Refresh a computer's `lastSeenAt` (stream open, heartbeat, result POST).
     * @param {string} computerId - computer to touch.
     * @param {string} [at] - ISO timestamp; defaults to now.
     * @returns {boolean} whether the computer exists.
     */
    touch(computerId, at = new Date(now()).toISOString()) {
      const computer = doc.computers.find((entry) => entry.id === computerId)
      if (computer === undefined) return false
      computer.lastSeenAt = at
      persist()
      return true
    },
    /** Re-read the file from disk (used by tooling and the smoke harness). */
    reload: load,
    /** Expose the clock in use. */
    now,
  }
}
