/**
 * Relay account center + device directory (v1.8.0, task-40).
 *
 * The relay is still a dumb tunnel for `/r/<hubId>/…`; this module adds the
 * small amount of state that makes machines find each other without
 * per-machine pairing:
 *
 * ```
 * accounts.json
 *   acct_<16hex> → { name, secretHash, createdAt,
 *                    devices: { mach_<…>: { machineId, name, platform,
 *                                           hubId, entryUrl, lastSeenAt } } }
 * ```
 *
 * Design notes
 *
 * - **Secrets are never stored in clear.** A secret is minted once
 *   (`dshf_<32hex>`), returned exactly once from the create call, and only its
 *   SHA-256 hash is persisted. Verification hashes the presented value and
 *   compares the two fixed-size digests with `timingSafeEqual`, so a wrong
 *   secret cannot be recovered byte-by-byte from response timing.
 * - **One pasteable key (v1.9.1).** The create call also returns
 *   `dshk_<16hex account>_<32hex secret>`: the account id is baked into the
 *   key, so a caller that only has the key still names the account it wants
 *   and no lookup-by-secret (or extra "which account?" round trip) is needed.
 *   The key is pure formatting — nothing new is persisted, and the secret half
 *   is verified exactly like a bare secret.
 * - **`online` is computed at read time**, never persisted: a device is online
 *   while `now - lastSeenAt <= 120 s`, which is what the host's 60 s heartbeat
 *   needs (two missed beats ≈ offline).
 * - **Upsert by `machineId`.** A machine re-registering on every heartbeat
 *   updates `lastSeenAt` in place; it can never grow the directory past the
 *   per-account cap.
 * - **The document is disposable-but-durable**: same-directory tmp file +
 *   rename (never a half-written JSON), mode 0600, and a corrupt file is moved
 *   aside (`accounts.json.corrupt-<ms>`) instead of bricking the relay — a
 *   bad document costs the directory, never the service.
 *
 * Node builtins only; this file has no `process.exit` and never throws from a
 * request path (every failure is a typed `{ ok: false, code, message }`).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** On-disk schema version of `accounts.json`. */
export const ACCOUNTS_VERSION = 1

/** `acct_` + 16 lowercase hex characters. */
export const ACCOUNT_ID_RE = /^acct_[0-9a-f]{16}$/

/** A machine id is an opaque, URL-safe token minted by the host (`mach_…`). */
export const MACHINE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

/** Same alphabet the tunnel router accepts for a hub id. */
export const HUB_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

/** Hard limits, exported so the HTTP layer and tests can assert them. */
export const ACCOUNT_LIMITS = Object.freeze({
  /** Devices one account may register. */
  maxDevicesPerAccount: 200,
  /** Largest accepted JSON body for the account routes (8 KiB). */
  maxBodyBytes: 8 * 1024,
  /** Bytes discarded after the body cap so the 413 response can still be read. */
  maxDrainedBodyBytes: 64 * 1024,
  /** A device is online while its last registration is at most this old. */
  onlineWindowMs: 120 * 1000,
  /** Account display name cap. */
  maxNameChars: 64,
  /** Device display name cap. */
  maxDeviceNameChars: 128,
  /** Platform label cap (`darwin` / `linux` / `win32`). */
  maxPlatformChars: 32,
  /** Entry URL cap. */
  maxEntryUrlChars: 2048,
})

/** Where `accounts.json` lives when the relay is started without `--data-dir`. */
export const DEFAULT_DATA_DIR = './.relay'

/** Absolute path of the accounts document for one data directory. */
export function accountsFile(dataDir) {
  return join(dataDir, 'accounts.json')
}

/** SHA-256 digest of one string. @param {string} value @returns {Buffer} */
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** Hex SHA-256 of a secret, the only form ever written to disk. */
export function hashSecret(secret) {
  return sha256(String(secret)).toString('hex')
}

/**
 * Constant-time comparison of two strings (both are hashed first, so the
 * comparison is over fixed-size digests regardless of input length).
 * @param {unknown} left - first value.
 * @param {unknown} right - second value.
 * @returns {boolean} whether both are equal strings.
 */
export function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return timingSafeEqual(sha256(left), sha256(right))
}

/**
 * Constant-time verification of a presented secret against a stored hash.
 * @param {unknown} presented - secret the caller sent.
 * @param {unknown} storedHash - hex SHA-256 from `accounts.json`.
 * @returns {boolean} whether the secret matches.
 */
