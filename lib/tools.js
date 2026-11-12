/**
 * The model-facing half of dsh-computers (PROTOCOL §5, §11.1, §11.2, §11.3).
 *
 * Tools: `computer_list`, `computer_exec` (foreground, background job, or
 * timeout-promoted job), and the remote file tools `computer_read`,
 * `computer_write`, `computer_edit`, `computer_glob`, `computer_grep`.
 *
 * Every tool resolves the same target: explicit `computer` argument → the
 * session pin → an actionable error, then applies the same gates in the same
 * order (activation, agent version, capability, access, presence).
 *
 * Tool definitions are raw JSON Schema objects (no `@deepseek-ai/*` imports,
 * so the bundle loads in any profile), therefore argument validation lives
 * here and produces messages the model can act on.
 *
 * Node builtins only.
 */

import { DISPOSITION, ERROR_CODES, EXECUTION_STATUS, JOB_STATUS } from './contracts.js'
import { HubError } from './hub.js'
import { assertToolsExhaustive, capsOf, createPolicy } from './policy.js'
import { normalizeSessionId } from './selection.js'
import { versionAtLeast, versionsDiffer } from './version.js'

/** Hard cap for one rendered tool result (~20 000 chars, PROTOCOL §5.2). */
const MAX_RENDER_CHARS = 20_000

/** Smallest accepted per-call timeout; below this the shell cannot start. */
const MIN_TIMEOUT_MS = 100

/** Largest accepted per-call foreground timeout (30 minutes). */
const MAX_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Timeout sent to the agent for every v2 execution. The HOST owns the
 * foreground timeout (§11.6.3 promotes instead of killing), so the agent must
 * not self-kill at the foreground deadline; 24 h is the agent's own cap.
 */
const AGENT_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** Cap on prompt lines / list rows so the context stays small. */
const MAX_LISTED_COMPUTERS = 12

const COMPUTER_REF_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, name: { type: 'string' } },
  required: ['id', 'name'],
  additionalProperties: false,
}

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
    capabilities: {
      type: 'array',
      items: { type: 'string' },
      description: 'Agent capabilities: exec, fs, pty.',
    },
    mode: {
      type: 'string',
      description: 'How the agent runs on that machine: \'embedded\' (DSH plugin runtime) or \'service\' (standalone agent install).',
    },
    caps: {
      type: 'object',
      description: 'Feature flags reported by the agent (R2): exec, fs, jobs, pty, tunnel.',
      properties: {
        exec: { type: 'boolean' },
        fs: { type: 'boolean' },
        jobs: { type: 'boolean' },
        pty: { type: 'boolean' },
        tunnel: { type: 'boolean' },
      },
      required: ['exec', 'fs', 'jobs', 'pty', 'tunnel'],
      additionalProperties: false,
    },
    drift: {
      type: 'boolean',
      description: 'True when the agent version differs from this host plugin version.',
    },
    updateRequired: {
      type: 'boolean',
      description: 'True when the agent is older than the configured minimum and must be upgraded.',
    },
  },
  required: ['id', 'name', 'online', 'platformLabel', 'os', 'hostname', 'lastSeenAt', 'agentVersion', 'capabilities', 'caps', 'mode', 'drift', 'updateRequired'],
  additionalProperties: false,
}

const LIST_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    computers: { type: 'array', items: COMPUTER_ITEM_SCHEMA, description: 'Every activated computer this conversation may use.' },
    selectedComputerId: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Computer pinned for this session (composer target picker), or null.',
    },
    hiddenComputerCount: {
      type: 'number',
      description: 'Connected computers this conversation may not use (access-controlled), omitted from the list.',
    },
  },
  required: ['computers', 'selectedComputerId', 'hiddenComputerCount'],
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
    cwd: { type: 'string', description: 'Working directory; defaults to the computer\'s reported workspace base (usually the home directory).' },
    timeoutMs: {
      type: 'number',
      description: 'Foreground timeout in milliseconds (defaults to the host exec timeout). When it expires the host promotes the command to a background job instead of killing it.',
    },
    run_in_background: {
      type: 'boolean',
      description: 'Return a job id immediately and keep the command running; read it with job_output and stop it with job_kill.',
    },
  },
  required: ['command'],
  additionalProperties: false,
}

const TERMINAL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['completed', 'failed', 'cancelled', 'timeout'] },
    disposition: { type: 'string', enum: ['reusable', 'broken'] },
    confirmed: { type: 'boolean', description: 'false when a stop was requested but the agent never confirmed it.' },
    exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['status', 'disposition', 'confirmed', 'exitCode', 'signal', 'error'],
  additionalProperties: false,
}

