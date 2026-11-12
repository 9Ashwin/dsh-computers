/**
 * Remote skills for the DSH slash menu (v1.9.0).
 *
 * Every connected computer's agent reports the skills that live ON THAT MACHINE
 * (`skills: [{ name, description, whenToUse?, path? }]`). This module turns that
 * report into a DSH skill provider: `list()` emits one candidate per skill named
 * `<machineSlug>-<skillName>`, and `get()` loads `<path>/SKILL.md` from the
 * machine over the existing fs channel — no new port, no new credential.
 *
 * The provider contract is the live DSH one (verified against the running
 * `skills` service):
 *   registerProvider((control) => ({ name, list(options), get(candidate, options) }))
 *   list -> SkillCandidate[] | { candidates, complete }
 *   get  -> SkillDefinition | undefined
 *
 * Invariants:
 * - only ONLINE computers contribute candidates: a skill you cannot load is not
 *   a skill, so an offline machine contributes nothing (the `computer_skills`
 *   tool is the inventory view and does include them, marked offline);
 * - every name is unique within the provider (the registry keeps one winner per
 *   name), so slugging collisions get `-2`, `-3`, … suffixes;
 * - `get` NEVER throws: an offline machine, a vanished file, an agent that
 *   cannot read files or a malformed candidate all resolve to `undefined`.
 *
 * Node builtins only.
 */

import { supports } from './policy.js'

/** Provider name reported in every summary (`provider` field). */
export const PROVIDER_NAME = 'dsh-computers'

/** The file that defines one skill inside its directory. */
export const SKILL_FILE_NAME = 'SKILL.md'

/** Every remote skill is an operator-provided custom skill. */
const SKILL_SOURCE = 'custom'

/** Provider candidates rank below project/bundled skills; the registry decides ties. */
const SKILL_RANK = 50

/** Caps mirror the agent-side report (PROTOCOL §12 / task v1.9.0a). */
const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 200
const MAX_WHEN_TO_USE_LENGTH = 200

/** A reported skill name must already be kebab-case (the agent drops anything else). */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Absolute POSIX or Windows path (the agent's fs ops require absolute paths). */
const isAbsolutePath = (value) => typeof value === 'string' && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value.trim())

/** Trim text to a character budget (no surrogate splitting: these are short fields). */
function capText(text, max) {
  if (typeof text !== 'string') return ''
  const value = text.trim()
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Slug one machine name for a skill prefix: lowercase, every run of
 * non-alphanumerics becomes one `-`, trim the edges, fall back to `computer`.
 * @param {string} value - machine display name.
 * @returns {string} kebab-case slug.
 */
export function machineSlug(value) {
  const text = typeof value === 'string' ? value : ''
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  return slug === '' ? 'computer' : slug
}

/** Unquote one YAML scalar (single/double quoted) and unescape the common cases. */
function unquote(value) {
  const text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

/** Frontmatter keys this parser understands (aliases folded to one field). */
const FRONTMATTER_FIELDS = new Map([
  ['name', 'name'],
  ['description', 'description'],
  ['whentouse', 'whenToUse'],
  ['when_to_use', 'whenToUse'],
  ['when-to-use', 'whenToUse'],
])

/**
 * Parse the YAML-frontmatter subset a `SKILL.md` uses: `---` fenced
 * `name`/`description`/`whenToUse` scalars (quoted, plain, or `|`/`>` block
 * scalars). Anything else in the block is ignored rather than fatal.
 * @param {string} source - raw SKILL.md text.
 * @returns {{ frontmatter: object, body: string, hasFrontmatter: boolean }} parsed parts.
 */
export function parseSkillDocument(source) {
  const text = typeof source === 'string' ? source.replace(/^\uFEFF/, '') : ''
  const lines = text.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { frontmatter: {}, body: text.trim(), hasFrontmatter: false }
  }
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index
      break
    }
  }
  if (end === -1) return { frontmatter: {}, body: text.trim(), hasFrontmatter: false }

  /** @type {Record<string, string>} */
  const frontmatter = {}
  let index = 1
  while (index < end) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[index])
    if (match === null) {
      index += 1
      continue
    }
    const field = FRONTMATTER_FIELDS.get(match[1].toLowerCase())
    if (field === undefined) {
      index += 1
      continue
    }
    const raw = match[2].trim()
    // Block scalars (`description: |` / `>`) continue on the following indented lines.
    if (/^[|>][+-]?$/.test(raw)) {
      const folded = raw.startsWith('>')
      const block = []
      index += 1
      while (index < end && (/^\s/.test(lines[index]) || lines[index].trim() === '')) {
        block.push(lines[index].replace(/^\s{1,4}/, ''))
        index += 1
      }
      while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()
      frontmatter[field] = folded ? block.join(' ').trim() : block.join('\n').trim()
      continue
    }
    frontmatter[field] = unquote(raw)
    index += 1
  }
  return { frontmatter, body: lines.slice(end + 1).join('\n').trim(), hasFrontmatter: true }
}

