/**
 * Self-runtime (v1.9.1): the hub's OWN machine as an executable target.
 *
 * Until now the settings page could connect OTHER machines, but the composer's
 * 「本地电脑」 entry had nothing behind it: it selects `computerId: null` and
 * `computer_exec` answered "no computer selected". The hub therefore manages one
 * extra runtime for itself, so this machine shows up in its own registry like
 * any other computer and the local target is executable.
 *
 * It is a SEPARATE, isolated identity on purpose:
 * - the child is the machine agent (`agent/dsh-computers-agent.mjs run`) with
 *   its own `DSH_COMPUTERS_HOME` under `${stateDir}/self-runtime`, so it can
 *   never touch the credentials or the config of the upstream runtime that
 *   `lib/runtime.js` manages (this machine may ALSO be a controlled machine of
 *   another hub — the two must not interfere);
 * - it dials `http://127.0.0.1:<ownPort>`, i.e. this hub, never a remote one.
 *
 * The child-process contract (the agent CLI is imported nowhere, only executed):
 *   argv:  <node> <agent/dsh-computers-agent.mjs> run
 *   env:   DSH_COMPUTERS_HOME=<stateDir>/self-runtime
 *          DSH_COMPUTERS_SELF_RUNTIME=1   (marker; the agent ignores unknown env)
 *   creds: written by THIS module into `${DSH_COMPUTERS_HOME}/config.json`
 *          (0600, the agent's documented schema v1) after a loopback enroll.
 *
 * The agent's `run` takes no `--server` flag (`parseArgs(..., { strict: true })`
 * rejects it) and requires a pre-enrolled config, so the `--server '<url>#join=…'`
 * form is the ENROLL step: this manager posts `{ join }` to its own hub's
 * `/agent/enroll` over loopback with the fleet token, then hands the child the
 * resulting identity. That keeps the single-use key / join-token handling in one
 * place (the hub route) instead of re-implementing it.
 *
 * If spawning is unavailable (a host that forbids child processes), the manager
 * falls back to the agent bundle's exported `startRuntime()` loop in-process,
 * with the same isolated identity — see {@link startEmbedded}.
 *
 * Lifecycle rules: at most {@link MAX_RESTARTS} automatic restarts inside
 * {@link RESTART_WINDOW_MS}; after that the manager gives up, reports
 * `state: 'failed'` and surfaces the reason. Nothing here ever throws into
 * `apply()` — every path settles into a status object.
 *
 * Node builtins only.
 */

import { spawn as spawnProcess } from 'node:child_process'
import { arch, cpus, homedir, hostname, platform, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { API_BASE } from './contracts.js'
import { postJson } from './http.js'
import { platformLabel } from './keys.js'
import { writeJsonAtomic } from './state.js'

/** Directory (under the plugin state dir) holding the isolated agent identity. */
export const SELF_DIR_NAME = 'self-runtime'

/** The agent config file name inside {@link SELF_DIR_NAME} (agent schema v1). */
export const SELF_CONFIG_NAME = 'config.json'

/** Runtime states the browser contract exposes. */
export const SELF_RUNTIME_STATES = Object.freeze(['stopped', 'starting', 'running', 'failed'])

/** Automatic restarts allowed inside {@link RESTART_WINDOW_MS}. */
export const MAX_RESTARTS = 3

/** Crash-loop window: a restart older than this no longer counts. */
export const RESTART_WINDOW_MS = 5 * 60_000

/** Delays before the 1st/2nd/3rd automatic restart (exponential-ish). */
const DEFAULT_RESTART_DELAYS = Object.freeze([1000, 2000, 4000])

/** How long to wait for the host web server to report a port at load. */
const DEFAULT_PORT_WAIT_MS = 15_000

/** Port poll interval while the listener is still binding. */
const DEFAULT_PORT_POLL_MS = 250

/** Grace period between SIGTERM and SIGKILL on stop. */
const DEFAULT_STOP_GRACE_MS = 2_000

/** Loopback enroll POST budget. */
const DEFAULT_ENROLL_TIMEOUT_MS = 10_000

/** Lines kept in the ring buffer / returned by `status().logs`. */
const LOG_RING = 200
const LOG_TAIL = 50
const LOG_LINE_MAX = 500

/** Capabilities the self-runtime's agent provides (same set the bundle serves). */
const SELF_CAPABILITIES = Object.freeze(['exec', 'fs'])

/** One log line: strip credentials an agent might echo and cap the length. */
function cleanLine(value) {
  let text = typeof value === 'string' ? value : String(value ?? '')
  // The agent redacts its own token, but a future/verbose build might not: the
  // diagnostic tail is served to the browser, so scrub the two credential shapes.
  text = text.replace(/(dshc_|dshf_)[A-Za-z0-9_-]{4,}/g, '$1[redacted]')
  return text.slice(0, LOG_LINE_MAX)
}

/** `error.message` or a string, never a throw. */
function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  return error.message ? String(error.message) : String(error)
}

