/**
 * Integration tests for the relay account center + device directory
 * (v1.8.0, task-40), including the composite account key (v1.9.1, task-47).
 *
 * Run with: `node --test lib/relay/test/relay-accounts.test.mjs`, or the whole
 * relay suite with `npm run test:relay`.
 *
 * No external processes and no dependencies: every test starts the real relay
 * from `relay/main.mjs` on an ephemeral port against a throwaway data
 * directory, then talks to it with plain `node:http`. The clock is injected
 * (`createRelay({ now })`) so the 120 s online window can be crossed without
 * sleeping.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ACCOUNT_LIMITS,
  constantTimeEqual,
  createAccountStore,
  formatFleetKey,
  hashSecret,
  parseFleetKey,
  verifySecret,
} from '../accounts.js'
import { RELAY_LIMITS, createRelay } from '../../../relay/main.mjs'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const DEVICE_A = Object.freeze({
  machineId: 'mach_aaaaaaaaaaaaaaaa',
  name: 'mini',
  platform: 'darwin',
  hubId: 'hub_mini',
  entryUrl: 'https://relay.example/r/hub_mini',
})
const DEVICE_B = Object.freeze({
  machineId: 'mach_bbbbbbbbbbbbbbbb',
  name: 'air',
  platform: 'darwin',
  hubId: 'hub_air',
  entryUrl: 'https://relay.example/r/hub_air',
})

/**
 * One HTTP request against the relay. Buffers the response and never rejects
 * on a 4xx/5xx status. Object bodies are JSON-encoded automatically.
 */
function request({ port, path, method = 'GET', headers = {}, body = undefined, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers }
    let payload = body
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      payload = JSON.stringify(body)
      if (finalHeaders['content-type'] === undefined) finalHeaders['content-type'] = 'application/json'
    }
    if (payload !== undefined) finalHeaders['content-length'] = Buffer.byteLength(payload)
    let responded = false
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: finalHeaders })
    const timer = setTimeout(() => {
      req.destroy(new Error(`client timeout after ${timeoutMs} ms`))
    }, timeoutMs)
    timer.unref?.()
    req.on('response', (res) => {
      responded = true
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        clearTimeout(timer)
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      })
      res.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    req.on('error', (error) => {
      if (responded) return
      clearTimeout(timer)
      reject(error)
    })
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** Same as {@link request} but parses the JSON answer (null when not JSON). */
async function jsonRequest(options) {
  const res = await request(options)
  let body = null
  try {
    body = JSON.parse(res.body.toString('utf8'))
  } catch {
    body = null
  }
  return { status: res.status, headers: res.headers, body, raw: res.body.toString('utf8') }
}

