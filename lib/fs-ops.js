/**
 * Remote file-operation plumbing over the existing SSE stream (PROTOCOL §11.3).
 *
 * Host → agent: one `fs` event `{ requestId, op, path, ... }`.
 * Agent → host: `POST /api/dsh-computers/agent/fs/result` with the same
 * `requestId`. No new inbound port, no new connection.
 *
 * Every request settles exactly once: an agent answer, the 15 s timeout, the
 * caller's abort signal, the stream closing, or plugin disposal.
 *
 * Node builtins only.
 */

import { randomBytes } from 'node:crypto'

import { HubError } from './hub.js'

/** Per-request timeout from the protocol. */
export const FS_REQUEST_TIMEOUT_MS = 15_000

/** Supported operations (the agent-side vocabulary). */
export const FS_OPS = Object.freeze(['read', 'write', 'list', 'stat', 'mkdir', 'rename', 'delete', 'glob', 'grep'])

/** Mint one file request id: `fsr_` plus 24 hex characters. */
export function newFsRequestId() {
  return `fsr_${randomBytes(12).toString('hex')}`
}

/**
 * Create the file-operation dispatcher for one plugin mount.
 * @param {object} options - wiring.
 * @param {object} options.hub - SSE hub (`send` + `isLive`).
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 * @returns {object} the dispatcher (`request`, `settle`, `pendingCount`, `dispose`).
 */
export function createFsOps({ hub, onWarn = () => {} }) {
  /** @type {Map<string, object>} */
  const pending = new Map()
  let disposed = false

  /** Detach one request's timers/listeners (idempotent). */
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

  /** Settle one request exactly once. */
  const finish = (entry, error, value) => {
    if (entry.settled) return false
    entry.settled = true
    detach(entry)
    pending.delete(entry.requestId)
    if (error !== undefined) entry.reject(error)
    else entry.resolve(value)
    return true
  }

  return {
    /**
     * Execute one remote file operation.
     * @param {object} request - operation inputs.
     * @param {string} request.computerId - target computer.
     * @param {string} request.name - display name for error messages.
     * @param {string} request.op - one of {@link FS_OPS}.
     * @param {object} request.payload - op-specific fields (`path`, `content`, …).
     * @param {AbortSignal} [request.signal] - caller cancellation.
     * @param {number} [request.timeoutMs] - override timeout.
     * @returns {Promise<object>} the agent's response payload (`ok:true`).
     */
    async request({ computerId, name, op, payload = {}, signal, timeoutMs = FS_REQUEST_TIMEOUT_MS }) {
      if (disposed) throw new HubError('disposed', 'the dsh-computers host plugin is shutting down')
      if (!FS_OPS.includes(op)) throw new HubError('invalid', `unsupported file operation ${JSON.stringify(op)}`)
      if (!hub.isLive(computerId)) {
        throw new HubError('offline', `computer '${name}' is offline; run computer_list to see what is connected`)
      }
      const requestId = newFsRequestId()
      return await new Promise((resolve, reject) => {
        const entry = {
          requestId,
          computerId,
          op,
          signal,
          onAbort: null,
          timer: null,
          settled: false,
          resolve,
          reject,
        }
        pending.set(requestId, entry)
        const done = (error, value) => finish(entry, error, value)

        entry.timer = setTimeout(() => {
          hub.send(computerId, 'cancel', { requestId })
          done(new HubError('timeout', `computer '${name}' did not answer the ${op} request within ${timeoutMs}ms`))
        }, timeoutMs)
        if (typeof entry.timer.unref === 'function') entry.timer.unref()

        if (signal !== undefined) {
          const abort = () => {
            hub.send(computerId, 'cancel', { requestId })
            done(new HubError('aborted', `the ${op} request on '${name}' was aborted`))
          }
          if (signal.aborted) {
            abort()
            return
          }
          entry.onAbort = abort
          signal.addEventListener('abort', abort, { once: true })
        }

        const sent = hub.send(computerId, 'fs', { requestId, op, ...payload })
        if (!sent) done(new HubError('offline', `computer '${name}' is offline; run computer_list to see what is connected`))
      })
    },

    /**
     * Settle one request from the agent's `fs/result` POST.
     * @param {string} computerId - authenticated computer.
     * @param {unknown} body - response payload.
     * @returns {boolean} false when the id is unknown/settled or owned elsewhere.
     */
    settle(computerId, body) {
      const requestId = body !== null && typeof body === 'object' ? body.requestId : undefined
      if (typeof requestId !== 'string') return false
      const entry = pending.get(requestId)
      if (entry === undefined || entry.computerId !== computerId) return false
      if (body.ok !== true) {
        const message = typeof body.error === 'string' && body.error !== '' ? body.error : 'remote file operation failed'
        finish(entry, new Error(`${message} (${entry.op} on '${entry.computerId}')`))
        return true
      }
      finish(entry, undefined, body)
      return true
    },

    /** Pending request count (diagnostics). */
    pendingCount: (computerId) => [...pending.values()].filter((entry) => computerId === undefined || entry.computerId === computerId).length,

    /** Fail every pending request for one computer (stream gone). */
    failComputer(computerId, reason = 'the connection to the computer was lost') {
      for (const entry of [...pending.values()]) {
        if (entry.computerId !== computerId) continue
        onWarn(`dsh-computers: fs request abandoned: ${reason}`)
        finish(entry, new HubError('offline', reason))
      }
    },

    /** Reject every pending request (plugin disposal). */
    dispose() {
      disposed = true
      for (const entry of [...pending.values()]) {
        finish(entry, new HubError('disposed', 'the dsh-computers host plugin shut down'))
      }
    },
  }
}