const EXEC_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        computer: COMPUTER_REF_SCHEMA,
        command: { type: 'string' },
        exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }], description: 'Exit code, or null when the process died by signal.' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        durationMs: { type: 'number' },
        ok: { type: 'boolean' },
        timedOut: { type: 'boolean' },
        truncated: { type: 'boolean' },
        terminal: TERMINAL_SCHEMA,
      },
      required: ['computer', 'command', 'exitCode', 'stdout', 'stderr', 'durationMs', 'ok', 'timedOut', 'truncated'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        computer: COMPUTER_REF_SCHEMA,
        command: { type: 'string' },
        jobId: { type: 'string', description: 'DSH job id: read it with job_output, stop it with job_kill.' },
        promoted: { type: 'boolean', description: 'True when a foreground timeout was adopted as a background job.' },
        started: { type: 'boolean', description: 'True when the command was started explicitly in the background.' },
      },
      required: ['computer', 'command', 'jobId'],
      additionalProperties: false,
    },
  ],
}

/** Shared parameter fragment: optional computer target. */
const OPTIONAL_COMPUTER_ARG = {
  type: 'string',
  description: 'Optional target: a computer id or name from computer_list. Omit it to use the computer pinned in the composer.',
}

const FS_OUTPUT_COMPUTER = COMPUTER_REF_SCHEMA

const READ_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    computer: OPTIONAL_COMPUTER_ARG,
    path: { type: 'string', description: 'Absolute path of the file to read on that computer.' },
    offset: { type: 'number', description: '0-based line offset to start from (default 0).' },
    limit: { type: 'number', description: 'Maximum number of lines to return (default 2000, max 20000).' },
  },
  required: ['path'],
  additionalProperties: false,
}

const READ_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    computer: FS_OUTPUT_COMPUTER,
    path: { type: 'string' },
    text: { type: 'string' },
    lines: { type: 'number' },
    bytes: { type: 'number' },
    truncated: { type: 'boolean' },
  },
  required: ['computer', 'path', 'text', 'lines', 'bytes', 'truncated'],
  additionalProperties: false,
}

const WRITE_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    computer: OPTIONAL_COMPUTER_ARG,
    path: { type: 'string', description: 'Absolute path of the file to write on that computer.' },
    content: { type: 'string', description: 'Full UTF-8 file content.' },
    createDirs: { type: 'boolean', description: 'Create parent directories when missing.' },
  },
  required: ['path', 'content'],
  additionalProperties: false,
}

const WRITE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    computer: FS_OUTPUT_COMPUTER,
    path: { type: 'string' },
    bytes: { type: 'number' },
    created: { type: 'boolean' },
  },
  required: ['computer', 'path', 'bytes', 'created'],
  additionalProperties: false,
}

const EDIT_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    computer: OPTIONAL_COMPUTER_ARG,
    path: { type: 'string', description: 'Absolute path of the file to edit on that computer.' },
    old: { type: 'string', description: 'Exact text to replace; must be unique unless replaceAll is true.' },
    new: { type: 'string', description: 'Replacement text.' },
    replaceAll: { type: 'boolean', description: 'Replace every occurrence of `old`.' },
  },
  required: ['path', 'old', 'new'],
  additionalProperties: false,
}

const EDIT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    computer: FS_OUTPUT_COMPUTER,
    path: { type: 'string' },
    replacements: { type: 'number' },
    bytes: { type: 'number' },
  },
  required: ['computer', 'path', 'replacements', 'bytes'],
  additionalProperties: false,
}

const GLOB_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    computer: OPTIONAL_COMPUTER_ARG,
    pattern: { type: 'string', description: 'Glob pattern, for example "**/*.ts".' },
    cwd: { type: 'string', description: 'Base directory; defaults to the computer\'s workspace base.' },
  },
  required: ['pattern'],
  additionalProperties: false,
}

const GLOB_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    computer: FS_OUTPUT_COMPUTER,
    paths: { type: 'array', items: { type: 'string' } },
  },
  required: ['computer', 'paths'],
  additionalProperties: false,
}

const GREP_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    computer: OPTIONAL_COMPUTER_ARG,
    pattern: { type: 'string', description: 'Regular expression to search for.' },
    path: { type: 'string', description: 'File or directory to search; defaults to the workspace base.' },
    include: { type: 'string', description: 'Only search files whose relative path matches this glob.' },
    maxMatches: { type: 'number', description: 'Maximum number of matches to return (default 500).' },
  },
  required: ['pattern'],
  additionalProperties: false,
}