/** Start the real relay on an ephemeral port with a throwaway data directory. */
async function startRelay(options = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'dsh-relay-accounts-'))
  const relay = createRelay({ host: '127.0.0.1', port: 0, ...options, dataDir })
  const address = await relay.listen()
  return {
    relay,
    dataDir,
    port: address.port,
    file: join(dataDir, 'accounts.json'),
    close: () => relay.close(),
    async dispose() {
      await relay.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** POST /api/fleet/accounts. */
function createAccount(fixture, { name, adminKey, headers = {} } = {}) {
  const finalHeaders = { ...headers }
  if (adminKey !== undefined) finalHeaders['x-admin-key'] = adminKey
  return jsonRequest({
    port: fixture.port,
    path: '/api/fleet/accounts',
    method: 'POST',
    headers: finalHeaders,
    body: { name },
  })
}

/** POST /api/fleet/accounts/<id>/devices (body secret by default). */
function registerDevice(fixture, accountId, secret, device, { viaHeader = false } = {}) {
  const headers = viaHeader ? { 'x-fleet-secret': secret } : {}
  return jsonRequest({
    port: fixture.port,
    path: `/api/fleet/accounts/${accountId}/devices`,
    method: 'POST',
    headers,
    body: viaHeader ? { device } : { secret, device },
  })
}

/** GET /api/fleet/accounts/<id>/devices. */
function listDevices(fixture, accountId, secret) {
  return jsonRequest({
    port: fixture.port,
    path: `/api/fleet/accounts/${accountId}/devices`,
    headers: secret === undefined ? {} : { 'x-fleet-secret': secret },
  })
}

/** DELETE /api/fleet/accounts/<id>/devices/<machineId>. */
function deleteDevice(fixture, accountId, secret, machineId) {
  return jsonRequest({
    port: fixture.port,
    path: `/api/fleet/accounts/${accountId}/devices/${encodeURIComponent(machineId)}`,
    method: 'DELETE',
    headers: secret === undefined ? {} : { 'x-fleet-secret': secret },
  })
}

/**
 * POST a device using only the composite key: `key` in the body by default,
 * `x-fleet-key` when `viaHeader` is set.
 */
function registerDeviceWithKey(fixture, accountId, key, device, { viaHeader = false } = {}) {
  const headers = viaHeader ? { 'x-fleet-key': key } : {}
  return jsonRequest({
    port: fixture.port,
    path: `/api/fleet/accounts/${accountId}/devices`,
    method: 'POST',
    headers,
    body: viaHeader ? { device } : { key, device },
  })
}

/** GET devices with only `x-fleet-key`. */
function listDevicesWithKey(fixture, accountId, key) {
  return jsonRequest({
    port: fixture.port,
    path: `/api/fleet/accounts/${accountId}/devices`,
    headers: { 'x-fleet-key': key },
  })
}

/** DELETE one device with only `x-fleet-key`. */
function deleteDeviceWithKey(fixture, accountId, key, machineId) {
  return jsonRequest({
    port: fixture.port,
    path: `/api/fleet/accounts/${accountId}/devices/${encodeURIComponent(machineId)}`,
    method: 'DELETE',
    headers: { 'x-fleet-key': key },
  })
}

/** Create one account and return `{ accountId, secret }`. */
async function bootstrap(fixture, options = {}) {
  const created = await createAccount(fixture, options)
  assert.equal(created.status, 201, `bootstrap failed: ${created.raw}`)
  return created.body
}

// ---------------------------------------------------------------------------
// bootstrap + admin key
// ---------------------------------------------------------------------------

test('accounts: a fresh relay bootstraps exactly one account, then requires an admin key', async () => {
  const fixture = await startRelay()
  try {
    const first = await createAccount(fixture, { name: 'Home' })
    assert.equal(first.status, 201)
    assert.match(first.body.accountId, /^acct_[0-9a-f]{16}$/)
    assert.match(first.body.secret, /^dshf_[0-9a-f]{32}$/)
    assert.equal(first.body.name, 'Home')

    // /health reports the count but never an id or a secret.
    const health = await jsonRequest({ port: fixture.port, path: '/health' })
    assert.equal(health.status, 200)
    assert.deepEqual(health.body, { ok: true, hubs: [], accounts: 1 })
    assert.equal(health.raw.includes(first.body.accountId), false)
    assert.equal(health.raw.includes(first.body.secret), false)

    // The bootstrap is one-shot: no second account without an admin key.
    const second = await createAccount(fixture, { name: 'Nope' })
    assert.equal(second.status, 403)
    assert.equal(second.body.error, 'admin-key-required')
    assert.equal(fixture.relay.accounts.count(), 1)
  } finally {
    await fixture.dispose()
  }
})

test('accounts: with an admin key configured, every creation requires the matching header', async () => {
  const adminKey = 'adm_test_key_0123456789'
  const fixture = await startRelay({ adminKey })
  try {
    const missing = await createAccount(fixture, { name: 'x' })
    assert.equal(missing.status, 403)
    assert.equal(missing.body.error, 'admin-key-required')

    const wrong = await createAccount(fixture, { name: 'x', adminKey: 'not-the-key' })
    assert.equal(wrong.status, 403)
    assert.equal(wrong.body.error, 'invalid-admin-key')

    const badName = await createAccount(fixture, { name: 'x'.repeat(ACCOUNT_LIMITS.maxNameChars + 1), adminKey })
    assert.equal(badName.status, 400)
    assert.equal(badName.body.error, 'invalid_name')

    const good = await createAccount(fixture, { name: 'ops', adminKey })
    assert.equal(good.status, 201)

    // The admin key is not bootstrap-limited: more accounts are allowed.
    const another = await createAccount(fixture, { name: 'ops-2', adminKey })
    assert.equal(another.status, 201)
    assert.notEqual(another.body.accountId, good.body.accountId)
    assert.equal(fixture.relay.accounts.count(), 2)
  } finally {
    await fixture.dispose()
  }
})

// ---------------------------------------------------------------------------
// device directory
// ---------------------------------------------------------------------------

test('accounts: two registered devices are listed with online state and lastSeenAt', async () => {
  const fixture = await startRelay()
  try {
    const { accountId, secret } = await bootstrap(fixture, { name: 'Home' })

    const first = await registerDevice(fixture, accountId, secret, DEVICE_A)
    assert.equal(first.status, 200)
    assert.deepEqual(first.body, { ok: true, deviceId: DEVICE_A.machineId })

    // Auth may travel in the header instead of the body.
    const second = await registerDevice(fixture, accountId, secret, DEVICE_B, { viaHeader: true })
    assert.equal(second.status, 200)

    const listed = await listDevices(fixture, accountId, secret)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.devices.length, 2)
    const mini = listed.body.devices.find((device) => device.machineId === DEVICE_A.machineId)
    assert.deepEqual(Object.keys(mini).sort(), [
      'entryUrl',
      'hubId',
      'lastSeenAt',
      'machineId',
      'name',
      'online',
      'platform',
    ])
    assert.equal(mini.name, 'mini')
    assert.equal(mini.platform, 'darwin')
    assert.equal(mini.hubId, 'hub_mini')
    assert.equal(mini.entryUrl, DEVICE_A.entryUrl)
    assert.equal(mini.online, true)
    assert.ok(Number.isFinite(Date.parse(mini.lastSeenAt)))
    // The secret never comes back out of the directory.
    assert.equal(listed.raw.includes(secret), false)
    assert.equal(listed.raw.includes('secretHash'), false)

    const unauthenticated = await listDevices(fixture, accountId)
    assert.equal(unauthenticated.status, 401)
    assert.equal(unauthenticated.body.error, 'invalid-secret')
  } finally {
    await fixture.dispose()
  }
})

test('accounts: a device goes offline after the 120 s window, and a heartbeat brings it back', async () => {
  assert.equal(ACCOUNT_LIMITS.onlineWindowMs, 120 * 1000)
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z')
  const fixture = await startRelay({ now: () => nowMs })
  try {
    const { accountId, secret } = await bootstrap(fixture)
    assert.equal((await registerDevice(fixture, accountId, secret, DEVICE_A)).status, 200)

    const fresh = await listDevices(fixture, accountId, secret)
    assert.equal(fresh.body.devices[0].online, true)
    assert.equal(fresh.body.devices[0].lastSeenAt, '2026-01-01T00:00:00.000Z')

    // Exactly at the window edge the device is still online…
    nowMs += ACCOUNT_LIMITS.onlineWindowMs
    assert.equal((await listDevices(fixture, accountId, secret)).body.devices[0].online, true)
    // …one millisecond later it is not.
    nowMs += 1
    const stale = await listDevices(fixture, accountId, secret)
    assert.equal(stale.body.devices[0].online, false)
    assert.equal(stale.body.devices[0].lastSeenAt, '2026-01-01T00:00:00.000Z')

    // A re-registration is the heartbeat: online again, one device only.
    assert.equal((await registerDevice(fixture, accountId, secret, DEVICE_A)).status, 200)
    const revived = await listDevices(fixture, accountId, secret)
    assert.equal(revived.body.devices.length, 1)
    assert.equal(revived.body.devices[0].online, true)
    assert.equal(revived.body.devices[0].lastSeenAt, '2026-01-01T00:02:00.001Z')
  } finally {
    await fixture.dispose()
  }
})

test('accounts: wrong secrets are 401 and unknown accounts are 404 on every device route', async () => {
  const fixture = await startRelay()
  try {
    const { accountId, secret } = await bootstrap(fixture)
    const wrongSecret = `dshf_${'0'.repeat(32)}`
    const unknownId = `acct_${'f'.repeat(16)}`

    for (const res of [
      await registerDevice(fixture, accountId, wrongSecret, DEVICE_A),
      await listDevices(fixture, accountId, wrongSecret),
      await deleteDevice(fixture, accountId, wrongSecret, DEVICE_A.machineId),
      await registerDevice(fixture, accountId, '', DEVICE_A),
    ]) {
      assert.equal(res.status, 401)
      assert.equal(res.body.error, 'invalid-secret')
    }

    for (const res of [
      await registerDevice(fixture, unknownId, secret, DEVICE_A),
      await listDevices(fixture, unknownId, secret),
      await deleteDevice(fixture, unknownId, secret, DEVICE_A.machineId),
    ]) {
      assert.equal(res.status, 404)
      assert.equal(res.body.error, 'unknown_account')
    }

    // Nothing was written by the rejected calls.
    assert.equal(fixture.relay.accounts.count(), 1)
    assert.equal((await listDevices(fixture, accountId, secret)).body.devices.length, 0)
  } finally {
    await fixture.dispose()
  }
})

test('accounts: device registration upserts by machineId instead of growing the directory', async () => {
  const fixture = await startRelay()
  try {
    const { accountId, secret } = await bootstrap(fixture)
    assert.equal((await registerDevice(fixture, accountId, secret, DEVICE_A)).status, 200)

    const updated = await registerDevice(fixture, accountId, secret, {
      ...DEVICE_A,
      name: 'mini-renamed',
      entryUrl: 'https://relay.example/r/hub_mini_new',
    })
    assert.equal(updated.status, 200)
    assert.deepEqual(updated.body, { ok: true, deviceId: DEVICE_A.machineId })

    const listed = await listDevices(fixture, accountId, secret)
    assert.equal(listed.body.devices.length, 1)
    assert.equal(listed.body.devices[0].name, 'mini-renamed')
    assert.equal(listed.body.devices[0].entryUrl, 'https://relay.example/r/hub_mini_new')
    // The persisted document agrees with the in-memory view.
    const onDisk = JSON.parse(readFileSync(fixture.file, 'utf8'))
    assert.equal(Object.keys(onDisk.accounts[accountId].devices).length, 1)
  } finally {
    await fixture.dispose()
  }
})

test('accounts: DELETE removes one device and is idempotent', async () => {
  const fixture = await startRelay()
  try {
    const { accountId, secret } = await bootstrap(fixture)
    await registerDevice(fixture, accountId, secret, DEVICE_A)
    await registerDevice(fixture, accountId, secret, DEVICE_B)

    const removed = await deleteDevice(fixture, accountId, secret, DEVICE_A.machineId)
    assert.equal(removed.status, 200)
    assert.deepEqual(removed.body, { ok: true })

    const listed = await listDevices(fixture, accountId, secret)
    assert.deepEqual(listed.body.devices.map((device) => device.machineId), [DEVICE_B.machineId])

    // Deleting again (or deleting something that never existed) is still ok.
    assert.equal((await deleteDevice(fixture, accountId, secret, DEVICE_A.machineId)).status, 200)
    assert.equal((await deleteDevice(fixture, accountId, secret, 'mach_unknown')).status, 200)
    assert.equal((await listDevices(fixture, accountId, secret)).body.devices.length, 1)
  } finally {
    await fixture.dispose()
  }
})

// ---------------------------------------------------------------------------
// composite account key (v1.9.1)
// ---------------------------------------------------------------------------

test('accounts: create returns one composite key that works on every device route', async () => {
  const fixture = await startRelay()
  try {
    const created = await bootstrap(fixture, { name: 'Home' })

    // Format: dshk_<accountId without acct_>_<secret without dshf_>.
    assert.match(created.key, /^dshk_[0-9a-f]{16}_[0-9a-f]{32}$/)
    assert.equal(
      created.key,
      `dshk_${created.accountId.slice('acct_'.length)}_${created.secret.slice('dshf_'.length)}`,
    )
    // The key is a pure format of the two values (no extra state anywhere).
    assert.deepEqual(parseFleetKey(created.key), {
      ok: true,
      accountId: created.accountId,
      secret: created.secret,
    })
    const onDisk = readFileSync(fixture.file, 'utf8')
    assert.equal(onDisk.includes(created.key), false)
    assert.equal(onDisk.includes(created.secret), false)

    // Register with only the key in the body…
    const viaBody = await registerDeviceWithKey(fixture, created.accountId, created.key, DEVICE_A)
    assert.equal(viaBody.status, 200, viaBody.raw)
    assert.deepEqual(viaBody.body, { ok: true, deviceId: DEVICE_A.machineId })
    // …and with only the key in the header.
    const viaHeader = await registerDeviceWithKey(fixture, created.accountId, created.key, DEVICE_B, {
      viaHeader: true,
    })
    assert.equal(viaHeader.status, 200, viaHeader.raw)

    // List and delete with only the key; the key never comes back out.
    const listed = await listDevicesWithKey(fixture, created.accountId, created.key)
    assert.equal(listed.status, 200)
    assert.deepEqual(
      listed.body.devices.map((device) => device.machineId),
      [DEVICE_A.machineId, DEVICE_B.machineId],
    )
    assert.equal(listed.raw.includes(created.key), false)
    assert.equal(listed.raw.includes(created.secret), false)
    const removed = await deleteDeviceWithKey(fixture, created.accountId, created.key, DEVICE_A.machineId)
    assert.equal(removed.status, 200)

    // A pasted key drags whitespace along: the body form is trimmed, not
    // rejected (HTTP headers cannot carry leading/trailing whitespace anyway).
    const pasted = await registerDeviceWithKey(fixture, created.accountId, `  ${created.key}\n`, DEVICE_A)
    assert.equal(pasted.status, 200, pasted.raw)
    assert.deepEqual(pasted.body, { ok: true, deviceId: DEVICE_A.machineId })

    // Back-compat: the bare secret keeps working (header and body).
    const viaSecret = await listDevices(fixture, created.accountId, created.secret)
    assert.equal(viaSecret.status, 200)
    assert.deepEqual(
      viaSecret.body.devices.map((device) => device.machineId),
      [DEVICE_A.machineId, DEVICE_B.machineId],
    )
    assert.equal((await registerDevice(fixture, created.accountId, created.secret, DEVICE_B)).status, 200)
  } finally {
    await fixture.dispose()
  }
})

test('accounts: a malformed key is 400 invalid-key and is never ignored', async () => {
  const fixture = await startRelay()
  try {
    const { accountId, secret, key } = await bootstrap(fixture)
    const malformed = [
      'dshk_',
      'dshk_nope',
      `dshk_${'a'.repeat(15)}_${'b'.repeat(32)}`, // 15 hex account id
      `dshk_${'a'.repeat(16)}_${'b'.repeat(31)}`, // 31 hex secret
      `dshk_${'a'.repeat(16)}_${'b'.repeat(32)}0`, // trailing garbage
      `dshk_${'A'.repeat(16)}_${'b'.repeat(32)}`, // uppercase hex
      `dshf_${'a'.repeat(16)}_${'b'.repeat(32)}`, // wrong prefix
      `dshk_${'a'.repeat(16)}-${'b'.repeat(32)}`, // wrong separator
      'x'.repeat(200), // over the length cap
    ]
    for (const bad of malformed) {
      for (const res of [
        await listDevicesWithKey(fixture, accountId, bad),
        await registerDeviceWithKey(fixture, accountId, bad, DEVICE_A),
        await deleteDeviceWithKey(fixture, accountId, bad, DEVICE_A.machineId),
      ]) {
        assert.equal(res.status, 400, `${bad} → ${res.status} ${res.raw}`)
        assert.equal(res.body.error, 'invalid-key')
      }
    }

    // A malformed key is an error even when a valid secret rides along: a
    // client that sends a key is asking for key auth, not "try both".
    const keyWins = await jsonRequest({
      port: fixture.port,
      path: `/api/fleet/accounts/${accountId}/devices`,
      method: 'POST',
      headers: { 'x-fleet-secret': secret },
      body: { key: 'dshk_bad', device: DEVICE_A },
    })
    assert.equal(keyWins.status, 400)
    assert.equal(keyWins.body.error, 'invalid-key')

    // A non-string key is malformed too (not silently treated as absent).
    const numericKey = await jsonRequest({
      port: fixture.port,
      path: `/api/fleet/accounts/${accountId}/devices`,
      method: 'POST',
      body: { key: 42, device: DEVICE_A },
    })
    assert.equal(numericKey.status, 400)
    assert.equal(numericKey.body.error, 'invalid-key')

    // Rejected calls wrote nothing; the valid key still works.
    assert.equal((await listDevices(fixture, accountId, secret)).body.devices.length, 0)
    assert.equal((await listDevicesWithKey(fixture, accountId, key)).status, 200)
  } finally {
    await fixture.dispose()
  }
})

test('accounts: a key for another account is 401 invalid-secret', async () => {
  const adminKey = 'adm_key_mismatch'
  const fixture = await startRelay({ adminKey })
  try {
    const first = await createAccount(fixture, { name: 'first', adminKey })
    const second = await createAccount(fixture, { name: 'second', adminKey })
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    assert.notEqual(first.body.accountId, second.body.accountId)

    // The key is self-describing, so the relay sees the disagreement itself.
    for (const res of [
      await listDevicesWithKey(fixture, first.body.accountId, second.body.key),
      await registerDeviceWithKey(fixture, first.body.accountId, second.body.key, DEVICE_A),
      await deleteDeviceWithKey(fixture, first.body.accountId, second.body.key, DEVICE_A.machineId),
    ]) {
      assert.equal(res.status, 401, res.raw)
      assert.equal(res.body.error, 'invalid-secret')
    }

    // Each key still opens exactly its own account; nothing leaked across.
    assert.equal((await listDevicesWithKey(fixture, first.body.accountId, first.body.key)).body.devices.length, 0)
    assert.equal(
      (await registerDeviceWithKey(fixture, second.body.accountId, second.body.key, DEVICE_B)).status,
      200,
    )
    assert.equal((await listDevicesWithKey(fixture, first.body.accountId, first.body.key)).body.devices.length, 0)
  } finally {
    await fixture.dispose()
  }
})

test('accounts: a key is not accepted after its account is deleted', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-relay-accounts-'))
  const first = await startRelay({ dataDir })
  let created
  try {
    created = await bootstrap(first)
    assert.equal((await registerDeviceWithKey(first, created.accountId, created.key, DEVICE_A)).status, 200)
  } finally {
    await first.close()
  }

  // There is no HTTP account-delete route yet, so deletion means removing the
  // account from the document (the authoritative store) and restarting.
  const documentPath = join(dataDir, 'accounts.json')
  const doc = JSON.parse(readFileSync(documentPath, 'utf8'))
  delete doc.accounts[created.accountId]
  writeFileSync(documentPath, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })

  const second = await startRelay({ dataDir })
  try {
    assert.equal(second.relay.accounts.count(), 0)
    for (const res of [
      await listDevicesWithKey(second, created.accountId, created.key),
      await registerDeviceWithKey(second, created.accountId, created.key, DEVICE_A),
      await deleteDeviceWithKey(second, created.accountId, created.key, DEVICE_A.machineId),
    ]) {
      assert.equal(res.status, 404, res.raw)
      assert.equal(res.body.error, 'unknown_account')
    }
    // The bare secret is rejected identically: nothing resurrects the account.
    assert.equal((await listDevices(second, created.accountId, created.secret)).status, 404)
    assert.equal((await jsonRequest({ port: second.port, path: '/health' })).body.accounts, 0)
  } finally {
    await second.dispose()
  }
})

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

