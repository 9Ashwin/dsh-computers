/**
 * Feature policy for one computer (refactor R2, docs/refactor-plan.md §3).
 *
 * Compatibility is decided by the agent's reported capability flags, not by a
 * version number: an agent that does not advertise a capability simply does not
 * get the feature, and the host never assumes "you should be new enough". The
 * only version-based decision left is the operator-forced `minAgentVersion`
 * upgrade gate (enforced in the tool layer, not here).
 *
 * Legacy derivation (agents before caps existed): `{exec:true, fs:<has fs>,
 * jobs:true, pty:false, tunnel:false}` — exactly the features those agents
 * actually had.
 *
 * R4 extends this file with the operation→permission table; `supports()` stays
 * the single feature predicate.
 */

import { CAPABILITIES, isPlainObject } from './contracts.js'
import { versionAtLeast } from './version.js'

/** The five capabilities, re-exported as the policy feature vocabulary. */
export const POLICY_FEATURES = CAPABILITIES

/**
 * Flags for an agent that never reported `caps` (pre-R2a).
 * @param {{ capabilities?: string[] }} computer - registry record.
 * @returns {{exec:boolean,fs:boolean,jobs:boolean,pty:boolean,tunnel:boolean}} derived caps.
 */
export function legacyCaps(computer) {
  const capabilities = Array.isArray(computer?.capabilities)
    ? computer.capabilities.filter((entry) => typeof entry === 'string')
    : []
  return {
    exec: true,
    fs: capabilities.includes('fs'),
    jobs: true,
    pty: false,
    tunnel: false,
  }
}

/**
 * Normalize a reported caps object to all five booleans. Absent flags mean
 * "not supported" (except `exec`, which every agent has) — that is what makes
 * an older/newer agent hiding a feature behave correctly.
 * @param {unknown} value - `caps` from enroll/handshake/heartbeat.
 * @returns {object|null} normalized caps, or null when nothing was reported.
 */
export function normalizeCaps(value) {
  if (!isPlainObject(value)) return null
  return {
    exec: value.exec !== false,
    fs: value.fs === true,
    jobs: value.jobs === true,
    pty: value.pty === true,
    tunnel: value.tunnel === true,
  }
}

/**
 * The effective capabilities of a stored computer: reported `caps` when
 * present, otherwise the legacy derivation.
 * @param {object} computer - registry record.
 * @returns {{exec:boolean,fs:boolean,jobs:boolean,pty:boolean,tunnel:boolean}} caps.
 */
export function capsOf(computer) {
  return normalizeCaps(computer?.caps) ?? legacyCaps(computer)
}

/**
 * The single feature predicate used by tools, routes and the prompt section.
 * @param {object} computer - registry record.
 * @param {'exec'|'fs'|'jobs'|'pty'|'tunnel'} feature - capability name.
 * @returns {boolean} whether the feature may be used on that computer.
 */
export function supports(computer, feature) {
  if (typeof feature !== 'string' || !POLICY_FEATURES.includes(feature)) return false
  return capsOf(computer)[feature] === true
}

// ---------------------------------------------------------------------------
// R4 — one exhaustive permission table + a single authorize() gate
// (docs/refactor-plan.md §3, Paseo's operation-permissions idea)
// ---------------------------------------------------------------------------

/**
 * Every inbound operation the host serves today. A new operation MUST be added
 * here (and to OPERATION_REQUIREMENTS) or the load-time self-check throws: that
 * is the "exhaustive table" guarantee — no operation can exist without a rule.
 */
export const OPERATIONS = Object.freeze([
  'exec',            // computer_exec (foreground)
  'exec.background', // computer_exec with run_in_background
  'cancel',          // job_kill -> cancel frame
  'read',            // computer_read
  'write',           // computer_write
  'edit',            // computer_edit
  'glob',            // computer_glob
  'grep',            // computer_grep
  'fs.request',      // generic fs dispatcher ops (list/stat/mkdir/rename/delete)
  'list',            // computer_list / prompt section visibility
])

