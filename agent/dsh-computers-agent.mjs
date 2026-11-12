#!/usr/bin/env node
/**
 * dsh-computers-agent — the machine-side half of dsh-computers.
 *
 * What it does (the whole trust story, so this file can be audited):
 *   1. `enroll` sends the one-time join key to the dsh-web server and stores the
 *      long-lived token it gets back in a 0600 JSON file under ~/.dsh-computers.
 *   2. `run` keeps one outbound SSE stream open (GET .../agent/events) carrying
 *      `exec` / `cancel` / `ping` / `config` events, executes the commands the
 *      server sends with the local shell, and POSTs the result back.
 *   3. `service` installs a user-level launchd / systemd unit so `run` starts at
 *      login and is restarted if it ever exits.
 *
 * It only makes outbound connections. It never listens on a port, never opens a
 * reverse proxy, and never prints the token. There are no dependencies, no
 * dynamic imports and no child processes other than the commands the server
 * asks for, the service manager, and (on Windows) taskkill.
 *
 * Protocol: see PROTOCOL.md in the dsh-computers repository (v1).
 *
 * Node.js >= 22, self-contained ESM. This exact file is served at
 * /api/dsh-computers/agent.mjs and downloaded by the install one-liner, so it
 * must work from any install directory and must not import siblings.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

// Keep in sync with package.json. The server compares this for display only.
export const AGENT_VERSION = '1.4.0'

const DEFAULT_EXEC_TIMEOUT_MS = 120_000
const MAX_EXEC_TIMEOUT_MS = 24 * 60 * 60 * 1000
const MAX_OUTPUT_BYTES = 1024 * 1024
const TRUNCATION_MARKER = '\n[output truncated]'
const LOG_ROTATE_BYTES = 5 * 1024 * 1024
const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
const HEARTBEAT_LOG_INTERVAL_MS = 60_000
const TRANSIENT_SERVER_WARN_INTERVAL_MS = 60_000
const DEFAULT_HEARTBEAT_MS = 20_000

// PROTOCOL §11: capabilities, streaming frames and remote fs.
const AGENT_CAPABILITIES = ['exec', 'fs']
const HANDSHAKE_VERSION = 1
const CHUNK_FLUSH_INTERVAL_MS = 100
const CHUNK_MAX_BATCH_BYTES = 32 * 1024
const CHUNK_HEARTBEAT_MS = 10_000
const CHUNK_POST_TIMEOUT_MS = 15_000
const FS_REQUEST_TIMEOUT_MS = 15_000
const FS_READ_MAX_BYTES = 1024 * 1024
const FS_READ_MAX_LINES = 20_000
const FS_READ_DEFAULT_LIMIT = 2000
const FS_WRITE_MAX_BYTES = 4 * 1024 * 1024
const FS_LIST_MAX_ENTRIES = 5000
const FS_GLOB_MAX_PATHS = 2000
const FS_GREP_MAX_MATCHES = 500
const FS_GREP_MAX_FILE_BYTES = 8 * 1024 * 1024
const FS_BINARY_SNIFF_BYTES = 8192
const FS_OPS = ['read', 'write', 'list', 'stat', 'mkdir', 'rename', 'delete', 'glob', 'grep']

// Service identifier. Overridable so tests (and power users with two installs)
// can use an isolated launchd/systemd job. Not part of the protocol.
const SERVICE_LABEL = (process.env.DSH_COMPUTERS_SERVICE_LABEL || 'com.dsh.computers.agent').trim()
const SERVICE_ACTIONS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status']

const SELF_PATH = path.resolve(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

function describeError(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return '请求被中止或超时'
  const cause = error.cause
  const causeText = cause ? (cause.code && cause.message ? `${cause.code} ${cause.message}` : String(cause.message || cause)) : ''
  const text = error.message ? String(error.message) : String(error)
  return causeText && !text.includes(causeText) ? `${text} (${causeText})` : text
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function abbreviate(text, max = 160) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ')
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

function platformLabel(platform = process.platform) {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  if (platform === 'win32') return 'Windows'
  return 'Unknown'
}

function machineInfo(name) {
  const hostname = os.hostname()
  let cpu = 'unknown'
  try {
    cpu = os.cpus()?.[0]?.model?.trim() || 'unknown'
  } catch {
    // os.cpus() is allowed to fail on some sandboxes; a placeholder is fine.
  }
  return {
    hostname,
    name: name && name.trim() ? name.trim() : hostname,
    os: process.platform,
    arch: process.arch,
    platform: platformLabel(),
    cpuModel: cpu,
    memoryBytes: os.totalmem(),
    nodeVersion: process.version,
  }
}

/**
 * The agent's default working directory (PROTOCOL §11.6): config `workspaceBase`,
 * default `os.homedir()`. Used as the default exec cwd and the base for
 * relative glob/grep patterns.
 */
function normalizeWorkspaceBase(value) {
  if (typeof value !== 'string' || !value.trim()) return os.homedir()
  let text = value.trim()
  if (text === '~') text = os.homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(os.homedir(), text.slice(2))
  return path.resolve(text)
}

/**
 * How this agent instance is running. `service` = the CLI/launchd one-liner
 * (there is a file at ~/.dsh-computers/agent.mjs to upgrade); `embedded` = the
 * plugin's in-process runtime (upgrade the DSH plugin instead).
 */
function normalizeRuntimeMode(value) {
  return value === 'embedded' ? 'embedded' : 'service'
}

/**
 * R2a: per-instance capability flags — the source of truth for what this agent
 * can actually do, so the host/UI never has to infer features from a version
 * number. Additive to §11.6 metadata; older hosts ignore unknown keys.
 *
 *   exec   — run shell commands (`exec` events, results, cancel, chunks)
 *   fs     — remote file access (§11.3 handlers are wired). `false` only when
 *            the instance was started with the test/advanced option `fs:false`
 *   jobs   — supports the host's background-job path: it accepts `cancel`,
 *            streams output chunks and always posts one final result
 *   pty    — terminal backend (§11.4, not implemented yet: always false)
 *   tunnel — relay/tunnel transport (not implemented: always false)
 *
 * `caps` does not get its own envelope: it rides inside the existing §11.6
 * metadata (`version: 1`), alongside the legacy `capabilities: ['exec','fs']`
 * array, which stays untouched for backwards compatibility.
 */
function agentCaps({ fs = true, jobs = true } = {}) {
  return { exec: true, fs: fs === true, jobs: jobs === true, pty: false, tunnel: false }
}

/**
 * PROTOCOL §11.6 handshake metadata + R2a `caps`.
 *
 * Reported in the enroll body, in the `x-dsh-computers-metadata` header on
 * every SSE connect (probe and each reconnect) and mirrored into the heartbeat
 * `meta`. `caps` is the authoritative per-instance capability object; the
 * legacy `capabilities` array is kept unchanged for older hosts.
 */
function handshakeMetadata(workspaceBase, mode, caps) {
  const info = machineInfo('')
  return {
    version: HANDSHAKE_VERSION,
    agentVersion: AGENT_VERSION,
    mode: normalizeRuntimeMode(mode),
    hostname: info.hostname,
    os: info.os,
    arch: info.arch,
    capabilities: [...AGENT_CAPABILITIES],
    caps: { ...(caps ?? agentCaps()) },
    workspaceBase: normalizeWorkspaceBase(workspaceBase),
  }
}

function encodeMetadataHeader(metadata) {
  return Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url')
}

// ---------------------------------------------------------------------------
// Paths and config (${DSH_COMPUTERS_HOME:-$HOME/.dsh-computers})
// ---------------------------------------------------------------------------

function agentHome() {
  const override = process.env.DSH_COMPUTERS_HOME
  if (override && override.trim()) return path.resolve(override.trim())
  return path.join(os.homedir(), '.dsh-computers')
}

function configFile() {
  return path.join(agentHome(), 'config.json')
}

function logFile() {
  return path.join(agentHome(), 'agent.log')
}

function launchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}

function systemdUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_LABEL}.service`)
}

function nohupPidFile() {
  return path.join(agentHome(), 'agent.pid')
}

function ensureAgentHome() {
  const home = agentHome()
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  } catch {
    // reported later when a write actually fails
  }
  try {
    fs.chmodSync(home, 0o700)
  } catch {
    // best effort: FAT/exFAT and Windows do not support POSIX modes
  }
  return home
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
}

/**
 * Write `data` to `file` through a temp file + rename, with an explicit mode.
 * Rename is atomic on the same filesystem, so a crash never leaves a partial
 * config.json that would lose the enrollment.
 */
async function atomicWriteFile(file, data, mode = 0o600) {
  await ensureDir(path.dirname(file))
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`)
  let handle
  try {
    handle = await fsp.open(tmp, 'w', mode)
    await handle.writeFile(data, 'utf8')
    try {
      await handle.sync()
    } catch {
      // fsync is not supported everywhere (and not required for atomicity)
    }
    await handle.close()
    handle = undefined
    await fsp.rename(tmp, file)
    try {
      await fsp.chmod(file, mode)
    } catch {
      // best effort only
    }
  } catch (error) {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // ignore
      }
    }
    try {
      await fsp.rm(tmp, { force: true })
    } catch {
      // ignore
    }
    throw error
  }
}

async function saveConfig(config) {
  await atomicWriteFile(configFile(), `${JSON.stringify(config, null, 2)}\n`, 0o600)
}

async function loadConfig() {
  const file = configFile()
  let raw
  let info
  try {
    info = await fsp.stat(file)
    raw = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CliError(`尚未注册：找不到配置文件 ${file}\n请先运行 enroll --server <url> --key <key>（或使用服务器给出的安装命令）。`)
    }
    throw new CliError(`无法读取配置文件 ${file}：${describeError(error)}`)
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    process.stderr.write(`警告：${file} 的权限过宽，已修正为 0600\n`)
    try {
      await fsp.chmod(file, 0o600)
    } catch {
      // keep going; the token is still only used locally
    }
  }
  const parsed = parseJsonSafe(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`配置文件 ${file} 不是合法 JSON，请重新 enroll。`)
  }
  if (parsed.version !== 1) {
    throw new CliError(`配置文件 ${file} 的版本不受支持（${String(parsed.version)}），请重新 enroll。`)
  }
  for (const field of ['serverUrl', 'computerId', 'token', 'name']) {
    if (typeof parsed[field] !== 'string' || parsed[field].length === 0) {
      throw new CliError(`配置文件 ${file} 缺少字段 ${field}，请重新 enroll。`)
    }
  }
  return {
    version: 1,
    serverUrl: normalizeServerUrl(parsed.serverUrl),
    computerId: parsed.computerId,
    token: parsed.token,
    name: parsed.name,
    enrolledAt: typeof parsed.enrolledAt === 'string' ? parsed.enrolledAt : '',
    workspaceBase: normalizeWorkspaceBase(parsed.workspaceBase),
  }
}

function redactToken(token) {
  if (typeof token !== 'string' || token.length === 0) return '(无)'
  return `dshc_…${token.slice(-6)}`
}

// ---------------------------------------------------------------------------
// Logging (agent.log, append, 5 MiB rotation keeping one .1)
// ---------------------------------------------------------------------------