test('accounts: accounts.json is 0600, hashes the secret, and survives a restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-relay-accounts-'))
  const first = await startRelay({ dataDir })
  let created
  try {
    created = await bootstrap(first, { name: 'Home' })
    assert.equal((await registerDevice(first, created.accountId, created.secret, DEVICE_A)).status, 200)

    const mode = statSync(first.file).mode & 0o777
    assert.equal(mode, 0o600, `accounts.json mode is ${mode.toString(8)}`)

    const raw = readFileSync(first.file, 'utf8')
    assert.equal(raw.includes(created.secret), false)
    assert.equal(raw.includes(created.secret.slice('dshf_'.length)), false)
    assert.match(raw, /"secretHash": "[0-9a-f]{64}"/)
    assert.equal(JSON.parse(raw).version, 1)
  } finally {
    await first.close()
  }

  // A brand-new relay process over the same directory loads the directory.
  const second = await startRelay({ dataDir })
  try {
    assert.equal(second.relay.accounts.count(), 1)
    // The bootstrap is no longer available (an account exists on disk)…
    assert.equal((await createAccount(second, { name: 'again' })).status, 403)
    // …but the persisted secret still lists the persisted device.
    const listed = await listDevices(second, created.accountId, created.secret)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.devices.length, 1)
    assert.equal(listed.body.devices[0].machineId, DEVICE_A.machineId)
    assert.equal(listed.body.devices[0].online, true)
  } finally {
    await second.dispose()
  }
})

