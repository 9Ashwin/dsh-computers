/**
 * Tiny semantic-version helpers for the agent version gate (PROTOCOL §11.1,
 * §11.6.5). Agent versions are ordinary `x.y.z` strings (optionally `v`-prefixed);
 * anything unparseable fails the gate closed with an actionable message.
 *
 * Node builtins only.
 */

/**
 * Parse `1.2.3` / `v1.2.3` / `1.2` into numeric parts, or null.
 * @param {unknown} value - version text.
 * @returns {number[] | null} up to three numbers.
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

/**
 * The `major.minor` prefix of a version (the default agent version gate).
 * @param {unknown} value - version text.
 * @returns {string} major.minor, or '' when unparseable.
 */
export function majorMinor(value) {
  const parts = parseVersion(value)
  return parts === null ? '' : `${parts[0]}.${parts[1]}`
}

/**
 * Whether `actual` is at least `minimum`. A missing/unparseable `minimum`
 * admits everything; a missing/unparseable `actual` is treated as v0 and so
 * fails any real minimum (an unknown agent is an old agent).
 * @param {unknown} actual - reported agent version.
 * @param {unknown} minimum - required version, or empty for none.
 * @returns {boolean} whether the agent satisfies the gate.
 */
export function versionAtLeast(actual, minimum) {
  const required = parseVersion(minimum)
  if (required === null) return true
  const reported = parseVersion(actual)
  if (reported === null) return false
  for (let index = 0; index < 3; index += 1) {
    if (reported[index] > required[index]) return true
    if (reported[index] < required[index]) return false
  }
  return true
}

/**
 * Whether two reported versions differ enough to show a drift badge.
 * @param {unknown} actual - reported version.
 * @param {unknown} expected - host plugin version.
 * @returns {boolean} true when they differ or the agent version is unknown.
 */
export function versionsDiffer(actual, expected) {
  const left = parseVersion(actual)
  const right = parseVersion(expected)
  if (left === null || right === null) return true
  return left[0] !== right[0] || left[1] !== right[1] || left[2] !== right[2]
}