export function verifySecret(presented, storedHash) {
  if (typeof presented !== 'string' || presented === '') return false
  if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false
  return timingSafeEqual(sha256(presented), Buffer.from(storedHash, 'hex'))
}

/** Prefix of the composite, pasteable account key (v1.9.1). */
export const FLEET_KEY_PREFIX = 'dshk_'

/**
 * `dshk_` + 16 hex (the `acct_` id body) + `_` + 32 hex (the `dshf_` secret
 * body). Anchored and lowercase-only on purpose: the key is a credential, not
 * a free-form string, so every deviation is a 400 `invalid-key`.
 */
export const FLEET_KEY_RE = /^dshk_([0-9a-f]{16})_([0-9a-f]{32})$/

/** Longest key we will even look at (the real one is 54 chars). */
const MAX_FLEET_KEY_CHARS = 128

/** The one 400 message for every malformed key. */
const FLEET_KEY_SHAPE = `a fleet key looks like ${FLEET_KEY_PREFIX}<16 hex>_<32 hex>`

/** Strip an optional `acct_` prefix from an account id body. */
function accountIdBody(value) {
  if (typeof value !== 'string') return null
  return value.startsWith('acct_') ? value.slice('acct_'.length) : value
}

/** Strip an optional `dshf_` prefix from a secret body. */
function secretBody(value) {
  if (typeof value !== 'string') return null
  return value.startsWith('dshf_') ? value.slice('dshf_'.length) : value
}

/**
 * Build the composite key from an account id and a secret.
 *
 * Accepts both the full forms (`acct_<16hex>` / `dshf_<32hex>`) and the bare
 * hex bodies, so callers that already hold either representation can format
 * the key without re-parsing. Invalid input is a programmer error → TypeError.
 *
 * @param {string} accountId - `acct_<16hex>` or the 16 hex characters.
 * @param {string} secret - `dshf_<32hex>` or the 32 hex characters.
 * @returns {string} `dshk_<16hex>_<32hex>`.
 */
export function formatFleetKey(accountId, secret) {
  const idHex = accountIdBody(accountId)
  const secretHex = secretBody(secret)
  if (idHex === null || !/^[0-9a-f]{16}$/.test(idHex)) {
    throw new TypeError('accountId must be acct_<16 lowercase hex>')
  }
  if (secretHex === null || !/^[0-9a-f]{32}$/.test(secretHex)) {
    throw new TypeError('secret must be dshf_<32 lowercase hex>')
  }
  return `${FLEET_KEY_PREFIX}${idHex}_${secretHex}`
}

/**
 * Parse a composite key back into `{ accountId, secret }`.
 *
 * Leading/trailing whitespace is trimmed (a pasted key usually drags a newline
 * along); everything else must match {@link FLEET_KEY_RE} exactly. Never
 * throws — a bad key is a typed failure the HTTP layer turns into 400.
 *
 * @param {unknown} value - `x-fleet-key` header or `key` body field.
 * @returns {{ok: true, accountId: string, secret: string}
 *   | {ok: false, code: 'invalid_key', message: string}}
 */
export function parseFleetKey(value) {
  if (typeof value !== 'string') {
    return { ok: false, code: 'invalid_key', message: FLEET_KEY_SHAPE }
  }
  const key = value.trim()
  if (key === '' || key.length > MAX_FLEET_KEY_CHARS) {
    return { ok: false, code: 'invalid_key', message: FLEET_KEY_SHAPE }
  }
  const match = FLEET_KEY_RE.exec(key)
  if (match === null) {
    return { ok: false, code: 'invalid_key', message: FLEET_KEY_SHAPE }
  }
  return { ok: true, accountId: `acct_${match[1]}`, secret: `dshf_${match[2]}` }
}

/** A fresh, empty document. */
function emptyDocument() {
  return { version: ACCOUNTS_VERSION, accounts: {} }
}

/** True for a plain JSON object (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Reject control characters in user-supplied labels. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/

/** Account display name: optional, trimmed, bounded, printable. */
export function normalizeAccountName(value) {
  if (value === undefined || value === null) return { ok: true, name: '' }
  if (typeof value !== 'string') {
    return { ok: false, code: 'invalid_name', message: 'name must be a string' }
  }
  const name = value.trim()
  if (name.length > ACCOUNT_LIMITS.maxNameChars) {
    return {
      ok: false,
      code: 'invalid_name',
      message: `name must be at most ${ACCOUNT_LIMITS.maxNameChars} characters`,
    }
  }
  if (CONTROL_CHARS_RE.test(name)) {
    return { ok: false, code: 'invalid_name', message: 'name must not contain control characters' }
  }
  return { ok: true, name }
}