test('accounts: a corrupt accounts.json is moved aside instead of breaking the relay', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-relay-accounts-'))
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'accounts.json'), '{ this is not json', { mode: 0o600 })

  const fixture = await startRelay({ dataDir })
  try {
    const health = await jsonRequest({ port: fixture.port, path: '/health' })
    assert.equal(health.status, 200)
    assert.equal(health.body.accounts, 0)

    // The relay is fully usable: bootstrap still works and rewrites the file.
    const created = await bootstrap(fixture)
    assert.match(created.accountId, /^acct_[0-9a-f]{16}$/)
    const files = readdirSync(dataDir)
    assert.ok(
      files.some((name) => name.startsWith('accounts.json.corrupt-')),
      `expected a moved-aside corrupt file, got ${files.join(', ')}`,
    )
    const parsed = JSON.parse(readFileSync(fixture.file, 'utf8'))
    assert.deepEqual(Object.keys(parsed.accounts), [created.accountId])
  } finally {
    await fixture.dispose()
  }
})

// ---------------------------------------------------------------------------
// limits + guards
// ---------------------------------------------------------------------------

test('accounts: body and device-field guards reject bad input with 400/413', async () => {
  assert.equal(ACCOUNT_LIMITS.maxBodyBytes, 8 * 1024)
  const fixture = await startRelay()
  try {
    const { accountId, secret } = await bootstrap(fixture)

    const notJson = await request({
      port: fixture.port,
      path: '/api/fleet/accounts',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json',
    })
    assert.equal(notJson.status, 400)
    assert.equal(JSON.parse(notJson.body.toString()).error, 'bad_request')

    const arrayBody = await request({
      port: fixture.port,
      path: '/api/fleet/accounts',
      method: 'POST',
      body: '[1,2,3]',
    })
    assert.equal(arrayBody.status, 400)

    const tooLarge = await request({
      port: fixture.port,
      path: '/api/fleet/accounts',
      method: 'POST',
      body: Buffer.alloc(ACCOUNT_LIMITS.maxBodyBytes + 1, 0x61),
    })
    assert.equal(tooLarge.status, 413)
    assert.equal(JSON.parse(tooLarge.body.toString()).error, 'payload_too_large')

    const cases = [
      [null, 'invalid_device'],
      [{}, 'invalid_machine_id'],
      [{ machineId: 'bad id!', entryUrl: DEVICE_A.entryUrl }, 'invalid_machine_id'],
      [{ ...DEVICE_A, machineId: 'mach_ok_1', entryUrl: 'not-a-url' }, 'invalid_entry_url'],
      [{ ...DEVICE_A, machineId: 'mach_ok_2', entryUrl: 'ftp://relay.example/r/hub' }, 'invalid_entry_url'],
      [{ ...DEVICE_A, machineId: 'mach_ok_3', name: 42 }, 'invalid_device_name'],
      [{ ...DEVICE_A, machineId: 'mach_ok_4', hubId: 'bad hub' }, 'invalid_hub_id'],
    ]
    for (const [device, expected] of cases) {
      const res = await registerDevice(fixture, accountId, secret, device)
      assert.equal(res.status, 400, `${expected}: ${res.raw}`)
      assert.equal(res.body.error, expected)
    }
    assert.equal((await listDevices(fixture, accountId, secret)).body.devices.length, 0)
  } finally {
    await fixture.dispose()
  }
})

