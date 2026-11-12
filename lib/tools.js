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
import { collectSkills } from './skills.js'
import { normalizeSessionId } from './selection.js'
import { versionAtLeast, versionsDiffer } from './version.js'
// v1.9.1: 本地电脑 and account devices as executable targets. The tool layer is
// wired independently of the settings-page managers, so the account login and
// the local runtime identity are read from the same documents the managers
// write (`account.json`, `self-runtime/config.json`) instead of being injected.
// v1.9.2: the self-runtime MANAGER is injected too, because a tool call for
// 本地电脑 is what lazily starts it (and waits for it to register).
import { fetchAccountDevices, readAccountIdentity } from './account.js'
import { FS_OPS } from './fs-ops.js'
import { platformLabel } from './keys.js'
import { postJson } from './http.js'
import { readSelfComputerId } from './self-runtime.js'
import { resolveStateDir } from './state.js'

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

// ---- v1.9.1: 本地电脑 and account devices as executable targets -------------

/** Target-id prefix of an account device (`acct:<machineId>`). */
const ACCOUNT_TARGET_PREFIX = 'acct:'

/** The composer's 本地电脑 label, used in messages when the local runtime is down. */
const LOCAL_TARGET_LABEL = '本地电脑'

/**
 * The actionable message when 本地电脑 cannot be used at all. v1.9.2: 被控 is no
 * longer what starts the local runtime (it only gates the machine-facing fleet
 * API), so the fix is about the runtime itself, not the switch.
 */
const LOCAL_RUNTIME_DOWN = `${LOCAL_TARGET_LABEL}的运行时没启动：请在 设置 → 电脑 → 高级 里查看本机运行时状态后重试`

/**
 * The actionable message when a lazy start failed (v1.9.2). `detail` is the
 * manager's `lastError`, which names the actual cause (no port, no join token,
 * spawn refused, crash loop, …). Kept under the {@link LOCAL_RUNTIME_DOWN}
 * prefix so every 本地电脑 failure reads the same way.
 * @param {string} detail - the runtime's last error.
 * @returns {string} model-facing text.
 */
const localRuntimeStartFailed = (detail) => {
  const reason = typeof detail === 'string' && detail.trim() !== '' ? `：${detail.trim()}` : ''
  return `${LOCAL_TARGET_LABEL}的运行时没启动${reason}；请在 设置 → 电脑 → 高级 里查看本机运行时后重试`
}

/**
 * The actionable message when the runtime started but never connected back
 * (the 5 s registration budget expired). Restarting it is the fix.
 * @param {number} timeoutMs - the budget that expired.
 * @returns {string} model-facing text.
 */
const localRuntimeNotRegistered = (timeoutMs) => `${LOCAL_TARGET_LABEL}的运行时没启动：它已启动，但 ${Math.round(timeoutMs / 1000)} 秒内没有连回本机；请在 设置 → 电脑 → 高级 里查看本机运行时日志，或稍后重试`

/** How long one account-directory read may take before the tools give up. */
const ACCOUNT_DIR_TIMEOUT_MS = 2_000

/** How long a fetched account directory is reused by the tools. */
const ACCOUNT_DIR_TTL_MS = 10_000

/**
 * Capabilities an account device offers through the fleet API: exec + fs. It
 * has no jobs (the fleet API is one request/one answer), no pty and no tunnel.
 */
const ACCOUNT_DEVICE_CAPS = Object.freeze({ exec: true, fs: true, jobs: false, pty: false, tunnel: false })

/** Extra HTTP budget on top of a fleet command's own deadline. */
const FLEET_HTTP_GRACE_MS = 20_000

/** Placeholder activation stamp for an account device with no lastSeenAt. */
const EPOCH_ISO = '1970-01-01T00:00:00.000Z'

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
    via: {
      type: 'string',
      enum: ['registry', 'account'],
      description: 'How this machine is reached: \'registry\' = a computer connected to this hub; \'account\' = another machine in this account, targeted as acct:<machineId> and driven over its own hub\'s fleet API.',
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
    self: {
      type: 'boolean',
      description: 'True only for THIS machine\'s own runtime (「本地电脑」). Such a record is never a remote computer.',
    },
    local: {
      type: 'boolean',
      description: 'True when the row is the 「本地电脑」 target (this machine).',
    },
  },
  required: ['id', 'name', 'online', 'platformLabel', 'os', 'hostname', 'lastSeenAt', 'agentVersion', 'capabilities', 'caps', 'mode', 'via', 'drift', 'updateRequired'],
  additionalProperties: false,
}