/** First non-empty body line, stripped of markdown heading marks (description fallback). */
function firstBodyLine(body) {
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const value = line.replace(/^#+\s*/, '').trim()
    if (value !== '') return value
  }
  return ''
}

/**
 * Normalize one reported skill entry; null when it is unusable.
 * @param {unknown} entry - `{ name, description?, whenToUse?, path? }` from the agent.
 * @returns {{ name: string, description: string, whenToUse: string|null, path: string|null } | null} normalized skill.
 */
export function normalizeSkill(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const rawName = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (rawName === '') return null
  // The agent guarantees kebab-case; a hand-written or older report is slugged
  // instead of dropped so the skill still shows up.
  const name = SKILL_NAME_PATTERN.test(rawName) ? rawName : machineSlug(rawName)
  if (name === '') return null
  const description = capText(typeof entry.description === 'string' ? entry.description : '', MAX_DESCRIPTION_LENGTH)
  const whenToUse = typeof entry.whenToUse === 'string' && entry.whenToUse.trim() !== ''
    ? capText(entry.whenToUse, MAX_WHEN_TO_USE_LENGTH)
    : null
  // `path` is optional in the report (the agent may send `dir` instead); an
  // absolute path is the skill's DIRECTORY, the host appends SKILL.md.
  const reported = isAbsolutePath(entry.path) ? entry.path : (isAbsolutePath(entry.dir) ? entry.dir : null)
  const path = reported === null ? null : reported.trim().replace(/[\\/]+$/, '')
  return { name, description, whenToUse, path }
}

/**
 * The skills a registry record reports (tolerating an absent/malformed report,
 * and an older agent that nested it under `metadata`).
 * @param {object} computer - registry record.
 * @returns {Array<{name: string, description: string, whenToUse: string|null, path: string|null}>} normalized skills.
 */
export function skillsOf(computer) {
  if (computer === null || typeof computer !== 'object') return []
  const raw = Array.isArray(computer.skills)
    ? computer.skills
    : (computer.metadata !== null && typeof computer.metadata === 'object' && Array.isArray(computer.metadata.skills)
      ? computer.metadata.skills
      : [])
  const seen = new Set()
  const skills = []
  for (const entry of raw) {
    const skill = normalizeSkill(entry)
    if (skill === null || seen.has(skill.name)) continue
    seen.add(skill.name)
    skills.push(skill)
  }
  return skills
}

/** Trim a name to `limit` characters at a dash boundary so it stays kebab-case. */
function fitName(value, limit) {
  if (value.length <= limit) return value
  const cut = value.slice(0, limit)
  const trimmed = cut.replace(/-+$/, '')
  return trimmed === '' ? cut.slice(0, limit).replace(/-+$/, '') : trimmed
}

/**
 * Build the slash-menu name for one skill, bounded to 64 kebab-case characters.
 * The machine prefix is trimmed first so the skill name stays recognizable.
 * @param {string} slug - machine slug.
 * @param {string} skillName - kebab-case skill name.
 * @returns {string} candidate name (no duplicate suffix yet).
 */
export function composeSkillName(slug, skillName) {
  const suffix = skillName === '' ? '' : `-${skillName}`
  const room = MAX_NAME_LENGTH - suffix.length
  if (room < 1) {
    // Pathological name: keep a usable prefix of the skill name alone.
    return fitName(skillName, MAX_NAME_LENGTH) || 'skill'
  }
  const prefix = fitName(slug, room) || 'computer'
  return `${prefix}${suffix}`
}

/**
 * Append a numeric suffix until the name is unused (mutates `used`).
 * @param {string} base - candidate name.
 * @param {Set<string>} used - names already taken in this catalog.
 * @returns {string} a unique name.
 */