function appendLog(message) {
  const file = logFile()
  try {
    ensureAgentHome()
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      size = 0
    }
    if (size > LOG_ROTATE_BYTES) {
      try {
        fs.rmSync(`${file}.1`, { force: true })
      } catch {
        // ignore
      }
      try {
        fs.renameSync(file, `${file}.1`)
      } catch {
        // a concurrent writer may have moved it; not fatal
      }
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 })
  } catch {
    // Logging must never take the agent down.
  }
}

/**
 * Default logger for embedders that did not pass `log` (e.g. a test or a host
 * that forgot it): stay quiet on info, surface warnings/errors on the console.
 */
function defaultRuntimeLog(level, message) {
  if (level === 'warn') console.warn(`dsh-computers-agent: ${message}`)
  else if (level === 'error') console.error(`dsh-computers-agent: ${message}`)
}

/**
 * CLI `run` sink: always append to agent.log, and also echo to stdout unless
 * launchd is already capturing stdout into the same log file.
 */
function createCliLogSink() {
  return (level, message) => {
    appendLog(level === 'info' ? message : `[${level}] ${message}`)
    if (process.env.DSH_COMPUTERS_LOG_ONLY !== '1') {
      process.stdout.write(`[${new Date().toISOString()}] ${message}\n`)
    }
  }
}

const RUNTIME_LOG_LEVELS = new Set(['info', 'warn', 'error'])

/** Call the runtime's logger; a broken host logger must never break the loop. */
function runtimeLog(runtime, level, message) {
  try {
    runtime.log(RUNTIME_LOG_LEVELS.has(level) ? level : 'info', message)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// HTTP / SSE client (global fetch, no dependencies)
// ---------------------------------------------------------------------------

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '')
}

function apiBase(serverUrl) {
  return `${trimTrailingSlash(serverUrl)}/api/dsh-computers`
}

function enrollUrl(serverUrl) {
  return `${apiBase(serverUrl)}/agent/enroll`
}

function eventsUrl(serverUrl) {
  return `${apiBase(serverUrl)}/agent/events`
}

function resultsUrl(serverUrl) {
  return `${apiBase(serverUrl)}/agent/results`
}

function heartbeatUrl(serverUrl) {
  return `${apiBase(serverUrl)}/agent/heartbeat`
}

function chunkUrl(serverUrl) {
  return `${apiBase(serverUrl)}/agent/results/chunk`
}

function fsResultUrl(serverUrl) {
  return `${apiBase(serverUrl)}/agent/fs/result`
}

function normalizeServerUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CliError('缺少 --server <url>（dsh-web 的地址，例如 http://127.0.0.1:3000）')
  }
  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new CliError(`--server 不是合法 URL：${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('--server 必须是 http:// 或 https:// 地址')
  }
  url.search = ''
  url.hash = ''
  return trimTrailingSlash(url.toString())
}

function requestHeaders(token, extra = {}) {
  const headers = {
    'user-agent': `dsh-computers-agent/${AGENT_VERSION}`,
    ...extra,
  }
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

/**
 * One JSON request. Returns { status, ok, json, text }. Throws only on
 * transport-level failures (DNS, refused connection, timeout, abort).
 */
async function requestJson(url, { method = 'GET', token, body, timeoutMs = 30_000, signal } = {}) {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort(signal.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders(token, body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    return { status: response.status, ok: response.ok, json: parseJsonSafe(text), text }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * Decide whether an HTTP 401 is OUR rejection of the stored token, or a
 * transient server-side condition.
 *
 * The host plugin answers a bad bearer with JSON `{"error":"invalid-token",...}`
 * (PROTOCOL §3). Anything else on 401 — bare text, a different JSON error, an
 * empty body — is NOT proof that the token is dead: while the plugin is being
 * disabled/enabled or upgraded, the SSE route momentarily does not exist and
 * the request falls through to the generic `/api` gateway, which answers a bare
 * 401/`unauthorized`. Treating that as fatal would break every connected
 * machine until the user re-ran the installer, so it must be retried instead.
 *
 * The same rule applies to 403/404/5xx: any non-2xx during connect is a
 * server-side condition, never a reason to drop the enrollment.
 */
function isInvalidTokenRejection(status, bodyText) {
  if (status !== 401) return false
  const parsed = parseJsonSafe(bodyText)
  return Boolean(parsed && typeof parsed === 'object' && parsed.error === 'invalid-token')
}

/** Read an error response body without ever throwing (bodies are tiny). */
async function readErrorBody(response) {
  try {
    return (await response.text()).trim()
  } catch {
    return ''
  }
}

function sseHeaders(token, metadata) {
  const headers = requestHeaders(token, {
    accept: 'text/event-stream',
    'cache-control': 'no-cache',
  })
  // PROTOCOL §11.6: every reconnect (SSE GET has no body) carries the handshake
  // metadata as a base64url JSON header, mirroring the reference product.
  if (metadata) headers['x-dsh-computers-metadata'] = encodeMetadataHeader(metadata)
  return headers
}

/** Parse one SSE block (`event:` / `data:` lines) into { event, data }. */
function parseSseBlock(block) {
  let name = ''
  const dataLines = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') name = value
    else if (field === 'data') dataLines.push(value)
    // `id:` and `retry:` are accepted and ignored; the agent owns its backoff.
  }
  if (name === '' && dataLines.length === 0) return null
  return { event: name || 'message', data: dataLines.join('\n') }
}

/** Async generator over the events of a text/event-stream body. */
async function* sseEvents(stream, signal) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) return
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseSseBlock(block)
        if (event) yield event
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // already errored/closed
    }
  }
}

/** Open the event stream for ~timeoutMs and wait for `hello`. */
async function probeEventStream(config, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetch(eventsUrl(config.serverUrl), {
      headers: sseHeaders(config.token, handshakeMetadata(config.workspaceBase, config.mode, config.caps)),
      signal: controller.signal,
    })
    if (response.status === 401) {
      const body = await readErrorBody(response)
      if (isInvalidTokenRejection(response.status, body)) {
        return { ok: false, unauthorized: true, message: 'HTTP 401 invalid-token' }
      }
      return { ok: false, message: `HTTP 401${body ? ` ${abbreviate(body, 80)}` : ''}（服务器可能尚未就绪）` }
    }
    if (!response.ok) {
      const body = await readErrorBody(response)
      return { ok: false, message: `HTTP ${response.status}${body ? ` ${abbreviate(body, 80)}` : ''}` }
    }
    if (!response.body) return { ok: false, message: '响应没有 body' }
    for await (const event of sseEvents(response.body, controller.signal)) {
      if (event.event === 'hello') {
        return { ok: true, hello: parseJsonSafe(event.data) || {} }
      }
    }
    return { ok: false, message: '服务器没有发送 hello 事件' }
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, message: `等待 hello 超时（${timeoutMs}ms）` }
    return { ok: false, message: describeError(error) }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/**
 * Build the host-native shell invocation.
 * POSIX: /bin/sh -lc <command> (login shell so the user's PATH is available).
 * Windows: let Node build `cmd.exe /d /s /c <command>` via the `shell` option;
 * passing the command as an argv element would double-apply CreateProcess
 * quoting and break metacharacters.
 */
function shellSpawnSpec(command) {
  if (process.platform === 'win32') {
    return { command, args: [], detached: false, shell: process.env.ComSpec || 'cmd.exe' }
  }
  return { command: '/bin/sh', args: ['-lc', command], detached: true, shell: false }
}

function resolveCwd(cwd) {
  const home = os.homedir()
  if (typeof cwd !== 'string' || cwd.trim() === '') return home
  let value = cwd.trim()
  if (value === '~') value = home
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(home, value.slice(2))
  return path.resolve(value)
}

/** Bounded byte capture for one output stream; never grows past `limit`. */
function createCapture(limit = MAX_OUTPUT_BYTES) {
  const chunks = []
  let size = 0
  let overflow = false
  return {
    push(chunk) {
      if (overflow) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const room = limit - size
      if (buffer.length > room) {
        if (room > 0) {
          chunks.push(buffer.subarray(0, room))
          size = limit
        }
        overflow = true
        return
      }
      chunks.push(buffer)
      size += buffer.length
    },
    isTruncated: () => overflow,
    text: () => Buffer.concat(chunks, size).toString('utf8'),
  }
}

function normalizeTimeout(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_EXEC_TIMEOUT_MS
  return Math.min(Math.max(1, Math.floor(number)), MAX_EXEC_TIMEOUT_MS)
}

/**
 * Run one command. Resolves with exactly the §3.3 result shape (minus
 * requestId):
 *   { ok, exitCode, signal, stdout, stderr, durationMs, truncated, timedOut, error }
 *
 * The child is spawned detached on POSIX so the whole process group can be
 * SIGKILLed on timeout/cancel; otherwise `sh -lc 'cmd | pipeline'` would leave
 * grandchildren running and the timeout would not actually stop the work.
 */
function executeCommand({ command, cwd, timeoutMs, onStdout, onStderr }) {
  const startedAt = Date.now()
  const limit = normalizeTimeout(timeoutMs)
  const stdout = createCapture()
  const stderr = createCapture()
  let child
  let finished = false
  let timedOut = false
  let cancelled = false
  let timeoutTimer
  let killTimer
  let resolvePromise
  const promise = new Promise((resolve) => {
    resolvePromise = resolve
  })

  const settle = (exitCode, signalCode, errorMessage) => {
    if (finished) return
    finished = true
    clearTimeout(timeoutTimer)
    clearTimeout(killTimer)
    const truncated = stdout.isTruncated() || stderr.isTruncated()
    resolvePromise({
      ok: exitCode === 0 && !timedOut && !cancelled,
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      signal: signalCode ?? null,
      stdout: stdout.text() + (stdout.isTruncated() ? TRUNCATION_MARKER : ''),
      stderr: stderr.text() + (stderr.isTruncated() ? TRUNCATION_MARKER : ''),
      durationMs: Date.now() - startedAt,
      truncated,
      timedOut,
      error: errorMessage ?? (cancelled ? 'cancelled' : null),
    })
  }

  const killGroup = () => {
    if (finished) return
    if (!child || child.pid === undefined) return
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).unref()
      } catch {
        // best effort
      }
    } else {
      try {
        // Negative pid = the child's process group (it is a group leader).
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
    }
    // SIGKILL cannot be ignored, but guard against a wedged close event so the
    // result is always reported.
    killTimer = setTimeout(() => settle(null, 'SIGKILL', cancelled ? 'cancelled' : '命令在终止后仍未退出'), 5000)
    killTimer.unref?.()
  }

  try {
    const spec = shellSpawnSpec(String(command ?? ''))
    child = spawn(spec.command, spec.args, {
      cwd: resolveCwd(cwd),
      env: process.env,
      detached: spec.detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: spec.shell,
      windowsHide: true,
    })
  } catch (error) {
    settle(null, null, `无法启动命令：${describeError(error)}`)
    return { promise, cancel() {} }
  }

  // The capture is capped for the final result; streaming (when enabled by the
  // host) sees every chunk so the job ring/progress view stays live.
  child.stdout?.on('data', (chunk) => {
    stdout.push(chunk)
    if (onStdout) {
      try {
        onStdout(chunk)
      } catch {
        // a broken stream sink must never kill the command
      }
    }
  })
  child.stderr?.on('data', (chunk) => {
    stderr.push(chunk)
    if (onStderr) {
      try {
        onStderr(chunk)
      } catch {
        // ignore
      }
    }
  })
  child.on('error', (error) => settle(null, null, `命令进程错误：${describeError(error)}`))
  child.on('close', (code, signalCode) => settle(code, signalCode, null))
  timeoutTimer = setTimeout(() => {
    timedOut = true
    killGroup()
  }, limit)

  return {
    promise,
    cancel() {
      if (finished) return
      cancelled = true
      killGroup()
    },
  }
}

// ---------------------------------------------------------------------------
// results / heartbeat client (one runtime instance per startRuntime() call)
// ---------------------------------------------------------------------------

async function postResult(runtime, payload) {
  const config = runtime.config
  const url = resultsUrl(config.serverUrl)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await requestJson(url, { method: 'POST', token: config.token, body: payload, timeoutMs: 30_000 })
      if (response.status === 200) return true
      if (response.status === 404) {
        runtimeLog(runtime, 'info', '结果被服务器忽略（该请求已结算或已超时）')
        return false
      }
      if (response.status === 401) {
        if (isInvalidTokenRejection(response.status, response.text)) {
          runtimeLog(runtime, 'error', '结果上报被拒绝（invalid-token）：token 已失效，需要重新 enroll')
          return false
        }
        // Bare/foreign 401 (server reloading): retry like any transient failure.
        throw new Error(`HTTP 401${response.text ? ` ${abbreviate(response.text, 80)}` : ''}`)
      }
      throw new Error(`HTTP ${response.status}${response.text ? ` ${abbreviate(response.text, 100)}` : ''}`)
    } catch (error) {
      if (attempt === 3) {
        runtimeLog(runtime, 'error', `结果上报失败（${payload.requestId}）：${describeError(error)}`)
        return false
      }
      await sleep(1000 * attempt)
    }
  }
  return false
}

async function sendHeartbeat(runtime) {
  const config = runtime.config
  const state = runtime.state
  try {
    const response = await requestJson(heartbeatUrl(config.serverUrl), {
      method: 'POST',
      token: config.token,
      body: {
        meta: {
          cpuModel: machineInfo('').cpuModel,
          memoryBytes: os.totalmem(),
          agentVersion: AGENT_VERSION,
          capabilities: [...AGENT_CAPABILITIES],
          mode: config.mode,
          caps: { ...config.caps },
        },
      },
      timeoutMs: 15_000,
    })
    if (response.status === 401) {
      if (isInvalidTokenRejection(response.status, response.text)) {
        runtimeLog(runtime, 'error', '心跳被拒绝（invalid-token）：token 已失效，请重新 enroll')
      } else {
        logHeartbeatError(runtime, `HTTP 401${response.text ? ` ${abbreviate(response.text, 60)}` : ''}（服务器可能正在重启）`)
      }
      return
    }
    if (!response.ok) {
      logHeartbeatError(runtime, `HTTP ${response.status}`)
      return
    }
    const name = response.json && typeof response.json.name === 'string' ? response.json.name : ''
    if (name && name !== state.name) {
      state.name = name
      config.name = name
      emitRuntimeState(runtime)
      runtimeLog(runtime, 'info', `服务器把电脑名称更新为 ${name}`)
    }
  } catch (error) {
    logHeartbeatError(runtime, describeError(error))
  }
}

function logHeartbeatError(runtime, message) {
  const now = Date.now()
  if (now - runtime.state.lastHeartbeatErrorAt < HEARTBEAT_LOG_INTERVAL_MS) return
  runtime.state.lastHeartbeatErrorAt = now
  runtimeLog(runtime, 'warn', `心跳失败：${message}`)
}

// ---------------------------------------------------------------------------
// Streaming result chunks (§11.2 / §11.6)
//
// Only used when an `exec` event carries `stream: true` AND the host's `hello`
// advertised the `stream` feature (§11.5). Frames are posted sequentially (so
// `seq` order matches arrival order):
//   { requestId, seq, type: 'stdout'|'stderr'|'heartbeat', data: base64 }
// Batches flush at most every 100 ms or 32 KiB (whichever first); a heartbeat
// frame goes out after each configured silent period (default 10 s). Chunk
// failures retry once, then that batch is dropped — the final /agent/results
// POST remains authoritative and still carries the capped buffers.
// ---------------------------------------------------------------------------

function logChunkDropThrottled(runtime, reason) {
  const now = Date.now()
  if (now - runtime.state.lastChunkDropAt < HEARTBEAT_LOG_INTERVAL_MS) return
  runtime.state.lastChunkDropAt = now
  runtimeLog(runtime, 'warn', `流式分片上报失败（已丢弃该批）：${reason}`)
}

function createChunkPump(runtime, requestId) {
  const buffers = { stdout: [], stderr: [] }
  const sizes = { stdout: 0, stderr: 0 }
  const heartbeatMs = runtime.state.chunkHeartbeatMs || CHUNK_HEARTBEAT_MS
  let seq = 0
  let queue = Promise.resolve()
  let flushTimer = null
  let heartbeatTimer = null
  let closed = false
  let aborted = false
  let lastSentAt = Date.now()

  const clearTimers = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const postFrame = async (frame) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (aborted || runtime.stopping) return false
      try {
        const response = await requestJson(chunkUrl(runtime.config.serverUrl), {
          method: 'POST',
          token: runtime.config.token,
          body: frame,
          timeoutMs: CHUNK_POST_TIMEOUT_MS,
          signal: runtime.controller.signal,
        })
        if (response.status === 200) {
          lastSentAt = Date.now()
          return true
        }
        if (response.status === 401 && isInvalidTokenRejection(response.status, response.text)) {
          runtimeLog(runtime, 'error', '流式分片被拒绝（invalid-token）：token 已失效，需要重新 enroll')
          return false
        }
        if (attempt === 0) {
          await sleep(50)
          continue
        }
        logChunkDropThrottled(runtime, `HTTP ${response.status}`)
        return false
      } catch (error) {
        if (attempt === 0 && !aborted && !runtime.controller.signal.aborted) {
          await sleep(50)
          continue
        }
        logChunkDropThrottled(runtime, describeError(error))
        return false
      }
    }
    return false
  }

  const enqueue = (frame) => {
    queue = queue.then(() => postFrame(frame)).catch(() => {})
  }

  const takeFrames = () => {
    const frames = []
    for (const type of ['stdout', 'stderr']) {
      if (sizes[type] === 0) continue
      const data = Buffer.concat(buffers[type], sizes[type])
      buffers[type] = []
      sizes[type] = 0
      frames.push({ requestId, seq: seq++, type, data: data.toString('base64') })
    }
    return frames
  }

  const flushNow = () => {
    if (closed || aborted) return
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    for (const frame of takeFrames()) enqueue(frame)
  }

  const scheduleFlush = () => {
    if (flushTimer || closed || aborted) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushNow()
    }, CHUNK_FLUSH_INTERVAL_MS)
    flushTimer.unref?.()
  }

  const maybeHeartbeat = () => {
    if (closed || aborted || runtime.stopping) return
    if (Date.now() - lastSentAt >= heartbeatMs) {
      enqueue({ requestId, seq: seq++, type: 'heartbeat', data: '' })
    }
  }

  heartbeatTimer = setInterval(maybeHeartbeat, heartbeatMs)
  heartbeatTimer.unref?.()

  const pump = {
    push(type, chunk) {
      if (closed || aborted) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      buffers[type].push(buffer)
      sizes[type] += buffer.length
      if (sizes.stdout + sizes.stderr >= CHUNK_MAX_BATCH_BYTES) flushNow()
      else scheduleFlush()
    },
    /** Flush what is buffered, stop timers and wait for queued frames. */
    async close() {
      flushNow()
      closed = true
      clearTimers()
      await queue
    },
    /** Drop everything (shutdown): no flush, no timers, no new frames. */
    abort() {
      aborted = true
      closed = true
      clearTimers()
      buffers.stdout = []
      buffers.stderr = []
      sizes.stdout = 0
      sizes.stderr = 0
    },
  }
  runtime.pumps.add(pump)
  return pump
}

// ---------------------------------------------------------------------------
// Remote file access (§11.3)
//
// Implemented in-process (no shell). Rules:
//   · read/write/list/stat/mkdir/rename/delete require ABSOLUTE paths and answer
//     `ok:false, error:"path must be absolute"` otherwise (§11.3).
//   · glob/grep accept absolute or cwd-relative paths/patterns; relative ones
//     resolve against the agent's workspaceBase (§11.6).
//   · reads follow symlinks (normal OS read semantics, like `cat`); lstat-based
//     stat/list report a symlink itself. write follows an existing symlink.
//   · directory walks never follow symlinked directories (loop safety) and skip
//     `.git`; grep skips binary files and files larger than 8 MiB.
//   · limits: read 1 MiB / 20 000 lines, write 4 MiB, list 5 000 entries,
//     glob 2 000 paths, grep 500 matches, 15 s per request.
// ---------------------------------------------------------------------------

function escapeRegExpText(text) {
  return String(text).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
}

/** Turn a glob (`*`, `?`, `**`, `{a,b}`) into an anchored RegExp on '/'-paths. */
function globToRegExp(pattern) {
  const normalized = String(pattern).replaceAll('\\', '/')
  let out = '^'
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1
        if (normalized[index + 1] === '/') {
          index += 1
          out += '(?:[^/]+/)*'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if (char === '{') {
      const close = normalized.indexOf('}', index)
      if (close === -1) {
        out += '\\{'
      } else {
        const options = normalized.slice(index + 1, close).split(',').map(escapeRegExpText)
        out += `(?:${options.join('|')})`
        index = close
      }
    } else if (char === '[') {
      const close = normalized.indexOf(']', index)
      if (close === -1) {
        out += '\\['
      } else {
        out += normalized.slice(index, close + 1)
        index = close
      }
    } else {
      out += escapeRegExpText(char)
    }
  }
  return new RegExp(`${out}$`)
}

function toPosixPath(value) {
  return String(value).replaceAll('\\', '/')
}

/** Directory prefix of a glob pattern that contains no wildcards. */
function globBaseDirectory(pattern) {
  const normalized = toPosixPath(pattern)
  const absolute = normalized.startsWith('/')
  const segments = normalized.split('/')
  const base = []
  for (const segment of segments) {
    if (segment === '') continue
    if (/[*?[\]{}]/.test(segment)) break
    base.push(segment)
  }
  const joined = base.join('/')
  if (absolute) return joined ? `/${joined}` : '/'
  return joined || '.'
}

function requireAbsoluteFsPath(value) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    throw new Error('path must be absolute')
  }
  return value
}

function resolveWorkspacePath(value, workspaceBase) {
  if (typeof value !== 'string' || value.trim() === '') return workspaceBase
  return path.isAbsolute(value) ? value : path.resolve(workspaceBase, value)
}

function describeFsType(stats) {
  if (!stats) return 'other'
  if (stats.isDirectory()) return 'dir'
  if (stats.isFile()) return 'file'
  if (stats.isSymbolicLink()) return 'symlink'
  return 'other'
}

function looksBinary(buffer) {
  const window = buffer.subarray(0, Math.min(buffer.length, FS_BINARY_SNIFF_BYTES))
  return window.includes(0)
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(number)))
}

async function readFileWindow(file, maximumBytes) {
  const handle = await fsp.open(file, 'r')
  try {
    const stats = await handle.stat()
    const length = Math.min(stats.size, maximumBytes)
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset)
      if (bytesRead <= 0) break
      offset += bytesRead
    }
    return { buffer: buffer.subarray(0, offset), stats }
  } finally {
    await handle.close().catch(() => {})
  }
}

async function fsRead(request) {
  const target = requireAbsoluteFsPath(request.path)
  const stats = await fsp.stat(target)
  if (stats.isDirectory()) throw new Error('EISDIR: illegal operation on a directory, read')
  const { buffer } = await readFileWindow(target, FS_READ_MAX_BYTES + FS_BINARY_SNIFF_BYTES)
  const requestedBase64 = request.encoding === 'base64'
  const requestedUtf8 = request.encoding === 'utf8'
  const binary = requestedBase64 || (!requestedUtf8 && looksBinary(buffer))
  const windowTruncated = stats.size > buffer.length
  if (binary) {
    const content = buffer.subarray(0, FS_READ_MAX_BYTES)
    return {
      encoding: 'base64',
      content: content.toString('base64'),
      bytes: content.length,
      truncated: windowTruncated || buffer.length > FS_READ_MAX_BYTES,
    }
  }
  let text = buffer.subarray(0, FS_READ_MAX_BYTES).toString('utf8')
  let readTruncated = windowTruncated || buffer.length > FS_READ_MAX_BYTES
  if (readTruncated) {
    // Do not return a half line/character at the window edge.
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline > 0) text = text.slice(0, lastNewline)
  }
  const lines = text.split('\n')
  const offset = clampInteger(request.offset, 0, Number.MAX_SAFE_INTEGER, 0)
  const limit = clampInteger(request.limit, 1, FS_READ_MAX_LINES, FS_READ_DEFAULT_LIMIT)
  const selected = lines.slice(offset, offset + limit)
  const selectedText = selected.join('\n')
  return {
    encoding: 'utf8',
    text: selectedText,
    lines: selected.length,
    bytes: Buffer.byteLength(selectedText, 'utf8'),
    truncated: readTruncated || offset + selected.length < lines.length,
  }
}

async function fsWrite(request) {
  const target = requireAbsoluteFsPath(request.path)
  const encoding = request.encoding === 'base64' ? 'base64' : 'utf8'
  const raw = typeof request.content === 'string' ? request.content : request.content == null ? '' : String(request.content)
  const content = encoding === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8')
  if (content.length > FS_WRITE_MAX_BYTES) {
    throw new Error(`content exceeds the ${FS_WRITE_MAX_BYTES} byte write limit`)
  }
  let existed = true
  try {
    await fsp.access(target)
  } catch {
    existed = false
  }
  if (request.createDirs === true) await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, content)
  return { encoding, bytes: content.length, created: !existed }
}

async function fsList(request) {
  const target = requireAbsoluteFsPath(request.path)
  const dirents = await fsp.readdir(target, { withFileTypes: true })
  dirents.sort((left, right) => left.name.localeCompare(right.name))
  const truncated = dirents.length > FS_LIST_MAX_ENTRIES
  const entries = []
  for (const dirent of dirents.slice(0, FS_LIST_MAX_ENTRIES)) {
    const entryPath = path.join(target, dirent.name)
    let stats = null
    try {
      stats = await fsp.lstat(entryPath)
    } catch {
      stats = null
    }
    entries.push({
      name: dirent.name,
      path: entryPath,
      type: describeFsType(stats ?? dirent),
      size: stats ? stats.size : 0,
      mtimeMs: stats ? stats.mtimeMs : 0,
    })
  }
  return { entries, truncated }
}

async function fsStat(request) {
  const target = requireAbsoluteFsPath(request.path)
  const stats = await fsp.lstat(target)
  return {
    stat: {
      type: describeFsType(stats),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      mode: stats.mode & 0o777,
    },
  }
}

async function fsMkdir(request) {
  const target = requireAbsoluteFsPath(request.path)
  await fsp.mkdir(target, { recursive: request.recursive === true })
  return { created: true }
}

async function fsRename(request) {
  const from = requireAbsoluteFsPath(request.path)
  const to = requireAbsoluteFsPath(request.to)
  await fsp.rename(from, to)
  return { path: to }
}

async function fsDelete(request) {
  const target = requireAbsoluteFsPath(request.path)
  await fsp.rm(target, { recursive: request.recursive === true, force: false })
  return {}
}

/** Depth-first walk; never follows symlinked directories, checks abort/deadline. */
async function walkTree(root, context, onEntry) {
  const stack = [root]
  while (stack.length > 0) {
    if (context.signal?.aborted) throw new Error('request aborted')
    if (Date.now() > context.deadline) throw new Error('request timed out')
    const directory = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        await onEntry(full, 'dir')
      } else if (entry.isFile()) {
        await onEntry(full, 'file')
      } else if (entry.isSymbolicLink()) {
        await onEntry(full, 'symlink')
      }
    }
  }
}

async function fsGlob(request, context) {
  const rawPattern = typeof request.pattern === 'string' ? request.pattern.trim() : ''
  if (!rawPattern) throw new Error('pattern is required')
  const pattern = path.isAbsolute(rawPattern) ? rawPattern : path.resolve(context.workspaceBase, rawPattern)
  const regex = globToRegExp(toPosixPath(pattern))
  const base = globBaseDirectory(pattern)
  const paths = []
  let truncated = false

  const record = (candidate) => {
    if (!regex.test(toPosixPath(candidate))) return
    if (paths.length >= FS_GLOB_MAX_PATHS) {
      truncated = true
      return
    }
    paths.push(candidate)
  }

  let baseStats = null
  try {
    baseStats = await fsp.stat(base)
  } catch {
    baseStats = null
  }
  if (baseStats && baseStats.isFile()) {
    // A fully literal pattern (no wildcards) that points at a file.
    record(base)
  } else {
    await walkTree(base, context, async (full, type) => {
      record(full)
      if (type === 'dir') return
    })
  }
  paths.sort()
  return { paths, truncated }
}

async function fsGrep(request, context) {
  const root = resolveWorkspacePath(request.path, context.workspaceBase)
  const rawPattern = typeof request.pattern === 'string' ? request.pattern : ''
  let regex
  try {
    regex = new RegExp(rawPattern)
  } catch (error) {
    throw new Error(`invalid pattern: ${describeError(error)}`)
  }
  const includeRegex =
    typeof request.include === 'string' && request.include.trim() ? globToRegExp(request.include.trim()) : null
  const maxMatches = clampInteger(request.maxMatches, 1, FS_GREP_MAX_MATCHES, FS_GREP_MAX_MATCHES)
  const matches = []
  let truncated = false

  const consider = async (file) => {
    if (Date.now() > context.deadline) throw new Error('request timed out')
    if (context.signal?.aborted) throw new Error('request aborted')
    const relative = toPosixPath(path.relative(context.workspaceBase, file))
    const basename = path.basename(file)
    if (includeRegex && !includeRegex.test(relative) && !includeRegex.test(basename)) return
    let stats
    try {
      stats = await fsp.stat(file)
    } catch {
      return
    }
    if (!stats.isFile() || stats.size > FS_GREP_MAX_FILE_BYTES) return
    let buffer
    try {
      buffer = await fsp.readFile(file)
    } catch {
      return
    }
    if (looksBinary(buffer)) return
    const lines = buffer.toString('utf8').split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      if (!regex.test(lines[index])) continue
      if (matches.length >= maxMatches) {
        truncated = true
        return
      }
      matches.push({ path: file, line: index + 1, text: lines[index].slice(0, 2000) })
    }
  }

  const stats = await fsp.stat(root)
  if (stats.isFile()) await consider(root)
  else await walkTree(root, context, async (full, type) => {
    if (type === 'file') await consider(full)
  })
  return { matches, truncated }
}

async function runFsRequest(runtime, request, context) {
  const base = {
    requestId: request.requestId,
    ok: true,
    op: request.op,
    path: typeof request.path === 'string' ? request.path : '',
    error: null,
  }
  switch (request.op) {
    case 'read':
      return { ...base, ...(await fsRead(request)) }
    case 'write':
      return { ...base, ...(await fsWrite(request)) }
    case 'list':
      return { ...base, ...(await fsList(request)) }
    case 'stat':
      return { ...base, ...(await fsStat(request)) }
    case 'mkdir':
      return { ...base, ...(await fsMkdir(request)) }
    case 'rename':
      return { ...base, ...(await fsRename(request)) }
    case 'delete':
      return { ...base, ...(await fsDelete(request)) }
    case 'glob':
      return { ...base, ...(await fsGlob(request, context)) }
    case 'grep':
      return { ...base, ...(await fsGrep(request, context)) }
    default:
      throw new Error(`unsupported fs op: ${request.op}`)
  }
}

/** Run one fs request with the 15 s deadline/abort wrapper. Never throws. */
async function executeFsRequest(runtime, request) {
  const controller = new AbortController()
  runtime.fs.controllers.add(controller)
  const deadline = Date.now() + FS_REQUEST_TIMEOUT_MS
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('request timed out'))
    }, FS_REQUEST_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    return await Promise.race([
      runFsRequest(runtime, request, {
        workspaceBase: runtime.config.workspaceBase,
        signal: controller.signal,
        deadline,
      }),
      timeout,
    ])
  } catch (error) {
    return {
      requestId: request.requestId,
      ok: false,
      op: request.op,
      path: typeof request.path === 'string' ? request.path : '',
      error: describeError(error),
    }
  } finally {
    clearTimeout(timer)
    runtime.fs.controllers.delete(controller)
  }
}

async function postFsResult(runtime, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (runtime.stopping) return false
    try {
      const response = await requestJson(fsResultUrl(runtime.config.serverUrl), {
        method: 'POST',
        token: runtime.config.token,
        body: payload,
        timeoutMs: 15_000,
        signal: runtime.controller.signal,
      })
      if (response.status === 200) return true
      if (response.status === 404) {
        runtimeLog(runtime, 'info', `fs 结果被服务器忽略（未知请求 ${payload.requestId}）`)
        return false
      }
      if (response.status === 401 && isInvalidTokenRejection(response.status, response.text)) {
        runtimeLog(runtime, 'error', 'fs 结果上报被拒绝（invalid-token）：token 已失效，需要重新 enroll')
        return false
      }
      throw new Error(`HTTP ${response.status}`)
    } catch (error) {
      if (attempt === 1 || runtime.stopping) {
        runtimeLog(runtime, 'warn', `fs 结果上报失败（${payload.requestId}）：${describeError(error)}`)
        return false
      }
      await sleep(300)
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// SSE event handlers
// ---------------------------------------------------------------------------

function handleExec(runtime, rawData) {
  const request = parseJsonSafe(rawData)
  if (!request || typeof request.requestId !== 'string' || typeof request.command !== 'string') {
    runtimeLog(runtime, 'warn', '忽略一条字段不完整的 exec 事件')
    return
  }
  if (runtime.stopping || !runtime.state.running) {
    runtimeLog(runtime, 'warn', `运行时已停止，忽略请求 ${request.requestId}`)
    return
  }
  if (runtime.jobs.has(request.requestId)) {
    runtimeLog(runtime, 'warn', `忽略重复的请求 ${request.requestId}`)
    return
  }
  const explicitCwd = typeof request.cwd === 'string' && request.cwd.trim() ? request.cwd : null
  // §11.2/§11.5: stream chunks only when the host asked for this exec AND
  // advertised the `stream` feature in `hello`.
  const streaming = request.stream === true && runtime.state.features.includes('stream')
  const pump = streaming ? createChunkPump(runtime, request.requestId) : null
  const job = executeCommand({
    command: request.command,
    cwd: explicitCwd ?? runtime.config.workspaceBase,
    timeoutMs: request.timeoutMs,
    onStdout: pump ? (chunk) => pump.push('stdout', chunk) : undefined,
    onStderr: pump ? (chunk) => pump.push('stderr', chunk) : undefined,
  })
  runtime.jobs.set(request.requestId, job)
  runtimeLog(runtime, 'info', `▶ ${request.requestId}${streaming ? ' [stream]' : ''} ${abbreviate(request.command)}`)
  void job.promise
    .then(async (result) => {
      runtimeLog(
        runtime,
        'info',
        `◀ ${request.requestId} exit=${result.exitCode ?? 'null'} ${result.durationMs}ms` +
          `${result.timedOut ? ' timedOut' : ''}${result.truncated ? ' truncated' : ''}`,
      )
      if (runtime.stopping) {
        pump?.abort()
        runtimeLog(runtime, 'info', `运行时已停止，不再上报结果 ${request.requestId}`)
        return
      }
      // Flush the tail chunks before the authoritative final result so the host
      // assembles output in order, then close the pump (no timers left).
      if (pump) await pump.close()
      await postResult(runtime, { requestId: request.requestId, ...result })
    })
    .catch((error) => {
      pump?.abort()
      runtimeLog(runtime, 'error', `✗ ${request.requestId} 执行失败：${describeError(error)}`)
    })
    .finally(() => {
      pump?.abort()
      if (pump) runtime.pumps.delete(pump)
      runtime.jobs.delete(request.requestId)
    })
}

function handleCancel(runtime, rawData) {
  const request = parseJsonSafe(rawData)
  if (!request || typeof request.requestId !== 'string') return
  const job = runtime.jobs.get(request.requestId)
  if (!job) {
    runtimeLog(runtime, 'info', `取消了一个未知请求：${request.requestId}`)
    return
  }
  runtimeLog(runtime, 'info', `取消 ${request.requestId}`)
  job.cancel()
}

function handleFs(runtime, rawData) {
  const request = parseJsonSafe(rawData)
  if (!request || typeof request.requestId !== 'string' || typeof request.op !== 'string') {
    runtimeLog(runtime, 'warn', '忽略一条字段不完整的 fs 事件')
    return
  }
  // §11.5: an old host never sends fs events; only accept them when it
  // advertised the `fs` feature in `hello` AND this instance actually wired the
  // fs handlers (R2a `caps.fs` — false only under the test/advanced option).
  if (!runtime.config.fsEnabled) {
    runtimeLog(runtime, 'warn', `忽略 fs 事件（本实例未启用 fs 能力）：${request.op} ${request.requestId}`)
    return
  }
  if (!runtime.state.features.includes('fs')) {
    runtimeLog(runtime, 'warn', `忽略 fs 事件（服务器未声明 fs 能力）：${request.op} ${request.requestId}`)
    return
  }
  if (!FS_OPS.includes(request.op)) {
    runtimeLog(runtime, 'warn', `忽略不支持的 fs op：${request.op}`)
    return
  }
  if (runtime.stopping || !runtime.state.running) return
  const promise = (async () => {
    const result = await executeFsRequest(runtime, request)
    if (runtime.stopping) return
    await postFsResult(runtime, result)
  })()
    .catch((error) => {
      runtimeLog(runtime, 'error', `fs 请求失败：${describeError(error)}`)
    })
    .finally(() => {
      runtime.fs.promises.delete(promise)
    })
  runtime.fs.promises.add(promise)
}

function applyConfigEvent(runtime, rawData) {
  const value = parseJsonSafe(rawData)
  if (!value) return
  if (typeof value.name === 'string' && value.name && value.name !== runtime.state.name) {
    runtime.state.name = value.name
    runtime.config.name = value.name
    emitRuntimeState(runtime)
    runtimeLog(runtime, 'info', `服务器把电脑名称更新为 ${value.name}`)
  }
  if (value.execEnabled === false) {
    runtimeLog(runtime, 'warn', '服务器已关闭远程执行（execEnabled=false），仍保持连接')
  }
}

// ---------------------------------------------------------------------------
// Embeddable runtime (PROTOCOL §10.4) — owns SSE, exec, results, heartbeats
// ---------------------------------------------------------------------------

function requireOptionString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`startRuntime: options.${field} must be a non-empty string`)
  }
  return value.trim()
}

function normalizeRuntimeHeartbeat(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_HEARTBEAT_MS
  return Math.min(Math.max(1000, Math.floor(number)), 300_000)
}

/** Chunk heartbeat cadence (§11.6 default 10 s; overridable for diagnostics). */
function normalizeChunkHeartbeat(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return CHUNK_HEARTBEAT_MS
  return Math.min(Math.max(100, Math.floor(number)), 300_000)
}

function createRuntime(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('startRuntime(options) requires an options object')
  }
  let serverUrl
  try {
    serverUrl = normalizeServerUrl(requireOptionString(options.serverUrl, 'serverUrl'))
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError(`startRuntime: options.serverUrl is not a valid http(s) URL (${describeError(error)})`)
  }
  const config = {
    serverUrl,
    token: requireOptionString(options.token, 'token'),
    computerId: requireOptionString(options.computerId, 'computerId'),
    name: typeof options.name === 'string' ? options.name.trim() : '',
    workspaceBase: normalizeWorkspaceBase(options.workspaceBase),
    mode: normalizeRuntimeMode(options.mode),
    // R2a: `fs:false` is a test/advanced option that simulates an agent build
    // with no fs handlers; real builds always wire them.
    caps: agentCaps({ fs: options.fs !== false }),
  }
  config.fsEnabled = config.caps.fs
  return {
    config,
    log: typeof options.log === 'function' ? options.log : defaultRuntimeLog,
    onState: typeof options.onState === 'function' ? options.onState : null,
    jobs: new Map(),
    controller: new AbortController(),
    stopping: false,
    stoppedLogged: false,
    emittingState: false,
    lastStateKey: '',
    loopPromise: null,
    fs: { controllers: new Set(), promises: new Set() },
    pumps: new Set(),
    state: {
      running: true,
      connected: false,
      heartbeatMs: normalizeRuntimeHeartbeat(options.heartbeatMs),
      name: config.name,
      features: [],
      chunkHeartbeatMs: normalizeChunkHeartbeat(options.chunkHeartbeatMs),
      since: null,
      lastConnectedAt: null,
      lastError: null,
      attempts: 0,
      exitCode: null,
      lastPingLogAt: 0,
      lastHeartbeatErrorAt: 0,
      lastChunkDropAt: 0,
    },
  }
}

/**
 * Start an embedded runtime (PROTOCOL §10.4).
 *
 * @param {{
 *   serverUrl: string,
 *   token: string,
 *   computerId: string,
 *   name?: string,
 *   heartbeatMs?: number,
 *   mode?: 'embedded' | 'service',   // default 'service'; the plugin passes 'embedded'
 *   fs?: boolean,                    // default true; false = simulate an agent without fs handlers (tests)
 *   log?: (level: 'info'|'warn'|'error', message: string) => void,
 *   onState?: (state: object) => void,
 * }} options
 * @returns {{ stop: () => Promise<void>, status: () => object }}
 *
 * `status()` is synchronous and returns
 * `{ running, connected, serverUrl, computerId, name, mode, workspaceBase,
 *    capabilities, caps, features, heartbeatMs, since, lastConnectedAt,
 *    lastError, attempts, exitCode }` —
 * the host manager only needs `connected` / `since` / `lastError` from it.
 *
 * A fatal `{"error":"invalid-token"}` 401 does NOT throw: the loop ends, sets
 * `lastError: 'invalid-token'`, `exitCode: 1`, and reports through `onState()`.
 */
export function startRuntime(options) {
  const runtime = createRuntime(options)
  runtime.loopPromise = runRuntimeLoop(runtime)
    .catch((error) => {
      runtime.state.lastError = describeError(error)
      runtimeLog(runtime, 'error', `运行时错误：${describeError(error)}`)
      return 1
    })
    .then((exitCode) => {
      runtime.state.exitCode = exitCode
      runtime.state.running = false
      runtime.state.connected = false
      runtime.state.since = null
      emitRuntimeState(runtime)
      return exitCode
    })
  return {
    stop: () => stopRuntime(runtime),
    status: () => runtimeStatus(runtime),
  }
}

function runtimeStatus(runtime) {
  const state = runtime.state
  return {
    running: state.running,
    connected: state.connected,
    serverUrl: runtime.config.serverUrl,
    computerId: runtime.config.computerId,
    name: state.name || runtime.config.name,
    mode: runtime.config.mode,
    workspaceBase: runtime.config.workspaceBase,
    capabilities: [...AGENT_CAPABILITIES],
    caps: { ...runtime.config.caps },
    features: [...state.features],
    heartbeatMs: state.heartbeatMs,
    since: state.since,
    lastConnectedAt: state.lastConnectedAt,
    lastError: state.lastError,
    attempts: state.attempts,
    exitCode: state.exitCode,
  }
}

/** Report a state snapshot; identical snapshots are skipped (one per transition). */
function emitRuntimeState(runtime) {
  if (!runtime.onState || runtime.emittingState) return
  const status = runtimeStatus(runtime)
  const key = [status.running, status.connected, status.since, status.lastError, status.name, status.exitCode, status.features.join(',')].join('|')
  if (key === runtime.lastStateKey) return
  runtime.lastStateKey = key
  runtime.emittingState = true
  try {
    runtime.onState(status)
  } catch {
    // A broken host callback must not break the loop.
  } finally {
    runtime.emittingState = false
  }
}

/** SIGKILL + reap every command still running for this runtime instance. */
async function cancelAndReapJobs(runtime) {
  const jobs = [...runtime.jobs.values()]
  for (const job of jobs) {
    try {
      job.cancel()
    } catch {
      // ignore
    }
  }
  if (jobs.length > 0) await Promise.allSettled(jobs.map((job) => job.promise))
}

async function stopRuntime(runtime) {
  if (runtime.emittingState) {
    // A host may call stop() from inside onState(); awaiting the loop from
    // within that callback would deadlock, so defer by a tick.
    return new Promise((resolve) => {
      setTimeout(() => {
        void stopRuntime(runtime).then(resolve)
      }, 0)
    })
  }
  if (!runtime.stopping) {
    runtime.stopping = true
    runtimeLog(runtime, 'info', '正在停止运行时…')
    runtime.controller.abort()
    // Drop buffered stream frames without flushing and clear every timer.
    for (const pump of [...runtime.pumps]) {
      try {
        pump.abort()
      } catch {
        // ignore
      }
    }
  }
  await cancelAndReapJobs(runtime)
  for (const controller of [...runtime.fs.controllers]) {
    try {
      controller.abort()
    } catch {
      // ignore
    }
  }
  if (runtime.fs.promises.size > 0) await Promise.allSettled([...runtime.fs.promises])
  if (runtime.loopPromise) await runtime.loopPromise.catch(() => {})
  // Reap jobs that a last in-flight event may have started before the flag.
  await cancelAndReapJobs(runtime)
  runtime.state.running = false
  runtime.state.connected = false
  runtime.state.since = null
  if (runtime.state.exitCode === null) runtime.state.exitCode = 0
  emitRuntimeState(runtime)
  if (!runtime.stoppedLogged) {
    runtime.stoppedLogged = true
    runtimeLog(runtime, 'info', '运行时已停止')
  }
}

function jitteredDelay(base) {
  const factor = 0.75 + Math.random() * 0.5
  return Math.max(MIN_BACKOFF_MS, Math.min(MAX_BACKOFF_MS, Math.round(base * factor)))
}

/**
 * The reconnect loop. Never throws for a fatal token rejection: it returns the
 * exit code (1 for invalid-token), and the caller (`startRuntime`) reports it.
 */
async function runRuntimeLoop(runtime) {
  const config = runtime.config
  runtimeLog(runtime, 'info', `dsh-computers-agent ${AGENT_VERSION} 启动 · ${config.serverUrl} · computer=${config.computerId}`)

  let backoff = MIN_BACKOFF_MS
  let lastTransientWarnAt = 0
  while (!runtime.controller.signal.aborted) {
    const attemptStartedAt = Date.now()
    runtime.state.attempts += 1
    let outcome
    try {
      outcome = await runOneSession(runtime, runtime.controller.signal)
    } catch (error) {
      if (runtime.controller.signal.aborted) break
      outcome = { kind: 'closed', reason: describeError(error), gotHello: false }
    }

    if (outcome.kind === 'unauthorized') {
      // The server explicitly answered `{"error":"invalid-token"}` for our
      // bearer: retrying cannot fix it. Do not throw (PROTOCOL §10.4 — the
      // embedded host decides what to do); return the exit code for the CLI.
      runtime.state.connected = false
      runtime.state.since = null
      runtime.state.lastError = 'invalid-token'
      emitRuntimeState(runtime)
      runtimeLog(runtime, 'error', '✗ 服务器拒绝了已保存的凭据（HTTP 401 invalid-token）。token 已失效，请重新运行 enroll 完成注册。')
      return 1
    }
    if (runtime.controller.signal.aborted) break

    runtime.state.connected = false
    runtime.state.since = null
    runtime.state.lastError = outcome.reason || 'unknown'
    emitRuntimeState(runtime)

    const healthy = outcome.gotHello && Date.now() - attemptStartedAt > 60_000
    if (healthy) backoff = MIN_BACKOFF_MS
    const delay = jitteredDelay(backoff)
    if (outcome.transientServer) {
      // Plugin reload / server restart / generic /api fence: the token is not
      // the problem. Warn at most once a minute (not once per attempt) and keep
      // retrying forever.
      const now = Date.now()
      if (now - lastTransientWarnAt >= TRANSIENT_SERVER_WARN_INTERVAL_MS) {
        lastTransientWarnAt = now
        runtimeLog(
          runtime,
          'warn',
          `⚠ 服务器暂时不可用（${outcome.reason || '未知原因'}）；保存的 token 未被拒绝，将继续重试（约 ${Math.round(delay / 1000)} 秒后）`,
        )
      }
    } else {
      runtimeLog(runtime, 'warn', `连接断开（${outcome.reason || '未知原因'}），${Math.round(delay / 1000)} 秒后重连`)
    }
    await sleep(delay, runtime.controller.signal)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
  runtimeLog(runtime, 'info', '已退出')
  return 0
}

/**
 * One connection attempt. Returns:
 *   { kind: 'unauthorized' }  -> only for our JSON `invalid-token` 401
 *   { kind: 'closed', reason, gotHello, transientServer? }
 * Throws only on transport errors (also retried).
 */
async function runOneSession(runtime, signal) {
  const config = runtime.config
  const response = await fetch(eventsUrl(config.serverUrl), {
    headers: sseHeaders(config.token, handshakeMetadata(config.workspaceBase, config.mode, config.caps)),
    signal,
  })
  if (response.status === 401) {
    const body = await readErrorBody(response)
    if (isInvalidTokenRejection(response.status, body)) return { kind: 'unauthorized' }
    // A bare/foreign 401 is the plugin-reload / gateway-fence case: the token is
    // probably still valid, so keep retrying with the normal backoff.
    return {
      kind: 'closed',
      reason: `HTTP 401${body ? ` ${abbreviate(body, 80)}` : ''}（token 可能仍然有效）`,
      gotHello: false,
      transientServer: true,
    }
  }
  if (!response.ok) {
    const detail = await readErrorBody(response)
    return {
      kind: 'closed',
      reason: `HTTP ${response.status}${detail ? ` ${abbreviate(detail, 80)}` : ''}`,
      gotHello: false,
      transientServer: true,
    }
  }
  if (!response.body) return { kind: 'closed', reason: '响应没有 body', gotHello: false }

  const state = runtime.state
  let gotHello = false
  let heartbeatTimer

  const startHeartbeatTimer = () => {
    if (heartbeatTimer) return
    const intervalMs = Math.max(2000, Math.min(state.heartbeatMs || DEFAULT_HEARTBEAT_MS, 300_000))
    heartbeatTimer = setInterval(() => {
      void sendHeartbeat(runtime)
    }, intervalMs)
    heartbeatTimer.unref?.()
  }

  try {
    for await (const event of sseEvents(response.body, signal)) {
      switch (event.event) {
        case 'hello': {
          const hello = parseJsonSafe(event.data) || {}
          gotHello = true
          if (typeof hello.name === 'string' && hello.name) state.name = hello.name
          if (typeof hello.heartbeatMs === 'number' && hello.heartbeatMs > 0) state.heartbeatMs = hello.heartbeatMs
          // PROTOCOL §11.5: an old host sends no `features`; behave exactly like v1.
          state.features = Array.isArray(hello.features)
            ? hello.features.filter((feature) => typeof feature === 'string')
            : []
          state.connected = true
          state.since = new Date().toISOString()
          state.lastConnectedAt = state.since
          state.lastError = null
          runtimeLog(
            runtime,
            'info',
            `已连接 ${config.serverUrl} · computer=${config.computerId}` +
              `${state.name ? ` · name=${state.name}` : ''} · heartbeat=${state.heartbeatMs}ms` +
              ` · features=${state.features.length > 0 ? state.features.join(',') : 'none'}`,
          )
          emitRuntimeState(runtime)
          startHeartbeatTimer()
          break
        }
        case 'exec':
          handleExec(runtime, event.data)
          break
        case 'cancel':
          handleCancel(runtime, event.data)
          break
        case 'ping': {
          const now = Date.now()
          if (now - state.lastPingLogAt >= HEARTBEAT_LOG_INTERVAL_MS) {
            state.lastPingLogAt = now
            runtimeLog(runtime, 'info', `心跳正常 · computer=${config.computerId}`)
          }
          break
        }
        case 'fs':
          handleFs(runtime, event.data)
          break
        case 'config':
          applyConfigEvent(runtime, event.data)
          break
        default:
          // Unknown event types are ignored for forward compatibility.
          break
      }
    }
    return { kind: 'closed', reason: '服务器关闭了事件流', gotHello }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
  }
}

// ---------------------------------------------------------------------------
// CLI `run` — a thin wrapper around startRuntime() for foreground / launchd use
// ---------------------------------------------------------------------------

async function cmdRun(argv) {
  const { values } = parseCliArgs(argv, { help: { type: 'boolean', short: 'h' } })
  if (values.help) {
    console.log(RUN_USAGE)
    return 0
  }
  const config = await loadConfig()
  ensureAgentHome()

  const sink = createCliLogSink()
  let savedName = config.name
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })

  const runtime = startRuntime({
    serverUrl: config.serverUrl,
    token: config.token,
    computerId: config.computerId,
    name: config.name,
    workspaceBase: config.workspaceBase,
    mode: 'service',
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    log: sink,
    onState: (state) => {
      // Keep the CLI config file in sync with server-driven renames; the
      // embedded runtime never writes ~/.dsh-computers.
      if (state.name && state.name !== savedName) {
        savedName = state.name
        config.name = state.name
        void saveConfig(config).catch(() => {})
      }
      if (!state.running) resolveDone(state)
    },
  })

  let stopping = false
  const shutdown = (name) => {
    if (stopping) return
    stopping = true
    sink('info', `收到 ${name}，正在退出`)
    void runtime.stop()
  }
  const onSigint = () => shutdown('SIGINT')
  const onSigterm = () => shutdown('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  try {
    await done
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    // Idempotent: the fatal path already finished the loop, a signal path is
    // already stopping; this guarantees children are reaped either way.
    await runtime.stop().catch(() => {})
  }
  return runtime.status().exitCode ?? 0
}

// ---------------------------------------------------------------------------
// enroll
// ---------------------------------------------------------------------------

async function cmdEnroll(argv) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        server: { type: 'string' },
        key: { type: 'string' },
        name: { type: 'string' },
        'workspace-base': { type: 'string' },
        replace: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }))
  } catch (error) {
    throw new CliError(`参数错误：${describeError(error)}\n\n${ENROLL_USAGE}`)
  }
  if (values.help) {
    console.log(ENROLL_USAGE)
    return 0
  }

  const serverUrl = normalizeServerUrl(values.server)
  const key = typeof values.key === 'string' ? values.key.trim() : ''
  if (!key) throw new CliError(`缺少 --key <key>（服务器生成的加入密钥）\n\n${ENROLL_USAGE}`)
  const requestedName = typeof values.name === 'string' ? values.name.trim() : ''

  if (fs.existsSync(configFile())) {
    console.error(`提示：${configFile()} 已存在，本次注册会覆盖旧的凭据。`)
  }

  const workspaceBase = normalizeWorkspaceBase(values['workspace-base'])
  const body = {
    key,
    agentVersion: AGENT_VERSION,
    // PROTOCOL §11.1 (top-level capabilities) + §11.6 (handshake metadata).
    capabilities: [...AGENT_CAPABILITIES],
    machine: machineInfo(requestedName),
    metadata: handshakeMetadata(workspaceBase, 'service', agentCaps()),
  }
  if (values.replace) body.replace = true

  let response
  try {
    response = await requestJson(enrollUrl(serverUrl), { method: 'POST', body, timeoutMs: 30_000 })
  } catch (error) {
    throw new CliError(`无法连接 ${serverUrl}：${describeError(error)}`)
  }

  if (response.status !== 200) {
    const code = (response.json && response.json.error) || `http-${response.status}`
    const message = (response.json && response.json.message) || (response.text || '').trim()
    throw new CliError(`注册失败（${code}）${message ? `：${message}` : ''}`)
  }

  const data = response.json
  if (
    !data ||
    typeof data.computerId !== 'string' ||
    typeof data.token !== 'string' ||
    typeof data.name !== 'string'
  ) {
    throw new CliError('服务器返回的注册响应缺少 computerId / token / name，请升级服务器端的 dsh-computers 插件。')
  }

  const config = {
    version: 1,
    serverUrl: normalizeServerUrl(typeof data.serverUrl === 'string' && data.serverUrl ? data.serverUrl : serverUrl),
    computerId: data.computerId,
    token: data.token,
    name: data.name,
    enrolledAt: new Date().toISOString(),
    workspaceBase,
  }
  await saveConfig(config)
  console.log(`✓ 凭据已保存到 ${configFile()}（仅本机可读，权限 0600）`)
  console.log(`工作目录：${workspaceBase}（exec 默认 cwd，glob/grep 的相对基准）`)

  // Prove the round trip once. Failure to receive hello is not fatal: the
  // enrollment itself succeeded and `run` retries forever.
  const probe = await probeEventStream(config, 5000)
  if (probe.unauthorized) {
    throw new CliError('服务器拒绝了这个 token（HTTP 401），请重新生成加入密钥。')
  }
  if (probe.ok) {
    const name = (probe.hello && probe.hello.name) || config.name
    console.log(`✓ 已连接 ${config.serverUrl}，这台电脑现在是 ${name}`)
  } else {
    console.log(`… 凭据已保存，但实时连接探测未成功（${probe.message}）；run 会自动重试。`)
  }

  console.log(`下一步：node "${SELF_PATH}" service install && node "${SELF_PATH}" service start`)
  console.log(`        或者前台运行：node "${SELF_PATH}" run`)
  return 0
}

// ---------------------------------------------------------------------------
// service (launchd on macOS, systemd --user on Linux, manual note on Windows)
// ---------------------------------------------------------------------------

/** Promise wrapper around execFile that never rejects; returns { code, stdout, stderr }. */
function runCommandFile(file, args, { timeout = 20_000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const code = typeof error.code === 'number' ? error.code : 1
        const message = String(stderr || error.message || '').trim()
        resolve({ code, stdout: String(stdout || ''), stderr: message })
        return
      }
      resolve({ code: 0, stdout: String(stdout || ''), stderr: String(stderr || '').trim() })
    })
  })
}

function xmlEscape(value) {
  const text = String(value)
  if (text.includes('\0')) throw new CliError('服务配置项包含非法空字符')
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function launchdContext() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return {
    label: SERVICE_LABEL,
    domain: `gui/${uid}`,
    target: `gui/${uid}/${SERVICE_LABEL}`,
    plistPath: launchdPlistPath(),
  }
}

function renderLaunchdPlist(context) {
  const environment = {
    PATH: process.env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    // Tell `run` that launchd already redirects stdout/stderr into agent.log,
    // so it should only append its own structured lines (no duplicates).
    DSH_COMPUTERS_LOG_ONLY: '1',
  }
  if (process.env.DSH_COMPUTERS_HOME) environment.DSH_COMPUTERS_HOME = path.resolve(process.env.DSH_COMPUTERS_HOME)
  if (process.env.DSH_COMPUTERS_SERVICE_LABEL) environment.DSH_COMPUTERS_SERVICE_LABEL = SERVICE_LABEL
  const environmentXml = Object.entries(environment)
    .map(([name, value]) => `    <key>${xmlEscape(name)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(context.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(SELF_PATH)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(agentHome())}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile())}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile())}</string>
