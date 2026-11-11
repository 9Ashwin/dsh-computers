/**
 * Every HTTP route dsh-computers serves (PROTOCOL §3 and §4).
 *
 * Two surfaces share `/api/dsh-computers`:
 * - machine routes (`/agent/*`) authenticate with a bearer token and never
 *   pass the browser gate;
 * - browser routes (state, keys, key-status, delete, rename) ask the host's
 *   request gate first, then answer JSON;
 * - public routes (join.sh, join.ps1, agent.mjs, health) are unauthenticated
 *   but key- or path-scoped.
 *
 * Node builtins only.
 */

import {
  HttpError, joinPs1, joinSh, jsonError, methodNotAllowed, readJsonBody,
  refuseBrowserRequest, resolveServerUrl, sendJson, sendText, serveAgentScript,
} from './http.js'
import {
  bearerToken, isExpired, mintSecret, newComputerId, normalizeDisplayName,
  optionalCount, optionalString, platformLabel, sha256Hex, tokenMatches,
} from './keys.js'

/** Base path shared by every route (PROTOCOL §3). */
export const API_BASE = '/api/dsh-computers'

/** Enrollment bodies are small (PROTOCOL §3.1: max 16 KiB). */
const ENROLL_MAX_BYTES = 16 * 1024

/** Browser control bodies are tiny. */
const CONTROL_MAX_BYTES = 16 * 1024

/** Result posts carry two ≤1 MiB streams plus JSON escaping. */
const RESULT_MAX_BYTES = 8 * 1024 * 1024

/** Platform names an agent may report → the label the settings page shows. */
const PLATFORM_LABELS = new Map([
  ['macos', 'macOS'],
  ['darwin', 'macOS'],
  ['osx', 'macOS'],
  ['linux', 'Linux'],
  ['windows', 'Windows'],
  ['win32', 'Windows'],
])

/** Enforce one method; answers 405 and returns false otherwise. */
function requireMethod(req, res, ...methods) {
  const method = typeof req.method === 'string' ? req.method.toUpperCase() : ''
  if (method === 'HEAD' && methods.includes('GET')) return true
  if (methods.includes(method)) return true
  methodNotAllowed(res, methods.join(' / '))
  return false
}

/** Parse an object body or throw the protocol's 400. */
async function readObjectBody(req, maxBytes) {
  const body = await readJsonBody(req, maxBytes)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'bad-request', 'request body must be a JSON object')
  }
  return body
}

/**
 * Build the exact-route registrar used by both route surfaces. Handlers own
 * the whole response lifecycle, which is what lets the SSE route stay open.
 */
function createRouteRegistrar(ctx, onWarn) {
  return (suffix, handler) => {
    const path = `${API_BASE}${suffix}`
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          if (res.headersSent) {
            try {
              res.end()
            } catch {
              // Client already gone.
            }
            return
          }
          if (error instanceof HttpError) {
            jsonError(res, error.status, error.code, error.message)
            return
          }
          onWarn(`dsh-computers: ${req.method} ${path} failed: ${error && error.stack ? error.stack : error}`)
          jsonError(res, 500, 'internal', 'the dsh-computers host failed to handle this request')
        }
      },
    }), `dsh-computers: ${path}`)
  }
}

