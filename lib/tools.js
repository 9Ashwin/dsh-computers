/**
 * The model-facing half of dsh-computers (PROTOCOL §5): `computer_list`,
 * `computer_exec`, and the short system-prompt section that makes the tools
 * discoverable.
 *
 * Tool definitions are registered as raw JSON Schema objects (no
 * `@deepseek-ai/*` imports, so the bundle loads in any profile). Argument
 * validation therefore lives here and produces messages the model can act on.
 *
 * Node builtins only.
 */

import { HubError } from './hub.js'
import { normalizeSessionId } from './selection.js'

/** Hard cap for one rendered tool result (PROTOCOL §5.2: ~20 000 chars). */
const MAX_RENDER_CHARS = 20_000

/** Smallest accepted per-call timeout; below this the shell cannot start. */
const MIN_TIMEOUT_MS = 100

/** Largest accepted per-call timeout (30 minutes). */
const MAX_TIMEOUT_MS = 30 * 60 * 1000

/** Cap on prompt lines / list rows so the context stays small. */
const MAX_LISTED_COMPUTERS = 12

const COMPUTER_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Stable computer id (cmp_...).' },
    name: { type: 'string', description: 'Display name shown in the Computers settings page.' },
    online: { type: 'boolean', description: 'Whether the machine currently holds a live connection.' },
    platformLabel: { type: 'string', description: 'macOS, Linux, Windows or Unknown.' },
    os: { type: 'string', description: 'Node os.platform() value.' },
    hostname: { type: 'string', description: 'Machine hostname as reported at enrollment.' },
    lastSeenAt: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: 'ISO timestamp of the last stream/heartbeat/result (null when unknown).',
    },
    agentVersion: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Version of the agent running on that machine (null when unknown).',
    },
  },
  required: ['id', 'name', 'online', 'platformLabel', 'os', 'hostname', 'lastSeenAt', 'agentVersion'],
  additionalProperties: false,
}

const LIST_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    computers: { type: 'array', items: COMPUTER_ITEM_SCHEMA, description: 'Every enrolled computer, online or not.' },
    selectedComputerId: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Computer pinned for this session (composer target picker), or null.',
    },
  },
  required: ['computers', 'selectedComputerId'],
  additionalProperties: false,
}

const EXEC_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    computer: {
      type: 'string',
      description: 'Optional target: a computer id or name from computer_list (an unambiguous name prefix is accepted). Omit it to use the computer the user pinned in the composer for this session.',
    },
    command: { type: 'string', description: 'Shell command to run on that computer.' },
    cwd: { type: 'string', description: 'Working directory for the command; defaults to the home directory.' },
    timeoutMs: {
      type: 'number',
      description: 'Timeout in milliseconds (defaults to the host exec timeout). The command is cancelled when it expires.',
    },
  },
  required: ['command'],
  additionalProperties: false,
}

const EXEC_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    computer: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id', 'name'],
      additionalProperties: false,
    },
    command: { type: 'string' },
    exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }], description: 'Exit code, or null when the process died by signal.' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    durationMs: { type: 'number' },
    ok: { type: 'boolean' },
    timedOut: { type: 'boolean' },
    truncated: { type: 'boolean' },
  },
  required: ['computer', 'command', 'exitCode', 'stdout', 'stderr', 'durationMs', 'ok', 'timedOut', 'truncated'],
  additionalProperties: false,
}

/** One text block, as every tool renderer returns. */
const textBlock = (text) => [{ type: 'text', text }]

/** Trim one rendered result to the protocol's display budget. */
function boundRender(text) {
  return text.length <= MAX_RENDER_CHARS
    ? text
    : `${text.slice(0, MAX_RENDER_CHARS)}\n… output truncated for display (${text.length - MAX_RENDER_CHARS} more characters)`
}

/**
 * Markdown table for `computer_list`, with the session's pinned target marked
 * by a leading `*` (and named up front, so the model knows what a bare
 * `computer_exec` will hit).
 */
