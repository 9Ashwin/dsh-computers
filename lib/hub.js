/**
 * The live side of dsh-computers: one SSE stream per computer and the exec
 * dispatcher that rides it (PROTOCOL §3.2, §3.3, §11.2, §11.6).
 *
 * Invariants this file keeps:
 * - at most one stream per computer; opening a new one ends the old one and
 *   fails the old agent's in-flight executions;
 * - `online` is the live stream and nothing else; `lastSeenAt` is display data
 *   refreshed by stream open / heartbeat / result POST;
 * - every exec has a unique `req_…` id and settles exactly once — a result
 *   POST, the silence timeout, the abort signal, a job cancel, the stream
 *   closing or the plugin disposing;
 * - streaming frames are deduped/reassembled by `seq` and a `heartbeat` frame
 *   resets the execution's silence timer (it carries no output);
 * - a foreground timeout can be *adopted* by a job instead of killing the
 *   command (`promoteOnTimeout`), after which chunks keep flowing into the job
 *   ring and the model controls it with job_output/job_kill;
 * - a late result for an already settled id is not accepted (the route
 *   answers 404).
 *
 * Node builtins only.
 */

import {
  DISPOSITION, EXECUTION_STATUS, HOST_FEATURES, WIRE_EVENT,
  cancelFrame, execFrame, helloFrame, pingFrame, requestIdOf,
} from './contracts.js'
import { newRequestId } from './keys.js'

/** Failure carrying a machine-readable code the tool layer maps to a message. */
export class HubError extends Error {
  /**
   * @param {string} code - `offline` | `timeout` | `aborted` | `invalid` | `disposed`.
   * @param {string} message - model-facing detail.
   */
  constructor(code, message) {
    super(message)
    this.name = 'HubError'
    this.code = code
  }
}

/** SSE response headers required by the protocol. */
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/** Host features advertised in `hello` (PROTOCOL §11.1/§11.5), re-exported. */
export { HOST_FEATURES }

/** How long a killed execution may take to report its final result before the host settles it locally. */
const KILL_SETTLE_MS = 5_000

/**
 * Trim UTF-8 text to a byte budget without cutting a character in half.
 * @param {string} text - input text.
 * @param {number} maxBytes - inclusive byte budget.
 * @returns {{ text: string, truncated: boolean }} trimmed text and whether it was cut.
 */
function capText(text, maxBytes) {
  if (typeof text !== 'string') return { text: '', truncated: false }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) return { text, truncated: false }
  let out = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  while (out.endsWith('\uFFFD')) out = out.slice(0, -1)
  return { text: `${out}\n[output truncated]`, truncated: true }
}