/** An absolute `http:`/`https:` URL, or false. */
export function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > ACCOUNT_LIMITS.maxEntryUrlChars) return false
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host !== ''
}

/**
 * Validate and normalize one device registration.
 *
 * `entryUrl` is the only field with real security weight: it must be an
 * absolute http(s) URL, because other machines will dial it. It is *not*
 * fetched here (the relay never dials it) — validation just keeps the
 * directory honest.
 *
 * @param {unknown} input - `device` from the request body.
 * @returns {{ok: true, device: object} | {ok: false, code: string, message: string}}
 */
export function validateDevice(input) {
  if (!isPlainObject(input)) {
    return { ok: false, code: 'invalid_device', message: 'device must be a JSON object' }
  }
  const { machineId } = input
  if (typeof machineId !== 'string' || !MACHINE_ID_RE.test(machineId)) {
    return {
      ok: false,
      code: 'invalid_machine_id',
      message: 'device.machineId must match /^[A-Za-z0-9._-]{1,128}$/',
    }
  }

  let name = machineId
  if (input.name !== undefined && input.name !== null) {
    if (typeof input.name !== 'string') {
      return { ok: false, code: 'invalid_device_name', message: 'device.name must be a string' }
    }
    name = input.name.trim()
    if (name === '') name = machineId
    if (name.length > ACCOUNT_LIMITS.maxDeviceNameChars) {
      return {
        ok: false,
        code: 'invalid_device_name',
        message: `device.name must be at most ${ACCOUNT_LIMITS.maxDeviceNameChars} characters`,
      }
    }
    if (CONTROL_CHARS_RE.test(name)) {
      return {
        ok: false,
        code: 'invalid_device_name',
        message: 'device.name must not contain control characters',
      }
    }
  }

  let platform = ''
  if (input.platform !== undefined && input.platform !== null) {
    if (typeof input.platform !== 'string' || input.platform.length > ACCOUNT_LIMITS.maxPlatformChars) {
      return {
        ok: false,
        code: 'invalid_platform',
        message: `device.platform must be a string of at most ${ACCOUNT_LIMITS.maxPlatformChars} characters`,
      }
    }
    platform = input.platform.trim()
    if (CONTROL_CHARS_RE.test(platform)) {
      return { ok: false, code: 'invalid_platform', message: 'device.platform must not contain control characters' }
    }
  }

  let hubId = ''
  if (input.hubId !== undefined && input.hubId !== null) {
    if (typeof input.hubId !== 'string' || (input.hubId !== '' && !HUB_ID_RE.test(input.hubId))) {
      return {
        ok: false,
        code: 'invalid_hub_id',
        message: 'device.hubId must be empty or match /^[A-Za-z0-9._-]{1,128}$/',
      }
    }
    hubId = input.hubId
  }

  if (!isHttpUrl(input.entryUrl)) {
    return {
      ok: false,
      code: 'invalid_entry_url',
      message: 'device.entryUrl must be an absolute http(s) URL',
    }
  }

  return {
    ok: true,
    device: { machineId, name, platform, hubId, entryUrl: input.entryUrl },
  }
}

/** Public (secret-free) view of one account. */
function publicAccount(account) {
  return {
    accountId: account.accountId,
    name: account.name,
    createdAt: account.createdAt,
    deviceCount: Object.keys(account.devices).length,
  }
}

/**
 * Create the in-memory account store backed by `${dataDir}/accounts.json`.
 *
 * Every mutation is synchronous: the document is tiny (a few hundred devices),
 * the relay is single-threaded, and a read-modify-write that cannot interleave
 * is worth more here than async I/O.
 *
 * @param {object} [options] - store options.
 * @param {string} [options.dataDir] - directory for `accounts.json` (`./.relay`).
 * @param {() => number} [options.now] - clock, injectable for the online window.
 * @param {number} [options.onlineWindowMs] - online window (120 s).
 * @param {number} [options.maxDevicesPerAccount] - device cap (200).
 * @param {(message: string) => void} [options.log] - warning sink (never throws).
 * @returns {object} store with create/auth/list/upsert/remove methods.
 */