</dict>
</plist>
`
}

async function launchdIsLoaded(context) {
  const result = await runCommandFile('/bin/launchctl', ['print', context.target])
  return result.code === 0
}

async function launchdStatus(context) {
  const installed = fs.existsSync(context.plistPath)
  if (!installed) return { installed: false, loaded: false, pid: null }
  const loaded = await launchdIsLoaded(context)
  let pid = null
  if (loaded) {
    const result = await runCommandFile('/bin/launchctl', ['print', context.target])
    const match = result.stdout.match(/\bpid\s*=\s*(\d+)/)
    if (match) pid = Number(match[1])
  }
  return { installed, loaded, pid }
}

async function launchdWaitLoaded(context, expected) {
  for (let attempt = 0; attempt < 25; attempt++) {
    if ((await launchdIsLoaded(context)) === expected) return true
    await sleep(200)
  }
  return (await launchdIsLoaded(context)) === expected
}

async function launchdInstall(context) {
  ensureAgentHome()
  await ensureDir(path.dirname(context.plistPath))
  await atomicWriteFile(context.plistPath, renderLaunchdPlist(context), 0o600)
  const lint = await runCommandFile('/usr/bin/plutil', ['-lint', context.plistPath])
  console.log(`✓ launchd 配置已写入 ${context.plistPath}`)
  if (lint.code !== 0) {
    console.error(`警告：plutil 校验失败：${lint.stderr || lint.stdout}`)
  }
  if (!fs.existsSync(configFile())) {
    console.error('警告：还没有完成 enroll，服务启动后会反复重试直到注册成功。')
  }
  console.log(`下一步：node "${SELF_PATH}" service start`)
  return 0
}

async function launchdStart(context) {
  if (!fs.existsSync(context.plistPath)) {
    console.error(`✗ 服务尚未安装（找不到 ${context.plistPath}），请先运行 service install。`)
    return 1
  }
  if (await launchdIsLoaded(context)) {
    console.log(`✓ 服务已在运行（${context.label}）`)
    return 0
  }
  const bootstrap = await runCommandFile('/bin/launchctl', ['bootstrap', context.domain, context.plistPath])
  if (bootstrap.code !== 0) {
    // Legacy loader for older macOS releases / restricted sessions.
    const legacy = await runCommandFile('/bin/launchctl', ['load', '-w', context.plistPath])
    if (legacy.code !== 0 && !(await launchdIsLoaded(context))) {
      console.error(`✗ launchctl bootstrap/load 失败：${bootstrap.stderr || legacy.stderr || '未知错误'}`)
      return 1
    }
  }
  if (await launchdWaitLoaded(context, true)) {
    console.log(`✓ 服务已启动（${context.label}）`)
    return 0
  }
  console.error('✗ 服务已提交但未出现在 launchctl 中，请查看日志：' + logFile())
  return 1
}

async function launchdStop(context) {
  if (!(await launchdIsLoaded(context))) {
    console.log(`✓ 服务未在运行（${context.label}）`)
    return 0
  }
  // bootout is asynchronous: keep polling until launchctl agrees it is gone.
  const bootout = await runCommandFile('/bin/launchctl', ['bootout', context.target])
  if (bootout.code !== 0 && fs.existsSync(context.plistPath)) {
    await runCommandFile('/bin/launchctl', ['unload', '-w', context.plistPath])
  }
  if (await launchdWaitLoaded(context, false)) {
    console.log(`✓ 服务已停止（${context.label}）`)
    return 0
  }
  console.error('✗ 服务仍在运行，请检查 launchctl print ' + context.target)
  return 1
}

async function launchdUninstall(context) {
  await launchdStop(context) // tolerant: reports "未在运行" when nothing is loaded
  try {
    await fsp.rm(context.plistPath, { force: true })
  } catch (error) {
    console.error(`✗ 无法删除 ${context.plistPath}：${describeError(error)}`)
    return 1
  }
  console.log('✓ launchd 服务已卸载（凭据与配置仍保留，可重新 enroll）')
  return 0
}

async function launchdCommand(action) {
  const context = launchdContext()
  switch (action) {
    case 'install':
      return launchdInstall(context)
    case 'uninstall':
      return launchdUninstall(context)
    case 'start':
      return launchdStart(context)
    case 'stop':
      return launchdStop(context)
    case 'restart':
      await launchdStop(context)
      return launchdStart(context)
    case 'status': {
      const status = await launchdStatus(context)
      const label = !status.installed ? '未安装' : status.loaded ? `运行中${status.pid ? ` (pid ${status.pid})` : ''}` : '已安装，未运行'
      console.log(`launchd: ${label}`)
      console.log(`plist: ${context.plistPath}`)
      return 0
    }
    default:
      console.error(`未知的 service 子命令：${action}`)
      return 1
  }
}

// --- Linux: systemd --user, with a nohup fallback -------------------------

function systemdContext() {
  return {
    unitName: `${SERVICE_LABEL}.service`,
    unitPath: systemdUnitPath(),
  }
}

function systemdQuote(value) {
  const text = String(value)
  return /[\s"\\]/.test(text) ? `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : text
}

