/**
 * Managed local relay (v1.9.2): the plugin runs the relay itself.
 *
 * Before this, a relay was a separate deployment (git clone + systemd + root).
 * That made "the relay" a second product to install and upgrade, and it left the
 * normal user with a settings page that could only point at an address someone
 * else had to keep alive. Now the SAME plugin owns a child relay process:
 *
 * - one click in Settings → 电脑 starts it, upgrading the plugin upgrades the
 *   relay, and no git/systemd/root is involved;
 * - the child is the package's own `bin/dsh-computers-relay.mjs`, spawned as
 *   `node <pkg>/bin/dsh-computers-relay.mjs --port <port> --host 127.0.0.1
 *   --data-dir <stateDir>/relay-data`. The relay's account document therefore
 *   lives inside the plugin's state directory and moves with it;
 * - the listener is LOOPBACK only: the relay is reached through the reverse
 *   proxy / tunnel in front of this machine, never by opening a second public
 *   port. `--host 127.0.0.1` is deliberate, not a default;
 * - starting the relay does NOT enable the relay link. They are two different
 *   switches: the supervisor owns a local SERVER, `relay.enabled` makes this
 *   hub DIAL OUT to it. The route answers the same shapes and the client keeps
 *   the existing enable switch.
 *
 * Adoption: a relay may already be running (a previous plugin load whose child
 * outlived it, or an operator-started one). Before spawning anything this
 * manager probes `GET http://127.0.0.1:<port>/health`; a real relay answers
 * `{ ok: true, … }` and is ADOPTED (`state: 'running', adopted: true`) instead
 * of starting a duplicate that would fight for the port. An adopted relay is
 * not owned: `stop()` releases the adoption but never kills a process this
 * manager did not spawn.
 *
 * Crash handling mirrors `lib/self-runtime.js`: at most {@link MAX_RESTARTS}
 * automatic restarts inside {@link RESTART_WINDOW_MS}, with the 1 s / 2 s / 4 s
 * delays, then `state: 'failed'` with the reason. A bind failure (EADDRINUSE in
 * the child's output) is not retried at all — it cannot succeed until something
 * changes, so it fails immediately with an actionable message.
 *
 * Lifecycle methods are TOTAL: they resolve to a status object and never throw,
 * so a route can answer 200 with `state: 'failed'` and `apply()` can never be
 * taken down by the supervisor.
 *
 * Node builtins only.
 */

import { spawn as spawnProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Default local relay port (the documented `relay.localPort` default). */
export const DEFAULT_RELAY_PORT = 8445

/** Runtime states the browser contract exposes. */
export const RELAY_SUPERVISOR_STATES = Object.freeze(['stopped', 'starting', 'running', 'failed'])

/** Automatic restarts allowed inside {@link RESTART_WINDOW_MS}. */
export const MAX_RESTARTS = 3

/** Crash-loop window: a restart older than this no longer counts. */
export const RESTART_WINDOW_MS = 5 * 60_000

/** Delays before the 1st/2nd/3rd automatic restart (1 s / 2 s / 4 s). */
const DEFAULT_RESTART_DELAYS = Object.freeze([1000, 2000, 4000])

/** The loopback interface the child binds: never expose a second public port. */
const RELAY_HOST = '127.0.0.1'

/** Health-probe budget: a live relay answers instantly, a black hole does not. */
const DEFAULT_HEALTH_TIMEOUT_MS = 750

/** Grace period between SIGTERM and SIGKILL on stop. */
const DEFAULT_STOP_GRACE_MS = 2_000

/** Lines kept in the ring buffer / returned by `status().logs`. */
const LOG_RING = 200
const LOG_TAIL = 80
const LOG_LINE_MAX = 500

/** Directory (under the plugin state dir) holding the relay's accounts.json. */
export const RELAY_DATA_DIR_NAME = 'relay-data'

/**
 * One log line, capped. The relay does not print credentials, but the tail is
 * served to the browser, so account keys are scrubbed defensively anyway.
 * @param {unknown} value - a chunk or message.
 * @returns {string} a single capped line.
 */
function cleanLine(value) {
  let text = typeof value === 'string' ? value : String(value ?? '')
  text = text.replace(/(dshk_|dshf_|dshc_)[A-Za-z0-9_-]{4,}/g, '$1[redacted]')
  return text.slice(0, LOG_LINE_MAX)
}

/** `error.message` or a string, never a throw. */
function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  return error.message ? String(error.message) : String(error)
}