test('accounts: an account is capped at 200 devices (overridable for tests)', async () => {
  assert.equal(ACCOUNT_LIMITS.maxDevicesPerAccount, 200)
  const fixture = await startRelay({ maxDevicesPerAccount: 2 })
  try {
    const { accountId, secret } = await bootstrap(fixture)
    assert.equal((await registerDevice(fixture, accountId, secret, DEVICE_A)).status, 200)
    assert.equal((await registerDevice(fixture, accountId, secret, DEVICE_B)).status, 200)

    const overflow = await registerDevice(fixture, accountId, secret, {
      ...DEVICE_A,
      machineId: 'mach_cccccccccccccccc',
      name: 'third',
    })
    assert.equal(overflow.status, 409)
    assert.equal(overflow.body.error, 'too_many_devices')

    // Upserting an already-registered machine is always allowed.
    assert.equal((await registerDevice(fixture, accountId, secret, DEVICE_A)).status, 200)
    assert.equal((await listDevices(fixture, accountId, secret)).body.devices.length, 2)
  } finally {
    await fixture.dispose()
  }
})

test('accounts: account creation is rate limited per IP', async () => {
  const adminKey = 'adm_rate_limit'
  const fixture = await startRelay({
    adminKey,
    accountRateLimit: { capacity: 2, refillPerSec: 0 },
  })
  try {
    assert.equal((await createAccount(fixture, { name: 'one', adminKey })).status, 201)
    assert.equal((await createAccount(fixture, { name: 'two', adminKey })).status, 201)

    const limited = await createAccount(fixture, { name: 'three', adminKey })
    assert.equal(limited.status, 429)
    assert.equal(limited.body.error, 'rate_limited')
    assert.equal(fixture.relay.accounts.count(), 2)
    // The default bucket is much larger than a single bootstrap.
    assert.equal(RELAY_LIMITS.accountRateLimit.capacity, 30)
  } finally {
    await fixture.dispose()
  }
})

