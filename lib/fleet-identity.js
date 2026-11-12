/**
 * Persistent fleet join identity (v1.7.0).
 *
 * Onboarding is ONE pasted string: `<advertisedBase>#join=<fleetToken>`. The
 * fragment never leaves the browser/terminal that holds it, so the token stays
 * out of reverse-proxy access logs and out of the hub's own request log; the
 * machine's agent parses it locally and posts `{ join }` to `/agent/enroll`.
 *
 * The token is the fleet credential: every machine the operator hands the
 * address to may join with it, until {@link rotateFleetIdentity} mints a new
 * one. That is deliberately weaker than a single-use key — the address is meant
 * to be pasted between machines — so it is long-lived, 128 bits of entropy, and
 * revocable in one call.
 *
 * It lives in its OWN document, `${stateDir}/fleet.json`
 * (`{ version: 1, joinToken, createdAt }`, mode 0600, atomic write), exactly
 * like `relay.json` and for the same reason: resetting the computer registry
 * (`state.json`) is a routine troubleshooting step and must NOT invalidate an
 * address that was already handed out. Deleting `fleet.json` is the manual way
 * to revoke the address; `POST /api/dsh-computers/fleet/rotate` does it without
 * touching anything else.
 *
 * Corrupt files are moved aside by {@link readJsonTolerant}, so a half-written
 * document costs a new token at worst — never a plugin that cannot load.
 *
 * Node builtins only.
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { readJsonTolerant, writeJsonAtomic } from './state.js'

/** On-disk schema version of `fleet.json`. */
export const FLEET_IDENTITY_VERSION = 1

/** Every fleet token carries this prefix, so it is greppable and distinct from `dshc_`. */
export const JOIN_TOKEN_PREFIX = 'dshf_'

/**
 * The exact token alphabet: `dshf_` + 32 lowercase hex characters (128 bits).
 * Anything else is not a token this module minted, so a corrupted document is
 * treated as absent rather than compared against.
 */
export const JOIN_TOKEN_PATTERN = /^dshf_[0-9a-f]{32}$/

/**
 * True for a fleet join token this plugin accepts.
 * @param {unknown} value - candidate.
 * @returns {boolean} whether it matches {@link JOIN_TOKEN_PATTERN}.
 */
export function isJoinToken(value) {
  return typeof value === 'string' && JOIN_TOKEN_PATTERN.test(value)
}

/**
 * Mint one fleet join token: `dshf_` + 32 hex characters.
 * @returns {string} a fresh token.
 */
export function mintJoinToken() {
  return `${JOIN_TOKEN_PREFIX}${randomBytes(16).toString('hex')}`
}

/**
 * Absolute path of the fleet identity document.
 * @param {string} stateDir - resolved state directory.
 * @returns {string} `${stateDir}/fleet.json`.
 */
export function fleetIdentityFile(stateDir) {
  return join(stateDir, 'fleet.json')
}

/** Normalize a persisted `createdAt`, or null when it is not a usable timestamp. */
function createdAtOf(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

/**
 * Read the persisted fleet identity. A missing/corrupt document — or one whose
 * `joinToken` is not a token this module would mint — reads as `null`, which
 * means "mint one on the next mount".
 * @param {string} stateDir - resolved state directory.
 * @param {{ onWarn?: (message: string) => void, now?: () => number }} [options] - warning sink and clock.
 * @returns {{ joinToken: string, createdAt: string | null } | null} identity or null.
 */
export function readFleetIdentity(stateDir, { onWarn = () => {}, now = Date.now } = {}) {
  const raw = readJsonTolerant(fleetIdentityFile(stateDir), { onWarn, now })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!isJoinToken(raw.joinToken)) return null
  return { joinToken: raw.joinToken, createdAt: createdAtOf(raw.createdAt) }
}

