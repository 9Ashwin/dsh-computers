/**
 * Persistent relay identity (v1.6.0, docs/relay-design.md §6.4).
 *
 * The hubId is the address other machines and the browser bookmark keep using:
 * `https://<relay>/r/<hubId>`. It is minted once, the first time relay is
 * enabled, and must survive restarts.
 *
 * It deliberately lives in its OWN document, `${stateDir}/relay.json`
 * (`{ version: 1, hubId, createdAt }`, mode 0600, atomic write), and NOT in
 * `state.json`: resetting the computer registry is a routine troubleshooting
 * step, and it must not orphan an address that was already bookmarked on a
 * phone or pasted into another machine. Deleting `relay.json` is the documented
 * way to rotate/revoke the address (design §8.2).
 *
 * Corrupt files are moved aside by {@link readJsonTolerant}, so a half-written
 * document costs a new hubId at worst — never a plugin that cannot load.
 *
 * Node builtins only.
 */

import { join } from 'node:path'

import { readJsonTolerant, writeJsonAtomic } from './state.js'

/** On-disk schema version of `relay.json`. */
export const RELAY_IDENTITY_VERSION = 1

/**
 * The hubId alphabet: URL-safe, greppable, and exactly what the relay's
 * `/r/<hubId>` router and `lib/relay/hub-link.js` accept.
 */
export const HUB_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/** True for a hubId this plugin and the relay both accept. */
export function isHubId(value) {
  return typeof value === 'string' && HUB_ID_PATTERN.test(value)
}

/**
 * Absolute path of the relay identity document.
 * @param {string} stateDir - resolved state directory.
 * @returns {string} `${stateDir}/relay.json`.
 */
export function relayIdentityFile(stateDir) {
  return join(stateDir, 'relay.json')
}

/**
 * Read the persisted hubId. Missing/corrupt/invalid documents read as `null`,
 * which simply means "mint a new one on the next enable".
 * @param {string} stateDir - resolved state directory.
 * @param {{ onWarn?: (message: string) => void, now?: () => number }} [options] - warning sink and clock.
 * @returns {{ hubId: string, createdAt: string | null } | null} identity or null.
 */
export function readRelayIdentity(stateDir, { onWarn = () => {}, now = Date.now } = {}) {
  const raw = readJsonTolerant(relayIdentityFile(stateDir), { onWarn, now })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!isHubId(raw.hubId)) return null
  return {
    hubId: raw.hubId,
    createdAt: typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : null,
  }
}

/**
 * Persist the hubId (atomic, 0600). `createdAt` is kept from the previous
 * document when the id did not change, so it really means "this address was
 * created at".
 * @param {string} stateDir - resolved state directory.
 * @param {{ hubId: string, createdAt?: string | null }} identity - identity to write.
 * @param {{ onWarn?: (message: string) => void, now?: () => number }} [options] - warning sink and clock.
 * @returns {boolean} whether the write succeeded.
 */
export function writeRelayIdentity(stateDir, identity, { onWarn = () => {}, now = Date.now } = {}) {
  const hubId = identity?.hubId
  if (!isHubId(hubId)) return false
  const createdAt = typeof identity?.createdAt === 'string' && Number.isFinite(Date.parse(identity.createdAt))
    ? identity.createdAt
    : new Date(now()).toISOString()
  return writeJsonAtomic(relayIdentityFile(stateDir), { version: RELAY_IDENTITY_VERSION, hubId, createdAt }, {
    dir: stateDir,
    onWarn,
  })
}