function renderComputerList(value) {
  const computers = Array.isArray(value?.computers) ? value.computers : []
  if (computers.length === 0) {
    return 'No computers are connected yet. Ask the user to open Settings → 电脑 and use “连接电脑”.'
  }
  const selectedId = typeof value?.selectedComputerId === 'string' ? value.selectedComputerId : null
  const selected = selectedId === null ? undefined : computers.find((computer) => computer.id === selectedId)
  const rows = computers.slice(0, MAX_LISTED_COMPUTERS).map((computer) => {
    const status = computer.online === true ? 'online' : 'offline'
    const lastSeen = typeof computer.lastSeenAt === 'string' ? computer.lastSeenAt : '—'
    const name = computer.id === selectedId ? `* ${computer.name}` : computer.name
    return `| ${name} | ${computer.platformLabel} | ${status} | ${lastSeen} |`
  })
  const lines = []
  if (selected !== undefined) {
    lines.push(`Pinned target for this session: **${selected.name}** (\`computer_exec\` without \`computer\` runs here).`, '')
  }
  lines.push('| Name | Platform | Status | Last seen |', '|---|---|---|---|', ...rows)
  const hidden = computers.length - Math.min(computers.length, MAX_LISTED_COMPUTERS)
  let table = lines.join('\n')
  if (hidden > 0) table += `\n… and ${hidden} more (only the first ${MAX_LISTED_COMPUTERS} are shown)`
  if (selected !== undefined) table += `\n\nRows marked * are selected in the composer for this session.`
  return table
}

/** The protocol's `$ command` / status / stdout / stderr layout. */
function renderExec(value) {
  const computer = value?.computer ?? {}
  const status = [
    `exit ${value?.exitCode ?? 'signal'}`,
    `${value?.durationMs ?? 0}ms`,
    computer.name ?? computer.id ?? 'unknown computer',
  ]
  if (value?.timedOut === true) status.push('timed out')
  if (value?.truncated === true) status.push('output truncated')
  const lines = [`$ ${value?.command ?? ''}`, status.join(' · ')]
  const stdout = typeof value?.stdout === 'string' ? value.stdout : ''
  const stderr = typeof value?.stderr === 'string' ? value.stderr : ''
  if (stdout !== '') lines.push('', stdout.replace(/\n+$/, ''))
  if (stderr !== '') lines.push('', 'stderr:', stderr.replace(/\n+$/, ''))
  return boundRender(lines.join('\n'))
}