/** Deny codes returned by authorize(); stable strings for tests and the UI. */
export const DENY_CODES = Object.freeze({
  UNKNOWN_OPERATION: 'unknown-operation',
  COMPUTER_UNKNOWN: 'computer-unknown',
  HOST_DISABLED: 'host-disabled',
  JOBS_UNAVAILABLE: 'jobs-unavailable',
  VERSION_BELOW_MINIMUM: 'version-below-minimum',
  CAPABILITY_MISSING: 'capability-missing',
  NOT_ACTIVATED: 'not-activated',
  SESSION_DENIED: 'session-denied',
  PRESET_DENIED: 'preset-denied',
  OFFLINE: 'offline',
})

/** Every rule has exactly this shape (self-checked below). */
const REQUIREMENT_FIELDS = Object.freeze([
  'feature', 'label', 'description', 'hostGate', 'operatorGate', 'jobsService',
  'activation', 'access', 'presence',
])

/** Build one frozen requirement with the exhaustive field set. */
const requirement = ({ feature = null, label = '', description = '', hostGate = false, operatorGate = true, jobsService = false, activation = true, access = true, presence = true }) =>
  Object.freeze({ feature, label, description, hostGate, operatorGate, jobsService, activation, access, presence })

/**
 * `operation -> requirement`. Frozen; keys must equal OPERATIONS exactly
 * (enforced by assertOperationTable() at module load).
 */
export const OPERATION_REQUIREMENTS = Object.freeze({
  exec: requirement({
    feature: 'exec', label: 'remote command execution', hostGate: true, operatorGate: true, jobsService: false,
    description: 'Run a foreground shell command on the computer.',
  }),
  'exec.background': requirement({
    feature: 'jobs', label: 'background jobs', hostGate: true, operatorGate: true, jobsService: true,
    description: 'Start a command as a DSH job and keep running after the tool returns.',
  }),
  cancel: requirement({
    feature: null, label: 'cancelling an execution', hostGate: false, operatorGate: false, jobsService: false,
    activation: false, presence: false,
    description: 'Stop a running execution; allowed even when the agent is otherwise unusable.',
  }),
  read: requirement({ feature: 'fs', label: 'remote file access', description: 'Read a file on the computer.' }),
  write: requirement({ feature: 'fs', label: 'remote file access', description: 'Write a file on the computer.' }),
  edit: requirement({ feature: 'fs', label: 'remote file access', description: 'Replace text in a file on the computer.' }),
  glob: requirement({ feature: 'fs', label: 'remote file access', description: 'List paths matching a glob on the computer.' }),
  grep: requirement({ feature: 'fs', label: 'remote file access', description: 'Search file contents on the computer.' }),
  'fs.request': requirement({ feature: 'fs', label: 'remote file access', description: 'Any other fs op (list/stat/mkdir/rename/delete).' }),
  list: requirement({
    feature: null, label: 'listing computers', operatorGate: false, activation: false, presence: false,
    description: 'List the computers this conversation may use (offline ones included).',
  }),
})

/**
 * Tool name -> operation(s) it is allowed to perform. `assertToolsExhaustive()`
 * throws when a registered tool is missing here, so a new tool cannot bypass
 * the table.
 */
export const TOOL_OPERATIONS = Object.freeze({
  computer_list: 'list',
  computer_exec: Object.freeze(['exec', 'exec.background', 'cancel']),
  computer_read: 'read',
  computer_write: 'write',
  computer_edit: 'edit',
  computer_glob: 'glob',
  computer_grep: 'grep',
})

/**
 * Load-time self-check: every operation has a rule, every rule has the full
 * field set, and no rule exists for an undeclared operation.
 * @returns {true} when the table is exhaustive.
 */