function renderSystemdUnit(context) {
  const environmentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin'
  const environmentHome = process.env.DSH_COMPUTERS_HOME
    ? `Environment=${systemdQuote(`DSH_COMPUTERS_HOME=${path.resolve(process.env.DSH_COMPUTERS_HOME)}`)}\n`
    : ''
  const environmentLabel = process.env.DSH_COMPUTERS_SERVICE_LABEL
    ? `Environment=${systemdQuote(`DSH_COMPUTERS_SERVICE_LABEL=${SERVICE_LABEL}`)}\n`
    : ''
  return `[Unit]
Description=dsh-computers agent (run shell commands for dsh-web)
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(SELF_PATH)} run
WorkingDirectory=${systemdQuote(agentHome())}
Environment=${systemdQuote(`PATH=${environmentPath}`)}
${environmentHome}${environmentLabel}Restart=always
RestartSec=5
StandardOutput=append:${systemdQuote(logFile())}
StandardError=append:${systemdQuote(logFile())}

[Install]
WantedBy=default.target
`
}

async function systemctlAvailable() {
  const result = await runCommandFile('systemctl', ['--user', '--version'], { timeout: 5000 })
  return result.code === 0
}

async function systemdInstall(context) {
  ensureAgentHome()
  await ensureDir(path.dirname(context.unitPath))
  await atomicWriteFile(context.unitPath, renderSystemdUnit(context), 0o644)
  console.log(`✓ systemd 用户单元已写入 ${context.unitPath}`)
  if (await systemctlAvailable()) {
    const reload = await runCommandFile('systemctl', ['--user', 'daemon-reload'])
    if (reload.code !== 0) console.error(`警告：daemon-reload 失败：${reload.stderr || reload.stdout}`)
  } else {
    console.error('警告：找不到可用的 systemctl --user，service start 会退化为 nohup 后台启动。')
  }
  if (!fs.existsSync(configFile())) {
    console.error('警告：还没有完成 enroll，服务启动后会反复重试直到注册成功。')
  }
  console.log(`下一步：node "${SELF_PATH}" service start`)
  return 0
}