/** A positive safe integer or the fallback. */
function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** `hostname()` that cannot throw. */
function hostName() {
  try {
    const value = hostname()
    return typeof value === 'string' && value !== '' ? value : 'localhost'
  } catch {
    return 'localhost'
  }
}

/**
 * Create the manager for this machine's own runtime.
 *
 * All lifecycle methods are total: they resolve to a status object and never
 * throw (a route calling them can therefore answer 200 with `state: 'failed'`
 * instead of a 500).
 *
 * @param {object} options - manager options.
 * @param {object | null} [options.ctx] - Cordis context (only `webServer.port`/`getOrigin()` are read, guarded).
 * @param {string} options.stateDir - plugin state directory.
 * @param {string} [options.version] - plugin version reported at enroll.
 * @param {string} [options.name] - display name for the local computer (default: hostname).
 * @param {() => string} [options.joinToken] - live fleet join token of THIS hub.
 * @param {(message: string) => void} [options.onWarn] - host warning sink.
 * @param {object} [options.deps] - test seams (see below); production leaves it empty.
 * @param {string} [options.deps.agentPath] - agent bundle to execute (default: ../agent/…).
 * @param {string} [options.deps.nodePath] - node binary (default: `process.execPath`).
 * @param {Function} [options.deps.spawn] - `child_process.spawn` replacement.
 * @param {Function} [options.deps.now] - epoch-ms clock.
 * @param {number} [options.deps.pollMs] - port poll interval.
 * @param {number} [options.deps.portWaitMs] - how long to wait for the port.
 * @param {number[]} [options.deps.restartDelays] - automatic-restart delays.
 * @param {number} [options.deps.maxRestarts] - restarts allowed per window.
 * @param {number} [options.deps.restartWindowMs] - crash-loop window.
 * @param {number} [options.deps.stopGraceMs] - SIGTERM → SIGKILL grace.
 * @param {number} [options.deps.enrollTimeoutMs] - enroll POST budget.
 * @returns {object} `{ start, stop, restart, status, autoStart, dispose, computerId, file, dir }`.
 */