export function assertOperationTable() {
  const declared = [...OPERATIONS].sort()
  const defined = Object.keys(OPERATION_REQUIREMENTS).sort()
  const missing = declared.filter((op) => !defined.includes(op))
  const unexpected = defined.filter((op) => !declared.includes(op))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `dsh-computers permission table is not exhaustive: missing rules for [${missing.join(', ')}]`
      + `; rules without an operation [${unexpected.join(', ')}]`,
    )
  }
  for (const op of OPERATIONS) {
    const rule = OPERATION_REQUIREMENTS[op]
    const keys = Object.keys(rule).sort()
    const expected = [...REQUIREMENT_FIELDS].sort()
    if (keys.join(',') !== expected.join(',')) {
      throw new Error(`dsh-computers permission rule for '${op}' has the wrong field set: [${keys.join(', ')}]`)
    }
    if (rule.feature !== null && !CAPABILITIES.includes(rule.feature)) {
      throw new Error(`dsh-computers permission rule for '${op}' requires unknown feature '${rule.feature}'`)
    }
  }
  for (const [tool, mapped] of Object.entries(TOOL_OPERATIONS)) {
    const ops = Array.isArray(mapped) ? mapped : [mapped]
    for (const op of ops) {
      if (!OPERATIONS.includes(op)) throw new Error(`dsh-computers tool '${tool}' maps to unknown operation '${op}'`)
    }
  }
  return true
}

// Fail fast at module load (and therefore at plugin load): a missing rule is a
// programming error that must never degrade silently into "allow".
assertOperationTable()

/**
 * Throw when a registered tool has no operation mapping (load-time check called
 * from tools.js after registration).
 * @param {Iterable<string>} toolNames - registered tool names.
 * @returns {true} when every tool is mapped.
 */
export function assertToolsExhaustive(toolNames) {
  const unmapped = []
  for (const name of toolNames) {
    if (TOOL_OPERATIONS[name] === undefined) unmapped.push(name)
  }
  if (unmapped.length > 0) {
    throw new Error(`dsh-computers permission table does not cover every tool: unmapped [${unmapped.join(', ')}]`)
  }
  return true
}

/**
 * Upgrade instructions that actually work for this machine (v1.3.2): an
 * embedded runtime is upgraded by updating the DSH plugin and restarting DSH —
 * the one-line install path does not even exist there.
 * @param {object} computer - registry record.
 * @returns {string} actionable upgrade hint.
 */
export function upgradeHint(computer) {
  return computer?.mode === 'embedded'
    ? '升级这台电脑的 DSH 插件（设置 → 插件市场 → 检查更新），然后重启 DSH。'
    : '重新运行安装命令 / 升级 agent（re-run the one-line install command on that machine to upgrade its agent）。'
}

/** Human feature labels for capability-denied reasons. */
const FEATURE_LABELS = Object.freeze({
  exec: 'remote command execution',
  fs: 'remote file access',
  jobs: 'background jobs',
  pty: 'an interactive terminal',
  tunnel: 'a relay tunnel',
})

/**
 * Create the permission authority for one plugin mount.
 *
 * `authorize()` is the ONLY gate every tool call goes through: capabilities,
 * host config, the operator version gate, the access.json session allow-list,
 * the computer's preset rule, activation and presence are combined here.
 *
 * @param {object} options - wiring.
 * @param {object} options.config - resolved plugin config (execEnabled, minAgentVersion).
 * @param {(computer: object) => boolean} [options.isOnline] - presence predicate.
 * @param {() => boolean} [options.hasJobs] - whether the DSH jobs registry is available.
 * @returns {object} `{ authorize, can, filterAuthorized }`.
 */