async function systemdStart(context) {
  if (!fs.existsSync(context.unitPath)) {
    console.error(`✗ 服务尚未安装（找不到 ${context.unitPath}），请先运行 service install。`)
    return 1
  }
  if (await systemctlAvailable()) {
    const start = await runCommandFile('systemctl', ['--user', 'enable', '--now', context.unitName])
    if (start.code !== 0) {
      console.error(`✗ systemctl --user enable --now 失败：${start.stderr || start.stdout}`)
      return 1
    }
    console.log(`✓ 服务已启动（${context.unitName}）`)
    return 0
  }
  return nohupStart()
}

async function systemdStop(context) {
  if (await systemctlAvailable()) {
    // disable --now exits non-zero when the unit is not loaded; that is fine.
    await runCommandFile('systemctl', ['--user', 'disable', '--now', context.unitName])
    console.log(`✓ 服务已停止（${context.unitName}）`)
    return 0
  }
  return nohupStop()
}

async function systemdUninstall(context) {
  if (await systemctlAvailable()) {
    await runCommandFile('systemctl', ['--user', 'disable', '--now', context.unitName])
  }
  // Also clean up a previous nohup fallback, without duplicating output.
  await nohupStop({ quiet: true }).catch(() => {})
  try {
    await fsp.rm(context.unitPath, { force: true })
  } catch (error) {
    console.error(`✗ 无法删除 ${context.unitPath}：${describeError(error)}`)
    return 1
  }
  if (await systemctlAvailable()) await runCommandFile('systemctl', ['--user', 'daemon-reload'])
  console.log('✓ systemd 服务已卸载（凭据与配置仍保留，可重新 enroll）')
  return 0
}