/**
 * Persist one fleet identity (atomic, 0600).
 *
 * `createdAt` keeps meaning "when the current token was minted": omit it and
 * the previous document's value is preserved (a hubId-style write never resets
 * it); pass a fresh ISO string to record a rotation.
 * @param {string} stateDir - resolved state directory.
 * @param {{ joinToken: string, createdAt?: string | null }} identity - identity to write.
 * @param {{ onWarn?: (message: string) => void, now?: () => number }} [options] - warning sink and clock.
 * @returns {boolean} whether the write succeeded.
 */
export function writeFleetIdentity(stateDir, identity, { onWarn = () => {}, now = Date.now } = {}) {
  const joinToken = identity?.joinToken
  if (!isJoinToken(joinToken)) return false
  // Re-read so a token-only write keeps the creation timestamp. The read is
  // tolerant: a corrupt file is moved aside and simply contributes nothing.
  const previous = readFleetIdentity(stateDir, { onWarn, now })
  const createdAt = createdAtOf(identity?.createdAt) ?? previous?.createdAt ?? new Date(now()).toISOString()
  return writeJsonAtomic(fleetIdentityFile(stateDir), {
    version: FLEET_IDENTITY_VERSION,
    joinToken,
    createdAt,
  }, {
    dir: stateDir,
    onWarn,
  })
}

/**
 * Read the persisted identity, minting and persisting one when it is missing.
 * A write failure is reported through `onWarn` but still returns the in-memory
 * identity: the hub can advertise a join address for this process lifetime, it
 * just cannot promise the address survives a restart.
 * @param {string} stateDir - resolved state directory.
 * @param {{ onWarn?: (message: string) => void, now?: () => number }} [options] - warning sink and clock.
 * @returns {{ joinToken: string, createdAt: string }} the live identity.
 */
export function ensureFleetIdentity(stateDir, { onWarn = () => {}, now = Date.now } = {}) {
  const existing = readFleetIdentity(stateDir, { onWarn, now })
  if (existing !== null) return existing
  const identity = { joinToken: mintJoinToken(), createdAt: new Date(now()).toISOString() }
  if (!writeFleetIdentity(stateDir, identity, { onWarn, now })) {
    onWarn('dsh-computers: could not persist the fleet join token; the join address will change on the next restart')
  }
  return identity
}

/**
 * Mint a new token, persist it, and return it. The previous token stops working
 * immediately (the routes compare against the live identity, not the file).
 * @param {string} stateDir - resolved state directory.
 * @param {{ onWarn?: (message: string) => void, now?: () => number }} [options] - warning sink and clock.
 * @returns {{ joinToken: string, createdAt: string } | null} the new identity, or null when it could not be persisted.
 */
export function rotateFleetIdentity(stateDir, { onWarn = () => {}, now = Date.now } = {}) {
  const identity = { joinToken: mintJoinToken(), createdAt: new Date(now()).toISOString() }
  return writeFleetIdentity(stateDir, identity, { onWarn, now }) ? identity : null
}

/**
 * The stateful view the routes hold: one live token, rotated in place.
 *
 * `rotate()` only adopts the new token after the document is safely on disk, so
 * a read-only state directory answers 500 instead of handing out a token that
 * dies with the process.
 * @param {object} options - identity options.
 * @param {string} options.stateDir - resolved state directory.
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 * @param {() => number} [options.now] - epoch-millisecond clock.
 * @returns {object} `{ file, read, token, rotate }`.
 */
export function createFleetIdentity({ stateDir, onWarn = () => {}, now = Date.now } = {}) {
  /** @type {{ joinToken: string, createdAt: string | null }} */
  let identity = ensureFleetIdentity(stateDir, { onWarn, now })
  return {
    /** Absolute `fleet.json` path (diagnostics + smoke assertions). */
    file: fleetIdentityFile(stateDir),
    /** Copy of the live identity (never aliases the internal object). */
    read: () => ({ ...identity }),
    /** The token the routes compare against. */
    token: () => identity.joinToken,
    /** Mint + persist a new token; null when persistence failed. */
    rotate() {
      const next = rotateFleetIdentity(stateDir, { onWarn, now })
      if (next === null) return null
      identity = next
      return { ...next }
    },
  }
}
