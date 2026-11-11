/**
 * The live side of dsh-computers: one SSE stream per computer and the exec
 * dispatcher that rides it (PROTOCOL §3.2, §3.3, §5.2).
 *
 * Invariants this file keeps:
 * - at most one stream per computer; opening a new one ends the old one and
 *   fails the old agent's in-flight executions;
 * - `online` is the live stream and nothing else; `lastSeenAt` is display data
 *   refreshed by stream open / heartbeat / result POST;
 * - every exec has a unique `req_…` id, every promise settles exactly once —
 *   a result POST, the timeout, the abort signal, the stream closing or the
 *   plugin disposing;
 * - a late result for an already settled id is not accepted (the route answers
 *   404).
 *
 * Node builtins only.
 */

import { newRequestId } from './keys.js'

/** Failure carrying a machine-readable code the tool layer maps to a message. */
export class HubError extends Error {
  /**
   * @param {string} code - `offline` | `timeout` | `aborted` | `disposed`.
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
  // A multi-byte character split at the boundary decodes to U+FFFD; drop only
  // the trailing replacement characters this slice may have produced.
  while (out.endsWith('\uFFFD')) out = out.slice(0, -1)
  return { text: `${out}\n[output truncated]`, truncated: true }
}

/**
 * Create the hub for one plugin mount.
 * @param {object} options - hub options.
 * @param {object} options.store - registry store (presence timestamps).
 * @param {number} options.heartbeatMs - SSE ping cadence reported to the agent.
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

  /** Detach one pending execution's timer and abort listener (idempotent). */
  const detach = (entry) => {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.signal !== undefined && entry.onAbort !== null) {
      entry.signal.removeEventListener('abort', entry.onAbort)
      entry.onAbort = null
    }
  }

  /** Reject one entry exactly once. */
  const failEntry = (entry, error) => {
    if (entry.settled) return
    entry.settled = true
    detach(entry)
    pending.delete(entry.requestId)
    entry.reject(error)
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

  const hub = {
    /** Whether a computer currently holds an open SSE stream. */
    isLive: (computerId) => streams.has(computerId),

    /**
     * Presence is the live SSE stream and nothing else.
     *
     * `lastSeenAt` is still refreshed by stream open / heartbeat / result POST
     * and is shown in the UI, but a heartbeat without a stream must NOT read
     * as online: the settings page polls every 5 s, so a machine that died
     * while its heartbeat timestamp is still warm would show "在线" for up to
     * 2x heartbeatMs. (PROTOCOL.md §2 still describes that older fallback; the
     * live behaviour is stream-only and the protocol is being updated.)
     * @param {object} computer - registry record.
     * @returns {boolean} whether the computer holds an open stream.
     */
    isOnline(computer) {
      if (computer === null || typeof computer !== 'object') return false
      return streams.has(computer.id)
    },

    /** How many computers are online right now. */
    onlineCount: () => store.read().computers.filter((computer) => hub.isOnline(computer)).length,

    /**
     * Accept a new SSE stream for a computer, replacing any previous one.
     * The caller owns authentication and `lastSeenAt`; the hub owns framing.
     * @param {string} computerId - authenticated computer.
     * @param {string} name - display name for the `hello` event.
     * @param {import('node:http').IncomingMessage} req - request (for close hooks).
     * @param {import('node:http').ServerResponse} res - response to hold open.
     * @returns {{ replaced: boolean, stream: object }} the opened stream.
     */
    openStream(computerId, name, req, res) {
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
      // Flush headers immediately: an agent must see the stream accepted
      // before it decides the connection failed.
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
      writeFrame(stream, 'hello', { computerId, name, heartbeatMs })

      const onClose = () => {
        // Only the CURRENT stream owns the computer's liveness.
        if (streams.get(computerId) !== stream) return
        retire(computerId, stream, { end: false })
        failComputerExecs(computerId, new HubError('offline', 'the connection to the computer was lost'))
      }
      res.on('close', onClose)
      res.on('error', onClose)
      req.on('close', () => {
        // The agent may close the request side without the response side
        // reporting it promptly on every platform.
        if (res.writableEnded || res.destroyed) onClose()
      })

      stream.timer = setInterval(() => {
        if (!writeFrame(stream, 'ping', { t: Date.now() })) onClose()
      }, heartbeatMs)
      // Pings must not keep a shutting-down process alive.
      if (typeof stream.timer.unref === 'function') stream.timer.unref()

      return { replaced, stream }
    },

    /**
     * Push one event to a computer's live stream.
     * @param {string} computerId - target computer.
     * @param {string} event - SSE event name.
     * @param {unknown} data - JSON payload.
     * @returns {boolean} false when the computer has no live stream.
     */
    send(computerId, event, data) {
      const stream = streams.get(computerId)
      if (stream === undefined) return false
      return writeFrame(stream, event, data)
    },

    /**
     * End a computer's live stream and fail its in-flight executions.
     * @param {string} computerId - target computer.
     * @returns {boolean} whether a stream was open.
     */
    closeStream(computerId) {
      const stream = streams.get(computerId)
      if (stream === undefined) {
        // Still fail executions: the HTTP side may already be gone.
        failComputerExecs(computerId, new HubError('offline', 'the computer was disconnected'))
        return false
      }
      retire(computerId, stream, { end: true })
      failComputerExecs(computerId, new HubError('offline', 'the computer was disconnected'))
      return true
    },

    /**
     * Dispatch one command through the computer's live stream.
     * @param {object} request - exec request.
     * @param {string} request.computerId - target computer.
     * @param {string} request.name - display name used in error messages.
     * @param {string} request.command - shell command.
     * @param {string | null} [request.cwd] - working directory or null.
     * @param {number} request.timeoutMs - settlement deadline.
     * @param {string} [request.shell] - shell hint for the agent.
     * @param {AbortSignal | undefined} [request.signal] - caller cancellation.
     * @returns {Promise<object>} normalized result when the agent answers.
     */
    async dispatch({ computerId, name, command, cwd = null, timeoutMs, shell = 'sh', signal }) {
      const label = typeof name === 'string' && name !== '' ? name : computerId
      if (disposed) throw new HubError('disposed', 'the dsh-computers host plugin is shutting down')
      if (!streams.has(computerId)) {
        throw new HubError('offline', `computer '${label}' is offline; run computer_list to see what is connected`)
      }
      if (typeof command !== 'string' || command.trim() === '') {
        throw new HubError('invalid', 'command must be a non-empty string')
      }
      const stream = streams.get(computerId)
      if (stream === undefined) {
        throw new HubError('offline', `computer '${label}' is offline; run computer_list to see what is connected`)
      }
      const requestId = newRequestId()
      return await new Promise((resolve, reject) => {
        const entry = {
          requestId,
          computerId,
          command,
          startedAt: Date.now(),
          signal,
          onAbort: null,
          timer: null,
          settled: false,
          resolve,
          reject,
        }
        pending.set(requestId, entry)

        // NOT unref'd: an in-flight execution must settle even if it is the
        // only work left in the process.
        entry.timer = setTimeout(() => {
          // Tell the agent to kill the process group before settling, so a
          // timed-out command does not keep eating the user's computer.
          hub.send(computerId, 'cancel', { requestId })
          failEntry(entry, new HubError('timeout',
            `computer '${label}' did not answer within ${timeoutMs}ms (the command was cancelled)`))
        }, timeoutMs)

        if (signal !== undefined) {
          const abort = () => {
            hub.send(computerId, 'cancel', { requestId })
            failEntry(entry, new HubError('aborted', `computer_exec was aborted while running on '${label}'`))
          }
          if (signal.aborted) {
            abort()
            return
          }
          entry.onAbort = abort
          signal.addEventListener('abort', abort, { once: true })
        }

        const written = writeFrame(stream, 'exec', {
          requestId,
          command,
          cwd: cwd ?? null,
          timeoutMs,
          shell,
        })
        if (!written) {
          failEntry(entry, new HubError('offline', `computer '${label}' is offline; run computer_list to see what is connected`))
        }
      })
    },

    /**
     * Settle one pending execution from the agent's result POST.
     * @param {string} computerId - authenticated computer.
     * @param {unknown} payload - result body from the agent.
     * @returns {boolean} false when the id is unknown/settled or owned elsewhere.
     */
    settle(computerId, payload) {
      const requestId = payload !== null && typeof payload === 'object' ? payload.requestId : undefined
      if (typeof requestId !== 'string') return false
      const entry = pending.get(requestId)
      if (entry === undefined || entry.computerId !== computerId) return false
      entry.settled = true
      detach(entry)
      pending.delete(requestId)

      const stdout = capText(typeof payload.stdout === 'string' ? payload.stdout : '', maxOutputBytes)
      const stderr = capText(typeof payload.stderr === 'string' ? payload.stderr : '', maxOutputBytes)
      const exitCode = typeof payload.exitCode === 'number' && Number.isFinite(payload.exitCode)
        ? Math.trunc(payload.exitCode)
        : null
      const duration = typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs) && payload.durationMs >= 0
        ? Math.trunc(payload.durationMs)
        : Date.now() - entry.startedAt
      entry.resolve({
        requestId,
        ok: payload.ok === true,
        exitCode,
        signal: typeof payload.signal === 'string' ? payload.signal : null,
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: duration,
        truncated: payload.truncated === true || stdout.truncated || stderr.truncated,
        timedOut: payload.timedOut === true,
        error: typeof payload.error === 'string' ? payload.error : null,
      })
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