function uniqueName(base, used) {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const marker = `-${suffix}`
    const name = `${fitName(base, MAX_NAME_LENGTH - marker.length)}${marker}`
    if (!used.has(name)) {
      used.add(name)
      return name
    }
  }
  return `${fitName(base, MAX_NAME_LENGTH - 9)}-${Date.now().toString(36)}`
}

/** Display name for one record (the id is the last resort, never empty). */
const machineNameOf = (computer) => {
  const name = typeof computer?.name === 'string' ? computer.name.trim() : ''
  return name === '' ? String(computer?.id ?? 'computer') : name
}

/**
 * Collect the skills of the given records into sorted, uniquely named rows.
 *
 * Both surfaces share this: the provider (`onlineOnly: true`) and the
 * `computer_skills` inventory tool (`onlineOnly: false`, so an offline machine
 * is still listed with its last report).
 *
 * @param {Iterable<object>} computers - registry records.
 * @param {object} [options] - filtering.
 * @param {(computer: object) => boolean} [options.isOnline] - presence predicate.
 * @param {boolean} [options.onlineOnly] - drop records that are not online (default true).
 * @returns {Array<{computer: object, machineName: string, skill: object, path: string|null, catalogName: string, online: boolean}>} sorted rows.
 */
export function collectSkills(computers, { isOnline = () => false, onlineOnly = true } = {}) {
  const rows = []
  for (const computer of Array.isArray(computers) ? computers : []) {
    if (computer === null || typeof computer !== 'object') continue
    // §11.6.4: an enrollment that never streamed is not a usable computer.
    if (typeof computer.activatedAt !== 'string') continue
    const online = isOnline(computer) === true
    if (onlineOnly && !online) continue
    const machineName = machineNameOf(computer)
    for (const skill of skillsOf(computer)) {
      // The locator carries the directory the host will read from: the agent's
      // reported path when it sent one, else the first workspace convention.
      const path = skillDirectoriesOf(computer, skill)[0] ?? null
      rows.push({ computer, machineName, skill, path, catalogName: '', online })
    }
  }
  // Stable order: machine name, then skill name, then id (ids break exact ties).
  rows.sort((left, right) =>
    left.machineName.localeCompare(right.machineName)
    || left.skill.name.localeCompare(right.skill.name)
    || String(left.computer.id).localeCompare(String(right.computer.id)))
  const used = new Set()
  for (const row of rows) {
    row.catalogName = uniqueName(composeSkillName(machineSlug(row.machineName), row.skill.name), used)
  }
  return rows
}

/**
 * The directory holding a skill's SKILL.md.
 *
 * The agent reports the directory it scanned when it can; when it does not, the
 * only machine-specific base the host knows is the reported workspace base, so
 * the workspace skill directories are tried in the documented order. Home
 * directories (`~/.dsh/skills`, `~/.agents/skills`) cannot be synthesized —
 * those skills need the reported path.
 *
 * @param {object} computer - registry record.
 * @param {{name: string, path?: string|null}} skill - normalized skill.
 * @returns {string[]} candidate directories, most specific first (may be empty).
 */
export function skillDirectoriesOf(computer, skill) {
  const directories = []
  const reported = typeof skill?.path === 'string' && isAbsolutePath(skill.path)
    ? skill.path.trim().replace(/[\\/]+$/, '')
    : null
  if (reported !== null) directories.push(reported)
  const base = typeof computer?.workspaceBase === 'string' && isAbsolutePath(computer.workspaceBase)
    ? computer.workspaceBase.trim().replace(/[\\/]+$/, '')
    : null
  const name = typeof skill?.name === 'string' ? skill.name : ''
  if (base !== null && name !== '') {
    const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
    for (const dir of ['.dsh/skills', '.agents/skills']) {
      const candidate = `${base}${separator}${dir.split('/').join(separator)}${separator}${name}`
      if (!directories.includes(candidate)) directories.push(candidate)
    }
  }
  return directories
}

/** Extract text from an fs `read` response (text or base64 `content`). */
function textOfResponse(response) {
  if (response === null || typeof response !== 'object' || response.ok === false) return null
  if (typeof response.text === 'string') return response.text
  if (typeof response.content === 'string') {
    try {
      return Buffer.from(response.content, 'base64').toString('utf8')
    } catch {
      return null
    }
  }
  return null
}

