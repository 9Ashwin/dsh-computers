/**
 * Test helpers for the dsh-computers agent. Importing this module has no side
 * effects, so `node --test agent/test/` may execute it as a (trivially empty)
 * test file in older Node versions.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const agentPath = fileURLToPath(new URL('../dsh-computers-agent.mjs', import.meta.url))

export async function tempHome(prefix = 'dshc-agent-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export function cliEnv(home, extra = {}) {
  return { ...process.env, DSH_COMPUTERS_HOME: home, ...extra }
}

/** Run the agent CLI once. Resolves with { code, stdout, stderr } for both success and failure. */
export function runCli(args, { home, env = {}, timeoutMs = 30_000 } = {}) {
  return runNode([agentPath, ...args], { home, env, timeoutMs })
}

/** Run an arbitrary node invocation (e.g. `-e <script>`). */
export function runNode(args, { home, env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      {
        env: cliEnv(home, env),
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        let code = 0
        if (error) {
          if (typeof error.code === 'number') code = error.code
          else code = error.killed ? 124 : 1
        }
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: Boolean(error?.killed),
        })
      },
    )
  })
}

export function runNodeEval(script, options = {}) {
  return runNode(['--input-type=module', '-e', script], options)
}

/**
 * Spawn a node process with captured stdout/stderr and a tolerant stop().
 * Used for `agent run` (CLI) and for `-e` scripts exercising startRuntime().
 */
export function spawnCaptured(args, { home, env = {} } = {}) {
  const child = spawn(process.execPath, args, {
    env: cliEnv(home, env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const state = { stdout: '', stderr: '', exitCode: null, signal: null, exited: false }
  child.stdout.on('data', (chunk) => {
    state.stdout += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    state.stderr += String(chunk)
  })
  const closed = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      state.exitCode = code
      state.signal = signal
      state.exited = true
      resolve({ code, signal })
    })
  })

  const stop = async () => {
    if (state.exited) return { code: state.exitCode, signal: state.signal }
    child.kill('SIGTERM')
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, 8000)
    const result = await closed
    clearTimeout(force)
    return result
  }

  const waitForOutput = (pattern, { timeoutMs = 10_000 } = {}) =>
    new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const tick = () => {
        const output = state.stdout + state.stderr
        if (pattern.test(output)) return resolve(output)
        if (state.exited) return reject(new Error(`process exited before matching ${pattern}:\n${output}`))
        if (Date.now() - startedAt > timeoutMs) return reject(new Error(`timed out waiting for ${pattern}:\n${output}`))
        setTimeout(tick, 25)
      }
      tick()
    })

  return {
    child,
    state,
    closed,
    stop,
    waitForOutput,
    /** Send one line to the child's stdin (used by the embedded-runtime test). */
    sendLine(line) {
      child.stdin.write(`${line}\n`)
    },
    get stdout() {
      return state.stdout
    },
    get stderr() {
      return state.stderr
    },
    get output() {
      return state.stdout + state.stderr
    },
  }
}

/** Spawn `agent run` in the background. */
export function startAgent({ home, env = {} } = {}) {
  return spawnCaptured([agentPath, 'run'], { home, env })
}

/** Spawn an inline ESM script (`node --input-type=module -e`) with stdin. */
export function spawnNodeEval(script, { home, env = {} } = {}) {
  return spawnCaptured(['--input-type=module', '-e', script], { home, env })
}

export async function readConfig(home) {
  return JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8'))
}

export async function readLog(home) {
  try {
    return await fs.readFile(path.join(home, 'agent.log'), 'utf8')
  } catch {
    return ''
  }
}

/** Enroll against the mock server and return { key, result, config }. */
export async function enrollAgent(mock, home, options = {}) {
  const key = options.key || mock.createEnrollKey({ replace: true })
  const args = ['enroll', '--server', mock.url, '--key', key, ...(options.extraArgs || [])]
  const result = await runCli(args, { home, ...options.runOptions })
  if (result.code !== 0) {
    throw new Error(`enroll failed (exit ${result.code})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return { key, result, config: await readConfig(home) }
}

export async function waitUntil(predicate, { timeoutMs = 10_000, interval = 50, label = 'condition' } = {}) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/**
 * Live processes that are actually running `marker` (a shell command), i.e. the
 * `sh -lc <marker>` wrapper we spawn or the command it exec'd into.
 *
 * Deliberately NOT a plain substring match on `ps -axo command`: the parent
 * shell that invokes the test runner may mention the marker in its own command
 * line (e.g. a CI step that greps for it), which would look like a leak.
 * Returns [] when ps is unavailable.
 */
export function findProcessCommands(marker) {
  const isSpawnedCommand = (line) => {
    const text = line.trimEnd()
    return (
      text === marker ||
      text.endsWith(` -lc ${marker}`) ||
      text.endsWith(` -c ${marker}`) ||
      text.endsWith(` -l -c ${marker}`)
    )
  }
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'command'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([])
      resolve(String(stdout).split('\n').filter(isSpawnedCommand))
    })
  })
}