test('accounts: unknown routes and unsupported methods are rejected', async () => {
  const fixture = await startRelay()
  try {
    const { accountId, secret } = await bootstrap(fixture)
    const unknownRoute = await jsonRequest({
      port: fixture.port,
      path: `/api/fleet/accounts/${accountId}/nope`,
    })
    assert.equal(unknownRoute.status, 404)
    assert.equal(unknownRoute.body.error, 'not_found')

    const put = await request({ port: fixture.port, path: '/api/fleet/accounts', method: 'PUT' })
    assert.equal(put.status, 405)
    assert.equal(put.headers.allow, 'POST')

    const deleteCollection = await request({
      port: fixture.port,
      path: `/api/fleet/accounts/${accountId}/devices`,
      method: 'DELETE',
      headers: { 'x-fleet-secret': secret },
    })
    assert.equal(deleteCollection.status, 405)
    assert.equal(deleteCollection.headers.allow, 'GET, POST')

    const patchDevice = await request({
      port: fixture.port,
      path: `/api/fleet/accounts/${accountId}/devices/${DEVICE_A.machineId}`,
      method: 'PATCH',
      headers: { 'x-fleet-secret': secret },
    })
    assert.equal(patchDevice.status, 405)
    assert.equal(patchDevice.headers.allow, 'DELETE')

    // The tunnel surface is untouched: an unknown hub is still 502.
    const tunnel = await jsonRequest({ port: fixture.port, path: '/r/hub_missing/api/x' })
    assert.equal(tunnel.status, 502)
    assert.equal(tunnel.body.error, 'hub_offline')
  } finally {
    await fixture.dispose()
  }
})