async function systemdStatus(context) {
  const installed = fs.existsSync(context.unitPath)
  let state = '未安装'
  if (installed) {
    if (await systemctlAvailable()) {
      const active = await runCommandFile('systemctl', ['--user', 'is-active', context.unitName])
      state = active.code === 0 ? '运行中' : '已安装，未运行'
    } else {
      state = '已安装（无 systemctl --user，使用 nohup 回退）'
    }
  }
  console.log(`systemd: ${state}`)
  console.log(`unit: ${context.unitPath}`)
  return 0
}

// --- nohup fallback (Linux without systemd --user) ------------------------

function readPidFile() {
  try {
    const pid = Number(fs.readFileSync(nohupPidFile(), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function nohupStart() {
  const existing = readPidFile()
  if (existing && processAlive(existing)) {
    console.log(`✓ 已在后台运行（pid ${existing}）`)
    return 0
  }
  ensureAgentHome()
  const out = fs.openSync(logFile(), 'a', 0o600)
  try {
    const child = spawn(process.execPath, [SELF_PATH, 'run'], {
      detached: true,
      stdio: ['ignore', out, out],
      cwd: agentHome(),
      env: process.env,
    })
    child.unref()
    fs.writeFileSync(nohupPidFile(), `${child.pid}\n`, { mode: 0o600 })
    console.log(`✓ 已在后台启动（nohup 回退，pid ${child.pid}）`)
  } finally {
    try {
      fs.closeSync(out)
    } catch {
      // ignore
    }
  }
  return 0
}

async function nohupStop({ quiet = false } = {}) {
  const pid = readPidFile()
  if (!pid || !processAlive(pid)) {
    try {
      await fsp.rm(nohupPidFile(), { force: true })
    } catch {
      // ignore
    }
    if (!quiet) console.log('✓ 服务未在运行')
    return 0
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // already gone
  }
  for (let attempt = 0; attempt < 25 && processAlive(pid); attempt++) await sleep(200)
  if (processAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // ignore
    }
  }
  try {
    await fsp.rm(nohupPidFile(), { force: true })
  } catch {
    // ignore
  }
  if (!quiet) console.log('✓ 服务已停止')
  return 0
}

async function systemdCommand(action) {
  const context = systemdContext()
  switch (action) {
    case 'install':
      return systemdInstall(context)
    case 'uninstall':
      return systemdUninstall(context)
    case 'start':
      return systemdStart(context)
    case 'stop':
      return systemdStop(context)
    case 'restart':
      await systemdStop(context)
      return systemdStart(context)
    case 'status':
      return systemdStatus(context)
    default:
      console.error(`未知的 service 子命令：${action}`)
      return 1
  }
}

function windowsServiceNote() {
  console.log('Windows 自动安装服务尚未实现（v1），请手动运行：')
  console.log(`  node "${SELF_PATH}" run`)
  console.log('开机自启：任务计划程序 → 创建任务 → 触发器“登录时” → 操作“启动程序”')
  console.log(`  程序："${process.execPath}"`)
  console.log(`  参数："${SELF_PATH}" run`)
  console.log(`配置与日志位于 ${agentHome()}`)
  return 0
}

async function cmdService(argv) {
  const action = String(argv[0] ?? '').toLowerCase()
  if (!SERVICE_ACTIONS.includes(action)) {
    console.error(`用法：dsh-computers-agent service <${SERVICE_ACTIONS.join('|')}>`)
    return 1
  }
  if (process.platform === 'darwin') return launchdCommand(action)
  if (process.platform === 'linux') return systemdCommand(action)
  return windowsServiceNote()
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function serviceSummary() {
  try {
    if (process.platform === 'darwin') {
      const context = launchdContext()
      const status = await launchdStatus(context)
      if (!status.installed) return '未安装'
      if (!status.loaded) return '已安装，未运行'
      return `运行中${status.pid ? ` (pid ${status.pid})` : ''}`
    }
    if (process.platform === 'linux') {
      const context = systemdContext()
      if (!fs.existsSync(context.unitPath)) return '未安装'
      if (await systemctlAvailable()) {
        const active = await runCommandFile('systemctl', ['--user', 'is-active', context.unitName])
        return active.code === 0 ? '运行中' : '已安装，未运行'
      }
      return '已安装（无 systemctl --user）'
    }
    return 'Windows 请手动运行（v1）'
  } catch (error) {
    return `未知（${describeError(error)}）`
  }
}

async function cmdStatus(argv) {
  const { values } = parseCliArgs(argv, { help: { type: 'boolean', short: 'h' } })
  if (values.help) {
    console.log(STATUS_USAGE)
    return 0
  }
  console.log(`dsh-computers-agent ${AGENT_VERSION}`)
  let config
  try {
    config = await loadConfig()
  } catch (error) {
    console.log('注册状态：未注册')
    console.log(`配置：${configFile()}（不存在或不可用）`)
    console.log(`提示：${describeError(error)}`)
    return 1
  }
  console.log('注册状态：已注册')
  console.log(`服务器：${config.serverUrl}`)
  console.log(`电脑：${config.name}（${config.computerId}）`)
  console.log(`注册时间：${config.enrolledAt || '未知'}`)
  console.log(`Token：${redactToken(config.token)}（已脱敏）`)
  console.log(`工作目录：${config.workspaceBase}`)
  console.log(`能力：${AGENT_CAPABILITIES.join(', ')}`)
  console.log(`配置：${configFile()}`)
  console.log(`日志：${logFile()}`)
  console.log(`服务：${await serviceSummary()}`)
  return 0
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

const ENROLL_USAGE = `用法：dsh-computers-agent enroll --server <url> --key <key> [--name <name>] [--workspace-base <path>] [--replace]

  --server <url>          dsh-web 的地址，例如 http://127.0.0.1:3000
  --key <key>             服务器生成的加入密钥（dshc_…），只能使用一次
  --name <name>           显示在服务器电脑列表里的名称，默认使用主机名
  --workspace-base <path> 默认工作目录（exec 默认 cwd，glob/grep 的相对基准），默认 $HOME
  --replace               让服务器用这台电脑的新凭据替换同名记录`

const RUN_USAGE = `用法：dsh-computers-agent run

连接服务器并等待执行请求（前台运行，Ctrl-C 退出）。
需要先完成 enroll；凭据保存在 ${configFile()}。`

const STATUS_USAGE = `用法：dsh-computers-agent status

显示注册信息、脱敏后的 token 和服务状态。退出码 0 表示已注册，1 表示未注册。`

const HELP_TEXT = `dsh-computers-agent ${AGENT_VERSION}
把本机接入 dsh-web，让服务器上的 agent 通过 computer_exec 在这台电脑执行命令。

用法 / Usage:
  dsh-computers-agent enroll --server <url> --key <key> [--name <name>] [--workspace-base <path>] [--replace]
      用服务器给出的加入密钥注册这台电脑，并把凭据保存到本机。
  dsh-computers-agent run
      前台运行：保持 SSE 连接并执行服务器发来的命令（Ctrl-C 退出）。
  dsh-computers-agent service install|uninstall|start|stop|restart|status
      安装 / 卸载 / 启动 / 停止登录自启服务（macOS launchd、Linux systemd --user）。
  dsh-computers-agent status
      显示注册信息、脱敏后的 token 与服务状态。
  dsh-computers-agent --version
  dsh-computers-agent --help

环境变量:
  DSH_COMPUTERS_HOME            配置与日志目录，默认 ~/.dsh-computers
  DSH_COMPUTERS_SERVICE_LABEL   覆盖 launchd/systemd 服务标识（默认 ${SERVICE_LABEL}）

凭据与安全:
  · 配置文件 ${configFile()} 权限 0600，原子写入。
  · token 只保存在本机，不会写入日志；status 只显示末 6 位。
  · 本程序只发起对外连接（enroll / SSE / 结果上报 / 心跳），不监听任何端口。
  · 命令以当前用户身份在 /bin/sh -lc 中执行，因此拥有与终端相同的权限。
  · 能力：exec（远程命令）+ fs（远程文件读写/glob/grep），默认工作目录可在 enroll 时指定。`

function parseCliArgs(args, options) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false })
  } catch (error) {
    throw new CliError(`参数错误：${describeError(error)}\n\n${HELP_TEXT}`)
  }
}

async function main(argv) {
  if (process.versions?.node && Number(process.versions.node.split('.')[0]) < 22) {
    console.error(`✗ 需要 Node.js >= 22，当前是 ${process.version}。请升级 Node.js 后重试。`)
    return 1
  }

  const [command, ...rest] = argv
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP_TEXT)
      return 0
    case 'version':
    case '--version':
    case '-v':
      console.log(AGENT_VERSION)
      return 0
    case 'enroll':
      return cmdEnroll(rest)
    case 'run':
      return cmdRun(rest)
    case 'service':
      return cmdService(rest)
    case 'status':
      return cmdStatus(rest)
    default:
      throw new CliError(`未知命令：${command}\n\n${HELP_TEXT}`)
  }
}