export function createAccountStore(options = {}) {
  const {
    dataDir = DEFAULT_DATA_DIR,
    now = Date.now,
    onlineWindowMs = ACCOUNT_LIMITS.onlineWindowMs,
    maxDevicesPerAccount = ACCOUNT_LIMITS.maxDevicesPerAccount,
    log = null,
  } = options

  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('dataDir must be a non-empty string')
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  if (!Number.isSafeInteger(onlineWindowMs) || onlineWindowMs < 1) {
    throw new TypeError('onlineWindowMs must be a positive integer')
  }
  if (!Number.isSafeInteger(maxDevicesPerAccount) || maxDevicesPerAccount < 1) {
    throw new TypeError('maxDevicesPerAccount must be a positive integer')
  }

  const dir = dataDir
  const file = accountsFile(dir)
  /** Optional logger that can never throw into a request path. */
  const warn = (message) => {
    if (typeof log !== 'function') return
    try {
      log(message)
    } catch {
      // ignore
    }
  }

  /** ISO timestamp from the injected clock. */
  const timestamp = () => new Date(now()).toISOString()

  /**
   * Read + sanitize the document. Missing → empty. Corrupt → moved aside and
   * empty (a bad directory must never stop the relay from serving tunnels).
   * @returns {object} sanitized document.
   */
  function load() {
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warn(`[relay] cannot read ${file}: ${error?.message ?? error}`)
      }
      return emptyDocument()
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      const aside = `${file}.corrupt-${now()}`
      try {
        renameSync(file, aside)
        warn(`[relay] ${file} was not valid JSON; moved to ${aside}`)
      } catch {
        warn(`[relay] ${file} was not valid JSON`)
      }
      return emptyDocument()
    }
    return sanitize(parsed)
  }

  /** Keep only well-formed accounts/devices from an on-disk document. */
  function sanitize(parsed) {
    const doc = emptyDocument()
    if (!isPlainObject(parsed) || !isPlainObject(parsed.accounts)) return doc
    for (const [accountId, value] of Object.entries(parsed.accounts)) {
      if (!ACCOUNT_ID_RE.test(accountId) || !isPlainObject(value)) continue
      if (typeof value.secretHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.secretHash)) continue
      const devices = {}
      if (isPlainObject(value.devices)) {
        for (const [machineId, device] of Object.entries(value.devices)) {
          const checked = validateDevice(device)
          if (!checked.ok || checked.device.machineId !== machineId) continue
          const lastSeenAt = typeof device.lastSeenAt === 'string' ? device.lastSeenAt : ''
          const firstSeenAt = typeof device.firstSeenAt === 'string' ? device.firstSeenAt : lastSeenAt
          devices[machineId] = { ...checked.device, firstSeenAt, lastSeenAt }
        }
      }
      doc.accounts[accountId] = {
        accountId,
        name: typeof value.name === 'string' ? value.name.slice(0, ACCOUNT_LIMITS.maxNameChars) : '',
        secretHash: value.secretHash,
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : timestamp(),
        devices,
      }
    }
    return doc
  }

  /**
   * Write the whole document atomically (same-directory tmp + rename, 0600).
   * Never throws; a failed write leaves the in-memory copy authoritative.
   * @returns {boolean} whether the document reached disk.
   */
  function persist() {
    let tmp = null
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        chmodSync(tmp, 0o600)
      } catch {
        // Windows has no POSIX modes; the 0600 intent still holds elsewhere.
      }
      renameSync(tmp, file)
      tmp = null
      return true
    } catch (error) {
      warn(`[relay] cannot write ${file}: ${error?.message ?? error}`)
      return false
    } finally {
      if (tmp !== null) {
        try {
          // A leftover tmp file would only confuse operators; best-effort.
          unlinkSync(tmp)
        } catch {
          // ignore
        }
      }
    }
  }

  /** Mint an id that is not already used. */
  function mintAccountId() {
    for (;;) {
      const accountId = `acct_${randomBytes(8).toString('hex')}`
      if (doc.accounts[accountId] === undefined) return accountId
    }
  }

  let doc = load()

  return {
    /** Absolute path of the backing document. */
    filePath: file,
    /** Directory holding the document. */
    dataDir: dir,
    /** Online window used by `listDevices`. */
    onlineWindowMs,

    /** Number of accounts (the `/health` counter). */
    count() {
      return Object.keys(doc.accounts).length
    },

    /** Secret-free account metadata, sorted by creation time. */
    accounts() {
      return Object.values(doc.accounts)
        .map(publicAccount)
        .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0))
    },

    /** Secret-free metadata for one account, or null. */
    getAccount(accountId) {
      const account = doc.accounts[accountId]
      return account === undefined ? null : publicAccount(account)
    },

    /**
     * Create an account and persist it. The returned secret is the only copy
     * that will ever exist in clear text; `key` is that secret combined with
     * the account id for one-field login (nothing extra is stored).
     * @param {{name?: unknown}} [input] - optional display name.
     * @returns {{ok: true, accountId: string, secret: string, key: string,
     *   name: string} | {ok: false, code: string, message: string}}
     */
    createAccount(input = {}) {
      const named = normalizeAccountName(input?.name)
      if (!named.ok) return named
      const accountId = mintAccountId()
      const secret = `dshf_${randomBytes(16).toString('hex')}`
      const createdAt = timestamp()
      doc.accounts[accountId] = {
        accountId,
        name: named.name,
        secretHash: hashSecret(secret),
        createdAt,
        devices: {},
      }
      persist()
      return { ok: true, accountId, secret, key: formatFleetKey(accountId, secret), name: named.name }
    },

    /**
     * Authenticate a request against one account.
     * @param {unknown} accountId - path parameter.
     * @param {unknown} secret - presented secret (body or header).
     * @returns {{ok: true, account: object} | {ok: false, code: string, message: string}}
     */
    authenticate(accountId, secret) {
      const account = typeof accountId === 'string' ? doc.accounts[accountId] : undefined
      if (account === undefined) {
        return { ok: false, code: 'unknown_account', message: 'no such account' }
      }
      if (!verifySecret(secret, account.secretHash)) {
        return { ok: false, code: 'invalid_secret', message: 'the account secret is wrong' }
      }
      return { ok: true, account: publicAccount(account) }
    },

    /**
     * List devices with `online` computed from the injected clock.
     * @param {string} accountId - account id.
     * @returns {object[] | null} devices, or null for an unknown account.
     */
    listDevices(accountId) {
      const account = doc.accounts[accountId]
      if (account === undefined) return null
      const nowMs = now()
      return Object.values(account.devices)
        .map((device) => {
          const seenMs = typeof device.lastSeenAt === 'string' ? Date.parse(device.lastSeenAt) : Number.NaN
          const online = Number.isFinite(seenMs) && nowMs - seenMs <= onlineWindowMs
          return {
            machineId: device.machineId,
            name: device.name,
            platform: device.platform,
            hubId: device.hubId,
            entryUrl: device.entryUrl,
            online,
            lastSeenAt: device.lastSeenAt,
          }
        })
        .sort((left, right) => (left.machineId < right.machineId ? -1 : left.machineId > right.machineId ? 1 : 0))
    },

    /**
     * Insert or refresh one device, keyed by `machineId`.
     * @param {string} accountId - account id.
     * @param {unknown} input - raw `device` object from the request.
     * @returns {{ok: true, deviceId: string} | {ok: false, code: string, message: string}}
     */
    upsertDevice(accountId, input) {
      const account = doc.accounts[accountId]
      if (account === undefined) {
        return { ok: false, code: 'unknown_account', message: 'no such account' }
      }
      const checked = validateDevice(input)
      if (!checked.ok) return checked
      const { device } = checked
      const existing = account.devices[device.machineId]
      if (existing === undefined && Object.keys(account.devices).length >= maxDevicesPerAccount) {
        return {
          ok: false,
          code: 'too_many_devices',
          message: `an account may register at most ${maxDevicesPerAccount} devices`,
        }
      }
      const lastSeenAt = timestamp()
      account.devices[device.machineId] = {
        ...device,
        firstSeenAt: existing === undefined ? lastSeenAt : existing.firstSeenAt,
        lastSeenAt,
      }
      persist()
      return { ok: true, deviceId: device.machineId }
    },

    /**
     * Remove one device. Idempotent: an unknown `machineId` is still `ok`.
     * @param {string} accountId - account id.
     * @param {string} machineId - device to remove.
     * @returns {{ok: true} | {ok: false, code: string, message: string}}
     */
    removeDevice(accountId, machineId) {
      const account = doc.accounts[accountId]
      if (account === undefined) {
        return { ok: false, code: 'unknown_account', message: 'no such account' }
      }
      if (typeof machineId === 'string' && Object.hasOwn(account.devices, machineId)) {
        delete account.devices[machineId]
        persist()
      }
      return { ok: true }
    },
  }
}
