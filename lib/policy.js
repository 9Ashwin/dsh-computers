/**
 * Feature policy for one computer (refactor R2, docs/refactor-plan.md §3).
 *
 * Compatibility is decided by the agent's reported capability flags, not by a
 * version number: an agent that does not advertise a capability simply does not
 * get the feature, and the host never assumes "you should be new enough". The
 * only version-based decision left is the operator-forced `minAgentVersion`
 * upgrade gate (enforced in the tool layer, not here).
 *
 * Legacy derivation (agents before caps existed): `{exec:true, fs:<has fs>,
 * jobs:true, pty:false, tunnel:false}` — exactly the features those agents
 * actually had.
 *
 * R4 extends this file with the operation→permission table; `supports()` stays
 * the single feature predicate.
 */

import { CAPABILITIES, isPlainObject } from './contracts.js'

/** The five capabilities, re-exported as the policy feature vocabulary. */
export const POLICY_FEATURES = CAPABILITIES

/**
 * Flags for an agent that never reported `caps` (pre-R2a).
 * @param {{ capabilities?: string[] }} computer - registry record.
 * @returns {{exec:boolean,fs:boolean,jobs:boolean,pty:boolean,tunnel:boolean}} derived caps.
 */
export function legacyCaps(computer) {
  const capabilities = Array.isArray(computer?.capabilities)
    ? computer.capabilities.filter((entry) => typeof entry === 'string')
    : []
  return {
    exec: true,
    fs: capabilities.includes('fs'),
    jobs: true,
    pty: false,
    tunnel: false,
  }
}

/**
 * Normalize a reported caps object to all five booleans. Absent flags mean
 * "not supported" (except `exec`, which every agent has) — that is what makes
 * an older/newer agent hiding a feature behave correctly.
 * @param {unknown} value - `caps` from enroll/handshake/heartbeat.
 * @returns {object|null} normalized caps, or null when nothing was reported.
 */
export function normalizeCaps(value) {
  if (!isPlainObject(value)) return null
  return {
    exec: value.exec !== false,
    fs: value.fs === true,
    jobs: value.jobs === true,
    pty: value.pty === true,
    tunnel: value.tunnel === true,
  }
}

/**
 * The effective capabilities of a stored computer: reported `caps` when
 * present, otherwise the legacy derivation.
 * @param {object} computer - registry record.
 * @returns {{exec:boolean,fs:boolean,jobs:boolean,pty:boolean,tunnel:boolean}} caps.
 */
export function capsOf(computer) {
  return normalizeCaps(computer?.caps) ?? legacyCaps(computer)
}

/**
 * The single feature predicate used by tools, routes and the prompt section.
 * @param {object} computer - registry record.
 * @param {'exec'|'fs'|'jobs'|'pty'|'tunnel'} feature - capability name.
 * @returns {boolean} whether the feature may be used on that computer.
 */
export function supports(computer, feature) {
  if (typeof feature !== 'string' || !POLICY_FEATURES.includes(feature)) return false
  return capsOf(computer)[feature] === true
}