// ---------------------------------------------------------------------------
// unit-level helpers / option validation
// ---------------------------------------------------------------------------

test('accounts: secret helpers are constant-time and reject non-string input', () => {
  const secret = `dshf_${'a'.repeat(32)}`
  const hash = hashSecret(secret)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(verifySecret(secret, hash), true)
  assert.equal(verifySecret(`${secret}x`, hash), false)
  assert.equal(verifySecret('', hash), false)
  assert.equal(verifySecret(secret, 'not-a-hash'), false)
  assert.equal(verifySecret(secret, undefined), false)

  assert.equal(constantTimeEqual('same', 'same'), true)
  assert.equal(constantTimeEqual('same', 'different'), false)
  assert.equal(constantTimeEqual('same', 1), false)
  assert.equal(constantTimeEqual(null, null), false)
})

test('accounts: fleet key helpers format, parse, and reject bad input', () => {
  const accountId = `acct_${'0123456789abcdef'}`
  const secret = `dshf_${'fedcba9876543210'.repeat(2)}`
  const expected = `dshk_0123456789abcdef_${'fedcba9876543210'.repeat(2)}`

  assert.equal(formatFleetKey(accountId, secret), expected)
  // Bare hex bodies format the same key (callers may hold either form).
  assert.equal(formatFleetKey(accountId.slice('acct_'.length), secret.slice('dshf_'.length)), expected)

  assert.deepEqual(parseFleetKey(expected), { ok: true, accountId, secret })
  assert.deepEqual(parseFleetKey(`  ${expected}\t`), { ok: true, accountId, secret })

  assert.throws(() => formatFleetKey('acct_short', secret), /accountId/)
  assert.throws(() => formatFleetKey(accountId, 'dshf_short'), /secret/)
  assert.throws(() => formatFleetKey(accountId.toUpperCase(), secret), /accountId/)
  assert.throws(() => formatFleetKey(null, secret), /accountId/)
  assert.throws(() => formatFleetKey(accountId, undefined), /secret/)

  for (const bad of [
    undefined,
    null,
    42,
    '',
    '   ',
    'dshk_x',
    `dshk_${'a'.repeat(16)}_${'b'.repeat(32)}x`,
    `dshk_${'A'.repeat(16)}_${'b'.repeat(32)}`,
    'x'.repeat(200),
  ]) {
    const parsed = parseFleetKey(bad)
    assert.equal(parsed.ok, false, `expected ${String(bad)} to be rejected`)
    assert.equal(parsed.code, 'invalid_key')
    assert.match(parsed.message, /dshk_/)
  }
})