export function createPolicy({ config = {}, isOnline = () => false, hasJobs = () => true } = {}) {
  const minimumVersion = typeof config?.minAgentVersion === 'string' ? config.minAgentVersion : ''

  /**
   * May this session drive this computer with this operation?
   * @param {object} request - `{ computer, operation, session, access }`.
   * @returns {{allowed: true} | {allowed: false, code: string, reason: string}} decision.
   */
  const authorize = ({ computer, operation, session = null, access = null } = {}) => {
    const deny = (code, reason) => ({ allowed: false, code, reason })
    const rule = OPERATIONS.includes(operation) ? OPERATION_REQUIREMENTS[operation] : null
    if (rule === null) {
      return deny(DENY_CODES.UNKNOWN_OPERATION, `unknown operation '${String(operation)}' (not in the permission table)`)
    }
    if (!isPlainObject(computer) || typeof computer.id !== 'string' || computer.id === '') {
      return deny(DENY_CODES.COMPUTER_UNKNOWN, 'unknown computer: resolve a target from computer_list first')
    }
    const name = typeof computer.name === 'string' && computer.name !== '' ? computer.name : computer.id
    const sessionId = typeof session?.sessionId === 'string' && session.sessionId !== '' ? session.sessionId : null
    const presetId = typeof session?.presetId === 'string' && session.presetId !== '' ? session.presetId : 'default'

    // 1. Host config / host-side availability.
    // Only an explicit `false` disables execution (the resolved config always
    // carries the boolean; partial test configs default to enabled).
    if (rule.hostGate && config?.execEnabled === false) {
      return deny(DENY_CODES.HOST_DISABLED, 'computer_exec is disabled on this host (dsh-computers config execEnabled: false)')
    }
    if (rule.jobsService && hasJobs() !== true) {
      return deny(DENY_CODES.JOBS_UNAVAILABLE,
        'background execution is unavailable on this host: the DSH jobs registry is not loaded (load @deepseek-ai/dsh-tool-jobs in the composition)')
    }

    // 2. Operator-forced upgrade gate (the only version-based decision).
    if (rule.operatorGate && minimumVersion !== '' && !versionAtLeast(computer.agentVersion, minimumVersion)) {
      return deny(DENY_CODES.VERSION_BELOW_MINIMUM,
        `blocked by the operator version gate: computer '${name}' runs agent ${computer.agentVersion ?? 'unknown'}, `
        + `older than the required v${minimumVersion}. Ask the user to upgrade it: ${upgradeHint(computer)}`)
    }

    // 3. Capability rule (reported caps, never a version number).
    if (rule.feature !== null && !supports(computer, rule.feature)) {
      const caps = capsOf(computer)
      const label = rule.label !== '' ? rule.label : (FEATURE_LABELS[rule.feature] ?? rule.feature)
      return deny(DENY_CODES.CAPABILITY_MISSING,
        `blocked by the capability rule: computer '${name}' does not support ${label}: `
        + `the '${rule.feature}' capability is missing (reported caps: ${JSON.stringify(caps)}). `
        + `Ask the user to upgrade it: ${upgradeHint(computer)}`)
    }

    // 4. Activation (an enrollment that never streamed is not usable).
    if (rule.activation && typeof computer.activatedAt !== 'string') {
      return deny(DENY_CODES.NOT_ACTIVATED,
        `blocked by the activation rule: computer '${name}' has not completed its first connection. `
        + 'Ask the user to reconnect it, then run computer_list again.')
    }

    // 5. Access rules from access.json (session allow-list, then preset rule).
    if (rule.access && access !== null && access !== undefined) {
      if (access.sessionAllows(sessionId, computer.id) === false) {
        return deny(DENY_CODES.SESSION_DENIED,
          `blocked by the session allow-list: computer '${name}' is not accessible to this conversation (Agent preset '${presetId}'). `
          + 'Ask the user to grant access in 管理访问权 (Access management) for this conversation, then retry.')
      }
      if (access.presetAllows(computer.id, presetId) === false) {
        return deny(DENY_CODES.PRESET_DENIED,
          `blocked by the computer's preset rule: computer '${name}' is not accessible to this conversation (Agent preset '${presetId}'). `
          + "Ask the user to enable that Bot in the computer's access dialog (管理访问权), then retry.")
      }
    }

    // 6. Presence (application-level: the computer must be connected now).
    if (rule.presence && isOnline(computer) !== true) {
      return deny(DENY_CODES.OFFLINE,
        `blocked by the presence rule: computer '${name}' is offline; run computer_list to see which computers are connected, `
        + 'and ask the user to wake or reconnect it')
    }

    return { allowed: true }
  }

  /** Capability check for non-authoritative UI decisions (never a gate by itself). */
  const can = (computer, feature) => supports(computer, feature)

  /** Only the computers this caller may use for an operation (silently drops denied). */
  const filterAuthorized = (computers, { operation, session = null, access = null } = {}) =>
    (Array.isArray(computers) ? computers : []).filter((computer) =>
      authorize({ computer, operation, session, access }).allowed)

  return { authorize, can, filterAuthorized }
}
