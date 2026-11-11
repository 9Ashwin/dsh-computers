/**
 * Secrets and small value helpers for dsh-computers (PROTOCOL §2, §3.1).
 *
 * Enrollment keys and agent tokens share one shape — `dshc_` plus 32 random
 * bytes as base64url — but have different lifetimes: the key is single use
 * with a TTL, the token is long lived and the host stores only its sha256.
 *
 * Node builtins only.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Every secret this plugin mints carries this prefix. */
export const SECRET_PREFIX = 'dshc_'

/** Token bytes per secret (base64url-encodes to 43 characters). */
const SECRET_BYTES = 32

/** Mint one `dshc_<43 base64url>` secret. */
export function mintSecret() {
  return `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`
}

/** Mint one computer id: `cmp_` plus 12 lowercase hex characters. */
export function newComputerId() {
  return `cmp_${randomBytes(6).toString('hex')}`
}

/** Mint one exec request id: `req_` plus 24 hex characters. */
export function newRequestId() {
  return `req_${randomBytes(12).toString('hex')}`
}

/**
 * sha256 of a secret as lowercase hex — the only form the host persists.
 * @param {string} value - secret or arbitrary string.
 * @returns {string} 64 hex characters.
 */
export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

/**
 * Compare a presented token against a stored sha256 hash in constant time.
 * Digests always have the same length, so `timingSafeEqual` cannot throw on
 * the comparison itself; a malformed stored hash simply fails closed.
 * @param {string} presented - bearer token from the request.
 * @param {string} expectedHash - stored `tokenHash`.
 * @returns {boolean} whether the token matches.
 */
export function tokenMatches(presented, expectedHash) {
  if (typeof presented !== 'string' || typeof expectedHash !== 'string') return false
  let expected
  try {
    expected = Buffer.from(expectedHash, 'hex')
  } catch {
    return false
  }
  if (expected.length !== 32) return false
  const actual = createHash('sha256').update(presented, 'utf8').digest()
  return timingSafeEqual(actual, expected)
}

/**
 * Extract a bearer token from an `authorization` header.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {string | null} the token, or null when the header is absent/malformed.
 */
export function bearerToken(req) {
  const header = req?.headers?.authorization
  if (typeof header !== 'string') return null
  const match = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(header.trim())
  return match === null ? null : match[1]
}

/**
 * Whether an ISO timestamp is at or before `nowMs`.
 * @param {string} iso - timestamp to test.
 * @param {number} nowMs - current epoch milliseconds.
 * @returns {boolean} true when the timestamp is missing/unparseable or in the past.
 */
export function isExpired(iso, nowMs) {
  if (typeof iso !== 'string') return true
  const at = Date.parse(iso)
  return !Number.isFinite(at) || at <= nowMs
}

/**
 * Normalize a display name to 1–64 visible characters (trimmed, control
 * characters removed). Returns null when the result is unacceptable, so the
 * caller can answer 400 instead of storing garbage.
 * @param {unknown} raw - candidate from a request body.
 * @returns {string | null} the normalized name.
 */
export function normalizeDisplayName(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned === '') return null
  if ([...cleaned].length > 64) return null
  return cleaned
}

/** Human platform label for a Node `os.platform()` value. */
export function platformLabel(osName) {
  switch (String(osName)) {
    case 'darwin': return 'macOS'
    case 'linux': return 'Linux'
    case 'win32': return 'Windows'
    default: return 'Unknown'
  }
}

/**
 * Coerce an optional string field from a request body.
 * @param {unknown} value - candidate.
 * @param {number} maxLength - inclusive character cap.
 * @returns {string | null} the value or null.
 */
export function optionalString(value, maxLength = 256) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > maxLength) return null
  return trimmed
}

/**
 * Coerce an optional non-negative integer field from a request body.
 * @param {unknown} value - candidate.
 * @returns {number | null} the value or null.
 */
export function optionalCount(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null
  return value
}