/** A port number in 1..65535, else null. */
function validPort(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 65535 ? value : null
}

/** A positive safe integer or the fallback. */
function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * Probe a port with the relay's own liveness route.
 *
 * Three outcomes matter to the supervisor:
 * - `healthy: true` — a relay answers `{ ok: true }`, so adopt it;
 * - `healthy: false, occupied: true` — something else owns the port (an HTTP
 *   service, or a listener that never answers): spawning would only produce an
 *   EADDRINUSE child, so fail with an actionable message;
 * - `healthy: false, occupied: false` — nothing is listening; spawn.
 *
 * @param {number} port - loopback port to probe.
 * @param {{ timeoutMs?: number }} [options] - probe budget.
 * @returns {Promise<{ healthy: boolean, occupied: boolean }>} the probe result.
 */
export function probeRelayHealth(port, { timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let request
    try {
      request = httpRequest({
        host: RELAY_HOST,
        port,
        path: '/health',
        method: 'GET',
        timeout: timeoutMs,
        headers: { accept: 'application/json' },
      }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          // The health payload is tiny; cap what a hostile listener can make us buffer.
          if (body.length < 64 * 1024) body += chunk
        })
        response.on('end', () => {
          let ok = false
          try {
            const data = JSON.parse(body)
            ok = data !== null && typeof data === 'object' && data.ok === true
          } catch {
            ok = false
          }
          // Any HTTP answer means the port is taken, whether or not it is a relay.
          finish({ healthy: response.statusCode === 200 && ok, occupied: true })
        })
        response.on('error', () => finish({ healthy: false, occupied: true }))
      })
    } catch {
      finish({ healthy: false, occupied: false })
      return
    }
    request.on('timeout', () => {
      try {
        request.destroy()
      } catch {
        // Already gone.
      }
      // A listener that accepts but never answers still owns the port.
      finish({ healthy: false, occupied: true })
    })
    request.on('error', (error) => {
      // ECONNREFUSED is the normal "free port" answer on loopback. Anything else
      // (ECONNRESET, EACCES, …) means we cannot prove it is free, so treat the
      // port as taken rather than spawn a child that may fight for it.
      const refused = error !== null && error !== undefined
        && (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH')
      finish({ healthy: false, occupied: refused !== true })
    })
    request.end()
  })
}

/**
 * Create the supervisor for this machine's local relay.
 *
 * @param {object} options - supervisor options.
 * @param {object | null} [options.ctx] - Cordis context (unused today; kept for symmetry with the other managers).
 * @param {string} options.stateDir - plugin state directory.
 * @param {number} [options.port] - desired loopback port (default 8445, `relay.localPort`).
 * @param {(message: string) => void} [options.onWarn] - host warning sink.
 * @param {object} [options.deps] - test seams; production leaves it empty.
 * @param {string} [options.deps.binPath] - relay bin to execute (default: ../bin/…).
 * @param {string} [options.deps.nodePath] - node binary (default: `process.execPath`).
 * @param {Function} [options.deps.spawn] - `child_process.spawn` replacement.
 * @param {Function} [options.deps.probe] - health probe replacement `(port) => Promise<{healthy, occupied}>`.
 * @param {Function} [options.deps.now] - epoch-ms clock.
 * @param {number[]} [options.deps.restartDelays] - automatic-restart delays.
 * @param {number} [options.deps.maxRestarts] - restarts allowed per window.
 * @param {number} [options.deps.restartWindowMs] - crash-loop window.
 * @param {number} [options.deps.stopGraceMs] - SIGTERM → SIGKILL grace.
 * @param {number} [options.deps.healthTimeoutMs] - health-probe budget.
 * @returns {object} `{ start, stop, restart, status, autoStart, dispose, binPath, dataDir, port }`.
 */