/**
 * Register every route on the host web server.
 * @param {object} options - route wiring.
 * @param {object} options.ctx - Cordis context (webServer + optional connection).
 * @param {object} options.config - resolved plugin config.
 * @param {object} options.store - registry store.
 * @param {object} options.hub - SSE/exec hub.
 * @param {string} options.version - plugin version reported by /health.
 * @param {URL} options.agentUrl - machine agent bundle location.
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 */
export function createRoutes({ ctx, config, store, hub, version, agentUrl, role = 'both', onWarn = () => {} }) {
  /** Current clock as ISO text. */
  const nowIso = () => new Date().toISOString()
  /** Parsed request URL (pathname + query). */
  const urlOf = (req) => new URL(typeof req.url === 'string' && req.url !== '' ? req.url : '/', 'http://dsh-computers.invalid')
  /** Exact-route registrar shared with the runtime surface. */
  const route = createRouteRegistrar(ctx, onWarn)

  /** Ask the host's browser gate; true when the request was already refused. */
  const refuseBrowser = (req, res) => refuseBrowserRequest(ctx, req, res)

  /** Resolve the bearer token to a registry computer, or undefined. */
  const authenticate = (req) => {
    const token = bearerToken(req)
    if (token === null) return undefined
    for (const computer of store.read().computers) {
      if (tokenMatches(token, computer.tokenHash)) return computer
    }
    return undefined
  }

  /** Refuse a machine route without valid credentials. */
  const requireComputer = (req, res) => {
    const computer = authenticate(req)
    if (computer === undefined) {
      jsonError(res, 401, 'invalid-token', 'authorization: Bearer <agent token> is required')
      return undefined
    }
    return computer
  }

  /** The pending key the browser should show, if any. */
  const currentPendingKey = (doc, nowMs) => {
    for (let index = doc.pendingKeys.length - 1; index >= 0; index -= 1) {
      const entry = doc.pendingKeys[index]
      if (typeof entry.usedAt === 'string') continue
      if (isExpired(entry.expiresAt, nowMs)) continue
      return entry
    }
    return null
  }

  /** Protocol §4.1 projection of one registry record. */
  const publicComputer = (computer) => {
    const online = hub.isOnline(computer)
    return {
      id: computer.id,
      name: computer.name,
      hostname: computer.hostname,
      os: computer.os,
      platformLabel: computer.platformLabel,
      online,
      lastSeenAt: computer.lastSeenAt ?? null,
      createdAt: computer.createdAt ?? null,
      agentVersion: computer.agentVersion ?? null,
      cpuModel: computer.cpuModel ?? null,
      memoryBytes: computer.memoryBytes ?? null,
      // Display sugar mirroring Memoh's "1/1 Bot" badge (PROTOCOL §4.1).
      bots: { used: online ? 1 : 0, total: 1 },
    }
  }

  /** Key-validated installer scripts share one refusal rule. */
  const installerKey = (req, res, requiredSearchParam) => {
    const keyValue = urlOf(req).searchParams.get(requiredSearchParam)
    if (keyValue === null || keyValue === '') {
      sendText(res, 410, 'missing enrollment key — open the Computers settings page and copy a fresh command\n')
      return null
    }
    const entry = store.read().pendingKeys.find((candidate) => candidate.key === keyValue)
    if (entry === undefined) {
      sendText(res, 410, 'unknown enrollment key — create a new one on the Computers settings page\n')
      return null
    }
    if (typeof entry.usedAt === 'string') {
      sendText(res, 410, 'this enrollment key was already used — create a new one on the Computers settings page\n')
      return null
    }
    if (isExpired(entry.expiresAt, Date.now())) {
      sendText(res, 410, 'this enrollment key expired — create a new one on the Computers settings page\n')
      return null
    }
    return entry
  }

  // ---------------------------------------------------------------------------
  // Machine routes (bearer token, no browser gate)
  // ---------------------------------------------------------------------------

  route('/agent/enroll', async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, ENROLL_MAX_BYTES)
    const keyValue = typeof body.key === 'string' ? body.key.trim() : ''
    if (!/^dshc_[A-Za-z0-9_-]{20,}$/.test(keyValue)) {
      throw new HttpError(400, 'bad-request', 'key must be a dshc_ enrollment key')
    }
    const nowMs = Date.now()
    const doc = store.read()
    const pendingKey = doc.pendingKeys.find((entry) => entry.key === keyValue)
    // Order matters: an unknown key is 401, a consumed one 409, a stale one 410.
    if (pendingKey === undefined) {
      throw new HttpError(401, 'invalid-key', 'unknown enrollment key; create a new one on the Computers settings page')
    }
    if (typeof pendingKey.usedAt === 'string') {
      throw new HttpError(409, 'key-used', 'this enrollment key was already used; create a new one')
    }
    if (isExpired(pendingKey.expiresAt, nowMs)) {
      throw new HttpError(410, 'key-expired', 'this enrollment key expired; create a new one')
    }

    const machine = body.machine !== null && typeof body.machine === 'object' && !Array.isArray(body.machine)
      ? body.machine
      : null
    const hostname = optionalString(machine?.hostname, 255)
    if (hostname === null) throw new HttpError(400, 'bad-request', 'machine.hostname is required')
    const osName = optionalString(machine?.os, 64) ?? 'unknown'
    const displayName = normalizeDisplayName(pendingKey.label)
      ?? normalizeDisplayName(optionalString(machine?.name, 255))
      ?? hostname
    const requestedPlatform = optionalString(machine?.platform, 64)
    const label = requestedPlatform !== null
      ? PLATFORM_LABELS.get(requestedPlatform.toLowerCase()) ?? platformLabel(osName)
      : platformLabel(osName)

    const fields = {
      name: displayName,
      hostname,
      os: osName,
      arch: optionalString(machine?.arch, 64) ?? 'unknown',
      platformLabel: label,
      cpuModel: optionalString(machine?.cpuModel, 256) ?? null,
      memoryBytes: optionalCount(machine?.memoryBytes) ?? null,
      nodeVersion: optionalString(machine?.nodeVersion, 64) ?? null,
      agentVersion: optionalString(body.agentVersion, 64) ?? optionalString(machine?.agentVersion, 64) ?? 'unknown',
    }
    const token = mintSecret()
    const tokenHash = sha256Hex(token)
    // Re-enroll in place only when the key asked for it (PROTOCOL §3.1).
    const replaceTarget = pendingKey.replace === true
      ? doc.computers.find((computer) => computer.hostname === hostname
        || computer.name.toLowerCase() === displayName.toLowerCase())
      : undefined

    const enrolled = store.mutate((document) => {
      const keyEntry = document.pendingKeys.find((entry) => entry.key === keyValue)
      if (keyEntry === undefined) {
        throw new HttpError(401, 'invalid-key', 'unknown enrollment key; create a new one on the Computers settings page')
      }
      let computer
      if (replaceTarget !== undefined) {
        computer = document.computers.find((entry) => entry.id === replaceTarget.id)
      }
      if (computer !== undefined) {
        // Same id, same name unless the agent reported a new one: the old
        // token hash is replaced so the previous install stops working.
        Object.assign(computer, fields, { tokenHash, lastSeenAt: nowIso() })
      } else {
        computer = {
          id: newComputerId(),
          ...fields,
          tokenHash,
          createdAt: nowIso(),
          lastSeenAt: nowIso(),
        }
        document.computers.push(computer)
      }
      keyEntry.usedAt = nowIso()
      keyEntry.computerId = computer.id
      return { computerId: computer.id, name: computer.name, replaced: replaceTarget !== undefined }
    })

    if (enrolled.replaced) {
      // The old agent's token no longer authenticates; drop its session.
      hub.closeStream(enrolled.computerId)
    }
    sendJson(res, 200, {
      computerId: enrolled.computerId,
      token,
      name: enrolled.name,
      serverUrl: resolveServerUrl(ctx, config, req),
    })
  })

  route('/agent/events', async (req, res) => {
    // Authenticate before anything else on machine routes (PROTOCOL §3).
    const computer = requireComputer(req, res)
    if (computer === undefined) return
    if (!requireMethod(req, res, 'GET')) return
    store.touch(computer.id)
    hub.openStream(computer.id, computer.name, req, res)
  })

  route('/agent/results', async (req, res) => {
    // Authenticate before anything else on machine routes (PROTOCOL §3).
    const computer = requireComputer(req, res)
    if (computer === undefined) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, RESULT_MAX_BYTES)
    store.touch(computer.id)
    if (!hub.settle(computer.id, body)) {
      // The server already settled/timed out this request (PROTOCOL §3.3);
      // the agent ignores this answer.
      jsonError(res, 404, 'unknown-request', 'this execution is no longer pending (already settled or timed out)')
      return
    }
    sendJson(res, 200, { ok: true })
  })

  route('/agent/heartbeat', async (req, res) => {
    // Authenticate before anything else on machine routes (PROTOCOL §3).
    const computer = requireComputer(req, res)
    if (computer === undefined) return
    if (!requireMethod(req, res, 'POST')) return
    let body = {}
    try {
      body = await readObjectBody(req, 64 * 1024)
    } catch (error) {
      // An empty heartbeat body is legal; anything else is still a 400.
      if (!(error instanceof HttpError) || error.code !== 'bad-request' || !/empty/.test(error.message)) throw error
    }
    const meta = body.meta !== null && typeof body.meta === 'object' && !Array.isArray(body.meta) ? body.meta : null
    const name = store.mutate((document) => {
      const record = document.computers.find((entry) => entry.id === computer.id)
      if (record === undefined) return computer.name
      record.lastSeenAt = nowIso()
      if (meta !== null) {
        const cpuModel = optionalString(meta.cpuModel, 256)
        const agentVersion = optionalString(meta.agentVersion, 64)
        const memoryBytes = optionalCount(meta.memoryBytes)
        if (cpuModel !== null) record.cpuModel = cpuModel
        if (agentVersion !== null) record.agentVersion = agentVersion
        if (memoryBytes !== null) record.memoryBytes = memoryBytes
      }
      return record.name
    })
    sendJson(res, 200, { ok: true, name })
  })

  // ---------------------------------------------------------------------------
  // Browser routes (host request gate first)
  // ---------------------------------------------------------------------------

  route('/state', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'GET')) return
    const doc = store.read()
    const pendingKey = currentPendingKey(doc, Date.now())
    sendJson(res, 200, {
      version: 2,
      role,
      serverUrl: resolveServerUrl(ctx, config, req),
      heartbeatMs: config.heartbeatMs,
      computers: doc.computers.map(publicComputer),
      pendingKey: pendingKey === null
        ? null
        : { key: pendingKey.key, expiresAt: pendingKey.expiresAt ?? null, os: pendingKey.os ?? 'macos' },
    })
  })

  route('/keys', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    const osName = typeof body.os === 'string' ? body.os.trim().toLowerCase() : 'macos'
    if (!['macos', 'windows', 'linux'].includes(osName)) {
      throw new HttpError(400, 'bad-request', 'os must be one of macos, windows, linux')
    }
    let label = null
    if (body.label !== undefined && body.label !== null) {
      label = normalizeDisplayName(body.label)
      if (label === null) throw new HttpError(400, 'bad-request', 'label must be 1-64 visible characters')
    }
    const replace = body.replace === true
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + config.keyTtlMinutes * 60_000).toISOString()
    const keyValue = mintSecret()

    store.mutate((document) => {
      // Only one pending key at a time: creating a new one invalidates the
      // earlier ones (PROTOCOL §4.2).
      for (const entry of document.pendingKeys) {
        if (typeof entry.usedAt !== 'string') entry.usedAt = createdAt
      }
      document.pendingKeys.push({
        key: keyValue,
        createdAt,
        expiresAt,
        os: osName,
        label,
        usedAt: null,
        computerId: null,
        replace,
      })
    })

    const serverUrl = resolveServerUrl(ctx, config, req)
    const installUrl = `${serverUrl}${API_BASE}/join.sh?key=${encodeURIComponent(keyValue)}`
    const windowsUrl = `${serverUrl}${API_BASE}/join.ps1?key=${encodeURIComponent(keyValue)}`
    sendJson(res, 200, {
      key: keyValue,
      os: osName,
      expiresAt,
      serverUrl,
      command: `curl -fsSL '${installUrl}' | sh`,
      windowsCommand: `irm '${windowsUrl}' | iex`,
      installUrl,
    })
  })

  route('/key-status', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'GET')) return
    const keyValue = urlOf(req).searchParams.get('key')
    const doc = store.read()
    const entry = keyValue === null
      ? undefined
      : doc.pendingKeys.find((candidate) => candidate.key === keyValue)
    let status = 'unknown'
    let computer = null
    if (entry !== undefined) {
      const linked = typeof entry.computerId === 'string'
        ? doc.computers.find((candidate) => candidate.id === entry.computerId)
        : undefined
      if (linked !== undefined) {
        status = 'connected'
        computer = { id: linked.id, name: linked.name, online: hub.isOnline(linked) }
      } else if (typeof entry.usedAt === 'string') {
        status = 'used'
      } else if (isExpired(entry.expiresAt, Date.now())) {
        status = 'expired'
      } else {
        status = 'waiting'
      }
    }
    sendJson(res, 200, { status, computer })
  })

  route('/delete', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') throw new HttpError(400, 'bad-request', 'id is required')
    const found = store.read().computers.some((computer) => computer.id === id)
    if (!found) throw new HttpError(404, 'not-found', `no computer with id ${JSON.stringify(id)}`)
    hub.closeStream(id)
    store.mutate((document) => {
      document.computers = document.computers.filter((computer) => computer.id !== id)
    })
    sendJson(res, 200, { ok: true })
  })

  route('/rename', async (req, res) => {
    // The host's request gate runs first on every browser route (PROTOCOL §4).
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id === '') throw new HttpError(400, 'bad-request', 'id is required')
    const name = normalizeDisplayName(body.name)
    if (name === null) throw new HttpError(400, 'bad-request', 'name must be 1-64 visible characters')
    const found = store.read().computers.some((computer) => computer.id === id)
    if (!found) throw new HttpError(404, 'not-found', `no computer with id ${JSON.stringify(id)}`)
    store.mutate((document) => {
      const record = document.computers.find((computer) => computer.id === id)
      if (record !== undefined) record.name = name
    })
    // Optional `config` event (PROTOCOL §3.2): the agent picks up the new name.
    hub.send(id, 'config', { name, execEnabled: config.execEnabled })
    sendJson(res, 200, { ok: true, name })
  })

  // ---------------------------------------------------------------------------
  // Public routes
  // ---------------------------------------------------------------------------

  route('/join.sh', async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    const entry = installerKey(req, res, 'key')
    if (entry === null) return
    const serverUrl = resolveServerUrl(ctx, config, req)
    sendText(res, 200, joinSh(serverUrl, entry.key), 'text/x-shellscript; charset=utf-8')
  })

  route('/join.ps1', async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    const entry = installerKey(req, res, 'key')
    if (entry === null) return
    const serverUrl = resolveServerUrl(ctx, config, req)
    sendText(res, 200, joinPs1(serverUrl, entry.key), 'text/plain; charset=utf-8')
  })

  route('/agent.mjs', async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    await serveAgentScript(res, agentUrl)
  })

  route('/health', async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    const computers = store.read().computers
    sendJson(res, 200, {
      ok: true,
      version,
      computers: computers.length,
      online: hub.onlineCount(),
    })
  })
}