const LIST_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    computers: {
      type: 'array',
      items: COMPUTER_ITEM_SCHEMA,
      description: 'Every REMOTE computer this conversation may use. This machine\'s own runtime is never in this list (see `localComputer`).',
    },
    localComputer: {
      oneOf: [COMPUTER_ITEM_SCHEMA, { type: 'null' }],
      description: 'This machine\'s own runtime (「本地电脑」, `self: true`) when it is up, else null. `computer_exec` without `computer` runs here.',
    },
    selectedComputerId: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Computer pinned for this session (composer target picker), or null (null = 本地电脑 / nothing pinned).',
    },
    hiddenComputerCount: {
      type: 'number',
      description: 'Connected computers this conversation may not use (access-controlled), omitted from the list.',
    },
  },
  required: ['computers', 'localComputer', 'selectedComputerId', 'hiddenComputerCount'],
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

const SKILLS_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    computer: {
      type: 'string',
      description: 'Optional computer id or name. Omit it to list the skills of every computer this conversation may use.',
    },
  },
  additionalProperties: false,
}

const SKILL_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    computer: COMPUTER_REF_SCHEMA,
    name: { type: 'string', description: 'Skill name as it exists on that machine (kebab-case).' },
    catalogName: { type: 'string', description: 'Name under which the skill appears in this deployment\'s slash menu (<machine>-<skill>).' },
    description: { type: 'string', description: 'One-line description from the skill\'s SKILL.md.' },
    whenToUse: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: 'When the skill should be used (null when the skill does not say).',
    },
    path: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Directory holding SKILL.md on that machine (null when it cannot be derived).',
    },
    online: { type: 'boolean', description: 'Whether the skill can be loaded right now (its machine is connected).' },
  },
  required: ['computer', 'name', 'catalogName', 'description', 'whenToUse', 'path', 'online'],
  additionalProperties: false,
}