export function createSelfRuntime({
  ctx = null,
  stateDir,
  version = '1.0.0',
  name = '',
  joinToken = () => '',
  onWarn = () => {},
  deps = {},
} = {}) {
  const selfDir = join(stateDir, SELF_DIR_NAME)
  const configFile = join(selfDir, SELF_CONFIG_NAME)
  const agentPath = typeof deps.agentPath === 'string' && deps.agentPath !== ''
    ? deps.agentPath
    : fileURLToPath(new URL('../agent/dsh-computers-agent.mjs', import.meta.url))
  const nodePath = typeof deps.nodePath === 'string' && deps.nodePath !== ''
    ? deps.nodePath
    : process.execPath
  const spawnChild = typeof deps.spawn === 'function' ? deps.spawn : spawnProcess
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const pollMs = positiveInt(deps.pollMs, DEFAULT_PORT_POLL_MS)
  const portWaitMs = positiveInt(deps.portWaitMs, DEFAULT_PORT_WAIT_MS)
  const stopGraceMs = positiveInt(deps.stopGraceMs, DEFAULT_STOP_GRACE_MS)
  const enrollTimeoutMs = positiveInt(deps.enrollTimeoutMs, DEFAULT_ENROLL_TIMEOUT_MS)
  const maxRestarts = positiveInt(deps.maxRestarts, MAX_RESTARTS)
  const restartWindowMs = positiveInt(deps.restartWindowMs, RESTART_WINDOW_MS)
  const restartDelays = Array.isArray(deps.restartDelays) && deps.restartDelays.length > 0
    ? deps.restartDelays.filter((value) => Number.isSafeInteger(value) && value >= 0)
    : DEFAULT_RESTART_DELAYS
  const delays = restartDelays.length > 0 ? restartDelays : DEFAULT_RESTART_DELAYS

  /** 'stopped' | 'starting' | 'running' | 'failed'. */
  let state = 'stopped'
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  let pid = null
  let since = null
  let lastError = null
  let computerId = ''
  /** @type {{ stop: () => Promise<void>, status?: () => object } | null} */
  let embedded = null
  let embeddedModulePromise = null
  /** Bumped by every stop/restart so an in-flight start can notice it lost. */
  let generation = 0
  /** The in-flight `start()` promise, so concurrent callers share one attempt. */
  let pending = null
  let restartTimer = null
  /** Epoch-ms timestamps of automatic restarts inside the window. */
  let restartTimes = []
  let disposed = false
  /** The child `stop()` is tearing down: its exit is expected, not a crash. */
  let stoppingChild = null
  let warned = null
  /** @type {string[]} */
  let logLines = []
  let logBuffer = ''

  /** Warn once per distinct line: a crash loop must not flood the host log. */
  const warnOnce = (message) => {
    const text = cleanLine(message)
    if (text === warned) return
    warned = text
    try {
      onWarn(`dsh-computers self-runtime: ${text}`)
    } catch {
      // A broken log sink must not break the runtime.
    }
  }

  /** Append one complete output line to the ring buffer. */
  const appendLine = (line) => {
    const text = cleanLine(line)
    if (text === '') return
    logLines.push(text)
    if (logLines.length > LOG_RING) logLines.splice(0, logLines.length - LOG_RING)
  }

  /** Feed a stdout/stderr chunk into the line buffer. */
  const pushLog = (chunk) => {
    let text
    try {
      text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    } catch {
      return
    }
    logBuffer += text
    const lines = logBuffer.split(/\r?\n/)
    logBuffer = lines.pop() ?? ''
    for (const line of lines) appendLine(line)
  }

  /** Flush a partial trailing line (process exit). */
  const flushLogBuffer = () => {
    if (logBuffer !== '') {
      appendLine(logBuffer)
      logBuffer = ''
    }
  }

  const status = () => ({
    state,
    // Optional fields are `null` rather than absent, so the browser contract has
    // a stable key set while the doc's `pid?`/`since?` semantics stay satisfied.
    pid: state === 'running' ? pid : null,
    since: state === 'running' ? since : null,
    lastError: lastError ?? null,
    // Additive diagnostics: which registry record is this machine, and the tail
    // of the child's output (last ~50 lines, credentials scrubbed).
    computerId: computerId === '' ? null : computerId,
    logs: logLines.slice(-LOG_TAIL),
  })

  /** Settle into the failure state (never throws). */
  const fail = (message) => {
    const text = cleanLine(message)
    lastError = text
    state = 'failed'
    pid = null
    since = null
    warnOnce(text)
  }

  const clearRestart = () => {
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
  }

  /** Unref'd sleep so a pending start never holds the host process open. */
  const wait = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })

  /**
   * This hub's loopback origin, read from the host web server. Guarded because
   * the real `getOrigin()` throws before the listener binds and a Cordis context
   * may refuse an undeclared property.
   * @returns {string} `http://127.0.0.1:<port>` or '' when unknown.
   */
  const ownBaseUrl = () => {
    try {
      const webServer = ctx === null || typeof ctx !== 'object' ? null : ctx.webServer
      if (webServer === null || typeof webServer !== 'object') return ''
      let origin = null
      try {
        origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : null
      } catch {
        origin = null
      }
      if (typeof origin === 'string' && origin !== '') {
        const parsed = new URL(origin)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          const port = parsed.port !== '' ? parsed.port : (parsed.protocol === 'https:' ? '443' : '80')
          // Always loopback: the runtime must talk to THIS process, not to a
          // public alias of it (which may be a relay hop or another machine).
          // A listener that bound a loopback name/IPv6 loopback keeps its own
          // spelling (binding `::1` does not accept 127.0.0.1).
          const host = parsed.hostname
          const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
          return `${parsed.protocol}//${loopback ? host : '127.0.0.1'}:${port}`
        }
      }
      const port = webServer.port
      if (Number.isSafeInteger(port) && port > 0) return `http://127.0.0.1:${port}`
    } catch {
      // Fall through to "unknown".
    }
    return ''
  }

  /** Wait (bounded) for the host listener to report a port. */
  const waitForBaseUrl = async (gen) => {
    const deadline = now() + portWaitMs
    for (;;) {
      const base = ownBaseUrl()
      if (base !== '') return base
      if (disposed || gen !== generation) return ''
      if (now() >= deadline) return ''
      await wait(pollMs)
    }
  }

  /** The display name the local computer is enrolled under. */
  const displayName = () => {
    const configured = typeof name === 'string' ? name.trim() : ''
    return (configured !== '' ? configured : hostName()).slice(0, 64)
  }

  /** Machine facts for the enroll body (§3.1). */
  const machineInfo = () => {
    const osName = platform()
    return {
      hostname: hostName(),
      name: displayName(),
      os: osName,
      arch: arch(),
      platform: platformLabel(osName),
      cpuModel: cpus()[0]?.model ?? null,
      memoryBytes: totalmem(),
      nodeVersion: process.version,
      agentVersion: version,
    }
  }

  /**
   * Enroll this machine with its own hub over loopback, using the fleet token.
   * The hub answers `{ computerId, token, name }`; its advertised `serverUrl` is
   * deliberately ignored (we always dial loopback).
   */
  const enroll = async ({ baseUrl, token }) => {
    const response = await postJson(`${baseUrl}${API_BASE}/agent/enroll`, {
      join: token,
      agentVersion: version,
      capabilities: [...SELF_CAPABILITIES],
      metadata: {
        version: 1,
        agentVersion: version,
        // The plugin owns this process, so it reads as an embedded runtime in
        // the settings page (no "install the one-liner" hint).
        mode: 'embedded',
        hostname: hostName(),
        os: platform(),
        arch: arch(),
        capabilities: [...SELF_CAPABILITIES],
        workspaceBase: homedir(),
      },
      machine: machineInfo(),
    }, { timeoutMs: enrollTimeoutMs })
    const data = response.data !== null && typeof response.data === 'object' ? response.data : {}
    if (response.status !== 200) {
      const code = typeof data.error === 'string' && data.error !== '' ? data.error : `http-${response.status}`
      const message = typeof data.message === 'string' && data.message !== '' ? data.message : code
      throw new Error(`the hub refused the enrollment (${code}): ${message}`)
    }
    const enrolledId = typeof data.computerId === 'string' ? data.computerId.trim() : ''
    const enrolledToken = typeof data.token === 'string' ? data.token.trim() : ''
    if (enrolledId === '' || enrolledToken === '') {
      throw new Error('the hub returned an unexpected enrollment response (no computerId/token)')
    }
    return {
      computerId: enrolledId,
      token: enrolledToken,
      name: typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : displayName(),
    }
  }

  /** Write the isolated agent config (documented agent schema v1, 0600, atomic). */
  const writeAgentConfig = ({ baseUrl, agentToken, enrolledId, enrolledName, joinToken: fleetToken }) => writeJsonAtomic(configFile, {
    version: 1,
    serverUrl: baseUrl,
    computerId: enrolledId,
    // The machine token the hub minted for THIS child (never the fleet token).
    token: agentToken,
    name: enrolledName,
    enrolledAt: new Date(now()).toISOString(),
    workspaceBase: homedir(),
    // The hub's fleet join token, kept so a later re-enroll (after a hub registry
    // reset) can join again; the agent only ever sends it on enroll.
    joinToken: fleetToken,
  }, {
    dir: selfDir,
    onWarn: (message) => warnOnce(message),
  })

  /** Kill a child, tolerating an already-dead one. */
  const killQuietly = (target, signal = 'SIGTERM') => {
    if (target === null || target === undefined) return
    try {
      target.kill(signal)
    } catch {
      // Already gone.
    }
  }

  /** Resolve true when the child exits within `timeoutMs`. */
  const waitForExit = (target, timeoutMs) => new Promise((resolve) => {
    if (target.exitCode !== null && target.exitCode !== undefined) {
      resolve(true)
      return
    }
    if (target.signalCode !== null && target.signalCode !== undefined) {
      resolve(true)
      return
    }
    let timer = null
    const onExit = () => {
      if (timer !== null) clearTimeout(timer)
      resolve(true)
    }
    target.once('exit', onExit)
    timer = setTimeout(() => {
      try {
        target.off('exit', onExit)
      } catch {
        // Older EventEmitter shape: the listener is harmless either way.
      }
      resolve(false)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })

  /** A crash: retry within the budget, else give up with the reason. */
  const onCrash = (code, signal) => {
    const reason = signal !== null && signal !== undefined ? `signal ${signal}` : `exit code ${code}`
    lastError = `the local runtime exited unexpectedly (${reason})`
    if (disposed) {
      state = 'stopped'
      return
    }
    const nowMs = now()
    restartTimes = restartTimes.filter((at) => nowMs - at < restartWindowMs)
    if (restartTimes.length >= maxRestarts) {
      state = 'failed'
      lastError = `the local runtime keeps crashing (${maxRestarts} restarts within ${Math.round(restartWindowMs / 60_000)} min); not restarting it again`
      warnOnce(lastError)
      return
    }
    restartTimes.push(nowMs)
    state = 'starting'
    warnOnce(lastError)
    const delay = delays[Math.min(restartTimes.length - 1, delays.length - 1)]
    clearRestart()
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (disposed) return
      void start()
    }, delay)
    if (typeof restartTimer.unref === 'function') restartTimer.unref()
  }

  /** Wire a freshly spawned child's output/exit handlers. */
  const attach = (proc, gen) => {
    const onData = (chunk) => {
      if (gen === generation) pushLog(chunk)
    }
    try {
      proc.stdout?.setEncoding?.('utf8')
      proc.stdout?.on('data', onData)
      proc.stderr?.setEncoding?.('utf8')
      proc.stderr?.on('data', onData)
    } catch {
      // A child without pipes still runs; only diagnostics are lost.
    }
    proc.once('error', (error) => {
      if (stoppingChild === proc) return
      if (child === proc) {
        child = null
        pid = null
        since = null
      }
      if (gen !== generation) return
      fail(`the local runtime could not start: ${messageOf(error)}`)
    })
    proc.once('exit', (code, signal) => {
      flushLogBuffer()
      if (stoppingChild === proc) {
        // `stop()` owns the transition; just drop the reference.
        stoppingChild = null
        return
      }
      if (child === proc) {
        child = null
        pid = null
        since = null
      }
      if (gen !== generation) return
      onCrash(code, signal)
    })
  }

  /** Wait for the spawn confirmation (or the immediate failure). */
  const waitForSpawn = (proc) => new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        proc.off('spawn', onSpawn)
        proc.off('error', onError)
        proc.off('exit', onExit)
      } catch {
        // Nothing to detach.
      }
      resolve(value)
    }
    const onSpawn = () => finish({ ok: true })
    const onError = (error) => finish({ ok: false, error })
    const onExit = (code) => finish({ ok: false, error: new Error(`exited with code ${code}`) })
    proc.once('spawn', onSpawn)
    proc.once('error', onError)
    proc.once('exit', onExit)
    // `spawn` may already have fired between creating the child and attaching.
    if (typeof proc.pid === 'number' && (proc.exitCode === null || proc.exitCode === undefined)) {
      finish({ ok: true })
    }
  })

  /**
   * The embedded fallback: run the agent's SSE/exec loop inside THIS process.
   * Used only when spawning is unavailable (e.g. a sandbox that forbids child
   * processes). It reuses the identity the enroll above produced, so it can
   * never touch the upstream runtime's credentials either.
   * @param {number} gen - the start generation this attempt belongs to.
   * @param {{ baseUrl: string, agentToken: string, enrolledId: string, enrolledName: string }} input - identity.
   * @returns {Promise<boolean>} whether the embedded loop took over.
   */
  const startEmbedded = async (gen, { baseUrl, agentToken, enrolledId, enrolledName }) => {
    let startRuntime = null
    try {
      if (typeof deps.startRuntime === 'function') {
        startRuntime = deps.startRuntime
      } else {
        if (embeddedModulePromise === null) {
          embeddedModulePromise = import(new URL('../agent/dsh-computers-agent.mjs', import.meta.url).href)
            .catch((error) => {
              embeddedModulePromise = null
              throw error
            })
        }
        const module = await embeddedModulePromise
        startRuntime = typeof module.startRuntime === 'function' ? module.startRuntime : null
      }
    } catch (error) {
      warnOnce(`the embedded runtime module could not be loaded: ${messageOf(error)}`)
      return false
    }
    if (typeof startRuntime !== 'function') {
      warnOnce('the embedded runtime is unavailable: the agent bundle does not export startRuntime')
      return false
    }
    let handle = null
    try {
      handle = startRuntime({
        serverUrl: baseUrl,
        token: agentToken,
        computerId: enrolledId,
        name: enrolledName,
        heartbeatMs: positiveInt(deps.heartbeatMs, undefined),
        // Same claim the plugin's own embedded runtime makes: the plugin owns
        // this loop, so the settings page must not offer the one-liner install.
        mode: 'embedded',
        log: (level, message) => {
          if (level === 'warn' || level === 'error') appendLine(message)
        },
        onState: (next) => {
          if (gen !== generation || disposed || next === null || typeof next !== 'object') return
          if (next.connected === true) {
            state = 'running'
            lastError = null
          } else if (typeof next.lastError === 'string' && next.lastError !== '') {
            lastError = cleanLine(next.lastError)
          }
        },
      })
      if (handle === null || typeof handle !== 'object' || typeof handle.stop !== 'function') {
        throw new Error('startRuntime() did not return { stop() }')
      }
      embedded = handle
      if (gen !== generation || disposed) {
        embedded = null
        try {
          await handle.stop()
        } catch {
          // This attempt already lost; there is nothing to report.
        }
        return true
      }
      state = 'running'
      // No child process owns the loop, so `pid` stays null while running.
      pid = null
      since = new Date(now()).toISOString()
      warned = null
      return true
    } catch (error) {
      embedded = null
      warnOnce(`the embedded runtime could not start: ${messageOf(error)}`)
      return false
    }
  }

  /** One start attempt: port → enroll → config → child. Never throws. */
  const doStart = async () => {    if (disposed) return
    clearRestart()
    state = 'starting'
    pid = null
    since = null
    lastError = null
    const gen = generation

    const baseUrl = await waitForBaseUrl(gen)
    if (disposed || gen !== generation) return
    if (baseUrl === '') {
      fail('the host web server did not report a port, so the local runtime cannot reach this hub')
      return
    }

    let token = ''
    try {
      token = typeof joinToken === 'function' ? joinToken() : ''
    } catch (error) {
      fail(`could not read this hub's join token: ${messageOf(error)}`)
      return
    }
    if (typeof token !== 'string' || token.trim() === '') {
      fail('this hub has no fleet join token, so the local runtime cannot enroll')
      return
    }

    let enrolled
    try {
      enrolled = await enroll({ baseUrl, token: token.trim() })
    } catch (error) {
      if (gen === generation) fail(messageOf(error))
      return
    }
    if (disposed || gen !== generation) return
    computerId = enrolled.computerId

    if (!writeAgentConfig({
      baseUrl,
      agentToken: enrolled.token,
      enrolledId: enrolled.computerId,
      enrolledName: enrolled.name,
      joinToken: token.trim(),
    })) {
      fail(`could not write the isolated agent config at ${configFile}`)
      return
    }

    let proc
    try {
      proc = spawnChild(nodePath, [agentPath, 'run'], {
        cwd: homedir(),
        env: {
          ...process.env,
          // Isolated identity: this child never sees ~/.dsh-computers, so it
          // cannot interfere with the upstream runtime in lib/runtime.js.
          DSH_COMPUTERS_HOME: selfDir,
          DSH_COMPUTERS_SELF_RUNTIME: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      // Spawning itself is unavailable in this host: fall back to the embedded
      // agent loop (same identity) instead of failing the whole feature.
      const tookOver = await startEmbedded(gen, {
        baseUrl,
        agentToken: enrolled.token,
        enrolledId: enrolled.computerId,
        enrolledName: enrolled.name,
      })
      if (tookOver) return
      fail(`the local runtime could not start: ${messageOf(error)}`)
      return
    }
    child = proc
    attach(proc, gen)

    const started = await waitForSpawn(proc)
    if (disposed || gen !== generation) {
      killQuietly(proc)
      return
    }
    if (!started.ok) {
      // The crash handler may already own the retry; do not overwrite it.
      if (restartTimer !== null || state === 'starting') return
      // A child that never reached `spawn` (ENOENT/EACCES/blocked) is the
      // documented "spawn unavailable" case: try the embedded loop.
      const tookOver = await startEmbedded(gen, {
        baseUrl,
        agentToken: enrolled.token,
        enrolledId: enrolled.computerId,
        enrolledName: enrolled.name,
      })
      if (tookOver) return
      fail(`the local runtime could not start: ${messageOf(started.error)}`)
      return
    }
    state = 'running'
    pid = typeof proc.pid === 'number' ? proc.pid : null
    since = new Date(now()).toISOString()
    warned = null
  }

  /** Start (idempotent; concurrent callers share one attempt). Never throws. */
  const start = async () => {
    if (disposed) return status()
    if (state === 'running' && child !== null) return status()
    if (pending !== null) return await pending
    pending = (async () => {
      try {
        await doStart()
      } catch (error) {
        fail(messageOf(error))
      } finally {
        pending = null
      }
      return status()
    })()
    return await pending
  }

  /** Stop the child (SIGTERM, then SIGKILL) and keep the configuration. */
  const stop = async () => {
    // Invalidate any in-flight start: it must not spawn after this point.
    generation += 1
    clearRestart()
    const current = child
    child = null
    if (current !== null) {
      stoppingChild = current
      killQuietly(current, 'SIGTERM')
      const exited = await waitForExit(current, stopGraceMs)
      if (!exited) {
        killQuietly(current, 'SIGKILL')
        await waitForExit(current, 500)
      }
      if (stoppingChild === current) stoppingChild = null
    }
    // The embedded fallback owns no process; stop its loop the same way.
    const currentEmbedded = embedded
    embedded = null
    if (currentEmbedded !== null) {
      try {
        await currentEmbedded.stop()
      } catch (error) {
        warnOnce(`the embedded runtime did not stop cleanly: ${messageOf(error)}`)
      }
    }
    state = 'stopped'
    pid = null
    since = null
    lastError = null
    return status()
  }

  /** Stop + start, resetting the crash-loop budget (an explicit user action). */
  const restart = async () => {
    restartTimes = []
    await stop()
    return await start()
  }

  /** Load-time start. Total: a failed start settles into `state: 'failed'`. */
  const autoStart = async () => {
    try {
      if (disposed) return status()
      return await start()
    } catch (error) {
      fail(messageOf(error))
      return status()
    }
  }

  /** Plugin unload: kill the child, keep the config for the next load. */
  const dispose = async () => {
    disposed = true
    await stop()
  }

  return {
    /** Absolute config path of the isolated agent identity (diagnostics). */
    file: configFile,
    /** Directory holding that identity (diagnostics). */
    dir: selfDir,
    /** Agent bundle executed by the child (diagnostics). */
    agentPath,
    /** Start (idempotent). */
    start,
    /** Stop the child but keep the identity/config. */
    stop,
    /** Stop + start with a fresh crash budget. */
    restart,
    /** `{ state, pid, since, lastError, computerId, logs }`. */
    status,
    /** Start at plugin load; never throws into `apply()`. */
    autoStart,
    /** Plugin unload. */
    dispose,
    /** The registry computer id of this machine's own runtime ('' before enroll). */
    computerId: () => computerId,
  }
}