/** Join a directory and the skill file name with the machine's separator style. */
function joinSkillFile(directory) {
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/'
  return `${directory}${separator}${SKILL_FILE_NAME}`
}

/** Message for one failed provider operation (never fatal). */
const describeError = (error) => (error && typeof error.message === 'string' ? error.message : String(error))

/**
 * Create the remote-skills provider for one plugin mount.
 *
 * @param {object} options - wiring.
 * @param {object} options.hub - SSE hub (`isOnline(computer)`).
 * @param {object} options.fsOps - remote file dispatcher (`request({...})`), may be null.
 * @param {() => object[]} options.computers - registry records (a live snapshot each call).
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 * @returns {object} `{ provider, list, get, inventory, invalidate, attachControl }`.
 */
export function createComputerSkills({ hub, fsOps, computers, onWarn = () => {} }) {
  /** The registration's lifecycle control (set by the registerProvider factory). */
  let control = null
  /** Last catalog fingerprint, so a changed machine/skill set invalidates the cache once. */
  let lastFingerprint = null

  /** The current registry records (never throws). */
  const records = () => {
    try {
      const value = typeof computers === 'function' ? computers() : computers
      if (Array.isArray(value)) return value
      if (value !== null && typeof value === 'object' && typeof value.read === 'function') {
        const document = value.read()
        return Array.isArray(document?.computers) ? document.computers : []
      }
      return []
    } catch (error) {
      onWarn(`dsh-computers: cannot read the computer registry for skills: ${describeError(error)}`)
      return []
    }
  }

  /** Presence predicate, tolerant of a missing/broken hub. */
  const isOnline = (computer) => {
    try {
      return hub !== null && hub !== undefined && typeof hub.isOnline === 'function' && hub.isOnline(computer) === true
    } catch {
      return false
    }
  }

  /** A stable fingerprint of what the catalog would contain (online machines + skill names). */
  const fingerprintOf = (rows) => rows
    .map((row) => `${row.computer.id}:${row.catalogName}`)
    .join('\n')

  /**
   * The current catalog rows (online machines only).
   * @param {{onlineOnly?: boolean}} [options] - inventory mode includes offline machines.
   */
  const inventory = ({ onlineOnly = true } = {}) =>
    collectSkills(records(), { isOnline, onlineOnly })

  /**
   * Ask the skills registry to drop its cached catalog. A machine connecting or
   * a new skill report changes what the slash menu should show; the registry
   * caches per revision until someone invalidates. Never throws.
   */
  const invalidate = () => {
    if (control === null || typeof control.invalidate !== 'function') return
    try {
      control.invalidate()
    } catch (error) {
      onWarn(`dsh-computers: could not invalidate the skill catalog: ${describeError(error)}`)
    }
  }

  /**
   * Invalidate on the NEXT turn, never during the discovery that noticed the
   * change: the registry is mid-`list()` right now, and re-entering its cache
   * from inside a provider is how a catalog thrashes.
   */
  const scheduleInvalidate = () => {
    try {
      setTimeout(() => invalidate(), 0).unref?.()
    } catch {
      // A host without timers still works; the next natural reload re-lists.
    }
  }

  /**
   * List every ONLINE computer's skills as DSH candidates.
   * @param {{cwd?: string, signal?: AbortSignal}} [options] - registry lookup options.
   * @returns {Promise<Array<object>>} candidates (sorted by machine, then skill).
   */
  const list = async (options = {}) => {
    try {
      const signal = options?.signal ?? control?.signal
      if (signal?.aborted) return []
      const rows = inventory({ onlineOnly: true })
      const fingerprint = fingerprintOf(rows)
      if (lastFingerprint !== null && lastFingerprint !== fingerprint) scheduleInvalidate()
      lastFingerprint = fingerprint
      return rows.map((row) => {
        const detail = row.skill.description === '' ? 'a skill on this machine' : row.skill.description
        return {
          name: row.catalogName,
          description: `[${row.machineName}] ${detail}`,
          ...(row.skill.whenToUse === null ? {} : { whenToUse: row.skill.whenToUse }),
          source: SKILL_SOURCE,
          provider: PROVIDER_NAME,
          invocation: { modelInvocable: true, userInvocable: true },
          rank: SKILL_RANK,
          locator: {
            computerId: String(row.computer.id),
            machineName: row.machineName,
            skillName: row.skill.name,
            path: row.path,
          },
          metadata: { computer: row.machineName },
        }
      })
    } catch (error) {
      // A broken report must never take the slash menu down with it.
      onWarn(`dsh-computers: cannot list remote skills: ${describeError(error)}`)
      return []
    }
  }

  /**
   * Load one skill's SKILL.md from the machine that owns it.
   * @param {object} candidate - a candidate returned by {@link list}.
   * @param {{cwd?: string, signal?: AbortSignal}} [options] - registry lookup options.
   * @returns {Promise<object|undefined>} the definition, or undefined when it cannot be read.
   */
  const get = async (candidate, options = {}) => {
    try {
      const signal = options?.signal ?? control?.signal
      if (signal?.aborted) return undefined
      const locator = candidate !== null && typeof candidate === 'object' ? candidate.locator : null
      if (locator === null || typeof locator !== 'object') return undefined
      const computerId = typeof locator.computerId === 'string' ? locator.computerId : ''
      const skillName = typeof locator.skillName === 'string' ? locator.skillName : ''
      if (computerId === '' || skillName === '') return undefined
      if (fsOps === null || fsOps === undefined || typeof fsOps.request !== 'function') return undefined
      const computer = records().find((entry) => entry !== null && typeof entry === 'object' && entry.id === computerId)
      if (computer === undefined) return undefined
      // A skill you cannot load right now is not a skill: offline → undefined.
      if (!isOnline(computer)) return undefined
      // An agent that cannot read files would take the full 15 s fs timeout to
      // say so; answer immediately instead.
      if (!supports(computer, 'fs')) return undefined
      const machineName = machineNameOf(computer)
      const directories = skillDirectoriesOf(computer, {
        name: skillName,
        path: typeof locator.path === 'string' ? locator.path : null,
      })
      let content = null
      let loadedPath = null
      for (const directory of directories) {
        const file = joinSkillFile(directory)
        let response
        try {
          response = await fsOps.request({
            computerId,
            name: machineName,
            op: 'read',
            payload: { path: file },
            ...(signal === undefined || signal === null ? {} : { signal }),
          })
        } catch {
          // Not there (or the agent cannot read files): try the next location.
          continue
        }
        const text = textOfResponse(response)
        if (text === null) continue
        content = text
        loadedPath = file
        break
      }
      if (content === null || loadedPath === null) return undefined
      const parsed = parseSkillDocument(content)
      const frontmatterName = typeof parsed.frontmatter.name === 'string' && parsed.frontmatter.name.trim() !== ''
        ? parsed.frontmatter.name.trim()
        : skillName
      const fallbackDescription = firstBodyLine(parsed.body)
      const description = capText(
        typeof parsed.frontmatter.description === 'string' && parsed.frontmatter.description.trim() !== ''
          ? parsed.frontmatter.description
          : (fallbackDescription === '' ? (candidate.description ?? '') : fallbackDescription),
        MAX_DESCRIPTION_LENGTH,
      )
      const whenToUse = typeof parsed.frontmatter.whenToUse === 'string' && parsed.frontmatter.whenToUse.trim() !== ''
        ? capText(parsed.frontmatter.whenToUse, MAX_WHEN_TO_USE_LENGTH)
        : (typeof candidate.whenToUse === 'string' ? candidate.whenToUse : undefined)
      const body = parsed.body !== '' ? parsed.body : content.trim()
      return {
        // The catalog name is what the registry and the slash menu key on.
        name: typeof candidate.name === 'string' && candidate.name !== '' ? candidate.name : skillName,
        description,
        ...(whenToUse === undefined ? {} : { whenToUse }),
        content: body,
        path: loadedPath,
        source: SKILL_SOURCE,
        provider: PROVIDER_NAME,
        invocation: { modelInvocable: true, userInvocable: true },
        metadata: { computer: machineName, computerId, skill: frontmatterName },
        resourceBase: {
          kind: 'opaque',
          description: `This skill lives on ${machineName}: use computer_read / computer_exec with computer="${machineName}" for its resources.`,
        },
      }
    } catch (error) {
      // Never let one bad skill break the catalog load.
      onWarn(`dsh-computers: cannot load a remote skill: ${describeError(error)}`)
      return undefined
    }
  }

  return {
    provider: { name: PROVIDER_NAME, list, get },
    list,
    get,
    inventory,
    invalidate,
    /** Called by the `registerProvider` factory with the registration's control. */
    attachControl(next) {
      control = next
    },
  }
}