/** Decode one base64 frame payload; empty/absent decodes to ''. */
function decodeFrame(data) {
  if (typeof data !== 'string' || data === '') return ''
  try {
    return Buffer.from(data, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Create the hub for one plugin mount.
 * @param {object} options - hub options.
 * @param {object} options.store - registry store (presence timestamps).
 * @param {number} options.heartbeatMs - ping cadence and presence window base.
 * @param {number} options.maxOutputBytes - per-stream result cap.
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 * @returns {object} the hub.
 */
export function createHub({ store, heartbeatMs, maxOutputBytes, onWarn = () => {} }) {
  /** @type {Map<string, { res: import('node:http').ServerResponse, timer: ReturnType<typeof setInterval>, openedAt: number }>} */
  const streams = new Map()
  /** @type {Map<string, object>} */
  const pending = new Map()
  let disposed = false

  /** Write one SSE frame; false when the stream is gone. */
  const writeFrame = (stream, event, data) => {
    const res = stream.res
    if (res.writableEnded || res.destroyed) return false
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      return true
    } catch (error) {
      onWarn(`dsh-computers: SSE write failed: ${error && error.message ? error.message : error}`)
      return false
    }
  }

  /** Detach one pending execution's timers and abort listener (idempotent). */
  const detach = (entry) => {
    if (entry.silenceTimer !== null) {
      clearTimeout(entry.silenceTimer)
      entry.silenceTimer = null
    }
    if (entry.graceTimer !== null) {
      clearTimeout(entry.graceTimer)
      entry.graceTimer = null
    }
    if (entry.signal !== undefined && entry.onAbort !== null) {
      entry.signal.removeEventListener('abort', entry.onAbort)
      entry.onAbort = null
    }
  }

  /**
   * Typed terminal state (R3): what actually happened, and whether the machine
   * can be reused. `broken` means the final result never arrived, so we cannot
   * claim the process stopped.
   */
  const terminalOf = ({ status, disposition, confirmed = true, exitCode = null, signal = null, error = null }) => ({
    status,
    disposition,
    confirmed,
    exitCode,
    signal,
    error,
  })

  /** Normalize one final result payload into the tool-facing shape. */
  const normalizeResult = (entry, payload) => {
    const stdout = capText(typeof payload.stdout === 'string' ? payload.stdout : entry.buffered.stdout, maxOutputBytes)
    const stderr = capText(typeof payload.stderr === 'string' ? payload.stderr : entry.buffered.stderr, maxOutputBytes)
    const exitCode = typeof payload.exitCode === 'number' && Number.isFinite(payload.exitCode)
      ? Math.trunc(payload.exitCode)
      : null
    const duration = typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs) && payload.durationMs >= 0
      ? Math.trunc(payload.durationMs)
      : Date.now() - entry.startedAt
    const signal = typeof payload.signal === 'string' ? payload.signal : null
    const error = typeof payload.error === 'string' ? payload.error : null
    // R3: a final result after a cancel request is the agent's acknowledgement:
    // the stop is CONFIRMED, and the exit/signal it reports is authoritative.
    const status = entry.cancelRequested === true
      ? EXECUTION_STATUS.CANCELLED
      : payload.timedOut === true
        ? EXECUTION_STATUS.TIMEOUT
        : (payload.ok === true ? EXECUTION_STATUS.COMPLETED : EXECUTION_STATUS.FAILED)
    return {
      requestId: entry.requestId,
      ok: payload.ok === true,
      exitCode,
      signal,
      stdout: stdout.text,
      stderr: stderr.text,
      durationMs: duration,
      truncated: payload.truncated === true || stdout.truncated || stderr.truncated,
      timedOut: payload.timedOut === true,
      error,
      killed: entry.killed === true,
      terminal: terminalOf({
        status,
        disposition: DISPOSITION.REUSABLE,
        confirmed: true,
        exitCode,
        signal,
        error,
      }),
    }
  }

  /**
   * Locally settle a cancelled execution that never reported a final result.
   * R3: this is NOT a confirmed stop — the agent never acknowledged, so the
   * command may still be running on the machine. Say so instead of pretending.
   */
  const settleKilled = (entry) => {
    if (entry.settled) return
    const error = 'cancellation not confirmed: the agent did not report a final result before the grace period; the command may still be running on the machine'
    const result = {
      requestId: entry.requestId,
      ok: false,
      exitCode: null,
      signal: null,
      stdout: entry.buffered.stdout,
      stderr: entry.buffered.stderr,
      durationMs: Date.now() - entry.startedAt,
      truncated: false,
      timedOut: false,
      error,
      killed: true,
      terminal: terminalOf({
        status: EXECUTION_STATUS.CANCELLED,
        disposition: DISPOSITION.BROKEN,
        confirmed: false,
        exitCode: null,
        signal: null,
        error,
      }),
    }
    finish(entry, result)
  }

  /** Resolve/reject the entry exactly once, feeding the job ring when present. */
  const finish = (entry, result) => {
    if (entry.settled) return
    entry.settled = true
    detach(entry)
    pending.delete(entry.requestId)
    if (entry.job !== null) {
      try {
        entry.job.settle(result)
      } catch (error) {
        onWarn(`dsh-computers: job settle failed: ${error && error.message ? error.message : error}`)
      }
    }
    if (entry.background === true) {
      entry.resultResolve(result)
    } else if (entry.promoted === true) {
      // The foreground tool call already returned {jobId, promoted:true}.
    } else {
      entry.resolve(result)
    }
  }

  /** Reject one entry exactly once (v1 failure paths). */
  const failEntry = (entry, error) => {
    if (entry.settled) return
    entry.settled = true
    detach(entry)
    pending.delete(entry.requestId)
    // Stream loss / abort / timeout: no final result arrived, so the machine's
    // state is unknown — the honest terminal state is failed/broken.
    const terminal = error.terminal ?? terminalOf({
      status: EXECUTION_STATUS.FAILED,
      disposition: DISPOSITION.BROKEN,
      confirmed: false,
      exitCode: null,
      signal: null,
      error: error.message,
    })
    if (error.terminal === undefined) error.terminal = terminal
    if (entry.job !== null) {
      try {
        entry.job.failed(error)
      } catch {
        // Already settled by the job registry.
      }
    }
    if (entry.background === true) entry.resultResolve({
      requestId: entry.requestId, ok: false, exitCode: null, signal: null, stdout: entry.buffered.stdout,
      stderr: entry.buffered.stderr, durationMs: Date.now() - entry.startedAt, truncated: false,
      timedOut: false, error: error.message, killed: error.code === 'aborted', terminal,
    })
    else if (entry.promoted !== true) entry.reject(error)
  }

  /** Reject every execution belonging to one computer (stream gone/offline). */
  const failComputerExecs = (computerId, error) => {
    for (const entry of [...pending.values()]) {
      if (entry.computerId === computerId) failEntry(entry, error)
    }
  }

  /** Stop a stream without letting its close event touch a replacement. */
  const retire = (computerId, stream, { end }) => {
    if (streams.get(computerId) === stream) streams.delete(computerId)
    if (stream.timer !== null) {
      clearInterval(stream.timer)
      stream.timer = null
    }
    if (end) {
      try {
        stream.res.end()
      } catch {
        // Already closed by the peer.
      }
    }
  }

  /** (Re)arm the silence timeout. Streaming heartbeats/chunks push it forward. */
  const armSilenceTimer = (entry) => {
    if (entry.timeoutMs <= 0) return
    if (entry.silenceTimer !== null) clearTimeout(entry.silenceTimer)
    entry.silenceTimer = setTimeout(() => {
      entry.silenceTimer = null
      if (entry.settled) return
      // §11.6.3: adopt the running execution into a background job instead of
      // killing it, when the tool layer offered a promotion adapter.
      const adopt = typeof entry.onTimeout === 'function' ? entry.onTimeout(entry) : null
      if (adopt !== null && adopt !== undefined) {
        entry.job = adopt
        entry.promoted = true
        entry.resolve({ promoted: true, jobId: adopt.jobId, requestId: entry.requestId, computer: entry.computer, command: entry.command })
        return
      }
      entry.timeoutRequested = true
      entry.cancelRequested = true
      hub.send(entry.computerId, WIRE_EVENT.CANCEL, cancelFrame(entry.requestId))
      const timeoutError = new HubError('timeout',
        `computer '${entry.label}' did not answer within ${entry.timeoutMs}ms (the command was cancelled)`)
      timeoutError.terminal = terminalOf({
        status: EXECUTION_STATUS.TIMEOUT,
        disposition: DISPOSITION.BROKEN,
        confirmed: false,
        exitCode: null,
        signal: null,
        error: timeoutError.message,
      })
      failEntry(entry, timeoutError)
    }, entry.timeoutMs)
    if (typeof entry.silenceTimer.unref === 'function') entry.silenceTimer.unref()
  }

  /** Append decoded incremental output to the execution tail and the job ring. */
  const appendChunk = (entry, channel, text) => {
    if (text === '') return
    const budget = maxOutputBytes
    const key = channel === 'stderr' ? 'stderr' : 'stdout'
    if (entry.bufferedBytes[key] < budget) {
      const room = budget - entry.bufferedBytes[key]
      const piece = capText(text, room)
      entry.buffered[key] += piece.text
      entry.bufferedBytes[key] += Buffer.byteLength(piece.text, 'utf8')
    }
    if (entry.job !== null) {
      try {
        entry.job.append(key, text)
      } catch {
        // The ring rejects writes after settlement; nothing else to do.
      }
    }
  }

  /** Create one pending execution and send its `exec` event. */
  const beginExecution = ({
    computerId, name, command, cwd = null, timeoutMs, agentTimeoutMs = null, shell = 'sh', signal,
    background = false, stream = true, job = null, onTimeout = null,
    resolve = () => {}, reject = () => {},
  }) => {
    const label = typeof name === 'string' && name !== '' ? name : computerId
    if (disposed) throw new HubError('disposed', 'the dsh-computers host plugin is shutting down')
    if (!streams.has(computerId)) {
      throw new HubError('offline', `computer '${label}' is offline; run computer_list to see what is connected`)
    }
    if (typeof command !== 'string' || command.trim() === '') {
      throw new HubError('invalid', 'command must be a non-empty string')
    }
    const streamRef = streams.get(computerId)
    if (streamRef === undefined) {
      throw new HubError('offline', `computer '${label}' is offline; run computer_list to see what is connected`)
    }
    const requestId = newRequestId()
    let resultResolve = () => {}
    const entry = {
      requestId,
      computerId,
      label,
      command,
      computer: null,
      startedAt: Date.now(),
      signal,
      onAbort: null,
      silenceTimer: null,
      graceTimer: null,
      settled: false,
      killed: false,
      cancelRequested: false,
      timeoutRequested: false,
      promoted: false,
      background,
      stream,
      job,
      onTimeout,
      timeoutMs,
      expectedSeq: 0,
      chunkMap: new Map(),
      buffered: { stdout: '', stderr: '' },
      bufferedBytes: { stdout: 0, stderr: 0 },
      resultPromise: null,
      resultResolve: () => {},
      resolve,
      reject,
    }
    entry.resultPromise = new Promise((resolve) => {
      resultResolve = resolve
      entry.resultResolve = resolve
    })
    entry.resultResolve = resultResolve
    pending.set(requestId, entry)
    armSilenceTimer(entry)

    if (signal !== undefined) {
      const abort = () => {
        hub.send(computerId, WIRE_EVENT.CANCEL, cancelFrame(requestId))
        failEntry(entry, new HubError('aborted', `computer_exec was aborted while running on '${label}'`))
      }
      if (signal.aborted) {
        abort()
        return { requestId, result: entry.resultPromise, entry }
      }
      entry.onAbort = abort
      signal.addEventListener('abort', abort, { once: true })
    }

    const written = writeFrame(streamRef, WIRE_EVENT.EXEC, execFrame({
      requestId,
      command,
      cwd,
      // The HOST owns the foreground timeout (§11.6.3 promotes instead of
      // killing), so the agent receives its own generous ceiling.
      timeoutMs: agentTimeoutMs ?? timeoutMs,
      shell,
      stream,
    }))
    if (!written) {
      failEntry(entry, new HubError('offline', `computer '${label}' is offline; run computer_list to see what is connected`))
    }
    return { requestId, result: entry.resultPromise, entry }
  }

  const hub = {
    /** Whether a computer currently holds an open SSE stream. */
    isLive: (computerId) => streams.has(computerId),

    /** Presence used everywhere the browser/tools need "online". */
    isOnline(computer) {
      if (computer === null || typeof computer !== 'object') return false
      return streams.has(computer.id)
    },

    /** How many computers are online right now. */
    onlineCount: () => store.read().computers.filter((computer) => hub.isOnline(computer)).length,

    /**
     * Accept a new SSE stream for a computer, replacing any previous one.
     * @param {string} computerId - authenticated computer.
     * @param {string} name - display name for the `hello` event.
     * @param {import('node:http').IncomingMessage} req - request (for close hooks).
     * @param {import('node:http').ServerResponse} res - response to hold open.
     * @param {{ capabilities?: string[] }} [handshake] - metadata to echo in `hello`.
     * @returns {{ replaced: boolean, stream: object }} the opened stream.
     */
    openStream(computerId, name, req, res, handshake = {}) {
      if (disposed) throw new HubError('disposed', 'the dsh-computers host plugin is shutting down')
      const previous = streams.get(computerId)
      let replaced = false
      if (previous !== undefined) {
        replaced = true
        retire(computerId, previous, { end: true })
        failComputerExecs(computerId, new HubError('offline',
          'the computer reconnected and replaced its previous session'))
      }

      res.writeHead(200, SSE_HEADERS)
      if (typeof res.flushHeaders === 'function') res.flushHeaders()
      res.write('retry: 2000\n\n')
      if (typeof res.socket?.setNoDelay === 'function') {
        try {
          res.socket.setNoDelay(true)
        } catch {
          // Socket already gone; the close handler will clean up.
        }
      }

      const stream = { computerId, res, timer: null, openedAt: Date.now() }
      streams.set(computerId, stream)
      const capabilities = Array.isArray(handshake.capabilities) ? handshake.capabilities : ['exec']
      writeFrame(stream, WIRE_EVENT.HELLO, helloFrame({
        computerId,
        name,
        heartbeatMs,
        capabilities,
        // §11.1/§11.5: the agent only uses v2 frames when the host advertises them.
        features: HOST_FEATURES,
      }))

      const onClose = () => {
        if (streams.get(computerId) !== stream) return
        retire(computerId, stream, { end: false })
        failComputerExecs(computerId, new HubError('offline', 'the connection to the computer was lost'))
      }
      res.on('close', onClose)
      res.on('error', onClose)
      req.on('close', () => {
        if (res.writableEnded || res.destroyed) onClose()
      })

      stream.timer = setInterval(() => {
        if (!writeFrame(stream, WIRE_EVENT.PING, pingFrame(Date.now()))) onClose()
      }, heartbeatMs)
      if (typeof stream.timer.unref === 'function') stream.timer.unref()

      return { replaced, stream }
    },

    /**
     * Push one event to a computer's live stream.
     * @returns {boolean} false when the computer has no live stream.
     */
    send(computerId, event, data) {
      const stream = streams.get(computerId)
      if (stream === undefined) return false
      return writeFrame(stream, event, data)
    },

    /** End a computer's live stream and fail its in-flight executions. */
    closeStream(computerId) {
      const stream = streams.get(computerId)
      if (stream === undefined) {
        failComputerExecs(computerId, new HubError('offline', 'the computer was disconnected'))
        return false
      }
      retire(computerId, stream, { end: true })
      failComputerExecs(computerId, new HubError('offline', 'the computer was disconnected'))
      return true
    },

    /**
     * Dispatch one foreground command (v1 shape) through the live stream.
     * @param {object} request - exec request.
     * @returns {Promise<object>} normalized result, or `{ promoted:true, jobId }`.
     */
    async dispatch({ computerId, name, command, cwd = null, timeoutMs, agentTimeoutMs = null, shell = 'sh', signal, stream = true, onTimeout = null }) {
      return await new Promise((resolve, reject) => {
        // Promise executor runs synchronously; beginExecution throws are captured.
        try {
          beginExecution({
            computerId, name, command, cwd, timeoutMs, agentTimeoutMs, shell, signal,
            background: false, stream, onTimeout, resolve, reject,
          })
        } catch (error) {
          reject(error)
        }
      })
    },

    /**
     * Start one background execution immediately (job path, §11.2).
     * @returns {{ requestId: string, result: Promise<object> }} the execution.
     */
    startExecution({ computerId, name, command, cwd = null, timeoutMs = 0, agentTimeoutMs = null, shell = 'sh', job = null }) {
      const handle = beginExecution({
        computerId, name, command, cwd, timeoutMs, agentTimeoutMs, shell,
        background: true, stream: true, job, onTimeout: null,
      })
      return { requestId: handle.requestId, result: handle.result }
    },

    /**
     * Request cancellation of a running execution and settle it locally when
     * the agent does not report a final result in time.
     */
    cancelExecution(computerId, requestId, { settleAfterMs = KILL_SETTLE_MS } = {}) {
      const entry = pending.get(requestId)
      if (entry === undefined || entry.computerId !== computerId) return false
      entry.killed = true
      // R3: remember the cancel so a later final result is classified as a
      // CONFIRMED cancellation instead of "completed".
      entry.cancelRequested = true
      hub.send(computerId, WIRE_EVENT.CANCEL, cancelFrame(requestId))
      if (entry.graceTimer !== null) clearTimeout(entry.graceTimer)
      entry.graceTimer = setTimeout(() => {
        entry.graceTimer = null
        if (!entry.settled) settleKilled(entry)
      }, settleAfterMs)
      if (typeof entry.graceTimer.unref === 'function') entry.graceTimer.unref()
      return true
    },

    /**
     * Apply one streaming frame (§11.2/§11.6.2):
     * `{type:'stdout'|'stderr'|'heartbeat', data(base64), seq}` or the v1.3
     * `{stdout, stderr}` pair. Out-of-order frames are reassembled by seq;
     * duplicates are dropped; heartbeats only reset the silence timer.
     * @returns {boolean} false when the id is unknown/settled or owned elsewhere.
     */
    settleChunk(computerId, payload) {
      const requestId = requestIdOf(payload)
      if (requestId === null) return false
      const entry = pending.get(requestId)
      if (entry === undefined || entry.computerId !== computerId) return false
      const frameType = typeof payload.type === 'string' ? payload.type : ''
      if (frameType === 'heartbeat') {
        armSilenceTimer(entry)
        return true
      }
      const seq = Number.isSafeInteger(payload.seq) && payload.seq >= 0 ? payload.seq : null
      if (seq === null) return false
      if (seq < entry.expectedSeq) return true // duplicate / already assembled
      // A streaming frame revives the execution: heartbeats reset it too, and
      // any real output proves the agent is alive.
      armSilenceTimer(entry)
      if (frameType === 'stdout' || frameType === 'stderr') {
        entry.chunkMap.set(seq, { channel: frameType, text: decodeFrame(payload.data) })
      } else if (payload.stdout !== undefined || payload.stderr !== undefined) {
        // v1.3 chunk shape: one seq carrying both streams.
        entry.chunkMap.set(seq, {
          stdout: typeof payload.stdout === 'string' ? decodeFrame(payload.stdout) : '',
          stderr: typeof payload.stderr === 'string' ? decodeFrame(payload.stderr) : '',
        })
      } else {
        return true
      }
      while (entry.chunkMap.has(entry.expectedSeq)) {
        const frame = entry.chunkMap.get(entry.expectedSeq)
        entry.chunkMap.delete(entry.expectedSeq)
        if (frame.channel !== undefined) appendChunk(entry, frame.channel, frame.text)
        else {
          appendChunk(entry, 'stdout', frame.stdout)
          appendChunk(entry, 'stderr', frame.stderr)
        }
        entry.expectedSeq += 1
      }
      return true
    },

    /**
     * Settle one pending execution from the agent's final result POST.
     * @returns {boolean} false when the id is unknown/settled or owned elsewhere.
     */
    settle(computerId, payload) {
      const requestId = requestIdOf(payload)
      if (requestId === null) return false
      const entry = pending.get(requestId)
      if (entry === undefined || entry.computerId !== computerId) return false
      finish(entry, normalizeResult(entry, payload))
      return true
    },

    /** Pending execution count (diagnostics + smoke assertions). */
    pendingCount: (computerId) => [...pending.values()].filter((entry) => computerId === undefined || entry.computerId === computerId).length,

    /** Fail one computer's executions (delete/disable paths). */
    failComputerExecs,

    /** End every stream and reject every pending execution (plugin disposal). */
    dispose() {
      disposed = true
      for (const computerId of [...streams.keys()]) {
        const stream = streams.get(computerId)
        if (stream !== undefined) retire(computerId, stream, { end: true })
      }
      for (const entry of [...pending.values()]) {
        failEntry(entry, new HubError('disposed', 'the dsh-computers host plugin shut down'))
      }
    },
  }

  return hub
}