const SKILLS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    computers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          online: { type: 'boolean' },
          skillCount: { type: 'number', description: 'How many skills that machine reported.' },
          via: {
            type: 'string',
            enum: ['registry', 'account'],
            description: 'How the machine is reached: the hub registry, or the account directory (an account device reports its skills to its own hub).',
          },
        },
        required: ['id', 'name', 'online', 'skillCount', 'via'],
        additionalProperties: false,
      },
      description: 'Every computer this conversation may use.',
    },
    skills: { type: 'array', items: SKILL_ITEM_SCHEMA, description: 'Skills reported by those computers (offline machines keep their last report, marked online:false).' },
    hiddenComputerCount: {
      type: 'number',
      description: 'Connected computers this conversation may not use (access-controlled), omitted from the list.',
    },
  },
  required: ['computers', 'skills', 'hiddenComputerCount'],
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
  const localComputer = value?.localComputer !== null && typeof value?.localComputer === 'object'
    ? value.localComputer
    : null
  if (computers.length === 0 && localComputer === null) {
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
    if (computer.via === 'account') notes.push('account')
    if (typeof computer.agentVersion === 'string') notes.push(`agent ${computer.agentVersion}`)
    if (computer.updateRequired === true) notes.push('UPDATE REQUIRED')
    else if (computer.drift === true) notes.push('drift')
    if (Array.isArray(computer.capabilities) && computer.capabilities.length > 0) notes.push(computer.capabilities.join(','))
    return `| ${name} | ${computer.platformLabel} | ${status} | ${notes.join(' · ')} | ${lastSeen} |`
  })
  const lines = []
  // v1.9.2: 本地电脑 is the machine you are on, not a remote computer — it is
  // reported first and never counted among the remote rows.
  if (localComputer !== null) {
    const status = localComputer.online === true ? 'online' : 'offline'
    lines.push(`Local target 「本地电脑」: **${localComputer.name}** (${localComputer.platformLabel}, ${status}) — \`computer_exec\` without \`computer\` runs here.`, '')
  }
  if (selected !== undefined) {
    lines.push(`Pinned target for this session: **${selected.name}** (\`computer_exec\` without \`computer\` runs here).`, '')
  }
  if (computers.length === 0) {
    lines.push('No other computers are connected. Ask the user to connect one from Settings → 电脑.')
    return lines.join('\n')
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

/** Per-machine skill inventory for `computer_skills`. */
function renderSkills(value) {
  const computers = Array.isArray(value?.computers) ? value.computers : []
  if (computers.length === 0) {
    if (typeof value?.hiddenComputerCount === 'number' && value.hiddenComputerCount > 0) {
      return `${value.hiddenComputerCount} computer(s) are connected but this conversation may not use any of them. `
        + 'Ask the user to grant access in 管理访问权 (Access management) for this conversation.'
    }
    return 'No computers are connected yet, so no remote skills are available.'
  }
  const skills = Array.isArray(value?.skills) ? value.skills : []
  const byComputer = new Map()
  for (const skill of skills) {
    const id = typeof skill?.computer?.id === 'string' ? skill.computer.id : ''
    if (!byComputer.has(id)) byComputer.set(id, [])
    byComputer.get(id).push(skill)
  }
  const lines = []
  for (const computer of computers) {
    const rows = byComputer.get(computer.id) ?? []
    lines.push(`${computer.name} (${computer.id}) — ${computer.online === true ? 'online' : 'offline'}`)
    if (rows.length === 0) {
      if (computer.via === 'account') {
        lines.push('  (account device — it reports its skills to its own hub, not to this one)')
        continue
      }
      lines.push(computer.online === true
        ? '  (no skills reported by this machine)'
        : '  (offline — no skills in its last report)')
      continue
    }
    for (const row of rows) {
      lines.push(`  - ${row.name}${row.online === true ? '' : ' (offline)'} — ${row.description}`)
      if (typeof row.whenToUse === 'string' && row.whenToUse !== '') lines.push(`    when: ${row.whenToUse}`)
      if (typeof row.path === 'string' && row.path !== '') lines.push(`    path: ${row.path}`)
      if (typeof row.catalogName === 'string' && row.catalogName !== '') lines.push(`    slash menu: /${row.catalogName}`)
    }
  }
  return boundRender(lines.join('\n'))
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
  ctx, config, store, hub, selections = null, access = null, fsOps = null, selfRuntime = null,
  version = '1.0.0', onWarn = () => {},
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

  /** The directory `account.json` and `self-runtime/` live in (same resolution as routes.js). */
  const stateDir = resolveStateDir(config.stateDir)

  /** True for an account-device target id (`acct:<machineId>`). */
  const isAccountTargetId = (value) => typeof value === 'string' && value.startsWith(ACCOUNT_TARGET_PREFIX)

  /**
   * Presence of one target: a live stream for a registry computer, the account
   * directory's `online` flag for an account device (the relay computes it from
   * the 120 s heartbeat window).
   */
  const isTargetOnline = (computer) => (computer?.via === 'account'
    ? computer.online === true
    : hub.isOnline(computer))

  /**
   * The registry id of this machine's own runtime. The manager knows it as soon
   * as it enrolled; the isolated agent identity on disk
   * (`${stateDir}/self-runtime/config.json`) survives restarts, so the id is
   * still known before the first lazy start of this process.
   * @returns {string} the computer id, or '' when the runtime never enrolled.
   */
  const selfComputerId = () => {
    try {
      const value = selfRuntime?.status?.()
      const id = value !== null && typeof value === 'object' ? value.computerId : null
      if (typeof id === 'string' && id !== '') return id
    } catch {
      // Fall through to the persisted identity.
    }
    return readSelfComputerId(stateDir, { onWarn })
  }

  /** @type {{ key: string, at: number, devices: object[], error: string|null } | null} */
  let directoryCache = null

  /**
   * The account's device directory, read from the relay with a bounded budget
   * and reused for {@link ACCOUNT_DIR_TTL_MS} (the settings page polls it too,
   * and one exec must not cost a relay round trip when a recent answer exists).
   *
   * Never throws: a relay failure is reported as `error`, keeping the previous
   * directory when there was one, so `computer_list` degrades instead of
   * failing and an execution target can explain itself precisely.
   * @param {{force?: boolean}} [options] - bypass the TTL.
   * @returns {Promise<{identity: object|null, devices: object[], error: string|null}>} the directory.
   */
  const accountDirectory = async ({ force = false } = {}) => {
    let identity = null
    try {
      identity = readAccountIdentity(stateDir, { onWarn })
    } catch {
      identity = null
    }
    if (identity === null) return { identity: null, devices: [], error: null }
    const cacheKey = typeof identity.key === 'string' ? identity.key : ''
    const nowMs = Date.now()
    if (!force && directoryCache !== null && directoryCache.key === cacheKey
      && nowMs - directoryCache.at < ACCOUNT_DIR_TTL_MS) {
      return { identity, devices: directoryCache.devices, error: directoryCache.error }
    }
    try {
      const devices = await fetchAccountDevices(identity, { timeoutMs: ACCOUNT_DIR_TIMEOUT_MS })
      directoryCache = { key: cacheKey, at: nowMs, devices, error: null }
    } catch (error) {
      const previous = directoryCache !== null && directoryCache.key === cacheKey ? directoryCache.devices : []
      const message = error && error.message ? error.message : String(error)
      directoryCache = { key: cacheKey, at: nowMs, devices: previous, error: message }
    }
    return { identity, devices: directoryCache.devices, error: directoryCache.error }
  }

  /**
   * One account device as a tool target.
   *
   * `agentVersion` is this plugin's version on purpose: a machine that answers
   * `/api/dsh-computers/fleet/*` is running this same plugin, so the operator's
   * minimum-agent-version gate describes the peer HUB, not a standalone agent.
   * @param {object} device - normalized device row.
   * @returns {object} the target (a registry-computer shape plus `via`/`entryUrl`).
   */
  const accountTargetOf = (device) => ({
    id: `${ACCOUNT_TARGET_PREFIX}${device.machineId}`,
    name: device.name !== '' ? device.name : device.machineId,
    online: device.online === true,
    platformLabel: platformLabel(device.platform),
    os: device.platform !== '' ? device.platform : 'unknown',
    hostname: '',
    lastSeenAt: device.lastSeenAt,
    agentVersion: version,
    capabilities: ['exec', 'fs'],
    caps: { ...ACCOUNT_DEVICE_CAPS },
    mode: 'embedded',
    activatedAt: typeof device.lastSeenAt === 'string' ? device.lastSeenAt : EPOCH_ISO,
    workspaceBase: null,
    via: 'account',
    machineId: device.machineId,
    entryUrl: device.entryUrl,
    controllable: device.controllable !== false,
  })

  /**
   * Every target the conversation could name: the registry's activated
   * computers plus this account's other devices. Registry rows of THIS
   * machine's own runtime are marked `self: true`; they are the 本地电脑
   * target, never a remote computer.
   * @returns {Promise<{registry: object[], devices: object[], directory: object, ownMachineId: string, selfComputerId: string}>} the lists.
   */
  const listTargets = async () => {
    const selfId = selfComputerId()
    const registry = visibleComputers().map((computer) => ({
      ...computer,
      via: 'registry',
      self: selfId !== '' && computer.id === selfId,
    }))
    const directory = await accountDirectory()
    const ownMachineId = directory.identity !== null && typeof directory.identity.machineId === 'string'
      ? directory.identity.machineId
      : ''
    const devices = directory.devices
      // This machine's own row is the same machine as 本地电脑: offering it again
      // would advertise a second, slower (HTTP) route to it.
      .filter((device) => device.machineId !== ownMachineId)
      .map(accountTargetOf)
    return { registry, devices, directory, ownMachineId, selfComputerId: selfId }
  }

  /**
   * Lazily bring 「本地电脑」 up (v1.9.2): start this machine's own runtime and
   * wait (≤ ~5 s) until its computer has registered with the hub.
   *
   * Loading the plugin must not spawn anything, so the FIRST tool call for the
   * local target is what starts it. A failure is never silent: the manager's
   * `lastError` is turned into an actionable message instead of "no computer
   * selected".
   * @returns {Promise<{ status: object, registered: boolean }>} the manager outcome.
   */
  const startLocalRuntime = async () => {
    if (selfRuntime === null || typeof selfRuntime.ensureStarted !== 'function') {
      return { status: null, registered: false }
    }
    try {
      return await selfRuntime.ensureStarted({
        isRegistered: (computerId) => hub.isLive(computerId) === true,
      })
    } catch (error) {
      onWarn(`dsh-computers: the local runtime could not be started lazily: ${error && error.message ? error.message : error}`)
      return { status: null, registered: false }
    }
  }

  /**
   * 「本地电脑」: the composer's `null` pin. Resolves to the registry record this
   * hub's own runtime enrolled as. The first call starts that runtime lazily;
   * once it is up, later calls are cheap. The error always says what to fix.
   * @returns {Promise<object>} the local target.
   */
  const localComputerTarget = async () => {
    let computerId = selfComputerId()
    let computer = computerId === ''
      ? undefined
      : visibleComputers().find((candidate) => candidate.id === computerId)
    if (computer === undefined || hub.isLive(computer.id) !== true) {
      const outcome = await startLocalRuntime()
      if (outcome.status === null || outcome.status.state !== 'running') {
        throw new Error(outcome.status !== null && typeof outcome.status.lastError === 'string'
          ? localRuntimeStartFailed(outcome.status.lastError)
          : LOCAL_RUNTIME_DOWN)
      }
      if (outcome.registered !== true) {
        throw new Error(localRuntimeNotRegistered(outcome.timeoutMs ?? 5000))
      }
      computerId = outcome.status.computerId ?? ''
      computer = computerId === ''
        ? undefined
        : visibleComputers().find((candidate) => candidate.id === computerId)
    }
    if (computer === undefined) throw new Error(LOCAL_RUNTIME_DOWN)
    return { ...computer, via: 'registry', local: true, self: true }
  }

  /**
   * Resolve `computer` over every target by exact id, exact name, then unique
   * substring (registry ids and names, plus `acct:<machineId>` and account
   * device names).
   * @param {string} query - id, name or unambiguous prefix.
   * @returns {Promise<object>} the target.
   */
  const resolveComputer = async (query) => {
    const { registry, devices } = await listTargets()
    const targets = [...registry, ...devices]
    if (targets.length === 0) {
      throw new Error('no computers are connected to this deployment; ask the user to connect one from Settings → 电脑')
    }
    const needle = query.trim()
    const lower = needle.toLowerCase()
    const byId = targets.find((computer) => computer.id === needle)
    if (byId !== undefined) return byId
    const byName = targets.find((computer) => String(computer.name).toLowerCase() === lower)
    if (byName !== undefined) return byName
    const candidates = targets.filter((computer) =>
      String(computer.name).toLowerCase().includes(lower) || String(computer.id).toLowerCase().includes(lower))
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) {
      const names = candidates.map((computer) => `${computer.name} (${computer.id})`).join(', ')
      throw new Error(`computer '${query}' is ambiguous; it matches ${names}. Pass the exact id or name.`)
    }
    const available = targets.map((computer) => `${computer.name} (${computer.id})`).join(', ')
    throw new Error(`no computer matches '${query}'; available computers: ${available}. Run computer_list for details.`)
  }

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

  /** The caller's session identity (`exec.agent.id` / `agent.session.id`). */
  const sessionIdOf = (exec) => {
    const agent = exec?.agent
    if (agent === undefined || agent === null) return null
    const fromSession = agent.session?.id
    const raw = typeof fromSession === 'string' ? fromSession : agent.id
    return normalizeSessionId(raw)
  }

  /** What the composer pinned for this session, whether or not it still exists. */
  const pinnedComputerId = (exec) => {
    const sessionId = sessionIdOf(exec)
    if (sessionId === null || selections === null) return null
    return selections.get(sessionId)
  }

  /** The pinned computer's display name captured when it was pinned (may be null). */
  const pinnedComputerName = (exec) => {
    const sessionId = sessionIdOf(exec)
    if (sessionId === null || selections === null || typeof selections.entry !== 'function') return null
    return selections.entry(sessionId)?.name ?? null
  }

  /**
   * The pin to report in `computer_list`: a registry id or an `acct:` target,
   * but only while that target still exists (a vanished device reads as "no
   * selection", exactly like a deleted computer).
   * @param {object} exec - tool execution context.
   * @param {object} targets - `listTargets()` result.
   * @returns {string | null} the still-valid pin.
   */
  const selectedComputerId = (exec, targets) => {
    const pinned = pinnedComputerId(exec)
    if (pinned === null) return null
    // A pin on this machine's own record IS 「本地电脑」, and the local target is
    // reported as a null selection (that is how the composer spells it).
    if (targets.selfComputerId !== '' && pinned === targets.selfComputerId) return null
    const exists = targets.registry.some((computer) => computer.id === pinned)
      || targets.devices.some((computer) => computer.id === pinned)
    return exists ? pinned : null
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
    // Account devices are not in this hub's stream table: their presence is the
    // account directory's `online` flag (v1.9.1).
    isOnline: (computer) => isTargetOnline(computer),
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

  /**
   * A resolved account target must be reachable AND drivable before a tool
   * touches it. Both failures get their own sentence: "offline" and "被控 is
   * off" are different problems with different fixes, and the peer's HTTP
   * answer would be far less actionable than naming the switch.
   * @param {object} target - resolved target.
   * @returns {object} the same target.
   */
  const assertAccountDrivable = (target) => {
    if (target === null || typeof target !== 'object' || target.via !== 'account') return target
    if (target.online !== true) {
      const seen = typeof target.lastSeenAt === 'string' ? ` (last heartbeat ${target.lastSeenAt})` : ''
      throw new Error(`computer '${target.name}' is offline${seen}; ask the user to wake it or check its network, then retry. Run computer_list to see what is available`)
    }
    if (target.controllable === false) {
      throw new Error(`computer '${target.name}' does not allow being controlled (被控 is off); ask the user to turn 被控 on in that machine's 设置 → 电脑 → 高级, then retry`)
    }
    return target
  }

  /**
   * Explicit argument wins; otherwise the computer pinned in the composer.
   *
   * v1.9.2 routing rules:
   * - a `null` pin is 「本地电脑」 → this hub's own runtime. That runtime is LAZY:
   *   the first call starts it and waits (≤ ~5 s) for it to register, so the
   *   local machine never shows up as "connected" before someone needs it;
   * - `acct:<machineId>` → that account device (executed over its hub's fleet
   *   API, never through this hub's stream table);
   * - anything else → a registry computer by id/name/unique substring.
   * @param {string | undefined} query - explicit `computer` argument.
   * @param {object} exec - tool execution context.
   * @returns {Promise<object>} the resolved target.
   */
  const resolveTargetComputer = async (query, exec) => {
    if (query !== undefined) {
      // The self computer is 本地电脑 even when named explicitly: running the
      // command locally is the same thing without the hub round trip.
      const selfId = selfComputerId()
      if (selfId !== '' && query.trim() === selfId) return await localComputerTarget()
      const target = await resolveComputer(query)
      if (target.self === true) return await localComputerTarget()
      return assertAccountDrivable(target)
    }
    const pinned = pinnedComputerId(exec)
    if (pinned === null) return await localComputerTarget()
    if (isAccountTargetId(pinned)) {
      const machineId = pinned.slice(ACCOUNT_TARGET_PREFIX.length)
      const { devices, ownMachineId } = await listTargets()
      // Our own directory row is 本地电脑: run locally instead of dialling
      // ourselves over HTTP (the same machine, one less hop).
      if (machineId !== '' && machineId === ownMachineId) return await localComputerTarget()
      const device = devices.find((candidate) => candidate.machineId === machineId)
      if (device === undefined) {
        const remembered = pinnedComputerName(exec)
        const label = remembered === null ? `“${pinned}”` : `“${remembered}”`
        throw new Error(`${label} is no longer in this account (or this machine is logged out); run computer_list to see what is available, or pick another target in the composer`)
      }
      return assertAccountDrivable(device)
    }
    // A pin on the self computer id means 本地电脑 too (the composer normally
    // clears the pin for the local row, but a stored selection may name it).
    if (selfComputerId() === pinned) return await localComputerTarget()
    const selected = visibleComputers().find((computer) => computer.id === pinned)
    if (selected === undefined) {
      // The pinned target was deleted after it was chosen. Naming it is the
      // difference between "I did something wrong" and "the machine I was using
      // is gone".
      const remembered = pinnedComputerName(exec)
      const label = remembered === null ? 'the computer selected in the composer' : `“${remembered}”`
      throw new Error(`${label} is no longer connected or has been removed; run computer_list to see what is available, or pick another target in the composer`)
    }
    return { ...selected, via: 'registry' }
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
  const resolveFsComputer = async (arg, exec) => {
    if (fsOps === null) throw new Error('remote file access is unavailable in this deployment')
    const query = typeof arg === 'string' && arg.trim() !== '' ? arg.trim() : undefined
    return await resolveTargetComputer(query, exec)
  }

  /**
   * One request to a PEER hub's fleet API (v1.9.1).
   *
   * An `acct:` target is a different machine's DSH plugin: it exposes
   * `POST <entryUrl>/api/dsh-computers/fleet/{exec,fs}`, authenticated by the
   * account key this machine is logged in with (`x-fleet-key`). That peer hub
   * forwards the request to its own local runtime and answers the normal
   * exec/fs shape, so the tool layer only has to translate transport/HTTP
   * failures into text a model can act on.
   *
   * @param {object} target - resolved account target (`entryUrl`, `name`).
   * @param {'exec'|'fs'} endpoint - fleet route.
   * @param {object} body - JSON body.
   * @param {{timeoutMs: number, signal?: AbortSignal, maxBytes?: number}} options - budget.
   * @returns {Promise<object>} the peer's JSON answer.
   */
  const fleetRequest = async (target, endpoint, body, { timeoutMs, signal, maxBytes = 1024 * 1024 } = {}) => {
    const entryUrl = typeof target.entryUrl === 'string' ? target.entryUrl.replace(/\/+$/, '') : ''
    if (entryUrl === '') {
      throw new Error(`computer '${target.name}' has no entry address in the account directory, so it cannot be reached; ask the user to reconnect it`)
    }
    const identity = (await accountDirectory()).identity
    const key = identity !== null && typeof identity.key === 'string' ? identity.key : ''
    if (key === '') {
      throw new Error('this machine is not logged into the account that owns that computer; log in from 设置 → 电脑 → 账号中心, then retry')
    }
    let response
    try {
      response = await postJson(`${entryUrl}/api/dsh-computers/fleet/${endpoint}`, body, {
        timeoutMs,
        signal,
        maxBytes,
        headers: { 'x-fleet-key': key },
      })
    } catch (error) {
      // postJson throws HttpError(502, 'hub-unreachable') on transport failure.
      throw new Error(`cannot reach computer '${target.name}' at ${entryUrl}: ${error && error.message ? error.message : error}. Ask the user to check that machine and its address`)
    }
    const data = response.data !== null && typeof response.data === 'object' && !Array.isArray(response.data)
      ? response.data
      : {}
    const detail = typeof data.message === 'string' && data.message !== '' ? data.message : ''
    switch (response.status) {
      case 200:
        return data
      case 401:
        throw new Error(`computer '${target.name}' rejected this machine's account key (HTTP 401): the two machines are not logged into the same account, or the key was rotated. Log in again on both machines`)
      case 403:
        throw new Error(`computer '${target.name}' does not allow being controlled (被控 is off, HTTP 403): ask the user to turn 被控 on in that machine's 设置 → 电脑 → 高级`)
      case 503:
        throw new Error(`computer '${target.name}' is in the account but its local runtime is not running (HTTP 503): ask the user to open that machine's 设置 → 电脑 → 高级 and check the local runtime${detail === '' ? '' : ` — ${detail}`}`)
      case 504:
        throw new Error(`computer '${target.name}' did not finish within ${timeoutMs}ms (HTTP 504)${detail === '' ? '' : `: ${detail}`}`)
      default:
        throw new Error(`computer '${target.name}' answered HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`)
    }
  }

  /** Run one fs op with a clear absolute-path check and error mapping. */
  const fsCall = async (computer, op, payload, exec) => {
    // An account device executes on its OWN hub: the file operation travels over
    // that hub's fleet API instead of this hub's stream table (v1.9.1).
    if (computer.via === 'account') {
      if (!FS_OPS.includes(op)) throw new Error(`unsupported file operation ${JSON.stringify(op)}`)
      const data = await fleetRequest(computer, 'fs', { op, payload }, {
        timeoutMs: FLEET_HTTP_GRACE_MS + 15_000,
        signal: exec?.signal,
        maxBytes: Math.max(1024 * 1024, Number(config.maxOutputBytes) + 256 * 1024),
      })
      if (data.ok !== true) {
        const message = typeof data.error === 'string' && data.error !== '' ? data.error : 'remote file operation failed'
        throw new Error(`${message} (${op} on '${computer.name}')`)
      }
      return data
    }
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
      const targets = await listTargets()
      const caller = callerOf(exec)
      const visible = authorizedComputers(targets.registry, 'list', caller)
      const selectedId = selectedComputerId(exec, targets)
      /** One registry row (the shape every computer row has). */
      const registryRowOf = (computer) => ({
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
        via: 'registry',
        drift: versionsDiffer(computer.agentVersion, version),
        updateRequired: config.minAgentVersion !== ''
          && !versionAtLeast(computer.agentVersion, config.minAgentVersion),
      })
      // v1.9.2: this machine's own runtime record is NOT a remote computer. It
      // is reported separately as `localComputer` (the 本地电脑 target), so a
      // list of remote machines can never contain the machine you are on — and
      // a UI can filter on `self` without guessing from the name.
      const selfId = targets.selfComputerId
      const selfRecord = selfId === '' ? undefined : visible.find((computer) => computer.id === selfId)
      const localComputer = selfRecord === undefined
        ? null
        : { ...registryRowOf(selfRecord), self: true, local: true }
      const remoteRegistry = visible.filter((computer) => computer.id !== selfId)
      const registryRows = remoteRegistry.map(registryRowOf)
      // v1.9.1: account devices are first-class targets too — same shape, marked
      // `via: 'account'`, id `acct:<machineId>`. They are authorized by the same
      // policy (which has no access rule for an id outside access.json), and
      // their `online`/`controllable` come from the account directory.
      const accountRows = targets.devices.map((computer) => ({
        id: computer.id,
        name: computer.name,
        online: computer.online === true,
        platformLabel: computer.platformLabel,
        os: computer.os,
        hostname: '',
        lastSeenAt: computer.lastSeenAt,
        agentVersion: computer.agentVersion,
        capabilities: computer.capabilities,
        caps: computer.caps,
        mode: computer.mode,
        via: 'account',
        drift: false,
        updateRequired: false,
      }))
      const computers = [...registryRows, ...accountRows]
      return {
        computers,
        localComputer,
        selectedComputerId: selectedId,
        hiddenComputerCount: targets.registry.length - visible.length,
      }
    },
  }), 'dsh-computers: computer_list tool')

  // -------------------------------------------------------------------------
  // computer_exec
  // -------------------------------------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: 'computer_exec',
    description: 'Run one shell command on one of the user\'s connected computers and return its exit code, stdout and stderr. The command runs in that machine\'s own shell; output is capped. Without `computer` it runs on the target pinned in the composer (「本地电脑」 = this machine; its local runtime starts on first use; an account device = `acct:<machineId>`). Use run_in_background for long-running work (job_output/job_kill) — background jobs need a computer connected to this hub, not an account device. A foreground command that exceeds its timeout is promoted to a background job instead of being killed. The machine must be online — call computer_list first.',
    parameters: EXEC_PARAMETERS_SCHEMA,
    output: {
      schema: EXEC_OUTPUT_SCHEMA,
      render: (_args, value) => textBlock(renderExec(value)),
    },
    async execute(args, exec) {
      const input = validateExecArgs(args)
      const computer = await resolveTargetComputer(input.computer, exec)
      const caller = callerOf(exec)
      authorizeOp(computer, input.runInBackground === true ? 'exec.background' : 'exec', caller)
      const owner = sessionIdOf(exec)
      const cwd = input.cwd ?? workspaceBaseOf(computer)
      const ref = { id: computer.id, name: computer.name }

      // v1.9.1: an account device executes on its OWN hub. There is no stream
      // in this hub's table for it, so the command travels over the peer's
      // fleet API and comes back as the normal result shape. No job adoption
      // (the fleet API is one request/one answer) — the policy gate already
      // denied `exec.background` because an account device has no `jobs`.
      if (computer.via === 'account') {
        const data = await fleetRequest(computer, 'exec', {
          command: input.command,
          ...(cwd === null ? {} : { cwd }),
          timeoutMs: input.timeoutMs,
        }, {
          timeoutMs: input.timeoutMs + FLEET_HTTP_GRACE_MS,
          signal: exec?.signal,
          maxBytes: Math.max(1024 * 1024, Number(config.maxOutputBytes) * 2 + 256 * 1024),
        })
        return {
          computer: ref,
          command: input.command,
          exitCode: typeof data.exitCode === 'number' ? data.exitCode : null,
          stdout: typeof data.stdout === 'string' ? data.stdout : '',
          stderr: typeof data.stderr === 'string' ? data.stderr : '',
          durationMs: Number.isFinite(data.durationMs) ? data.durationMs : 0,
          ok: data.ok === true && data.timedOut !== true,
          timedOut: data.timedOut === true,
          truncated: data.truncated === true,
        }
      }

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
      const computer = await resolveFsComputer(args?.computer, exec)
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
      const computer = await resolveFsComputer(args?.computer, exec)
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
      const computer = await resolveFsComputer(args?.computer, exec)
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
      const computer = await resolveFsComputer(args?.computer, exec)
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
      const computer = await resolveFsComputer(args?.computer, exec)
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

  // -------------------------------------------------------------------------
  // Remote skills (v1.9.0)
  // -------------------------------------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: 'computer_skills',
    description: 'List the skills that exist on connected computers. Each computer\'s agent reports the skills in its own skills directories; without `computer` every computer this conversation may use is listed, with `computer` only that machine. Offline machines keep their last report but their skills cannot be loaded until they reconnect. The same skills also appear in the slash menu as <machine>-<skill>, where their full instructions can be loaded.',
    parameters: SKILLS_PARAMETERS_SCHEMA,
    output: { schema: SKILLS_OUTPUT_SCHEMA, render: (_args, value) => textBlock(renderSkills(value)) },
    async execute(args, exec) {
      const caller = callerOf(exec)
      const query = typeof args?.computer === 'string' && args.computer.trim() !== '' ? args.computer.trim() : undefined
      let targets
      let hiddenComputerCount = 0
      if (query !== undefined) {
        const computer = await resolveComputer(query)
        authorizeOp(computer, 'list', caller)
        targets = [computer]
      } else {
        // v1.9.1: the inventory covers every usable target, including the
        // account's devices (marked `via: 'account'`). Those report their skills
        // to their OWN hub, so they appear with `skillCount: 0` — the row still
        // tells the model that the machine exists and how to target it.
        const { registry, devices } = await listTargets()
        const visible = authorizedComputers(registry, 'list', caller)
        hiddenComputerCount = registry.length - visible.length
        targets = [...visible, ...devices]
      }
      // Offline machines are included on purpose: `online` on every row is the
      // difference between "no such skill" and "not right now".
      const rows = collectSkills(targets.filter((computer) => computer.via !== 'account'), {
        isOnline: (computer) => hub.isOnline(computer),
        onlineOnly: false,
      })
      const computers = targets.map((computer) => ({
        id: computer.id,
        name: String(computer.name ?? computer.id),
        online: isTargetOnline(computer) === true,
        skillCount: rows.filter((row) => row.computer.id === computer.id).length,
        via: computer.via === 'account' ? 'account' : 'registry',
      }))
      return {
        computers,
        skills: rows.map((row) => ({
          computer: { id: row.computer.id, name: row.machineName },
          name: row.skill.name,
          catalogName: row.catalogName,
          description: row.skill.description,
          whenToUse: row.skill.whenToUse,
          path: row.path,
          online: row.online,
        })),
        hiddenComputerCount,
      }
    },
  }), 'dsh-computers: computer_skills tool')

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
    'computer_skills',
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
          // v1.9.2: this machine's own record is 「本地电脑」, not a remote
          // computer — it must never appear in the remote list the prompt shows.
          const selfId = selfComputerId()
          const all = visibleComputers().filter((computer) => selfId === '' || computer.id !== selfId)
          const agent = context !== null && typeof context === 'object' ? context.agent : undefined
          const presetId = agent === undefined || access === null ? 'default' : access.presetIdForAgent(agent)
          const computers = authorizedComputers(all, 'list', { sessionId: null, presetId })
          if (computers.length === 0) return ''
          const lines = [
            'You can run shell commands on the user\'s connected computers with `computer_exec`.',
            'Call `computer_list` to see their ids, names, online state, capabilities and the target pinned in the composer.',
            'The user can pin a target computer in the composer; `computer_exec` without a `computer` argument runs on that pinned computer. 「本地电脑」 is this machine (its local runtime starts on first use); account devices are targeted as `acct:<machineId>`.',
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