const GREP_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    computer: FS_OUTPUT_COMPUTER,
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['path', 'line', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['computer', 'matches'],
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

/** Markdown table for `computer_list`. */
function renderComputerList(value) {
  const computers = Array.isArray(value?.computers) ? value.computers : []
  if (computers.length === 0) {
    if (typeof value?.hiddenComputerCount === 'number' && value.hiddenComputerCount > 0) {
      return `${value.hiddenComputerCount} computer(s) are connected but this conversation may not use any of them. `
        + 'Ask the user to grant access in 管理访问权 (Access management) for this conversation.'
    }
    return 'No computers are connected yet. Ask the user to open Settings → 电脑 and use “连接电脑”.'
  }
  const selectedId = typeof value?.selectedComputerId === 'string' ? value.selectedComputerId : null
  const selected = selectedId === null ? undefined : computers.find((computer) => computer.id === selectedId)
  const rows = computers.slice(0, MAX_LISTED_COMPUTERS).map((computer) => {
    const status = computer.online === true ? 'online' : 'offline'
    const lastSeen = typeof computer.lastSeenAt === 'string' ? computer.lastSeenAt : '—'
    const name = `${computer.id === selectedId ? '* ' : ''}${computer.name}`
    const notes = []
    if (typeof computer.agentVersion === 'string') notes.push(`agent ${computer.agentVersion}`)
    if (computer.updateRequired === true) notes.push('UPDATE REQUIRED')
    else if (computer.drift === true) notes.push('drift')
    if (Array.isArray(computer.capabilities) && computer.capabilities.length > 0) notes.push(computer.capabilities.join(','))
    return `| ${name} | ${computer.platformLabel} | ${status} | ${notes.join(' · ')} | ${lastSeen} |`
  })
  const lines = []
  if (selected !== undefined) {
    lines.push(`Pinned target for this session: **${selected.name}** (\`computer_exec\` without \`computer\` runs here).`, '')
  }
  lines.push('| Name | Platform | Status | Agent | Last seen |', '|---|---|---|---|---|', ...rows)
  const hidden = computers.length - Math.min(computers.length, MAX_LISTED_COMPUTERS)
  let table = lines.join('\n')
  if (hidden > 0) table += `\n… and ${hidden} more (only the first ${MAX_LISTED_COMPUTERS} are shown)`
  if (selected !== undefined) table += '\n\nRows marked * are selected in the composer for this session.'
  return table
}

/** The protocol's `$ command` / status / stdout / stderr layout. */
function renderExec(value) {
  const computer = value?.computer ?? {}
  if (typeof value?.jobId === 'string') {
    const how = value.promoted === true ? 'promoted a timed-out foreground command to background job' : 'started background job'
    return boundRender([
      `$ ${value?.command ?? ''}`,
      `${how} ${value.jobId} on ${computer.name ?? computer.id ?? 'unknown computer'}`,
      'Use job_output to read its output and job_kill to stop it.',
    ].join('\n'))
  }
  const status = [
    `exit ${value?.exitCode ?? 'signal'}`,
    `${value?.durationMs ?? 0}ms`,
    computer.name ?? computer.id ?? 'unknown computer',
  ]
  if (value?.timedOut === true) status.push('timed out')
  if (value?.truncated === true) status.push('output truncated')
  const lines = [`$ ${value?.command ?? ''}`, status.join(' · ')]
  // R3: surface the typed terminal state when it is not a clean completion.
  const terminal = value?.terminal
  if (terminal !== null && terminal !== undefined && (terminal.status !== 'completed' || terminal.disposition === 'broken')) {
    const bits = [terminal.status]
    if (terminal.status === 'cancelled' || terminal.status === 'timeout') {
      bits.push(terminal.confirmed === true ? 'confirmed' : 'NOT confirmed')
    }
    if (terminal.disposition === 'broken') bits.push('broken — the command may still be running on the machine')
    lines.push(`status: ${bits.join(' · ')}`)
  }
  const stdout = typeof value?.stdout === 'string' ? value.stdout : ''
  const stderr = typeof value?.stderr === 'string' ? value.stderr : ''
  if (stdout !== '') lines.push('', stdout.replace(/\n+$/, ''))
  if (stderr !== '') lines.push('', 'stderr:', stderr.replace(/\n+$/, ''))
  return boundRender(lines.join('\n'))
}

/** Numbered file content, in the built-in `read` tool's style. */
function renderRead(value) {
  const text = typeof value?.text === 'string' ? value.text : ''
  const header = `${value?.path ?? ''} (${value?.lines ?? 0} lines, ${value?.bytes ?? 0} bytes${value?.truncated === true ? ', truncated' : ''})`
  const numbered = text.split('\n').map((line, index) => `${String(index + 1).padStart(6, ' ')}\t${line}`).join('\n')
  return boundRender(`${header}\n\n${numbered}`)
}

/** Built-in-style write/edit/glob/grep renders. */
function renderWrite(value) {
  return `${value?.created === true ? 'Created' : 'Wrote'} ${value?.bytes ?? 0} bytes to ${value?.path ?? ''} on ${value?.computer?.name ?? 'the computer'}`
}

function renderEdit(value) {
  return `Applied ${value?.replacements ?? 0} replacement(s) to ${value?.path ?? ''} (${value?.bytes ?? 0} bytes) on ${value?.computer?.name ?? 'the computer'}`
}

function renderGlob(value) {
  const paths = Array.isArray(value?.paths) ? value.paths : []
  if (paths.length === 0) return 'No matching files.'
  return boundRender(`Found ${paths.length} path(s) on ${value?.computer?.name ?? 'the computer'}:\n${paths.join('\n')}`)
}

function renderGrep(value) {
  const matches = Array.isArray(value?.matches) ? value.matches : []
  if (matches.length === 0) return 'No matches.'
  return boundRender(`${matches.length} match(es) on ${value?.computer?.name ?? 'the computer'}:\n`
    + matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n'))
}

/** Outcome mapping for a DSH job fed by a remote execution. */
/**
 * Map a hub execution result to the DSH job outcome (R3). The typed terminal
 * object is handed through as the job's `result`, so job_output/job_kill surface
 * the same status/disposition the tool render uses.
 */
const jobOutcome = (result) => {
  const terminal = result?.terminal
  if (terminal !== undefined && terminal !== null) {
    if (terminal.status === EXECUTION_STATUS.CANCELLED) {
      const confirmed = terminal.confirmed === true
      return {
        status: JOB_STATUS.KILLED,
        detail: confirmed
          ? `cancelled (confirmed${terminal.signal ? ` · ${terminal.signal}` : ''})`
          : 'cancelled (NOT confirmed — the command may still be running)',
        result: terminal,
      }
    }
    if (terminal.status === EXECUTION_STATUS.COMPLETED) {
      return {
        status: JOB_STATUS.COMPLETED,
        detail: `exit ${terminal.exitCode ?? 0}${result.truncated === true ? ', output truncated' : ''}`,
        result: terminal,
      }
    }
    const broken = terminal.disposition === DISPOSITION.BROKEN
    return {
      status: JOB_STATUS.FAILED,
      detail: `${terminal.status}${broken ? ' (broken: state unknown)' : ''}: ${terminal.error ?? `exit ${terminal.exitCode ?? terminal.signal ?? '?'}`}`,
      result: terminal,
    }
  }
  // Defensive fallback for a hub result without a terminal object.
  if (result.killed === true) return { status: JOB_STATUS.KILLED, detail: 'cancelled' }
  if (result.ok === true && result.timedOut !== true) {
    return { status: JOB_STATUS.COMPLETED, detail: `exit ${result.exitCode ?? 0}${result.truncated === true ? ', output truncated' : ''}` }
  }
  return { status: JOB_STATUS.FAILED, detail: result.error ?? `exit ${result.exitCode ?? result.signal ?? '?'}` }
}

/** Absolute POSIX or Windows path? (the agent requires absolute paths). */
const isAbsolutePath = (value) => typeof value === 'string' && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value.trim())

/**
 * Register the tools and the system-prompt section for one plugin mount.
 * @param {object} options - wiring.
 * @param {object} options.ctx - Cordis context (tools, systemPrompt, jobs).
 * @param {object} options.config - resolved plugin config.
 * @param {object} options.store - registry store.
 * @param {object} options.hub - SSE/exec hub.
 * @param {object} options.selections - per-session selection store.
 * @param {object} options.access - access control.
 * @param {object} options.fsOps - remote file dispatcher.
 * @param {string} options.version - plugin version (drift baseline).
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 */
export function createTools({
  ctx, config, store, hub, selections = null, access = null, fsOps = null, version = '1.0.0', onWarn = () => {},
}) {
  /** Live `jobs` service, when the composition has one. */
  const jobsOf = () => {
    try {
      const service = ctx.get('jobs')
      return service === undefined || service === null ? undefined : service
    } catch {
      return undefined
    }
  }

  /** §11.6.4: only activated computers exist for tools. */
  const visibleComputers = () => store.read().computers.filter((computer) => typeof computer.activatedAt === 'string')

  /** Agent capabilities; a v1 agent reports none and is exec-only. */
  const capabilitiesOf = (computer) => (Array.isArray(computer.capabilities) && computer.capabilities.length > 0
    ? computer.capabilities
    : ['exec'])

  /** The computer's reported default working directory. */
  const workspaceBaseOf = (computer) => (typeof computer.workspaceBase === 'string' && computer.workspaceBase !== ''
    ? computer.workspaceBase
    : null)

  /** How the agent runs there: an embedded plugin runtime or a service install. */
  const modeOf = (computer) => (computer.mode === 'embedded' ? 'embedded' : 'service')

  /** Resolve `computer` by exact id, exact name, then unique substring (activated only). */
  const resolveComputer = (query) => {
    const computers = visibleComputers()
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

  /** The caller's session identity (`exec.agent.id` / `agent.session.id`). */
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
    return visibleComputers().some((computer) => computer.id === stored) ? stored : null
  }

  /** The Agent preset id that owns this tool call (`default` when unknown). */
  const presetIdOf = (exec) => (access === null ? 'default' : access.presetIdForAgent(exec?.agent))

  /** The caller identity passed to the permission authority. */
  const callerOf = (exec) => ({ sessionId: sessionIdOf(exec), presetId: presetIdOf(exec) })

  /**
   * R4: the single permission authority. Every tool call goes through
   * authorize(); nothing else in this file decides capability, ACL, version or
   * presence. See lib/policy.js for the frozen operation table.
   */
  const policy = createPolicy({
    config,
    isOnline: (computer) => hub.isOnline(computer),
    hasJobs: () => jobsOf() !== undefined,
  })

  /** Turn a deny decision into the thrown tool error (code kept for tests). */
  const denialError = (decision) => {
    const error = new Error(decision.reason)
    error.code = decision.code
    return error
  }

  /** Authorize one operation or throw its actionable denial. */
  const authorizeOp = (computer, operation, caller) => {
    const decision = policy.authorize({ computer, operation, session: caller, access })
    if (!decision.allowed) throw denialError(decision)
    return decision
  }

  /** The computers a caller may list (denied ones are silently dropped). */
  const authorizedComputers = (computers, operation, session) =>
    policy.filterAuthorized(computers, { operation, session, access })

  /** Explicit argument wins; otherwise the computer pinned in the composer. */
  const resolveTargetComputer = (query, exec) => {
    if (query !== undefined) return resolveComputer(query)
    const selectedId = selectedComputerId(exec)
    if (selectedId === null) {
      throw new Error('no computer selected: pass `computer` (an id or name from computer_list), or pick a target computer in the composer')
    }
    const selected = visibleComputers().find((computer) => computer.id === selectedId)
    if (selected === undefined) {
      throw new Error('the computer selected in the composer no longer exists; run computer_list and pick another target')
    }
    return selected
  }

  /** Map a hub/fs failure onto actionable model-facing text. */
  const actionable = (error, computer, timeoutMs) => {
    if (error instanceof HubError) {
      switch (error.code) {
        case ERROR_CODES.OFFLINE:
          return new Error(`computer '${computer.name}' is offline; run computer_list to see which computers are connected, and ask the user to wake or reconnect it`)
        case ERROR_CODES.TIMEOUT:
          return new Error(`computer '${computer.name}' did not answer within ${timeoutMs}ms; the command was cancelled. Retry with a larger timeoutMs, or run a shorter command`)
        case ERROR_CODES.ABORTED:
          return new Error(`the call on '${computer.name}' was aborted by the caller, and the command was cancelled on that machine`)
        case ERROR_CODES.DISPOSED:
          return new Error('the dsh-computers host plugin is shutting down; try again in a moment')
        default:
          return error
      }
    }
    return error instanceof Error ? error : new Error(String(error))
  }

  /**
   * Register one DSH job that feeds on a remote execution (§11.2/§11.6.3).
   * The returned adapter is what the hub appends chunks into and settles.
   * Returns null when the composition has no jobs registry.
   */
  const createExecJob = ({ computer, command, owner, caller = null, start }) => {
    const jobs = jobsOf()
    if (jobs === undefined || typeof jobs.start !== 'function') return null
    let handle = null
    let execution = null
    let resolveDone = () => {}
    const done = new Promise((resolve) => {
      resolveDone = resolve
    })
    const sink = {
      jobId: null,
      append(channel, text) {
        try {
          handle?.append(text, { channel })
        } catch {
          // Writes after settlement are dropped by the registry.
        }
      },
      settle(result) {
        resolveDone(jobOutcome(result))
      },
      failed(error) {
        const terminal = error?.terminal ?? null
        const message = error && error.message ? error.message : String(error)
        resolveDone({
          status: JOB_STATUS.FAILED,
          detail: terminal === null
            ? message
            : `${terminal.status} (${terminal.disposition}): ${message}`,
          ...(terminal === null ? {} : { result: terminal }),
        })
      },
    }
    const jobId = jobs.start({
      kind: 'computer-exec',
      label: `${computer.name}: ${command}`,
      ...(owner === null ? {} : { owner }),
      outputLimitBytes: config.maxOutputBytes,
      run(jobHandle) {
        handle = jobHandle
        execution = start(sink)
        return {
          cancel() {
            // R4: cancellation is an operation too — the single gate applies.
            const decision = policy.authorize({ computer, operation: 'cancel', session: caller, access })
            if (!decision.allowed) {
              onWarn(`dsh-computers: cancel denied: ${decision.reason}`)
              return
            }
            if (execution !== null) hub.cancelExecution(computer.id, execution.requestId)
          },
          done,
        }
      },
    })
    sink.jobId = jobId
    return sink
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
    let runInBackground = false
    if (args.run_in_background !== undefined && args.run_in_background !== null) {
      if (typeof args.run_in_background !== 'boolean') throw new Error('computer_exec "run_in_background" must be a boolean')
      runInBackground = args.run_in_background
    }
    return { computer, command, cwd, timeoutMs: requestedTimeout ?? config.execTimeoutMs, runInBackground }
  }

  /** Resolve the target for one remote-file tool call (authorization is separate). */
  const resolveFsComputer = (arg, exec) => {
    if (fsOps === null) throw new Error('remote file access is unavailable in this deployment')
    const query = typeof arg === 'string' && arg.trim() !== '' ? arg.trim() : undefined
    return resolveTargetComputer(query, exec)
  }

  /** Run one fs op with a clear absolute-path check and error mapping. */
  const fsCall = async (computer, op, payload, exec) => {
    try {
      return await fsOps.request({ computerId: computer.id, name: computer.name, op, payload, signal: exec?.signal })
    } catch (error) {
      throw actionable(error, computer, 15_000)
    }
  }

  // -------------------------------------------------------------------------
  // computer_list
  // -------------------------------------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: 'computer_list',
    description: 'List the activated computers connected to this DSH Web deployment (the user\'s own machines), with platform, online state, agent version/capabilities and the target pinned in the composer. Call this before computer_exec to get a valid computer id or name.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: LIST_OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(renderComputerList(value)),
    },
    async execute(_args, exec) {
      const all = visibleComputers()
      const caller = callerOf(exec)
      const visible = authorizedComputers(all, 'list', caller)
      const visibleIds = new Set(visible.map((computer) => computer.id))
      const selectedId = selectedComputerId(exec)
      const computers = visible.map((computer) => ({
        id: computer.id,
        name: computer.name,
        online: hub.isOnline(computer),
        platformLabel: computer.platformLabel ?? 'Unknown',
        os: computer.os ?? 'unknown',
        hostname: computer.hostname ?? '',
        lastSeenAt: typeof computer.lastSeenAt === 'string' ? computer.lastSeenAt : null,
        agentVersion: typeof computer.agentVersion === 'string' ? computer.agentVersion : null,
        capabilities: capabilitiesOf(computer),
        caps: capsOf(computer),
        mode: modeOf(computer),
        drift: versionsDiffer(computer.agentVersion, version),
        updateRequired: config.minAgentVersion !== ''
          && !versionAtLeast(computer.agentVersion, config.minAgentVersion),
      }))
      return {
        computers,
        selectedComputerId: selectedId !== null && visibleIds.has(selectedId) ? selectedId : null,
        hiddenComputerCount: all.length - visible.length,
      }
    },
  }), 'dsh-computers: computer_list tool')

  // -------------------------------------------------------------------------
  // computer_exec
  // -------------------------------------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: 'computer_exec',
    description: 'Run one shell command on one of the user\'s connected computers and return its exit code, stdout and stderr. The command runs in that machine\'s own shell; output is capped. Use run_in_background for long-running work (job_output/job_kill). A foreground command that exceeds its timeout is promoted to a background job instead of being killed. The machine must be online — call computer_list first.',
    parameters: EXEC_PARAMETERS_SCHEMA,
    output: {
      schema: EXEC_OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(renderExec(value)),
    },
    async execute(args, exec) {
      const input = validateExecArgs(args)
      const computer = resolveTargetComputer(input.computer, exec)
      const caller = callerOf(exec)
      authorizeOp(computer, input.runInBackground === true ? 'exec.background' : 'exec', caller)
      const owner = sessionIdOf(exec)
      const cwd = input.cwd ?? workspaceBaseOf(computer)
      const ref = { id: computer.id, name: computer.name }

      if (input.runInBackground === true) {
        let sink
        try {
          sink = createExecJob({
            computer,
            command: input.command,
            owner,
            caller,
            start: (jobSink) => hub.startExecution({
              computerId: computer.id,
              name: computer.name,
              command: input.command,
              cwd,
              timeoutMs: 0,
              agentTimeoutMs: AGENT_MAX_TIMEOUT_MS,
              job: jobSink,
            }),
          })
        } catch (error) {
          throw actionable(error, computer, input.timeoutMs)
        }
        if (sink === null) {
          throw new Error('background execution is unavailable on this host: the DSH jobs registry is not loaded (load @deepseek-ai/dsh-tool-jobs in the composition)')
        }
        return { computer: ref, command: input.command, jobId: sink.jobId, started: true }
      }

      // §11.6.3: a foreground timeout adopts the running command into a job
      // instead of killing it (unless the operator disabled that).
      const jobs = jobsOf()
      const canPromote = config.promoteOnTimeout === true && jobs !== undefined
      let result
      try {
        result = await hub.dispatch({
          computerId: computer.id,
          name: computer.name,
          command: input.command,
          cwd,
          timeoutMs: input.timeoutMs,
          agentTimeoutMs: AGENT_MAX_TIMEOUT_MS,
          signal: exec?.signal,
          stream: true,
          onTimeout: canPromote
            ? (entry) => {
                try {
                  // Adopt the existing execution: the job's chunks flow from
                  // the same pending entry from now on.
                  return createExecJob({
                    computer,
                    command: input.command,
                    owner,
                    caller,
                    start: () => ({ requestId: entry.requestId }),
                  })
                } catch (error) {
                  onWarn(`dsh-computers: could not promote timed-out execution: ${error && error.message ? error.message : error}`)
                  return null
                }
              }
            : null,
        })
      } catch (error) {
        throw actionable(error, computer, input.timeoutMs)
      }
      if (result !== null && typeof result === 'object' && result.promoted === true) {
        return { computer: ref, command: input.command, jobId: result.jobId, promoted: true }
      }
      return {
        computer: ref,
        command: input.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        ok: result.ok === true && result.timedOut !== true,
        timedOut: result.timedOut === true,
        truncated: result.truncated === true,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      }
    },
  }), 'dsh-computers: computer_exec tool')

  // -------------------------------------------------------------------------
  // Remote file tools (§11.3)
  // -------------------------------------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: 'computer_read',
    description: 'Read a UTF-8 file from a connected computer. `path` must be absolute. Returns the text, line count, byte count and whether it was truncated. Only works when that machine\'s agent supports file access.',
    parameters: READ_PARAMETERS_SCHEMA,
    output: { schema: READ_OUTPUT_SCHEMA, render: (_args, value) => textBlock(renderRead(value)) },
    async execute(args, exec) {
      const path = typeof args?.path === 'string' ? args.path : ''
      if (!isAbsolutePath(path)) throw new Error('computer_read requires an absolute "path"')
      const computer = resolveFsComputer(args?.computer, exec)
      authorizeOp(computer, 'read', callerOf(exec))
      const payload = { path: path.trim() }
      if (typeof args.offset === 'number' && Number.isFinite(args.offset) && args.offset >= 0) payload.offset = Math.trunc(args.offset)
      if (typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0) payload.limit = Math.trunc(args.limit)
      payload.encoding = 'utf8'
      const response = await fsCall(computer, 'read', payload, exec)
      const text = typeof response.text === 'string'
        ? response.text
        : typeof response.content === 'string'
          ? Buffer.from(response.content, 'base64').toString('utf8')
          : ''
      return {
        computer: { id: computer.id, name: computer.name },
        path: typeof response.path === 'string' ? response.path : path,
        text,
        lines: typeof response.lines === 'number' ? response.lines : text.split('\n').length,
        bytes: typeof response.bytes === 'number' ? response.bytes : Buffer.byteLength(text, 'utf8'),
        truncated: response.truncated === true,
      }
    },
  }), 'dsh-computers: computer_read tool')

  ctx.effect(() => ctx.tools.register({
    name: 'computer_write',
    description: 'Write a complete UTF-8 file on a connected computer. `path` must be absolute; set createDirs to create missing parent directories. Overwrites existing content. Only works when that machine\'s agent supports file access.',
    parameters: WRITE_PARAMETERS_SCHEMA,
    output: { schema: WRITE_OUTPUT_SCHEMA, render: (_args, value) => textBlock(renderWrite(value)) },
    async execute(args, exec) {
      const path = typeof args?.path === 'string' ? args.path : ''
      if (!isAbsolutePath(path)) throw new Error('computer_write requires an absolute "path"')
      if (typeof args.content !== 'string') throw new Error('computer_write requires "content"')
      const computer = resolveFsComputer(args?.computer, exec)
      authorizeOp(computer, 'write', callerOf(exec))
      const payload = { path: path.trim(), content: args.content, encoding: 'utf8' }
      if (args.createDirs === true) payload.createDirs = true
      const response = await fsCall(computer, 'write', payload, exec)
      return {
        computer: { id: computer.id, name: computer.name },
        path: typeof response.path === 'string' ? response.path : path,
        bytes: typeof response.bytes === 'number' ? response.bytes : Buffer.byteLength(args.content, 'utf8'),
        created: response.created === true,
      }
    },
  }), 'dsh-computers: computer_write tool')

  ctx.effect(() => ctx.tools.register({
    name: 'computer_edit',
    description: 'Replace literal text in one file on a connected computer. `old` must appear exactly once unless replaceAll is true; `new` replaces every match. Read the file first with computer_read. Only works when that machine\'s agent supports file access.',
    parameters: EDIT_PARAMETERS_SCHEMA,
    output: { schema: EDIT_OUTPUT_SCHEMA, render: (_args, value) => textBlock(renderEdit(value)) },
    async execute(args, exec) {
      const path = typeof args?.path === 'string' ? args.path : ''
      if (!isAbsolutePath(path)) throw new Error('computer_edit requires an absolute "path"')
      const oldText = typeof args.old === 'string' ? args.old : ''
      const newText = typeof args.new === 'string' ? args.new : ''
      if (oldText === '') throw new Error('computer_edit requires a non-empty "old" string')
      const replaceAll = args.replaceAll === true
      const computer = resolveFsComputer(args?.computer, exec)
      authorizeOp(computer, 'edit', callerOf(exec))
      // Read → literal replace → write. Two fs round trips, both with the same
      // 15 s budget and the caller's signal.
      const current = await fsCall(computer, 'read', { path: path.trim(), encoding: 'utf8' }, exec)
      const text = typeof current.text === 'string'
        ? current.text
        : typeof current.content === 'string'
          ? Buffer.from(current.content, 'base64').toString('utf8')
          : ''
      const occurrences = text.split(oldText).length - 1
      if (occurrences === 0) throw new Error(`computer_edit: "old" text was not found in ${path}`)
      if (occurrences > 1 && !replaceAll) {
        throw new Error(`computer_edit: "old" text appears ${occurrences} times in ${path}; pass a longer unique snippet or set replaceAll: true`)
      }
      const replacements = replaceAll ? occurrences : 1
      const next = replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText)
      const written = await fsCall(computer, 'write', { path: path.trim(), content: next, encoding: 'utf8' }, exec)
      return {
        computer: { id: computer.id, name: computer.name },
        path: typeof written.path === 'string' ? written.path : path,
        replacements,
        bytes: typeof written.bytes === 'number' ? written.bytes : Buffer.byteLength(next, 'utf8'),
      }
    },
  }), 'dsh-computers: computer_edit tool')

  ctx.effect(() => ctx.tools.register({
    name: 'computer_glob',
    description: 'Find file paths on a connected computer by glob pattern (for example "**/*.ts"). Relative patterns resolve against the computer\'s workspace base; use cwd to search elsewhere. Only works when that machine\'s agent supports file access.',
    parameters: GLOB_PARAMETERS_SCHEMA,
    output: { schema: GLOB_OUTPUT_SCHEMA, render: (_args, value) => textBlock(renderGlob(value)) },
    async execute(args, exec) {
      const pattern = typeof args?.pattern === 'string' ? args.pattern.trim() : ''
      if (pattern === '') throw new Error('computer_glob requires a non-empty "pattern"')
      const computer = resolveFsComputer(args?.computer, exec)
      authorizeOp(computer, 'glob', callerOf(exec))
      // The agent's `glob` op accepts only {pattern} and anchors relative
      // patterns at its workspaceBase, so a user-provided cwd is folded in.
      let effectivePattern = pattern
      if (typeof args.cwd === 'string' && args.cwd.trim() !== '' && !isAbsolutePath(pattern)) {
        const base = args.cwd.trim().replace(/[\\/]+$/, '')
        const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
        effectivePattern = `${base}${separator}${pattern}`
      }
      const response = await fsCall(computer, 'glob', { pattern: effectivePattern }, exec)
      return {
        computer: { id: computer.id, name: computer.name },
        paths: Array.isArray(response.paths) ? response.paths.filter((entry) => typeof entry === 'string') : [],
      }
    },
  }), 'dsh-computers: computer_glob tool')

  ctx.effect(() => ctx.tools.register({
    name: 'computer_grep',
    description: 'Search file contents on a connected computer with a regular expression. `path` defaults to the computer\'s workspace base; `include` filters by relative glob; results are capped. Only works when that machine\'s agent supports file access.',
    parameters: GREP_PARAMETERS_SCHEMA,
    output: { schema: GREP_OUTPUT_SCHEMA, render: (_args, value) => textBlock(renderGrep(value)) },
    async execute(args, exec) {
      const pattern = typeof args?.pattern === 'string' ? args.pattern.trim() : ''
      if (pattern === '') throw new Error('computer_grep requires a non-empty "pattern"')
      const computer = resolveFsComputer(args?.computer, exec)
      authorizeOp(computer, 'grep', callerOf(exec))
      const payload = { pattern }
      if (typeof args.path === 'string' && args.path.trim() !== '') payload.path = args.path.trim()
      if (typeof args.include === 'string' && args.include.trim() !== '') payload.include = args.include.trim()
      if (typeof args.maxMatches === 'number' && Number.isFinite(args.maxMatches) && args.maxMatches > 0) {
        payload.maxMatches = Math.trunc(args.maxMatches)
      }
      const response = await fsCall(computer, 'grep', payload, exec)
      const matches = Array.isArray(response.matches)
        ? response.matches
            .filter((match) => match !== null && typeof match === 'object')
            .map((match) => ({
              path: typeof match.path === 'string' ? match.path : '',
              line: typeof match.line === 'number' ? Math.trunc(match.line) : 0,
              text: typeof match.text === 'string' ? match.text : '',
            }))
        : []
      return { computer: { id: computer.id, name: computer.name }, matches }
    },
  }), 'dsh-computers: computer_grep tool')

  // ---------------------------------------------------------------------------
  // R4 load-time guarantee: every registered tool has an operation rule.
  // Throws at plugin load if a future tool is added without a table entry.
  // ---------------------------------------------------------------------------
  assertToolsExhaustive([
    'computer_list',
    'computer_exec',
    'computer_read',
    'computer_write',
    'computer_edit',
    'computer_glob',
    'computer_grep',
  ])

  // ---------------------------------------------------------------------------
  // System prompt section (PROTOCOL §5.3, §11)
  // ---------------------------------------------------------------------------
  // `systemPrompt` is not in `inject` (it is optional for this plugin), so it
  // is looked up defensively; a host without it keeps working unchanged.
  try {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.section === 'function') {
      let order = 3000
      try {
        const resolved = typeof systemPrompt.getSectionOrder === 'function'
          ? systemPrompt.getSectionOrder('TOOL_COMPUTER_USE')
          : undefined
        if (Number.isFinite(resolved)) order = resolved
      } catch {
        // Unknown placement name: keep the numeric fallback.
      }
      ctx.effect(() => systemPrompt.section({
        name: 'computers',
        order,
        text: (context) => {
          const all = visibleComputers()
          const agent = context !== null && typeof context === 'object' ? context.agent : undefined
          const presetId = agent === undefined || access === null ? 'default' : access.presetIdForAgent(agent)
          const computers = authorizedComputers(all, 'list', { sessionId: null, presetId })
          if (computers.length === 0) return ''
          const lines = [
            'You can run shell commands on the user\'s connected computers with `computer_exec`.',
            'Call `computer_list` to see their ids, names, online state, capabilities and the target pinned in the composer.',
            'The user can pin a target computer in the composer; `computer_exec` without a `computer` argument runs on that pinned computer.',
          ]
          if (computers.some((computer) => policy.can(computer, 'fs'))) {
            lines.push('Use `computer_read`/`computer_write`/`computer_edit`/`computer_glob`/`computer_grep` for files on machines whose agent supports file access.')
          }
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