/**
 * Register the runtime-mode routes (PROTOCOL §10.5) on the host web server.
 *
 * These are browser-gated exactly like §4 and every answer carries the full
 * §10.3 status object (plus `role`, so a pure `role: 'runtime'` deployment —
 * which registers no `/state` route — can still tell the client what to render).
 *
 * @param {object} options - route wiring.
 * @param {object} options.ctx - Cordis context.
 * @param {object} options.config - resolved plugin config.
 * @param {object} options.runtime - runtime manager (lib/runtime.js).
 * @param {string} options.role - 'hub' | 'runtime' | 'both' (echoed in answers).
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 */
export function createRuntimeRoutes({ ctx, config, runtime, role = 'both', onWarn = () => {} }) {
  const route = createRouteRegistrar(ctx, onWarn)
  const refuseBrowser = (req, res) => refuseBrowserRequest(ctx, req, res)
  /** Every answer is the status object plus the role the client is talking to. */
  const respond = (res, status) => sendJson(res, 200, { ...status, role })

  route('/runtime', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'GET')) return
    respond(res, runtime.status())
  })

  route('/runtime/connect', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    const serverUrl = typeof body.serverUrl === 'string' ? body.serverUrl.trim() : ''
    if (serverUrl === '') throw new HttpError(400, 'bad-request', 'serverUrl is required')
    // The client may send `key` (spec) or `enrollmentKey` (older drafts).
    const key = typeof body.key === 'string'
      ? body.key.trim()
      : typeof body.enrollmentKey === 'string'
        ? body.enrollmentKey.trim()
        : ''
    if (key === '') throw new HttpError(400, 'bad-request', 'key is required')
    // configure() validates the URL, enrolls against the hub and maps the hub's
    // 401/409/410 onto the protocol's invalid-key/key-used/key-expired codes;
    // a transport failure becomes 502 hub-unreachable.
    respond(res, await runtime.configure({ serverUrl, key }))
  })

  route('/runtime/enable', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    const body = await readObjectBody(req, CONTROL_MAX_BYTES)
    if (typeof body.enabled !== 'boolean') {
      throw new HttpError(400, 'bad-request', 'enabled must be a boolean')
    }
    respond(res, await runtime.enable(body.enabled))
  })

  route('/runtime/disconnect', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'POST')) return
    // Body is optional on disconnect: nothing to read, nothing to validate.
    // Drain it anyway so keep-alive sockets are not reset between requests.
    try {
      req.resume()
    } catch {
      // Nothing to drain.
    }
    respond(res, await runtime.disconnect())
  })
}

