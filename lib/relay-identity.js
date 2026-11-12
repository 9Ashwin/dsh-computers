/**
 * Persistent relay identity + runtime switch (v1.6.0, docs/relay-design.md §6.4).
 *
 * The hubId is the address other machines and the browser bookmark keep using:
 * `https://<relay>/r/<hubId>`. It is minted once, the first time relay is
 * enabled, and must survive restarts.
 *
 * It deliberately lives in its OWN document, `${stateDir}/relay.json`
 * (`{ version: 1, hubId, createdAt, enabled, url }`, mode 0600, atomic write),
 * and NOT in `state.json`: resetting the computer registry is a routine
 * troubleshooting step, and it must not orphan an address that was already
 * bookmarked on a phone or pasted into another machine. Deleting `relay.json`
 * is the documented way to rotate/revoke the address (design §8.2).
 *
 * `enabled` is the runtime switch (v1.6.1): the settings page persists the
 * on/off decision here instead of asking the operator to edit
 * `cordis.patch.yml`. `null` (or an absent field, which is how a pre-v1.6.1
 * document reads) means "follow the config default", so an existing deployment
 * keeps its behaviour until someone flips the switch.
 *
 * `url` is the same kind of runtime override (v1.7.1): the settings page can
 * set the relay address too, so a deployment needs no `relay.url` in config at
 * all. `null` (or absent) means "follow `config.relay.url`"; writing `''` from
 * the UI clears the override and falls back to the config value. Both
 * overrides are additive fields: a pre-v1.7.1 document still reads correctly.
 *
 * Corrupt files are moved aside by {@link readJsonTolerant}, so a half-written
 * document costs a new hubId at worst — never a plugin that cannot load.
 *
 * Node builtins only.
 */

import { unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { readJsonTolerant, writeJsonAtomic } from './state.js'

/** On-disk schema version of `relay.json`. `enabled`/`url` are additive fields. */
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

/** The `enabled` override a document carries: a boolean, or null (follow config). */
function overrideOf(raw) {
  return typeof raw?.enabled === 'boolean' ? raw.enabled : null
}

/**
 * The `url` override a document carries: a non-empty string, or null (follow
 * config). `''` is how a cleared override is written, so it reads as null.
 */
function urlOverrideOf(raw) {
  if (typeof raw?.url !== 'string') return null
  const trimmed = raw.url.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Read the persisted hubId, switch override and address override. A
 * missing/corrupt document reads as `null`, which means "mint a new id on the
 * next enable and follow the config defaults".
 *
 * A document that has an override but no usable hubId still yields the
 * override: the operator's intent is worth honouring even if the address was
 * damaged, and the manager mints a fresh hubId the next time it turns on.
 * @param {string} stateDir - resolved state directory.
 * @param {{ onWarn?: (message: string) => void, now?: () => number }} [options] - warning sink and clock.
 * @returns {{ hubId: string, createdAt: string | null, enabled: boolean | null, url: string | null } | null} identity or null.
 */
export function readRelayIdentity(stateDir, { onWarn = () => {}, now = Date.now } = {}) {
  const raw = readJsonTolerant(relayIdentityFile(stateDir), { onWarn, now })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const hubId = isHubId(raw.hubId) ? raw.hubId : ''
  const enabled = overrideOf(raw)
  const url = urlOverrideOf(raw)
  // Nothing at all to carry forward: no address, no switch, no relay url.
  if (hubId === '' && enabled === null && url === null) return null
  return {
    hubId,
    createdAt: typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : null,
    enabled,
    url,
  }
}

/**
 * Persist the identity + runtime overrides (atomic, 0600).
 *
 * Omitted fields are preserved from the previous document:
 * - `createdAt` keeps meaning "this address was created at";
 * - `enabled` stays whatever the last explicit switch decision was, so writing
 *   the hubId never silently resets the UI override. Pass `enabled: null`
 *   explicitly to clear the override and follow the config default again;
 * - `url` keeps the last explicit address override. Pass `url: ''` (or
 *   `url: null`) to clear it and follow `config.relay.url` again.
 *
 * `hubId` may be empty while a UI override exists: the settings page can set
 * the relay address before the first enable mints an id. A later write with an
 * empty `hubId` never erases an already-persisted one.
 * @param {string} stateDir - resolved state directory.
 * @param {{ hubId?: string, createdAt?: string | null, enabled?: boolean | null, url?: string | null }} identity - identity to write.
 * @param {{ onWarn?: (message: string) => void, now?: () => number }} [options] - warning sink and clock.
 * @returns {boolean} whether the write succeeded.
 */
export function writeRelayIdentity(stateDir, identity, { onWarn = () => {}, now = Date.now } = {}) {
  // Re-read so a field-only write does not drop the other fields. The read is
  // tolerant: a corrupt file is moved aside and simply contributes nothing.
  const previous = readRelayIdentity(stateDir, { onWarn, now })
  const hubId = isHubId(identity?.hubId)
    ? identity.hubId
    : (previous !== null && isHubId(previous.hubId) ? previous.hubId : '')
  const createdAt = typeof identity?.createdAt === 'string' && Number.isFinite(Date.parse(identity.createdAt))
    ? identity.createdAt
    : (previous?.createdAt ?? new Date(now()).toISOString())
  let enabled
  if (identity?.enabled === true || identity?.enabled === false) enabled = identity.enabled
  else if (identity?.enabled === null) enabled = null
  else enabled = previous?.enabled ?? null
  let url
  if (typeof identity?.url === 'string') {
    const trimmed = identity.url.trim()
    url = trimmed === '' ? null : trimmed
  } else if (identity?.url === null) {
    url = null
  } else {
    url = previous?.url ?? null
  }
  // Nothing meaningful left (no address, no switch, no relay url): clearing the
  // last override deletes the document rather than keeping an empty one. That
  // is also the documented way to rotate the address (design §8.2).
  if (hubId === '' && enabled === null && url === null) {
    try {
      unlinkSync(relayIdentityFile(stateDir))
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        onWarn(`dsh-computers: cannot remove ${relayIdentityFile(stateDir)}: ${error.message}`)
        return false
      }
    }
    return true
  }
  return writeJsonAtomic(relayIdentityFile(stateDir), {
    version: RELAY_IDENTITY_VERSION,
    hubId,
    createdAt,
    enabled,
    url,
  }, {
    dir: stateDir,
    onWarn,
  })
}