export function createRelaySupervisor({
  ctx = null,
  stateDir,
  port = DEFAULT_RELAY_PORT,
  onWarn = () => {},
  deps = {},
} = {}) {
  // `ctx` is accepted so the manager has the same construction shape as the
  // tunnel/relay/self-runtime managers; nothing is read from it today.
  void ctx
  const binPath = typeof deps.binPath === 'string' && deps.binPath !== ''
    ? deps.binPath
    : fileURLToPath(new URL('../bin/dsh-computers-relay.mjs', import.meta.url))
  const nodePath = typeof deps.nodePath === 'string' && deps.nodePath !== ''
    ? deps.nodePath
    : process.execPath
  const spawnChild = typeof deps.spawn === 'function' ? deps.spawn : spawnProcess
  const probe = typeof deps.probe === 'function' ? deps.probe : probeRelayHealth
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const healthTimeoutMs = positiveInt(deps.healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS)
  const stopGraceMs = positiveInt(deps.stopGraceMs, DEFAULT_STOP_GRACE_MS)
  const maxRestarts = positiveInt(deps.maxRestarts, MAX_RESTARTS)
  const restartWindowMs = positiveInt(deps.restartWindowMs, RESTART_WINDOW_MS)
  const restartDelays = Array.isArray(deps.restartDelays) && deps.restartDelays.length > 0
    ? deps.restartDelays.filter((value) => Number.isSafeInteger(value) && value >= 0)
    : DEFAULT_RESTART_DELAYS
  const delays = restartDelays.length > 0 ? restartDelays : DEFAULT_RESTART_DELAYS
  const dataDir = join(stateDir, RELAY_DATA_DIR_NAME)

  /** The port the user asked for; survives stop() so the UI can show it. */
  let desiredPort = validPort(port) ?? DEFAULT_RELAY_PORT
  /** 'stopped' | 'starting' | 'running' | 'failed'. */
  let state = 'stopped'
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  let pid = null
  let since = null
  let lastError = null
  /** True when a relay this manager did NOT spawn is being observed. */
  let adopted = false
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
      onWarn(`dsh-computers relay supervisor: ${text}`)
    } catch {
      // A broken log sink must not break the supervisor.
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

  /**
   * The browser contract. `pid`/`since` are null unless this manager owns a
   * running child; an adopted relay reports `adopted: true` and no pid (we do
   * not own that process and cannot prove which pid is its).
   * @returns {{ state: string, pid: number|null, port: number, since: string|null, lastError: string|null, logs: string[], adopted: boolean }} the status.
   */
  const status = () => ({
    state,
    pid: state === 'running' && adopted !== true ? pid : null,
    port: desiredPort,
    since: state === 'running' ? since : null,
    lastError: lastError ?? null,
    logs: logLines.slice(-LOG_TAIL),
    adopted,
  })

  /** Settle into the failure state (never throws). */
  const fail = (message) => {
    const text = cleanLine(message)
    lastError = text
    state = 'failed'
    pid = null
    since = null
    adopted = false
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

  /** Recent output, for classifying a crash (a bind failure is not retried). */
  const recentLogs = () => logLines.slice(-8).join('\n')

  /** A crash: retry within the budget, else give up with the reason. */
  const onCrash = (code, signal) => {
    const reason = signal !== null && signal !== undefined ? `signal ${signal}` : `exit code ${code}`
    lastError = `the local relay exited unexpectedly (${reason})`
    if (disposed) {
      state = 'stopped'
      return
    }
    // A bind failure cannot fix itself: retrying would just crash again, so fail
    // now with the actionable message instead of burning the restart budget.
    if (/EADDRINUSE|cannot listen|address already in use/i.test(recentLogs())) {
      fail(`the local relay could not bind port ${desiredPort}: it is already in use; stop the other service or choose another port`)
      return
    }
    const nowMs = now()
    restartTimes = restartTimes.filter((at) => nowMs - at < restartWindowMs)
    if (restartTimes.length >= maxRestarts) {
      state = 'failed'
      lastError = `the local relay keeps crashing (${maxRestarts} restarts within ${Math.round(restartWindowMs / 60_000)} min); not restarting it again`
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
      fail(`the local relay could not start: ${messageOf(error)}`)
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

  /** One start attempt: probe → adopt or spawn. Never throws. */
  const doStart = async () => {
    if (disposed) return
    clearRestart()
    state = 'starting'
    pid = null
    since = null
    lastError = null
    adopted = false
    const gen = generation

    // Adoption first: a relay may already own the port (a previous load's child,
    // or one the operator started). Starting a second one would only fail.
    let probeResult
    try {
      probeResult = await probe(desiredPort, { timeoutMs: healthTimeoutMs })
    } catch {
      probeResult = { healthy: false, occupied: false }
    }
    if (disposed || gen !== generation) return
    const healthy = probeResult !== null && typeof probeResult === 'object' && probeResult.healthy === true
    const occupied = probeResult !== null && typeof probeResult === 'object' && probeResult.occupied === true
    if (healthy) {
      adopted = true
      state = 'running'
      pid = null
      since = new Date(now()).toISOString()
      appendLine(`adopted an existing relay on http://${RELAY_HOST}:${desiredPort}`)
      return
    }
    if (occupied) {
      fail(`port ${desiredPort} is already in use by another service (it does not answer the relay health check); stop it or choose another port`)
      return
    }

    // The relay writes accounts.json here, so the directory must exist first.
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    } catch (error) {
      fail(`could not create the relay data directory at ${dataDir}: ${messageOf(error)}`)
      return
    }

    let proc
    try {
      proc = spawnChild(nodePath, [
        binPath,
        '--port', String(desiredPort),
        '--host', RELAY_HOST,
        '--data-dir', dataDir,
      ], {
        cwd: stateDir,
        // Inherit the environment (PATH for node), but the data directory is the
        // plugin's own: the child never touches a system-wide relay document.
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      fail(`the local relay could not start: ${messageOf(error)}`)
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
      fail(`the local relay could not start: ${messageOf(started.error)}`)
      return
    }
    state = 'running'
    pid = typeof proc.pid === 'number' ? proc.pid : null
    since = new Date(now()).toISOString()
    adopted = false
    warned = null
  }

  /** Start (idempotent; concurrent callers share one attempt). Never throws. */
  const start = async (portOverride) => {
    if (disposed) return status()
    const nextPort = validPort(portOverride)
    if (nextPort !== null && nextPort !== desiredPort) {
      // A different port means a different listener: tear the old one down first.
      await stop()
      desiredPort = nextPort
    }
    if (state === 'running' && (child !== null || adopted)) return status()
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

  /** Stop the owned child (SIGTERM, then SIGKILL); release an adopted relay. */
  const stop = async () => {
    // Invalidate any in-flight start: it must not spawn after this point.
    generation += 1
    clearRestart()
    const wasAdopted = adopted
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
    if (wasAdopted) {
      // Never kill a process this manager did not spawn: only release the claim.
      appendLine(`released the adopted relay on http://${RELAY_HOST}:${desiredPort}`)
    }
    adopted = false
    state = 'stopped'
    pid = null
    since = null
    lastError = null
    return status()
  }

  /** Stop + start, resetting the crash-loop budget (an explicit user action). */
  const restart = async (portOverride) => {
    restartTimes = []
    await stop()
    return await start(portOverride)
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

  /**
   * Last-resort cleanup: a plugin unload must not leave an orphan relay behind.
   * The `exit` hook is synchronous because async work does not run there.
   */
  const onProcessExit = () => {
    if (child === null) return
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
  }
  try {
    process.once('exit', onProcessExit)
  } catch {
    // A host without process events still works; dispose() is the normal path.
  }

  /** Plugin unload: kill the owned child, keep the relay's data. */
  const dispose = async () => {
    disposed = true
    try {
      process.removeListener('exit', onProcessExit)
    } catch {
      // Nothing registered.
    }
    await stop()
  }

  return {
    /** Absolute relay bin this manager spawns (diagnostics). */
    binPath,
    /** Directory holding the relay's accounts.json (diagnostics). */
    dataDir,
    /** The desired loopback port (also in `status()`). */
    port: () => desiredPort,
    /** Start (idempotent; optional port override). */
    start,
    /** Stop the owned child / release an adopted relay. */
    stop,
    /** Stop + start with a fresh crash budget. */
    restart,
    /** `{ state, pid, port, since, lastError, logs, adopted }`. */
    status,
    /** Start at plugin load; never throws into `apply()`. */
    autoStart,
    /** Plugin unload. */
    dispose,
  }
}