/**
 * True only when this file is the process entry point (`node agent.mjs …`),
 * false when it is imported (e.g. `import { startRuntime } from …` by the host
 * plugin) or evaluated with `node -e`. Importing the module must never run CLI
 * code or touch the filesystem.
 *
 * `process.argv[1]` is resolved through pathToFileURL so relative paths work;
 * a realpath comparison keeps symlinked installs working, and comparing the
 * URL keeps `--preserve-symlinks-main` working.
 */
function isProcessEntryPoint() {
  const entry = process.argv[1]
  if (!entry) return false // `node -e`, REPL, `import()`
  try {
    if (pathToFileURL(path.resolve(entry)).href === import.meta.url) return true
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isProcessEntryPoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
      // If an idle HttpClient keeps the event loop alive, do not hang forever.
      const forced = setTimeout(() => process.exit(code), 5000)
      forced.unref?.()
    })
    .catch((error) => {
      const message = error instanceof CliError ? error.message : `✗ ${describeError(error)}`
      process.stderr.write(`${message}\n`)
      if (!(error instanceof CliError)) appendLog(`fatal: ${describeError(error)}${error?.stack ? `\n${error.stack}` : ''}`)
      process.exitCode = error instanceof CliError ? error.exitCode : 1
      const forced = setTimeout(() => process.exit(process.exitCode ?? 1), 5000)
      forced.unref?.()
    })
}