test('accounts: createAccount returns the composite key for its own id and secret', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-relay-accounts-'))
  try {
    const store = createAccountStore({ dataDir })
    const created = store.createAccount({ name: 'unit' })
    assert.equal(created.ok, true)
    assert.match(created.key, /^dshk_[0-9a-f]{16}_[0-9a-f]{32}$/)

    const parsed = parseFleetKey(created.key)
    assert.deepEqual(parsed, { ok: true, accountId: created.accountId, secret: created.secret })
    // The secret half authenticates exactly like the bare secret.
    assert.equal(store.authenticate(parsed.accountId, parsed.secret).ok, true)
    assert.equal(store.authenticate(created.accountId, created.secret).ok, true)
    assert.equal(store.authenticate(created.accountId, `dshf_${'0'.repeat(32)}`).ok, false)
    // Nothing about the key is persisted.
    const raw = readFileSync(join(dataDir, 'accounts.json'), 'utf8')
    assert.equal(raw.includes(created.key), false)
    assert.equal(raw.includes(created.secret), false)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('accounts: createRelay and createAccountStore validate their options', () => {
  assert.throws(() => createRelay({ dataDir: '' }), /dataDir/)
  assert.throws(() => createRelay({ adminKey: '' }), /adminKey/)
  assert.throws(() => createRelay({ now: 42 }), /now/)
  assert.throws(() => createRelay({ onlineWindowMs: 0 }), /onlineWindowMs/)
  assert.throws(() => createRelay({ maxDevicesPerAccount: 0 }), /maxDevicesPerAccount/)
  assert.throws(() => createRelay({ accountRateLimit: { capacity: 0, refillPerSec: 1 } }), /accountRateLimit/)
  assert.throws(() => createAccountStore({ dataDir: '' }), /dataDir/)
  assert.throws(() => createAccountStore({ now: null }), /now/)
})
