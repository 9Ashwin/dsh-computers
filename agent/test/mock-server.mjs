/**
 * In-memory dsh-computers server for agent tests (PROTOCOL.md §3.1–§3.4).
 *
 * This is deliberately a *test double*, not the host plugin: it keeps no files
 * and implements only the four agent-facing routes. It is used by
 * `node --test agent/test/` and can also be run standalone to poke at the agent
 * by hand:
 *
 *   node agent/test/mock-server.mjs --port 0 --name "Mock Mac"
 *
 * Importing this module has no side effects; the HTTP server only starts when
 * `start()` is called (or when the file is executed directly).
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function tokenFor() {
  return `dshc_${randomBytes(32).toString('base64url')}`
}

function idFor() {
  return `cmp_${randomBytes(6).toString('hex')}`
}

async function readRequestBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export class MockComputerServer {
  constructor(options = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 20_000
    this.name = options.name ?? 'Mock Mac'
    this.verbose = options.verbose ?? false
    /** §11.5: features advertised in `hello`; null/undefined = v1 host (none). */
    this.features = Array.isArray(options.features) ? [...options.features] : null
    /** §11.2: chunk POSTs captured as { requestId, seq, type, data, at }. */
    this.chunks = []
    /** Every chunk POST attempt (including retried/failed ones). */
    this.chunkAttempts = 0
    /** Number of leading chunk POSTs to fail with 503 (retry/failure tests). */
    this.chunkFailuresRemaining = options.chunkFailures ?? 0
    /** §11.3: fs results captured as { requestId, payload, at }. */
    this.fsResults = []
    /** SSE requests with headers, for handshake-metadata assertions. */
    this.eventsRequests = []
    /** Heartbeat round trips (successful and failed attempts). */
    this.heartbeatAttempts = 0
    /** How many leading heartbeat POSTs to answer 503 (liveness-miss tests). */
    this.heartbeatFailuresRemaining = options.heartbeatFailures ?? 0
    /**
     * v1.7.0 one-address join: the hub's long-lived fleet token. `enroll` with
     * `{ join }` matching this creates/replaces a computer record; anything else
     * answers 401 `invalid-join`.
     */
    this.joinToken = typeof options.joinToken === 'string' ? options.joinToken : `dshf_${randomBytes(16).toString('hex')}`

    /** key -> { key, expiresAt, usedAt, replace, computerId } */
    this.keys = new Map()
    /** id -> computer record */
    this.computers = new Map()
    /** token -> computer id */
    this.tokens = new Map()
    /** computerId -> { computerId, res, id, openedAt } */
    this.streams = new Map()
    /** requestId -> { payload, sentAt } */
    this.pending = new Map()
    /** accepted results: [{ requestId, payload, at }] */
    this.results = []
    /** results POSTed for requests the mock already settled */
    this.rejectedResults = []
    /** heartbeat bodies */
    this.heartbeats = []
    /** enroll bodies */
    this.enrollments = []
    /** every stream ever opened: [{ computerId, id, openedAt, closedAt }] */
    this.streamHistory = []
    /** every route the agent called, for debugging */
    this.requests = []

    /**
     * Fault injection for the SSE route: a queue of responses to answer
     * `GET /agent/events` with before normal SSE handling. Used to simulate a
     * plugin reload / generic /api gateway fence (bare 401, 404, 503).
     * Each entry: { status, body, contentType? }.
     */
    this.eventsFence = []
    /** Responses served from eventsFence, in order. */
    this.fenceHits = []

    this.server = null
    this.port = 0
    this.url = ''
    this.streamSeq = 0
    this.streamWaiters = []
    this.resultWaiters = new Map()
    this.rejectedWaiters = new Map()
  }

  async start() {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (!res.headersSent) this.sendJson(res, 500, { error: 'internal', message: String(error?.message || error) })
        else res.end()
      })
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    this.port = this.server.address().port
    this.url = `http://127.0.0.1:${this.port}`
    return this.url
  }

  async stop() {
    this.closeStreams()
    await new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      this.server.closeAllConnections?.()
    })
    this.server = null
  }

  // --- test helpers -------------------------------------------------------

  createEnrollKey({ ttlMs = 15 * 60_000, replace = false, key } = {}) {
    const value = key || `dshc_${randomBytes(32).toString('base64url')}`
    this.keys.set(value, { key: value, createdAt: Date.now(), expiresAt: Date.now() + ttlMs, usedAt: null, replace, computerId: null })
    return value
  }

  /** Expire an existing key without consuming it. */
  expireKey(key) {
    const entry = this.keys.get(key)
    if (entry) entry.expiresAt = Date.now() - 1000
  }

  getComputer(computerId) {
    return this.computers.get(computerId)
  }

  getComputerByToken(token) {
    const id = this.tokens.get(token)
    return id ? this.computers.get(id) : undefined
  }

  /** Simulate the server losing every token (e.g. state.json deleted). */
  revokeTokens() {
    this.tokens.clear()
  }

  /**
   * Queue responses for the next SSE connect attempts. Once the queue is empty
   * the route behaves normally again (accepts the stream). See `eventsFence`.
   */
  setEventsFence(responses) {
    this.eventsFence = [...responses].map((entry) => ({
      status: entry.status,
      body: entry.body ?? '',
      contentType: entry.contentType ?? 'text/plain; charset=utf-8',
    }))
    this.fenceHits = []
    return this.eventsFence.length
  }

  clearEventsFence() {
    this.eventsFence = []
  }

  /** Number of currently open SSE streams. */
  get openStreamCount() {
    return this.streams.size
  }

  /**
   * The v1.7.0 one-address join string for this mock: `<url>#join=<token>`.
   * Pasting it as `--server` is the whole enrollment.
   */
  get joinAddress() {
    return `${this.url}#join=${this.joinToken}`
  }

  /** Every stream ever opened, in order. */
  get streamCount() {
    return this.streamHistory.length
  }

  waitForStream({ timeoutMs = 10_000 } = {}) {
    const existing = [...this.streams.values()][0]
    if (existing) return Promise.resolve(existing.computerId)
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (computerId) => {
          clearTimeout(waiter.timer)
          resolve(computerId)
        },
        reject,
        timer: setTimeout(() => {
          this.streamWaiters = this.streamWaiters.filter((candidate) => candidate !== waiter)
          reject(new Error(`timed out after ${timeoutMs}ms waiting for an SSE stream`))
        }, timeoutMs),
      }
      this.streamWaiters.push(waiter)
    })
  }

  waitForStreamCount(count, { timeoutMs = 10_000 } = {}) {
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.streamCount >= count) return resolve(this.streamCount)
        if (Date.now() - startedAt > timeoutMs) {
          return reject(new Error(`timed out waiting for ${count} SSE streams (saw ${this.streamCount})`))
        }
        setTimeout(tick, 25)
      }
      tick()
    })
  }

  waitForResult(requestId, { timeoutMs = 20_000 } = {}) {
    const existing = this.results.find((entry) => entry.requestId === requestId)
    if (existing) return Promise.resolve(existing.payload)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resultWaiters.delete(requestId)
        reject(new Error(`timed out after ${timeoutMs}ms waiting for result ${requestId}`))
      }, timeoutMs)
      this.resultWaiters.set(requestId, (payload) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })
  }

  waitForRejectedResult(requestId, { timeoutMs = 20_000 } = {}) {
    const existing = this.rejectedResults.find((entry) => entry.requestId === requestId)
    if (existing) return Promise.resolve(existing.payload)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectedWaiters.delete(requestId)
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a rejected result ${requestId}`))
      }, timeoutMs)
      this.rejectedWaiters.set(requestId, (payload) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })
  }

  /** All stream frames captured for one request, in arrival order. */
  chunksFor(requestId) {
    return this.chunks.filter((chunk) => chunk.requestId === requestId)
  }

  waitForChunks(requestId, count = 1, { timeoutMs = 15_000 } = {}) {
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      const tick = () => {
        const frames = this.chunksFor(requestId)
        if (frames.length >= count) return resolve(frames)
        if (Date.now() - startedAt > timeoutMs) {
          return reject(new Error(`timed out waiting for ${count} chunk(s) of ${requestId} (saw ${frames.length})`))
        }
        setTimeout(tick, 20)
      }
      tick()
    })
  }

  waitForFsResult(requestId, { timeoutMs = 15_000 } = {}) {
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      const tick = () => {
        const entry = this.fsResults.find((candidate) => candidate.requestId === requestId)
        if (entry) return resolve(entry.payload)
        if (Date.now() - startedAt > timeoutMs) {
          return reject(new Error(`timed out waiting for fs result ${requestId}`))
        }
        setTimeout(tick, 20)
      }
      tick()
    })
  }

  /** Make the next `count` heartbeat POSTs fail with 503 (default: forever). */
  failHeartbeats(count = Number.POSITIVE_INFINITY) {
    this.heartbeatFailuresRemaining = count
  }

  /** Let heartbeats succeed again. */
  allowHeartbeats() {
    this.heartbeatFailuresRemaining = 0
  }

  waitForHeartbeat({ timeoutMs = 20_000 } = {}) {
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.heartbeats.length > 0) return resolve(this.heartbeats.at(-1))
        if (Date.now() - startedAt > timeoutMs) return reject(new Error('timed out waiting for a heartbeat'))
        setTimeout(tick, 25)
      }
      tick()
    })
  }

  waitForEnrollment({ timeoutMs = 10_000 } = {}) {
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.enrollments.length > 0) return resolve(this.enrollments.at(-1))
        if (Date.now() - startedAt > timeoutMs) return reject(new Error('timed out waiting for an enrollment'))
        setTimeout(tick, 25)
      }
      tick()
    })
  }

  /** Push an exec event. Throws when no agent is connected. */
  pushExec({ command, cwd = null, timeoutMs = 120_000, shell, requestId, stream = false } = {}) {
    const id = requestId || `req_${randomBytes(6).toString('hex')}`
    if (this.pending.has(id)) throw new Error(`duplicate requestId ${id}`)
    if (this.streams.size === 0) throw new Error('no connected agent SSE stream to push exec to')
    const payload = {
      requestId: id,
      command: String(command ?? ''),
      cwd: cwd ?? null,
      timeoutMs,
      shell: shell ?? (process.platform === 'win32' ? 'cmd' : 'sh'),
    }
    if (stream) payload.stream = true
    this.pending.set(id, { payload, sentAt: Date.now() })
    this.emitEvent('exec', payload)
    return id
  }

  /** Push a cancel and settle the request on the "server" side (as the host does). */
  pushCancel(requestId) {
    this.pending.delete(requestId)
    this.emitEvent('cancel', { requestId })
  }

  pushPing() {
    this.emitEvent('ping', { t: Date.now() })
  }

  pushConfig({ name, execEnabled = true } = {}) {
    if (typeof name === 'string' && name) {
      const computer = [...this.computers.values()][0]
      if (computer) computer.name = name
    }
    this.emitEvent('config', { name, execEnabled })
  }

  /** Push a §11.3 fs request and return its requestId. */
  pushFs({ op, path, requestId, ...rest } = {}) {
    const id = requestId || `fsr_${randomBytes(6).toString('hex')}`
    if (this.streams.size === 0) throw new Error('no connected agent SSE stream to push fs to')
    const payload = { requestId: id, op, path, ...rest }
    this.emitEvent('fs', payload)
    return id
  }

  /** Close every open SSE stream without shutting the server down. */
  closeStreams() {
    for (const entry of [...this.streams.values()]) {
      try {
        entry.res.end()
      } catch {
        // ignore
      }
      entry.closedAt = Date.now()
      this.streams.delete(entry.computerId)
    }
  }

  emitEvent(event, data) {
    const entry = [...this.streams.values()][0]
    if (!entry) throw new Error(`cannot emit ${event}: no connected agent`)
    entry.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    if (this.verbose) process.stderr.write(`[mock] -> ${event} ${JSON.stringify(data)}\n`)
  }

  // --- HTTP plumbing ------------------------------------------------------

  sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  /** Plain response used by the fault-injection fence (gateways are not JSON). */
  sendRaw(res, status, body, contentType = 'text/plain; charset=utf-8') {
    const text = String(body ?? '')
    res.writeHead(status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  authenticate(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
    const token = header.slice('Bearer '.length).trim()
    if (!token) return undefined
    return this.getComputerByToken(token)
  }

  async handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    this.requests.push({ method: req.method, pathname: url.pathname, at: Date.now() })
    if (this.verbose) process.stderr.write(`[mock] ${req.method} ${url.pathname}\n`)

    if (req.method === 'POST' && url.pathname === '/api/dsh-computers/agent/enroll') {
      return this.handleEnroll(req, res)
    }
    if (req.method === 'GET' && url.pathname === '/api/dsh-computers/agent/events') {
      return this.handleEvents(req, res)
    }
    if (req.method === 'POST' && url.pathname === '/api/dsh-computers/agent/results') {
      return this.handleResults(req, res)
    }
    if (req.method === 'POST' && url.pathname === '/api/dsh-computers/agent/heartbeat') {
      return this.handleHeartbeat(req, res)
    }
    if (req.method === 'POST' && url.pathname === '/api/dsh-computers/agent/results/chunk') {
      return this.handleChunk(req, res)
    }
    if (req.method === 'POST' && url.pathname === '/api/dsh-computers/agent/fs/result') {
      return this.handleFsResult(req, res)
    }
    return this.sendJson(res, 404, { error: 'not-found', message: `no mock route for ${req.method} ${url.pathname}` })
  }

  async handleEnroll(req, res) {
    let body
    try {
      body = JSON.parse(await readRequestBody(req))
    } catch {
      return this.sendJson(res, 400, { error: 'bad-request', message: 'body must be JSON under 16 KiB' })
    }
    if (!body || typeof body !== 'object') {
      return this.sendJson(res, 400, { error: 'bad-request', message: 'missing key or join' })
    }

    // v1.7.0 one-address join: `{ join }` is an alternative to `{ key }`.
    if (typeof body.join === 'string' && body.join !== '') {
      if (body.join !== this.joinToken) {
        return this.sendJson(res, 401, { error: 'invalid-join', message: 'unknown join token' })
      }
      // A reusable fleet address: re-joining from the same machine replaces its
      // record instead of adding a duplicate (the hub keys join enrolls off the
      // machine hostname, exactly like the keyed path with `replace`).
      return this.completeEnrollment(res, body, { viaJoin: true, replace: true })
    }
    if (typeof body.key !== 'string' || !body.key) {
      return this.sendJson(res, 400, { error: 'bad-request', message: 'missing key or join' })
    }
    const key = this.keys.get(body.key)
    if (!key) return this.sendJson(res, 401, { error: 'invalid-key', message: 'unknown enrollment key' })
    if (key.usedAt) return this.sendJson(res, 409, { error: 'key-used', message: 'this enrollment key was already used' })
    if (Date.now() > key.expiresAt) return this.sendJson(res, 410, { error: 'key-expired', message: 'this enrollment key has expired' })
    return this.completeEnrollment(res, body, { viaJoin: false, replace: key.replace })
  }

  /**
   * Shared enroll tail (key and join paths): upsert the computer record, mint a
   * token, mark the key used and answer §3.1's 200 payload.
   */
  completeEnrollment(res, body, { viaJoin, replace }) {
    const machine = body.machine && typeof body.machine === 'object' ? body.machine : {}
    const name = typeof machine.name === 'string' && machine.name ? machine.name : this.name
    const hostname = typeof machine.hostname === 'string' ? machine.hostname : 'mock.local'

    let computer
    if (replace) {
      computer = [...this.computers.values()].find((entry) => entry.hostname === hostname || entry.name === name)
    }
    if (!computer) {
      computer = {
        id: idFor(),
        name,
        hostname,
        os: machine.os ?? 'unknown',
        arch: machine.arch ?? 'unknown',
        platform: machine.platform ?? 'Unknown',
        cpuModel: machine.cpuModel ?? 'unknown',
        memoryBytes: machine.memoryBytes ?? 0,
        nodeVersion: machine.nodeVersion ?? 'unknown',
        agentVersion: body.agentVersion ?? 'unknown',
        createdAt: new Date().toISOString(),
        token: '',
      }
      this.computers.set(computer.id, computer)
    } else {
      this.tokens.delete(computer.token)
    }

    const token = tokenFor()
    computer.token = token
    computer.name = name
    computer.hostname = hostname
    computer.agentVersion = body.agentVersion ?? computer.agentVersion
    this.tokens.set(token, computer.id)
    if (!viaJoin) {
      const key = this.keys.get(body.key)
      if (key) {
        key.usedAt = Date.now()
        key.computerId = computer.id
      }
    }

    this.enrollments.push({
      at: Date.now(),
      // Exactly one credential is sent: `key` for the one-time path, `join` for
      // the one-address path (null when the other was used).
      key: viaJoin ? null : body.key,
      join: viaJoin ? body.join : null,
      viaJoin,
      agentVersion: body.agentVersion,
      capabilities: body.capabilities,
      metadata: body.metadata,
      // v1.9.0: the machine's local skills report (top-level, not in metadata).
      skills: body.skills,
      machine,
      replace: body.replace === true,
    })

    return this.sendJson(res, 200, {
      computerId: computer.id,
      token,
      name: computer.name,
      serverUrl: this.url,
    })
  }

  handleEvents(req, res) {
    this.eventsRequests.push({ at: Date.now(), headers: { ...req.headers } })
    // A plugin reload / generic /api fence answers before our route is reached,
    // so the fence deliberately bypasses auth.
    if (this.eventsFence.length > 0) {
      const hit = this.eventsFence.shift()
      this.fenceHits.push(hit)
      if (this.verbose) process.stderr.write(`[mock] fence -> ${hit.status} ${hit.body}\n`)
      return this.sendRaw(res, hit.status, hit.body, hit.contentType)
    }
    const computer = this.authenticate(req)
    if (!computer) {
      // The host plugin's own rejection is JSON `{error:'invalid-token'}`.
      return this.sendJson(res, 401, { error: 'invalid-token', message: 'invalid or missing agent token' })
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    // Only one live stream per computer: a new one replaces the old one.
    const previous = this.streams.get(computer.id)
    if (previous) {
      try {
        previous.res.end()
      } catch {
        // ignore
      }
      previous.closedAt = Date.now()
      this.streams.delete(computer.id)
    }

    const entry = { computerId: computer.id, res, id: ++this.streamSeq, openedAt: Date.now() }
    this.streams.set(computer.id, entry)
    this.streamHistory.push(entry)
    if (this.verbose) process.stderr.write(`[mock] stream open for ${computer.id}\n`)

    const hello = { computerId: computer.id, name: computer.name, heartbeatMs: this.heartbeatMs }
    if (this.features !== null) hello.features = [...this.features]
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`)

    for (const waiter of this.streamWaiters.splice(0)) waiter.resolve(computer.id)

    const cleanup = () => {
      const current = this.streams.get(computer.id)
      if (current && current.res === res) this.streams.delete(computer.id)
      entry.closedAt = Date.now()
      if (this.verbose) process.stderr.write(`[mock] stream closed for ${computer.id}\n`)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    return undefined
  }

  async handleResults(req, res) {
    if (!this.authenticate(req)) return this.sendJson(res, 401, { error: 'invalid-token', message: 'invalid or missing agent token' })
    let body
    try {
      // Results carry up to 1 MiB of stdout + 1 MiB of stderr per stream, so
      // unlike enroll (16 KiB, PROTOCOL §3.1) this route needs a wider limit.
      body = JSON.parse(await readRequestBody(req, 8 * 1024 * 1024))
    } catch {
      return this.sendJson(res, 400, { error: 'bad-request', message: 'body must be JSON' })
    }
    if (!body || typeof body.requestId !== 'string') {
      return this.sendJson(res, 400, { error: 'bad-request', message: 'missing requestId' })
    }
    if (!this.pending.has(body.requestId)) {
      const entry = { requestId: body.requestId, payload: body, at: Date.now() }
      this.rejectedResults.push(entry)
      const waiter = this.rejectedWaiters.get(body.requestId)
      if (waiter) {
        this.rejectedWaiters.delete(body.requestId)
        waiter(body)
      }
      return this.sendJson(res, 404, { error: 'unknown-request' })
    }
    this.pending.delete(body.requestId)
    const entry = { requestId: body.requestId, payload: body, at: Date.now() }
    this.results.push(entry)
    const waiter = this.resultWaiters.get(body.requestId)
    if (waiter) {
      this.resultWaiters.delete(body.requestId)
      waiter(body)
    }
    return this.sendJson(res, 200, { ok: true })
  }

  async handleChunk(req, res) {
    this.chunkAttempts += 1
    if (this.chunkFailuresRemaining > 0) {
      this.chunkFailuresRemaining -= 1
      return this.sendJson(res, 503, { error: 'unavailable', message: 'chunk sink temporarily unavailable' })
    }
    if (!this.authenticate(req)) return this.sendJson(res, 401, { error: 'invalid-token', message: 'invalid or missing agent token' })
    let body
    try {
      body = JSON.parse(await readRequestBody(req, 8 * 1024 * 1024))
    } catch {
      return this.sendJson(res, 400, { error: 'bad-request', message: 'body must be JSON' })
    }
    if (
      !body ||
      typeof body.requestId !== 'string' ||
      typeof body.seq !== 'number' ||
      !['stdout', 'stderr', 'heartbeat'].includes(body.type) ||
      typeof body.data !== 'string'
    ) {
      return this.sendJson(res, 400, { error: 'bad-request', message: 'malformed chunk frame' })
    }
    this.chunks.push({ requestId: body.requestId, seq: body.seq, type: body.type, data: body.data, at: Date.now() })
    return this.sendJson(res, 200, { ok: true })
  }

  async handleFsResult(req, res) {
    if (!this.authenticate(req)) return this.sendJson(res, 401, { error: 'invalid-token', message: 'invalid or missing agent token' })
    let body
    try {
      body = JSON.parse(await readRequestBody(req, 8 * 1024 * 1024))
    } catch {
      return this.sendJson(res, 400, { error: 'bad-request', message: 'body must be JSON' })
    }
    if (!body || typeof body.requestId !== 'string') {
      return this.sendJson(res, 400, { error: 'bad-request', message: 'missing requestId' })
    }
    this.fsResults.push({ requestId: body.requestId, payload: body, at: Date.now() })
    return this.sendJson(res, 200, { ok: true })
  }

  async handleHeartbeat(req, res) {
    this.heartbeatAttempts += 1
    if (this.heartbeatFailuresRemaining > 0) {
      this.heartbeatFailuresRemaining -= 1
      return this.sendJson(res, 503, { error: 'unavailable', message: 'heartbeat sink temporarily unavailable' })
    }
    const computer = this.authenticate(req)
    if (!computer) return this.sendJson(res, 401, { error: 'invalid-token', message: 'invalid or missing agent token' })
    let body = {}
    try {
      body = JSON.parse(await readRequestBody(req))
    } catch {
      return this.sendJson(res, 400, { error: 'bad-request', message: 'body must be JSON' })
    }
    this.heartbeats.push({ at: Date.now(), body, computerId: computer.id })
    return this.sendJson(res, 200, { ok: true, name: computer.name })
  }
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (isDirectRun()) {
  const args = process.argv.slice(2)
  const readFlag = (name, fallback) => {
    const index = args.indexOf(name)
    return index === -1 ? fallback : args[index + 1]
  }
  const mock = new MockComputerServer({
    name: readFlag('--name', 'Mock Mac'),
    verbose: args.includes('--verbose'),
  })
  const port = Number(readFlag('--port', '0'))
  await new Promise((resolve, reject) => {
    mock.server = createServer((req, res) => {
      mock.handle(req, res).catch((error) => {
        if (!res.headersSent) mock.sendJson(res, 500, { error: 'internal', message: String(error?.message || error) })
        else res.end()
      })
    })
    mock.server.once('error', reject)
    mock.server.listen(port, '127.0.0.1', () => {
      mock.server.off('error', reject)
      resolve()
    })
  })
  mock.port = mock.server.address().port
  mock.url = `http://127.0.0.1:${mock.port}`
  const key = mock.createEnrollKey({ replace: true })
  const script = fileURLToPath(new URL('../dsh-computers-agent.mjs', import.meta.url))
  console.log(`mock dsh-computers server listening on ${mock.url}`)
  console.log(`join:    node "${script}" enroll --server '${mock.joinAddress}'`)
  console.log(`enroll:  node "${script}" enroll --server ${mock.url} --key ${key}`)
  console.log(`run:     DSH_COMPUTERS_HOME=${path.join(process.cwd(), 'tmp-agent-home')} node "${script}" run`)
  console.log('Ctrl-C to stop.')
  const shutdown = async () => {
    await mock.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