/**
 * Register the tools and the system-prompt section for one plugin mount.
 * @param {object} options - wiring.
 * @param {object} options.ctx - Cordis context (tools + optional systemPrompt).
 * @param {object} options.config - resolved plugin config.
 * @param {object} options.store - registry store.
 * @param {object} options.hub - SSE/exec hub.
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 */
export function createTools({ ctx, config, store, hub, selections = null, onWarn = () => {} }) {
  /** Resolve `computer` by exact id, exact name, then unique substring. */
  const resolveComputer = (query) => {
    const computers = store.read().computers
    if (computers.length === 0) {
      throw new Error('no computers are connected to this deployment; ask the user to connect one from Settings → 电脑')
    }
    const needle = query.trim()
    const lower = needle.toLowerCase()
    const byId = computers.find((computer) => computer.id === needle)
    if (byId !== undefined) return byId
    const byName = computers.find((computer) => String(computer.name).toLowerCase() === lower)
    if (byName !== undefined) return byName
    const candidates = computers.filter((computer) =>
      String(computer.name).toLowerCase().includes(lower) || String(computer.id).toLowerCase().includes(lower))
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) {
      const names = candidates.map((computer) => `${computer.name} (${computer.id})`).join(', ')
      throw new Error(`computer '${query}' is ambiguous; it matches ${names}. Pass the exact id or name.`)
    }
    const available = computers.map((computer) => `${computer.name} (${computer.id})`).join(', ')
    throw new Error(`no computer matches '${query}'; available computers: ${available}. Run computer_list for details.`)
  }

  /**
   * The caller's session identity.
   *
   * `exec.agent.id` IS the session-backed Agent identity (`SessionId`), and the
   * live runtime face additionally exposes the same value as `agent.session.id`
   * (see core/agent/src/types.ts: `readonly id: SessionId`, "Session-backed
   * Agent identity"). Both are read so a future handle shape cannot silently
   * disable the composer default.
   */
  const sessionIdOf = (exec) => {
    const agent = exec?.agent
    if (agent === undefined || agent === null) return null
    const fromSession = agent.session?.id
    const raw = typeof fromSession === 'string' ? fromSession : agent.id
    return normalizeSessionId(raw)
  }

  /** The session's pinned computer id, but only while that computer exists. */
  const selectedComputerId = (exec) => {
    const sessionId = sessionIdOf(exec)
    if (sessionId === null || selections === null) return null
    const stored = selections.get(sessionId)
    if (stored === null) return null
    return store.read().computers.some((computer) => computer.id === stored) ? stored : null
  }

  /** Explicit argument wins; otherwise the computer pinned in the composer. */
  const resolveTargetComputer = (query, exec) => {
    if (query !== undefined) return resolveComputer(query)
    const selectedId = selectedComputerId(exec)
    if (selectedId === null) {
      throw new Error('no computer selected: pass `computer` (an id or name from computer_list), or pick a target computer in the composer')
    }
    const selected = store.read().computers.find((computer) => computer.id === selectedId)
    if (selected === undefined) {
      throw new Error('the computer selected in the composer no longer exists; run computer_list and pick another target')
    }
    return selected
  }

  /** Validate `computer_exec` arguments into a normalized shape. */
  const validateExecArgs = (args) => {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('computer_exec expects an object with "command"')
    }
    let computer
    if (args.computer !== undefined && args.computer !== null) {
      if (typeof args.computer !== 'string') throw new Error('computer_exec "computer" must be a string when provided')
      const trimmed = args.computer.trim()
      computer = trimmed === '' ? undefined : trimmed
    }
    const command = typeof args.command === 'string' ? args.command : ''
    if (command.trim() === '') throw new Error('computer_exec requires "command": a non-empty shell command')
    let cwd = null
    if (args.cwd !== undefined && args.cwd !== null) {
      if (typeof args.cwd !== 'string') throw new Error('computer_exec "cwd" must be a string')
      cwd = args.cwd.trim() === '' ? null : args.cwd
    }
    let requestedTimeout = null
    if (args.timeoutMs !== undefined && args.timeoutMs !== null) {
      if (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs)) {
        throw new Error('computer_exec "timeoutMs" must be a finite number of milliseconds')
      }
      requestedTimeout = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(args.timeoutMs)))
    }
    return { computer, command, cwd, timeoutMs: requestedTimeout ?? config.execTimeoutMs }
  }

  /** Map a hub failure onto actionable model-facing text (PROTOCOL §5.2). */
  const actionable = (error, computer, timeoutMs) => {
    if (error instanceof HubError) {
      switch (error.code) {
        case 'offline':
          return new Error(`computer '${computer.name}' is offline; run computer_list to see which computers are connected, and ask the user to wake or reconnect it`)
        case 'timeout':
          return new Error(`computer '${computer.name}' did not finish within ${timeoutMs}ms; the command was cancelled. Retry with a larger timeoutMs, or run a shorter command`)
        case 'aborted':
          return new Error(`computer_exec on '${computer.name}' was aborted by the caller, and the command was cancelled on that machine`)
        case 'disposed':
          return new Error('the dsh-computers host plugin is shutting down; try again in a moment')
        default:
          return error
      }
    }
    return error instanceof Error ? error : new Error(String(error))
  }

  // Each registration is wrapped in its own effect: the tool registry also
  // owns it, but an explicit effect makes the reload path deterministic.
  ctx.effect(() => ctx.tools.register({
    name: 'computer_list',
    description: 'List the computers connected to this DSH Web deployment (the user\'s own machines), with their platform, online state and last-seen time. Call this before computer_exec to get a valid computer id or name.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: LIST_OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(renderComputerList(value)),
    },
    async execute(_args, exec) {
      const selectedId = selectedComputerId(exec)
      const computers = store.read().computers.map((computer) => ({
        id: computer.id,
        name: computer.name,
        online: hub.isOnline(computer),
        platformLabel: computer.platformLabel ?? 'Unknown',
        os: computer.os ?? 'unknown',
        hostname: computer.hostname ?? '',
        lastSeenAt: typeof computer.lastSeenAt === 'string' ? computer.lastSeenAt : null,
        agentVersion: typeof computer.agentVersion === 'string' ? computer.agentVersion : null,
      }))
      return { computers, selectedComputerId: selectedId }
    },
  }), 'dsh-computers: computer_list tool')

  ctx.effect(() => ctx.tools.register({
    name: 'computer_exec',
    description: 'Run one shell command on one of the user\'s connected computers and return its exit code, stdout and stderr. The command runs in that machine\'s own shell (POSIX `sh -lc` on macOS/Linux, `cmd.exe` on Windows); there is no streaming, and the output is capped by the host. The machine must be online — call computer_list first.',
    parameters: EXEC_PARAMETERS_SCHEMA,
    output: {
      schema: EXEC_OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(renderExec(value)),
    },
    async execute(args, exec) {
      if (config.execEnabled !== true) {
        throw new Error('computer_exec is disabled on this host (dsh-computers config execEnabled: false)')
      }
      const input = validateExecArgs(args)
      const computer = resolveTargetComputer(input.computer, exec)
      if (!hub.isOnline(computer)) {
        throw new Error(`computer '${computer.name}' is offline; run computer_list to see which computers are connected, and ask the user to wake or reconnect it`)
      }
      let result
      try {
        result = await hub.dispatch({
          computerId: computer.id,
          name: computer.name,
          command: input.command,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          signal: exec?.signal,
        })
      } catch (error) {
        throw actionable(error, computer, input.timeoutMs)
      }
      return {
        computer: { id: computer.id, name: computer.name },
        command: input.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        ok: result.ok === true && result.timedOut !== true,
        timedOut: result.timedOut === true,
        truncated: result.truncated === true,
      }
    },
  }), 'dsh-computers: computer_exec tool')

  // ---------------------------------------------------------------------------
  // System prompt section (PROTOCOL §5.3)
  // ---------------------------------------------------------------------------
  // `systemPrompt` is not in `inject` (it is optional for this plugin), so it
  // is looked up defensively; a host without it keeps working unchanged.
  try {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.section === 'function') {
      // The nearest centrally allocated slot is COMPUTER_USE; fall back to its
      // numeric value when the host's table predates that name.
      let order = 3000
      try {
        const resolved = typeof systemPrompt.getSectionOrder === 'function'
          ? systemPrompt.getSectionOrder('TOOL_COMPUTER_USE')
          : undefined
        if (Number.isFinite(resolved)) order = resolved
      } catch {
        // Unknown placement name: keep the numeric fallback.
      }
      // Wrapped in an effect: a plugin reload must remove the old section, or
      // the duplicate name 'computers' throws and the section silently vanishes.
      ctx.effect(() => systemPrompt.section({
        name: 'computers',
        order,
        text: () => {
          const computers = store.read().computers
          if (computers.length === 0) return ''
          const lines = [
            'You can run shell commands on the user\'s connected computers with `computer_exec`.',
            'Call `computer_list` to see their ids, names and online state.',
            'The user can pin a target computer in the composer; `computer_exec` without a `computer` argument runs on that pinned computer.',
          ]
          for (const computer of computers.slice(0, MAX_LISTED_COMPUTERS)) {
            const state = hub.isOnline(computer) ? 'online' : 'offline'
            lines.push(`- ${computer.name} (${computer.platformLabel ?? 'Unknown'}, ${state})`)
          }
          return lines.join('\n')
        },
      }), 'dsh-computers: prompt section')
    }
  } catch (error) {
    onWarn(`dsh-computers: could not register the system prompt section: ${error && error.message ? error.message : error}`)
  }
}