/**
 * Register the minimal read-only routes a `role: 'runtime'` deployment still
 * needs (PROTOCOL §10.1, client contract in §10.6).
 *
 * A runtime is not a controller, so the hub API stays unregistered — no
 * `/agent/*`, no keys/join scripts, no served agent bundle. But the settings
 * client learns its role from `GET /state`; without it the page can only show
 * a load-error card. `/state` therefore answers with `role` and an empty
 * computer list (a runtime owns no registry), and `/health` stays for probes.
 *
 * @param {object} options - route wiring.
 * @param {object} options.ctx - Cordis context.
 * @param {object} options.config - resolved plugin config.
 * @param {string} options.role - always 'runtime' here; echoed in /state.
 * @param {string} options.version - plugin version reported by /health.
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 */
export function createRuntimeStatusRoutes({ ctx, config, role = 'runtime', version, onWarn = () => {} }) {
  const route = createRouteRegistrar(ctx, onWarn)
  const refuseBrowser = (req, res) => refuseBrowserRequest(ctx, req, res)

  route('/state', async (req, res) => {
    if (refuseBrowser(req, res)) return
    if (!requireMethod(req, res, 'GET')) return
    sendJson(res, 200, {
      version: 2,
      role,
      serverUrl: resolveServerUrl(ctx, config, req),
      heartbeatMs: config.heartbeatMs,
      // This deployment only follows a hub; it has no computer registry.
      computers: [],
      pendingKey: null,
    })
  })

  route('/health', async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    sendJson(res, 200, { ok: true, version, computers: 0, online: 0 })
  })
}
