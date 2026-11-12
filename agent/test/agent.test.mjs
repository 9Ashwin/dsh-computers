/**
 * End-to-end tests for agent/dsh-computers-agent.mjs against the in-memory
 * mock server. Run with: `node --test agent/test/`.
 *
 * Everything is observed from the outside (CLI process + HTTP mock), which is
 * exactly how the host plugin will use the agent.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { AGENT_VERSION, LIVENESS } from '../dsh-computers-agent.mjs'
import { MockComputerServer } from './mock-server.mjs'
import {
  agentPath,
  enrollAgent,
  findProcessCommands,
  readConfig,
  readLog,
  runCli,
  runNodeEval,
  spawnNodeEval,
  startAgent,
  tempHome,
  waitUntil,
} from './helpers.mjs'

/** Parse one `PREFIX {json}` line out of a child process' captured stdout. */
function readJsonLine(output, prefix) {
  const line = output.split('\n').find((candidate) => candidate.startsWith(prefix))
  assert.ok(line, `missing "${prefix.trim()}" line in output:\n${output}`)
  return JSON.parse(line.slice(prefix.length))
}

/** Push one fs request and wait for its result (PROTOCOL §11.3). */
async function fsCall(mock, request, { timeoutMs = 20_000 } = {}) {
  const requestId = mock.pushFs(request)
  return { requestId, result: await mock.waitForFsResult(requestId, { timeoutMs }) }
}

async function setup(t, options = {}) {
  const mock = new MockComputerServer(options)
  await mock.start()
  const home = await tempHome()
  t.after(async () => {
    await mock.stop()
    await rmQuiet(home)
  })
  return { mock, home }
}

async function rmQuiet(target) {
  try {
    await fs.rm(target, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

test('--help prints usage and exits 0', async (t) => {
  const { home } = await setup(t)
  const result = await runCli(['--help'], { home })
  assert.equal(result.code, 0)
  for (const needle of ['enroll', 'run', 'service', 'status', 'DSH_COMPUTERS_HOME', 'install', 'uninstall']) {
    assert.ok(result.stdout.includes(needle), `--help should mention ${needle}`)
  }
  assert.ok(result.stdout.includes('dsh-computers-agent'))
})

test('--version prints a bare semver', async (t) => {
  const { home } = await setup(t)
  const result = await runCli(['--version'], { home })
  assert.equal(result.code, 0)
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/)
})

test('unknown command exits non-zero with usage', async (t) => {
  const { home } = await setup(t)
  const result = await runCli(['frobnicate'], { home })
  assert.equal(result.code, 1)
  assert.ok(result.stderr.includes('未知命令'))
  assert.ok(result.stderr.includes('enroll'))
})

test('status without enrollment exits 1 and explains how to enroll', async (t) => {
  const { home } = await setup(t)
  const result = await runCli(['status'], { home })
  assert.equal(result.code, 1)
  assert.ok(result.stdout.includes('未注册'))
  assert.ok(result.stdout.includes('enroll'))
})

// ---------------------------------------------------------------------------
// enroll
// ---------------------------------------------------------------------------

test('enroll rejects an unknown key without writing config', async (t) => {
  const { mock, home } = await setup(t)
  const result = await runCli(['enroll', '--server', mock.url, '--key', 'dshc_not_a_real_key'], { home })
  assert.equal(result.code, 1)
  assert.ok(result.stderr.includes('invalid-key'), result.stderr)
  assert.ok(!existsSync(path.join(home, 'config.json')))
})

test('enroll rejects an expired key (410 key-expired)', async (t) => {
  const { mock, home } = await setup(t)
  const key = mock.createEnrollKey({ ttlMs: -1000 })
  const result = await runCli(['enroll', '--server', mock.url, '--key', key], { home })
  assert.equal(result.code, 1)
  assert.ok(result.stderr.includes('key-expired'), result.stderr)
  assert.ok(!existsSync(path.join(home, 'config.json')))
})

test('enroll rejects a re-used key (409 key-used)', async (t) => {
  const { mock, home } = await setup(t)
  const key = mock.createEnrollKey({ replace: true })
  const first = await runCli(['enroll', '--server', mock.url, '--key', key], { home })
  assert.equal(first.code, 0, first.stderr)
  const second = await runCli(['enroll', '--server', mock.url, '--key', key], { home })
  assert.equal(second.code, 1)
  assert.ok(second.stderr.includes('key-used'), second.stderr)
})

test('enroll misses --server / --key with a clear message', async (t) => {
  const { home } = await setup(t)
  const noServer = await runCli(['enroll', '--key', 'dshc_x'], { home })
  assert.equal(noServer.code, 1)
  assert.ok(noServer.stderr.includes('--server'))
  const noKey = await runCli(['enroll', '--server', 'http://127.0.0.1:1'], { home })
  assert.equal(noKey.code, 1)
  assert.ok(noKey.stderr.includes('--key'))
})

test('enroll happy path: saves 0600 config atomically, proves SSE, hides token', async (t) => {
  const { mock, home } = await setup(t)
  const key = mock.createEnrollKey({ replace: true })
  const result = await runCli(['enroll', '--server', mock.url, '--key', key, '--name', 'Test Mac Book'], { home })

  assert.equal(result.code, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
  assert.ok(result.stdout.includes('✓ 已连接'), result.stdout)
  assert.ok(result.stdout.includes('Test Mac Book'), result.stdout)
  assert.ok(result.stdout.includes(mock.url), result.stdout)

  const configPath = path.join(home, 'config.json')
  const config = await readConfig(home)
  assert.equal(config.version, 1)
  assert.equal(config.serverUrl, mock.url)
  assert.match(config.computerId, /^cmp_[0-9a-f]{12}$/)
  assert.match(config.token, /^dshc_[A-Za-z0-9_-]{40,}$/)
  assert.equal(config.name, 'Test Mac Book')
  assert.ok(!Number.isNaN(Date.parse(config.enrolledAt)))

  const info = await fs.stat(configPath)
  assert.equal(info.mode & 0o777, 0o600, 'config.json must be 0600')
  const dirInfo = await fs.stat(home)
  assert.equal(dirInfo.mode & 0o777, 0o700, 'config dir should be 0700')

  // Atomic write: no temp leftovers.
  const leftovers = (await fs.readdir(home)).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [])

  // The token must never be printed.
  assert.ok(!result.stdout.includes(config.token))
  assert.ok(!result.stderr.includes(config.token))

  // The machine block matched PROTOCOL §3.1.
  const enrollment = await mock.waitForEnrollment()
  assert.equal(enrollment.agentVersion, AGENT_VERSION)
  assert.equal(enrollment.machine.os, process.platform)
  assert.equal(enrollment.machine.arch, process.arch)
  assert.equal(enrollment.machine.platform, process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'Linux' : 'Windows')
  assert.equal(enrollment.machine.nodeVersion, process.version)
  assert.equal(enrollment.machine.hostname, os.hostname())
  assert.ok(enrollment.machine.memoryBytes > 0)
  assert.ok(typeof enrollment.machine.cpuModel === 'string' && enrollment.machine.cpuModel.length > 0)

  // Enrollment probe opened and closed one SSE stream.
  assert.equal(mock.openStreamCount, 0)
  assert.ok(mock.streamCount >= 1)
})

test('re-enroll with --replace keeps the same computer id and rotates the token', async (t) => {
  const { mock, home } = await setup(t)
  const first = await enrollAgent(mock, home, { extraArgs: ['--name', 'Replace Mac'] })
  const secondKey = mock.createEnrollKey({ replace: true })
  const second = await runCli(['enroll', '--server', mock.url, '--key', secondKey, '--replace'], { home })
  assert.equal(second.code, 0, second.stderr)
  const config = await readConfig(home)
  assert.equal(config.computerId, first.config.computerId)
  assert.notEqual(config.token, first.config.token)
  assert.equal(mock.computers.size, 1)
  const enrollments = mock.enrollments
  assert.equal(enrollments.at(-1).replace, true, '--replace should be sent to the server')
})

test('status shows redacted token, server and service state', async (t) => {
  const { mock, home } = await setup(t)
  const { config } = await enrollAgent(mock, home, { extraArgs: ['--name', 'Status Mac'] })
  const result = await runCli(['status'], { home })
  assert.equal(result.code, 0, result.stderr)
  assert.ok(result.stdout.includes(mock.url))
  assert.ok(result.stdout.includes(config.computerId))
  assert.ok(result.stdout.includes('Status Mac'))
  assert.ok(result.stdout.includes(config.token.slice(-6)), 'shows the last 6 chars of the token')
  assert.ok(!result.stdout.includes(config.token), 'never prints the full token')
  assert.match(result.stdout, /dshc_…/)
  assert.ok(result.stdout.includes('服务'))
})

// ---------------------------------------------------------------------------
// run + exec
// ---------------------------------------------------------------------------

test('run requires enrollment', async (t) => {
  const { home } = await setup(t)
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  const exited = await Promise.race([
    agent.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('run did not exit without config')), 10_000)),
  ])
  assert.notEqual(exited.code, 0)
  assert.ok((agent.stderr + agent.stdout).includes('enroll'))
})

test('run connects over SSE, executes commands and posts §3.3 results', async (t) => {
  const { mock, home } = await setup(t)
  await enrollAgent(mock, home)
  const agent = startAgent({ home, env: { DSH_COMPUTERS_TEST_ENV: 'inherited' } })
  t.after(() => agent.stop())
  await mock.waitForStream()
  await agent.waitForOutput(/已连接/)

  // 1) exit code, stdout, stderr, duration.
  const first = mock.pushExec({ command: "printf 'hello\\n'; printf 'oops\\n' >&2; exit 3", timeoutMs: 10_000 })
  const firstResult = await mock.waitForResult(first)
  assert.equal(firstResult.requestId, first)
  assert.equal(firstResult.ok, false)
  assert.equal(firstResult.exitCode, 3)
  assert.equal(firstResult.signal, null)
  assert.equal(firstResult.stdout, 'hello\n')
  assert.equal(firstResult.stderr, 'oops\n')
  assert.equal(firstResult.timedOut, false)
  assert.equal(firstResult.truncated, false)
  assert.equal(firstResult.error, null)
  assert.ok(Number.isFinite(firstResult.durationMs) && firstResult.durationMs >= 0)
  assert.ok(firstResult.durationMs < 10_000)

  // 2) success + default cwd is the user's home directory.
  const success = mock.pushExec({ command: 'pwd' })
  const successResult = await mock.waitForResult(success)
  assert.equal(successResult.ok, true)
  assert.equal(successResult.exitCode, 0)
  assert.equal(await fs.realpath(successResult.stdout.trim()), await fs.realpath(os.homedir()))

  // 3) explicit cwd.
  const cwd = await tempHome('dshc-cwd-')
  t.after(() => rmQuiet(cwd))
  const explicit = mock.pushExec({ command: 'pwd', cwd })
  const explicitResult = await mock.waitForResult(explicit)
  assert.equal(await fs.realpath(explicitResult.stdout.trim()), await fs.realpath(cwd))

  // 4) environment is inherited.
  const envRequest = mock.pushExec({ command: 'printf "%s" "$DSH_COMPUTERS_TEST_ENV"' })
  const envResult = await mock.waitForResult(envRequest)
  assert.equal(envResult.stdout, 'inherited')

  // The token must never end up in the on-disk log either.
  const config = await readConfig(home)
  const log = await readLog(home)
  assert.ok(log.length > 0, 'run should write to agent.log')
  assert.ok(!log.includes(config.token), 'agent.log must not contain the token')
})

test('run kills the whole process group on timeout', async (t) => {
  const { mock, home } = await setup(t)
  await enrollAgent(mock, home)
  const agent = startAgent({ home, env: { DSH_COMPUTERS_TEST_ENV: 'inherited' } })
  t.after(() => agent.stop())
  await mock.waitForStream()

  const marker = 'sleep 31.25'
  const requestId = mock.pushExec({ command: marker, timeoutMs: 800 })
  const result = await mock.waitForResult(requestId)
  assert.equal(result.timedOut, true)
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, null)
  assert.equal(result.signal, 'SIGKILL')
  assert.ok(result.durationMs < 10_000, `timeout should fire quickly, got ${result.durationMs}ms`)

  // The killed command (and its shell) must be gone, not just reported dead.
  await waitUntil(async () => (await findProcessCommands(marker)).length === 0, {
    timeoutMs: 5000,
    label: `${marker} to disappear`,
  })

  // The agent itself must still be alive and serving.
  const after = mock.pushExec({ command: 'echo alive' })
  const afterResult = await mock.waitForResult(after)
  assert.equal(afterResult.stdout, 'alive\n')
})

test('run caps output streams at 1 MiB and flags truncation', async (t) => {
  const { mock, home } = await setup(t)
  await enrollAgent(mock, home)
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()

  const requestId = mock.pushExec({ command: 'yes x | head -c 3000000', timeoutMs: 30_000 })
  const result = await mock.waitForResult(requestId, { timeoutMs: 30_000 })
  assert.equal(result.truncated, true)
  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.ok(result.stdout.endsWith('[output truncated]'), 'truncation marker is appended')
  assert.ok(result.stdout.length >= 1024 * 1024, 'captured the full 1 MiB')
  assert.ok(result.stdout.length <= 1024 * 1024 + '\n[output truncated]'.length, 'never exceeds the cap')
})

test('run kills the process group on cancel and reports the cancellation', async (t) => {
  const { mock, home } = await setup(t)
  await enrollAgent(mock, home)
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()

  const marker = 'sleep 41.25'
  const requestId = mock.pushExec({ command: marker, timeoutMs: 60_000 })
  await waitUntil(async () => (await findProcessCommands(marker)).length > 0, {
    timeoutMs: 5000,
    label: `${marker} to start`,
  })

  // pushCancel settles the request server-side (like the host does), so the
  // result POST is answered with 404 and the agent must tolerate it.
  mock.pushCancel(requestId)
  const result = await mock.waitForRejectedResult(requestId, { timeoutMs: 15_000 })
  assert.equal(result.ok, false)
  assert.equal(result.signal, 'SIGKILL')
  assert.equal(result.exitCode, null)
  assert.equal(result.error, 'cancelled')

  await waitUntil(async () => (await findProcessCommands(marker)).length === 0, {
    timeoutMs: 5000,
    label: `${marker} to disappear`,
  })

  const after = mock.pushExec({ command: 'echo after-cancel' })
  const afterResult = await mock.waitForResult(after)
  assert.equal(afterResult.stdout, 'after-cancel\n')
})

test('run reconnects with backoff after the stream drops', async (t) => {
  const { mock, home } = await setup(t)
  await enrollAgent(mock, home)
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()

  // streamCount counts every stream ever opened (including the one the enroll
  // probe used), so wait for one MORE than the current total.
  const before = mock.streamCount
  mock.closeStreams()
  await mock.waitForStreamCount(before + 1, { timeoutMs: 10_000 })

  const requestId = mock.pushExec({ command: 'echo reconnected' })
  const result = await mock.waitForResult(requestId)
  assert.equal(result.stdout, 'reconnected\n')
})

test('run sends heartbeats and picks up the server display name', async (t) => {
  const { mock, home } = await setup(t, { heartbeatMs: 400 })
  await enrollAgent(mock, home)
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()

  const heartbeat = await mock.waitForHeartbeat({ timeoutMs: 10_000 })
  assert.equal(heartbeat.body.meta.agentVersion, AGENT_VERSION)
  assert.deepEqual(heartbeat.body.meta.capabilities, ['exec', 'fs'])
  assert.equal(heartbeat.body.meta.mode, 'service')
  assert.deepEqual(heartbeat.body.meta.caps, { exec: true, fs: true, jobs: true, pty: false, tunnel: false })
  assert.ok(heartbeat.body.meta.memoryBytes > 0)

  mock.pushConfig({ name: 'Renamed Mac' })
  await waitUntil(async () => (await readConfig(home)).name === 'Renamed Mac', {
    timeoutMs: 5000,
    label: 'config.json rename from a config event',
  })
})

test("run exits non-zero only for the plugin's JSON invalid-token 401 (no retry)", async (t) => {
  const { mock, home } = await setup(t)
  await enrollAgent(mock, home)
  const streamsBefore = mock.streamCount
  const eventsBefore = mock.requests.filter((request) => request.pathname.endsWith('/agent/events')).length
  mock.revokeTokens()
  const agent = startAgent({ home })
  t.after(() => agent.stop())

  const exited = await Promise.race([
    agent.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('agent kept retrying after 401')), 10_000)),
  ])
  assert.notEqual(exited.code, 0)
  assert.equal(mock.streamCount, streamsBefore, 'a 401 must not open a stream')

  const eventsRequests = mock.requests.filter((request) => request.pathname.endsWith('/agent/events')).length
  assert.equal(eventsRequests - eventsBefore, 1, 'a 401 must not be retried')
  const outputAndLog = agent.output + (await readLog(home))
  assert.match(outputAndLog, /401/)
  assert.match(outputAndLog, /invalid-token/)
  assert.match(agent.output, /enroll/)
})

test('enroll fails clearly when the server is unreachable', async (t) => {
  const { home } = await setup(t)
  const result = await runCli(['enroll', '--server', 'http://127.0.0.1:1', '--key', 'dshc_x'], { home, timeoutMs: 20_000 })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /无法连接/)
})

test('agent.log rotates at 5 MiB keeping one .1 file', async (t) => {
  const { mock, home } = await setup(t)
  await enrollAgent(mock, home)
  const logPath = path.join(home, 'agent.log')
  // Pretend the log already grew past the cap, then make the agent log a line.
  await fs.writeFile(logPath, 'x'.repeat(5 * 1024 * 1024 + 1), { mode: 0o600 })
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()

  await waitUntil(async () => existsSync(`${logPath}.1`), { timeoutMs: 10_000, label: 'agent.log.1 to appear' })
  const rotated = await fs.stat(`${logPath}.1`)
  assert.ok(rotated.size > 5 * 1024 * 1024, 'rotated file keeps the old content')
  const current = await fs.readFile(logPath, 'utf8')
  assert.ok(current.includes('dsh-computers-agent'), 'new log has the new line only')
  assert.ok(current.length < 64 * 1024, 'current log starts fresh after rotation')
})

// ---------------------------------------------------------------------------
// 401 transient-vs-fatal classification (plugin reload must not break machines)
// ---------------------------------------------------------------------------

test('run retries a foreign 401 (bare text / other JSON) instead of exiting', async (t) => {
  const { mock, home } = await setup(t)
  await enrollAgent(mock, home)
  const streamsBefore = mock.streamCount
  // A plugin reload / generic /api gateway fence: not our JSON invalid-token.
  mock.setEventsFence([
    { status: 401, body: 'unauthorized' },
    { status: 401, body: '{"error":"unauthorized","message":"gateway fence"}', contentType: 'application/json' },
  ])

  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStreamCount(streamsBefore + 1, { timeoutMs: 20_000 })
  assert.deepEqual(mock.fenceHits.map((hit) => hit.status), [401, 401])
  assert.equal(agent.state.exited, false, 'a foreign 401 must not stop the agent')

  // Fully functional after the fence clears.
  const requestId = mock.pushExec({ command: 'echo after-fence' })
  const result = await mock.waitForResult(requestId)
  assert.equal(result.stdout, 'after-fence\n')

  // The transient warning is throttled: one line for two failed attempts.
  assert.equal((agent.output.match(/保存的 token 未被拒绝/g) || []).length, 1, agent.output)
  assert.match(agent.output, /服务器暂时不可用/)
  const exit = await agent.stop()
  assert.equal(exit.code, 0)
})

test('run retries 404/503 during connect and connects when the route returns', async (t) => {
  const { mock, home } = await setup(t)
  await enrollAgent(mock, home)
  const streamsBefore = mock.streamCount
  mock.setEventsFence([
    { status: 404, body: 'Not Found' },
    { status: 503, body: 'Service Unavailable' },
  ])

  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStreamCount(streamsBefore + 1, { timeoutMs: 20_000 })
  assert.deepEqual(mock.fenceHits.map((hit) => hit.status), [404, 503])
  assert.equal(agent.state.exited, false, '404/503 must not stop the agent')

  const requestId = mock.pushExec({ command: 'echo back-online' })
  const result = await mock.waitForResult(requestId)
  assert.equal(result.stdout, 'back-online\n')
  assert.match(agent.output, /服务器暂时不可用/)

  const exit = await agent.stop()
  assert.equal(exit.code, 0)
})

// ---------------------------------------------------------------------------
// Embedded runtime (PROTOCOL §10.4) — importable, side-effect free
// ---------------------------------------------------------------------------

test('importing the module is side-effect free and exports startRuntime', async (t) => {
  const { home } = await setup(t)
  const script = [
    `const module = await import(${JSON.stringify(agentPath)})`,
    "if (typeof module.startRuntime !== 'function') { console.error('missing startRuntime'); process.exit(2) }",
    "if (typeof module.AGENT_VERSION !== 'string') { console.error('missing AGENT_VERSION'); process.exit(3) }",
    "console.log('typeof startRuntime = ' + typeof module.startRuntime)",
    "console.log('AGENT_VERSION = ' + module.AGENT_VERSION)",
    'process.exit(0)',
  ].join('\n')

  const result = await runNodeEval(script, { home })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /typeof startRuntime = function/)
  assert.match(result.stdout, /AGENT_VERSION = \d+\.\d+\.\d+/)
  // Importing must not run the CLI (no help/version/usage output, no errors).
  assert.ok(!result.stdout.includes('用法'), 'import must not print CLI help')
  // …and must not touch DSH_COMPUTERS_HOME (no config, log, temp dirs).
  assert.deepEqual(await fs.readdir(home), [], 'import must not write to DSH_COMPUTERS_HOME')
})

test('startRuntime embedded: connects, execs, status(), stop() reclaims children', async (t) => {
  const { mock, home } = await setup(t)
  const { config } = await enrollAgent(mock, home, { extraArgs: ['--name', 'Embedded Mac'] })

  const script = [
    `import { startRuntime } from ${JSON.stringify(agentPath)}`,
    'const options = JSON.parse(process.env.DSHC_EMBEDDED_OPTIONS)',
    'const states = []',
    'const runtime = startRuntime({',
    '  serverUrl: options.serverUrl,',
    '  token: options.token,',
    '  computerId: options.computerId,',
    '  name: options.name,',
    '  log: (level, message) => process.stderr.write("[" + level + "] " + message + String.fromCharCode(10)),',
    '  onState: (state) => states.push(state),',
    '})',
    'const initial = runtime.status()',
    'process.stdout.write("INITIAL " + JSON.stringify({ running: initial.running, connected: initial.connected, serverUrl: initial.serverUrl, computerId: initial.computerId }) + String.fromCharCode(10))',
    'const deadline = Date.now() + 10000',
    'while (!runtime.status().connected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))',
    'const connected = runtime.status()',
    'process.stdout.write("CONNECTED " + JSON.stringify({ running: connected.running, connected: connected.connected, since: connected.since, name: connected.name, serverUrl: connected.serverUrl }) + String.fromCharCode(10))',
    'process.stdin.setEncoding("utf8")',
    'process.stdin.resume()',
    'await new Promise((resolve) => process.stdin.once("data", resolve))',
    'const before = runtime.status()',
    'await runtime.stop()',
    'const after = runtime.status()',
    'const report = JSON.stringify({ before: { connected: before.connected, running: before.running }, after: { connected: after.connected, running: after.running, exitCode: after.exitCode, lastError: after.lastError }, stateCount: states.length })',
    'await new Promise((resolve) => process.stdout.write("STOPPED " + report + String.fromCharCode(10), resolve))',
    'process.exit(0)',
  ].join('\n')

  const embedded = spawnNodeEval(script, {
    home,
    env: {
      DSHC_EMBEDDED_OPTIONS: JSON.stringify({
        serverUrl: mock.url,
        token: config.token,
        computerId: config.computerId,
        name: 'Embedded Mac',
      }),
    },
  })
  t.after(() => embedded.stop())

  await embedded.waitForOutput(/CONNECTED/)
  const initial = readJsonLine(embedded.stdout, 'INITIAL ')
  assert.equal(initial.running, true)
  assert.equal(initial.connected, false, 'startRuntime must return before the first hello')
  assert.equal(initial.serverUrl, mock.url)
  assert.equal(initial.computerId, config.computerId)

  const connected = readJsonLine(embedded.stdout, 'CONNECTED ')
  assert.equal(connected.connected, true)
  assert.equal(connected.running, true)
  assert.equal(connected.name, 'Embedded Mac')
  assert.ok(typeof connected.since === 'string' && connected.since.length > 0, 'status().since is set')

  // Exec goes through the embedded runtime exactly like the CLI path.
  const execId = mock.pushExec({ command: 'echo embedded' })
  const execResult = await mock.waitForResult(execId)
  assert.equal(execResult.stdout, 'embedded\n')
  assert.equal(execResult.ok, true)

  // Start a long command, then stop(): the process group must be killed, its
  // result must NOT be posted, and no child may outlive stop().
  const marker = 'sleep 63.25'
  const longId = mock.pushExec({ command: marker, timeoutMs: 60_000 })
  await waitUntil(async () => (await findProcessCommands(marker)).length > 0, {
    timeoutMs: 5000,
    label: 'embedded child process to start',
  })
  embedded.sendLine('stop')
  const exited = await embedded.closed
  assert.equal(exited.code, 0, embedded.output)

  const stopped = readJsonLine(embedded.stdout, 'STOPPED ')
  assert.equal(stopped.before.connected, true)
  assert.equal(stopped.after.connected, false)
  assert.equal(stopped.after.running, false)
  assert.equal(stopped.after.exitCode, 0)
  assert.equal(stopped.after.lastError, null)
  assert.ok(stopped.stateCount >= 2, 'onState reported connect and stop transitions')

  await waitUntil(async () => (await findProcessCommands(marker)).length === 0, {
    timeoutMs: 5000,
    label: 'embedded child process to be reaped',
  })
  assert.equal(mock.pending.has(longId), true, 'stop() must not post a result after shutdown')
  await waitUntil(async () => mock.openStreamCount === 0, {
    timeoutMs: 5000,
    label: 'embedded SSE stream to close',
  })
})

// ---------------------------------------------------------------------------
// PROTOCOL §11 — capabilities, handshake metadata, streaming, remote fs
// ---------------------------------------------------------------------------

test('enroll reports capabilities and §11.6 handshake metadata', async (t) => {
  const { mock, home } = await setup(t)
  const workspace = await tempHome('dshc-workspace-')
  t.after(() => rmQuiet(workspace))
  const key = mock.createEnrollKey({ replace: true })

  const result = await runCli(
    ['enroll', '--server', mock.url, '--key', key, '--name', 'Metadata Mac', '--workspace-base', workspace],
    { home },
  )
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /工作目录/)
  assert.ok(result.stdout.includes(workspace))

  const enrollment = await mock.waitForEnrollment()
  // (a) R2a: real capability flags in the enroll metadata — not version inference.
  assert.deepEqual(enrollment.metadata.caps, { exec: true, fs: true, jobs: true, pty: false, tunnel: false })
  // (d) old metadata fields are unchanged by the additive caps object.
  assert.equal(enrollment.metadata.version, 1)
  assert.equal(enrollment.metadata.agentVersion, AGENT_VERSION)
  assert.equal(enrollment.metadata.mode, 'service', 'CLI enrollment is the service mode')
  assert.deepEqual(enrollment.metadata.capabilities, ['exec', 'fs'], 'legacy capabilities array untouched')
  assert.equal(enrollment.metadata.hostname, os.hostname())
  assert.equal(enrollment.metadata.os, process.platform)
  assert.equal(enrollment.metadata.arch, process.arch)
  assert.equal(await fs.realpath(enrollment.metadata.workspaceBase), await fs.realpath(workspace))
  assert.deepEqual(enrollment.capabilities, ['exec', 'fs'])

  const config = await readConfig(home)
  assert.equal(await fs.realpath(config.workspaceBase), await fs.realpath(workspace))

  const status = await runCli(['status'], { home })
  assert.equal(status.code, 0)
  assert.ok(status.stdout.includes('能力：exec, fs'), status.stdout)
  assert.ok(status.stdout.includes(workspace), status.stdout)
})

test('exec uses workspaceBase as the default cwd', async (t) => {
  const { mock, home } = await setup(t)
  const workspace = await tempHome('dshc-default-cwd-')
  t.after(() => rmQuiet(workspace))
  await enrollAgent(mock, home, { extraArgs: ['--workspace-base', workspace] })

  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()
  const requestId = mock.pushExec({ command: 'pwd' })
  const result = await mock.waitForResult(requestId)
  assert.equal(await fs.realpath(result.stdout.trim()), await fs.realpath(workspace))
})

test('every reconnect carries the handshake metadata header (§11.6)', async (t) => {
  const { mock, home } = await setup(t, { features: ['stream', 'fs'] })
  const { config } = await enrollAgent(mock, home)
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()
  await waitUntil(async () => mock.eventsRequests.length >= 2, { timeoutMs: 10_000, label: 'probe + run SSE requests' })

  const last = mock.eventsRequests.at(-1)
  const header = last.headers['x-dsh-computers-metadata']
  assert.ok(typeof header === 'string' && header.length > 0, 'metadata header present')
  const metadata = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  assert.equal(metadata.version, 1)
  assert.equal(metadata.agentVersion, AGENT_VERSION)
  assert.equal(metadata.mode, 'service', 'CLI run reports service mode on every reconnect')
  assert.deepEqual(metadata.capabilities, ['exec', 'fs'], 'legacy capabilities array unchanged')
  assert.deepEqual(metadata.caps, { exec: true, fs: true, jobs: true, pty: false, tunnel: false })
  assert.equal(await fs.realpath(metadata.workspaceBase), await fs.realpath(os.homedir()))
  assert.equal(metadata.hostname, os.hostname())
  assert.equal(metadata.os, process.platform)
  assert.equal(config.computerId, mock.getComputerByToken(config.token)?.id)
})

test('streams typed chunk frames when the host advertises `stream` (§11.2/§11.6)', async (t) => {
  const { mock, home } = await setup(t, { features: ['stream', 'fs'] })
  await enrollAgent(mock, home)
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()

  const requestId = mock.pushExec({
    stream: true,
    command: "printf 'aa'; sleep 0.18; printf 'bb' >&2; sleep 0.18; printf 'cc'",
    timeoutMs: 20_000,
  })
  const result = await mock.waitForResult(requestId)
  assert.equal(result.ok, true)
  assert.equal(result.stdout, 'aacc')
  assert.equal(result.stderr, 'bb')

  const frames = await mock.waitForChunks(requestId, 2)
  assert.ok(mock.chunkAttempts >= 2)
  // seq starts at 0, increases by exactly 1, no gaps/duplicates.
  const seqs = frames.map((frame) => frame.seq)
  assert.deepEqual(seqs, seqs.map((_value, index) => index))
  for (const frame of frames) {
    assert.ok(['stdout', 'stderr', 'heartbeat'].includes(frame.type), frame.type)
    assert.equal(typeof frame.data, 'string')
  }
  const decode = (type) =>
    Buffer.concat(frames.filter((frame) => frame.type === type).map((frame) => Buffer.from(frame.data, 'base64'))).toString('utf8')
  assert.equal(decode('stdout'), 'aacc')
  assert.equal(decode('stderr'), 'bb')
})

test('old hosts without `features` get exactly v1 behaviour (no chunks, no fs)', async (t) => {
  const { mock, home } = await setup(t) // no features advertised
  await enrollAgent(mock, home)
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()

  const requestId = mock.pushExec({ stream: true, command: 'echo legacy-host' })
  const result = await mock.waitForResult(requestId)
  assert.equal(result.stdout, 'legacy-host\n')

  mock.pushFs({ op: 'read', path: '/etc/hosts' })
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(mock.fsResults.length, 0, 'fs events must be ignored without the fs feature')
  assert.equal(mock.chunkAttempts, 0, 'no chunk POSTs without the stream feature')
  assert.equal(agent.state.exited, false)
})

test('chunk POST failures retry once and never kill the command', async (t) => {
  const flaky = await setup(t, { features: ['stream'], chunkFailures: 1 })
  await enrollAgent(flaky.mock, flaky.home)
  const firstAgent = startAgent({ home: flaky.home })
  t.after(() => firstAgent.stop())
  await flaky.mock.waitForStream()
  const firstId = flaky.mock.pushExec({ stream: true, command: "printf 'retry-me'" })
  const firstResult = await flaky.mock.waitForResult(firstId)
  assert.equal(firstResult.stdout, 'retry-me')
  await flaky.mock.waitForChunks(firstId, 1)
  assert.ok(flaky.mock.chunkAttempts >= 2, 'the failed batch was retried')
  await firstAgent.stop()

  const broken = await setup(t, { features: ['stream'], chunkFailures: 10_000 })
  await enrollAgent(broken.mock, broken.home)
  const secondAgent = startAgent({ home: broken.home })
  t.after(() => secondAgent.stop())
  await broken.mock.waitForStream()
  const secondId = broken.mock.pushExec({ stream: true, command: "printf 'still-alive'" })
  const secondResult = await broken.mock.waitForResult(secondId)
  assert.equal(secondResult.ok, true)
  assert.equal(secondResult.stdout, 'still-alive')
  assert.ok(broken.mock.chunkAttempts >= 2, 'chunk POSTs were attempted and dropped')
  assert.equal(secondAgent.state.exited, false, 'dropped chunks must not kill the agent')
})

test('embedded status() exposes capabilities and the host feature set', async (t) => {
  const { mock, home } = await setup(t, { features: ['stream', 'fs'] })
  const { config } = await enrollAgent(mock, home)
  const script = [
    `import { startRuntime } from ${JSON.stringify(agentPath)}`,
    'const options = JSON.parse(process.env.DSHC_EMBEDDED_OPTIONS)',
    'const runtime = startRuntime({ serverUrl: options.serverUrl, token: options.token, computerId: options.computerId, mode: "embedded", log: () => {}, onState: () => {} })',
    'const deadline = Date.now() + 10000',
    'while (!runtime.status().connected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))',
    'const status = runtime.status()',
    'await new Promise((resolve) => process.stdout.write("STATUS " + JSON.stringify({ mode: status.mode, capabilities: status.capabilities, caps: status.caps, features: status.features, workspaceBase: status.workspaceBase }) + String.fromCharCode(10), resolve))',
    'await runtime.stop()',
    'process.exit(0)',
  ].join('\n')
  const embedded = spawnNodeEval(script, {
    home,
    env: {
      DSHC_EMBEDDED_OPTIONS: JSON.stringify({ serverUrl: mock.url, token: config.token, computerId: config.computerId }),
    },
  })
  t.after(() => embedded.stop())
  await embedded.waitForOutput(/STATUS /)
  const status = readJsonLine(embedded.stdout, 'STATUS ')
  assert.equal(status.mode, 'embedded', 'the plugin host passes mode: "embedded"')
  assert.deepEqual(status.capabilities, ['exec', 'fs'])
  assert.deepEqual(status.caps, { exec: true, fs: true, jobs: true, pty: false, tunnel: false })
  assert.deepEqual(status.features, ['stream', 'fs'])
  // The connect header from the embedded runtime also says embedded.
  const embeddedConnect = mock.eventsRequests.at(-1)
  const embeddedMetadata = JSON.parse(Buffer.from(embeddedConnect.headers['x-dsh-computers-metadata'], 'base64url').toString('utf8'))
  assert.equal(embeddedMetadata.mode, 'embedded')
  assert.equal(await fs.realpath(status.workspaceBase), await fs.realpath(os.homedir()))
  await embedded.closed
})

test('a silent streamed command emits heartbeat frames (§11.6)', async (t) => {
  const { mock, home } = await setup(t, { features: ['stream'] })
  const { config } = await enrollAgent(mock, home)
  const script = [
    `import { startRuntime } from ${JSON.stringify(agentPath)}`,
    'const options = JSON.parse(process.env.DSHC_EMBEDDED_OPTIONS)',
    'const runtime = startRuntime({ serverUrl: options.serverUrl, token: options.token, computerId: options.computerId, log: () => {}, onState: () => {}, chunkHeartbeatMs: 300 })',
    'const deadline = Date.now() + 10000',
    'while (!runtime.status().connected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))',
    'process.stdout.write("READY" + String.fromCharCode(10))',
    'process.stdin.setEncoding("utf8")',
    'process.stdin.resume()',
    'await new Promise((resolve) => process.stdin.once("data", resolve))',
    'await runtime.stop()',
    'process.exit(0)',
  ].join('\n')
  const embedded = spawnNodeEval(script, {
    home,
    env: {
      DSHC_EMBEDDED_OPTIONS: JSON.stringify({ serverUrl: mock.url, token: config.token, computerId: config.computerId }),
    },
  })
  t.after(() => embedded.stop())
  await embedded.waitForOutput(/READY/)

  const requestId = mock.pushExec({
    stream: true,
    command: "printf 'start'; sleep 1.2; printf 'end'",
    timeoutMs: 20_000,
  })
  const result = await mock.waitForResult(requestId)
  assert.equal(result.stdout, 'startend')

  const frames = await mock.waitForChunks(requestId, 2)
  await waitUntil(async () => mock.chunksFor(requestId).some((frame) => frame.type === 'heartbeat'), {
    timeoutMs: 5000,
    label: 'a heartbeat chunk frame for the silent command',
  })
  const all = mock.chunksFor(requestId)
  const seqs = all.map((frame) => frame.seq)
  assert.deepEqual(seqs, seqs.map((_value, index) => index))
  const heartbeats = all.filter((frame) => frame.type === 'heartbeat')
  assert.ok(heartbeats.length >= 1)
  for (const heartbeat of heartbeats) assert.equal(heartbeat.data, '')

  embedded.sendLine('stop')
  const exited = await embedded.closed
  assert.equal(exited.code, 0)
})

test('caps.fs is false when the fs handlers are unavailable (test option)', async (t) => {
  const { mock, home } = await setup(t, { features: ['stream', 'fs'] })
  const { config } = await enrollAgent(mock, home)
  const script = [
    `import { startRuntime } from ${JSON.stringify(agentPath)}`,
    'const options = JSON.parse(process.env.DSHC_EMBEDDED_OPTIONS)',
    'const runtime = startRuntime({ serverUrl: options.serverUrl, token: options.token, computerId: options.computerId, mode: "embedded", fs: false, log: () => {}, onState: () => {} })',
    'const deadline = Date.now() + 10000',
    'while (!runtime.status().connected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))',
    'const status = runtime.status()',
    'await new Promise((resolve) => process.stdout.write("STATUS " + JSON.stringify({ caps: status.caps, capabilities: status.capabilities, mode: status.mode }) + String.fromCharCode(10), resolve))',
    'process.stdin.setEncoding("utf8")',
    'process.stdin.resume()',
    'await new Promise((resolve) => process.stdin.once("data", resolve))',
    'await runtime.stop()',
    'process.exit(0)',
  ].join('\n')
  const embedded = spawnNodeEval(script, {
    home,
    env: {
      DSHC_EMBEDDED_OPTIONS: JSON.stringify({ serverUrl: mock.url, token: config.token, computerId: config.computerId }),
    },
  })
  t.after(() => embedded.stop())
  await embedded.waitForOutput(/STATUS /)
  const status = readJsonLine(embedded.stdout, 'STATUS ')
  assert.deepEqual(status.caps, { exec: true, fs: false, jobs: true, pty: false, tunnel: false })
  // (d) compatibility: the legacy array and mode are untouched by the simulation.
  assert.deepEqual(status.capabilities, ['exec', 'fs'])
  assert.equal(status.mode, 'embedded')

  // The connect metadata carries the same caps object.
  const connect = mock.eventsRequests.at(-1)
  const metadata = JSON.parse(Buffer.from(connect.headers['x-dsh-computers-metadata'], 'base64url').toString('utf8'))
  assert.deepEqual(metadata.caps, { exec: true, fs: false, jobs: true, pty: false, tunnel: false })
  assert.deepEqual(metadata.capabilities, ['exec', 'fs'])
  assert.equal(metadata.version, 1)

  // …and the agent ignores fs events even though the host advertises fs.
  const requestId = mock.pushFs({ op: 'read', path: '/etc/hosts' })
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(
    mock.fsResults.some((entry) => entry.requestId === requestId),
    false,
    'fs handlers are unwired, so no fs result may be posted',
  )

  embedded.sendLine('stop')
  const exited = await embedded.closed
  assert.equal(exited.code, 0)
})

// --- remote fs ------------------------------------------------------------

test('fs read: text window, binary base64, relative rejection and OS errors', async (t) => {
  const { mock, home } = await setup(t, { features: ['fs'] })
  const workspace = await tempHome('dshc-fs-read-')
  t.after(() => rmQuiet(workspace))
  await enrollAgent(mock, home, { extraArgs: ['--workspace-base', workspace] })
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()

  const textPath = path.join(workspace, 'text.txt')
  await fs.writeFile(textPath, 'line1\nline2\nline3\nline4\nline5\n')
  const binaryPath = path.join(workspace, 'binary.bin')
  const binaryBytes = Buffer.from([0, 1, 2, 255, 254, 10, 0])
  await fs.writeFile(binaryPath, binaryBytes)

  const window = await fsCall(mock, { op: 'read', path: textPath, offset: 1, limit: 2 })
  assert.equal(window.result.ok, true)
  assert.equal(window.result.encoding, 'utf8')
  assert.equal(window.result.text, 'line2\nline3')
  assert.equal(window.result.lines, 2)
  assert.equal(window.result.truncated, true)

  const binary = await fsCall(mock, { op: 'read', path: binaryPath })
  assert.equal(binary.result.ok, true)
  assert.equal(binary.result.encoding, 'base64')
  assert.deepEqual(Buffer.from(binary.result.content, 'base64'), binaryBytes)

  const forcedBase64 = await fsCall(mock, { op: 'read', path: textPath, encoding: 'base64' })
  assert.equal(forcedBase64.result.encoding, 'base64')
  assert.equal(Buffer.from(forcedBase64.result.content, 'base64').toString('utf8'), 'line1\nline2\nline3\nline4\nline5\n')

  const relative = await fsCall(mock, { op: 'read', path: 'relative.txt' })
  assert.equal(relative.result.ok, false)
  assert.equal(relative.result.error, 'path must be absolute')

  const missing = await fsCall(mock, { op: 'read', path: path.join(workspace, 'nope.txt') })
  assert.equal(missing.result.ok, false)
  assert.match(missing.result.error, /ENOENT/)

  const tooManyLines = path.join(workspace, 'long.txt')
  await fs.writeFile(tooManyLines, Array.from({ length: 25_000 }, (_value, index) => `row-${index}`).join('\n'))
  const longRead = await fsCall(mock, { op: 'read', path: tooManyLines, limit: 20_000 })
  assert.equal(longRead.result.ok, true)
  assert.equal(longRead.result.lines, 20_000)
  assert.equal(longRead.result.truncated, true)
})

test('fs write/list/stat/mkdir/rename/delete round trip', async (t) => {
  const { mock, home } = await setup(t, { features: ['fs'] })
  const workspace = await tempHome('dshc-fs-write-')
  t.after(() => rmQuiet(workspace))
  await enrollAgent(mock, home, { extraArgs: ['--workspace-base', workspace] })
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()

  const dir = path.join(workspace, 'sub')
  const created = await fsCall(mock, { op: 'mkdir', path: dir, recursive: true })
  assert.equal(created.result.ok, true)
  assert.ok(existsSync(dir))

  const fileA = path.join(dir, 'a.txt')
  const write = await fsCall(mock, { op: 'write', path: fileA, content: 'hello fs' })
  assert.equal(write.result.ok, true)
  assert.equal(write.result.bytes, 8)
  assert.equal(write.result.created, true)
  assert.equal(await fs.readFile(fileA, 'utf8'), 'hello fs')

  const overwrite = await fsCall(mock, { op: 'write', path: fileA, content: 'hello again' })
  assert.equal(overwrite.result.created, false)

  const stat = await fsCall(mock, { op: 'stat', path: fileA })
  assert.equal(stat.result.ok, true)
  assert.equal(stat.result.stat.type, 'file')
  assert.equal(stat.result.stat.size, 11)
  assert.ok(stat.result.stat.mtimeMs > 0)
  assert.equal(typeof stat.result.stat.mode, 'number')

  const list = await fsCall(mock, { op: 'list', path: dir })
  assert.equal(list.result.ok, true)
  assert.deepEqual(list.result.entries.map((entry) => entry.name), ['a.txt'])
  assert.equal(list.result.entries[0].type, 'file')

  const fileB = path.join(dir, 'b.txt')
  const renamed = await fsCall(mock, { op: 'rename', path: fileA, to: fileB })
  assert.equal(renamed.result.ok, true)
  assert.ok(!existsSync(fileA) && existsSync(fileB))

  const deleted = await fsCall(mock, { op: 'delete', path: fileB })
  assert.equal(deleted.result.ok, true)
  assert.ok(!existsSync(fileB))

  const nested = path.join(workspace, 'deep', 'nested', 'c.txt')
  const nestedWrite = await fsCall(mock, { op: 'write', path: nested, content: 'nested', createDirs: true })
  assert.equal(nestedWrite.result.ok, true)
  assert.equal(await fs.readFile(nested, 'utf8'), 'nested')

  // §11.3: write is capped at 4 MiB.
  const huge = await fsCall(mock, { op: 'write', path: path.join(workspace, 'huge.bin'), content: 'x'.repeat(4 * 1024 * 1024 + 1) })
  assert.equal(huge.result.ok, false)
  assert.match(huge.result.error, /write limit/)

  const relativeStat = await fsCall(mock, { op: 'stat', path: 'nope' })
  assert.equal(relativeStat.result.ok, false)
  assert.equal(relativeStat.result.error, 'path must be absolute')
})

test('fs glob and grep run in-process with §11.3 limits', async (t) => {
  const { mock, home } = await setup(t, { features: ['fs'] })
  const workspace = await tempHome('dshc-fs-glob-')
  t.after(() => rmQuiet(workspace))
  await enrollAgent(mock, home, { extraArgs: ['--workspace-base', workspace] })
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()

  await fs.mkdir(path.join(workspace, 'sub', 'deep'), { recursive: true })
  await fs.writeFile(path.join(workspace, 'a.txt'), 'alpha needle one\nplain\n')
  await fs.writeFile(path.join(workspace, 'a.log'), 'log a\n')
  await fs.writeFile(path.join(workspace, 'b.log'), 'log b\n')
  await fs.writeFile(path.join(workspace, 'sub', 'c.txt'), 'gamma needle two\n')
  await fs.writeFile(path.join(workspace, 'sub', 'deep', 'd.txt'), 'delta\n')
  await fs.writeFile(path.join(workspace, 'sub', 'binary.bin'), Buffer.from('needle\u0000binary', 'utf8'))

  const glob = await fsCall(mock, { op: 'glob', pattern: '**/*.txt' })
  assert.equal(glob.result.ok, true)
  const relativePaths = glob.result.paths.map((candidate) => path.relative(workspace, candidate)).sort()
  assert.deepEqual(relativePaths, ['a.txt', 'sub/c.txt', 'sub/deep/d.txt'].map((value) => value))
  assert.equal(glob.result.truncated, false)

  const braces = await fsCall(mock, { op: 'glob', pattern: '{a,b}.log' })
  assert.equal(braces.result.ok, true)
  assert.deepEqual(braces.result.paths.map((candidate) => path.basename(candidate)).sort(), ['a.log', 'b.log'])

  const grep = await fsCall(mock, { op: 'grep', pattern: 'needle', include: '*.txt' })
  assert.equal(grep.result.ok, true)
  assert.deepEqual(
    grep.result.matches.map((match) => ({ file: path.relative(workspace, match.path), line: match.line, text: match.text })),
    [
      { file: 'a.txt', line: 1, text: 'alpha needle one' },
      { file: 'sub/c.txt', line: 1, text: 'gamma needle two' },
    ],
  )

  const capped = await fsCall(mock, { op: 'grep', pattern: 'needle', include: '*.txt', maxMatches: 1 })
  assert.equal(capped.result.matches.length, 1)
  assert.equal(capped.result.truncated, true)

  const relativeRoot = await fsCall(mock, { op: 'grep', pattern: 'log', path: 'sub' })
  assert.equal(relativeRoot.result.ok, true)

  const invalid = await fsCall(mock, { op: 'grep', pattern: '[unclosed' })
  assert.equal(invalid.result.ok, false)
  assert.match(invalid.result.error, /invalid pattern/)
})

test('stop() during an in-flight fs request posts nothing and exits cleanly', async (t) => {
  const { mock, home } = await setup(t, { features: ['fs'] })
  await enrollAgent(mock, home)
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()

  const requestId = mock.pushFs({ op: 'grep', pattern: 'needle', path: os.homedir() })
  const exit = await agent.stop()
  assert.equal(exit.code, 0)
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(
    mock.fsResults.some((entry) => entry.requestId === requestId),
    false,
    'an fs result must not be posted after stop()',
  )
})

// ---------------------------------------------------------------------------
// service (launchd on macOS)
// ---------------------------------------------------------------------------

test(
  'service install/write/status/stop/uninstall are idempotent',
  { skip: process.platform !== 'darwin' ? 'launchd test is macOS only' : false },
  async (t) => {
    const { mock, home } = await setup(t)
    // Use a throw-away HOME and a unique label so the test can never touch a
    // real installed agent (a real one would live under the user's own label).
    const fakeHome = await tempHome('dshc-fakehome-')
    t.after(() => rmQuiet(fakeHome))
    const label = `com.dsh.computers.agent.test-${process.pid}-${Date.now()}`
    const env = { HOME: fakeHome, DSH_COMPUTERS_SERVICE_LABEL: label }

    await enrollAgent(mock, home, { runOptions: { env } })

    const install = await runCli(['service', 'install'], { home, env })
    assert.equal(install.code, 0, install.stderr)

    const plistPath = path.join(fakeHome, 'Library', 'LaunchAgents', `${label}.plist`)
    assert.ok(existsSync(plistPath), `expected ${plistPath}`)
    const plist = await fs.readFile(plistPath, 'utf8')
    assert.ok(plist.includes(`<string>${label}</string>`))
    assert.ok(plist.includes('<key>RunAtLoad</key>'))
    assert.ok(plist.includes('<key>KeepAlive</key>'))
    assert.ok(plist.includes(`<string>${agentPath}</string>`), 'absolute agent path')
    assert.ok(plist.includes(`<string>${process.execPath}</string>`), 'node executable')
    assert.ok(plist.includes(`<string>${path.join(home, 'agent.log')}</string>`), 'log path')
    assert.ok(plist.includes('<string>run</string>'), 'ProgramArguments ends with run')

    const status = await runCli(['service', 'status'], { home, env })
    assert.equal(status.code, 0)
    assert.ok(status.stdout.includes('未运行'), status.stdout)

    // Nothing is loaded under our throw-away label, so stop must be a no-op success.
    const stop = await runCli(['service', 'stop'], { home, env })
    assert.equal(stop.code, 0, stop.stderr)

    const uninstall = await runCli(['service', 'uninstall'], { home, env })
    assert.equal(uninstall.code, 0, uninstall.stderr)
    assert.ok(!existsSync(plistPath))

    const uninstallAgain = await runCli(['service', 'uninstall'], { home, env })
    assert.equal(uninstallAgain.code, 0, uninstallAgain.stderr)
    assert.equal(uninstallAgain.stderr, '')
  },
)

// ---------------------------------------------------------------------------
// R5a: application-level liveness (heartbeat misses) and reconnect backoff
// ---------------------------------------------------------------------------

test('liveness: the policy stays inside the host lease with margin', async () => {
  // Contract check, no sleeping: the host refreshes presence only on validated
  // inbound frames with a 45 s lease, so the agent must prove liveness far more
  // often than that, and must give up on a stream well before the lease expires.
  assert.equal(LIVENESS.heartbeatMs, 10_000)
  assert.equal(LIVENESS.missLimit, 2)
  assert.ok(LIVENESS.heartbeatMs < LIVENESS.hostLeaseMs / 2, 'heartbeat must be much faster than the lease')
  assert.ok(
    LIVENESS.missLimit * LIVENESS.heartbeatMs < LIVENESS.hostLeaseMs,
    'two missed heartbeats must be declared dead before the host lease expires',
  )
  assert.equal(LIVENESS.reconnectBaseMs, 1_500)
  assert.equal(LIVENESS.reconnectMaxMs, 30_000)
  assert.equal(LIVENESS.reconnectJitter, 0.2)
  assert.ok(Object.isFrozen(LIVENESS))
})

test('liveness: one missed heartbeat keeps the stream, two tear it down', async (t) => {
  // A short interval keeps the test fast; the agent never goes slower than
  // hello.heartbeatMs, so this only lowers it.
  const { mock, home } = await setup(t, { heartbeatMs: 250 })
  await enrollAgent(mock, home)
  const agent = startAgent({ home })
  t.after(() => agent.stop())
  await mock.waitForStream()
  await agent.waitForOutput(/已连接/)
  const streamsBefore = mock.eventsRequests.length

  // One unanswered round trip is a miss, not a death: the next good one resets.
  mock.failHeartbeats(1)
  await waitUntil(() => mock.heartbeatAttempts >= 2, { timeoutMs: 10_000, label: 'two heartbeat attempts' })
  await waitUntil(() => mock.heartbeats.length >= 1, { timeoutMs: 10_000, label: 'a successful heartbeat' })
  assert.equal(agent.state.exited, false)
  assert.equal(mock.eventsRequests.length, streamsBefore, 'a single miss must not reconnect')

  // Two consecutive misses are a death: the half-dead stream is abandoned.
  mock.failHeartbeats(Number.POSITIVE_INFINITY)
  await waitUntil(() => mock.eventsRequests.length > streamsBefore, {
    timeoutMs: 15_000,
    label: 'a reconnect after two misses',
  })
  const log = agent.output + (await readLog(home))
  assert.match(log, /declared dead by heartbeat misses/)
  assert.match(log, /连续 2 次心跳无响应/)
  assert.equal(agent.state.exited, false, 'the runtime keeps running; only the stream died')
})

test('liveness: reconnect backoff doubles to the ceiling with ±20% jitter', async (t) => {
  // Test-only curve override so the whole 1.5 s → 30 s shape runs in ~2 s.
  const base = 400
  const max = 800
  const { mock, home } = await setup(t)
  await enrollAgent(mock, home)
  // Empty 200 streams: the agent reads EOF without a hello, which is a plain
  // disconnect (not a throttled transient-server warning), so every attempt logs.
  mock.setEventsFence(
    Array.from({ length: 6 }, () => ({ status: 200, body: '', contentType: 'text/event-stream; charset=utf-8' })),
  )
  const agent = startAgent({
    home,
    env: { DSH_COMPUTERS_RECONNECT_BASE_MS: String(base), DSH_COMPUTERS_RECONNECT_MAX_MS: String(max) },
  })
  t.after(() => agent.stop())
  // Fenced responses never become real streams, so count connect attempts.
  await waitUntil(() => mock.eventsRequests.length >= 7, { timeoutMs: 20_000, label: 'seven connect attempts' })

  // Nominal steps: 400, 800, then the ceiling holds at 800.
  const log = agent.output + (await readLog(home))
  const nominal = [...log.matchAll(/标称 (\d+)ms/g)].map((match) => Number(match[1]))
  assert.deepEqual(nominal.slice(0, 4), [base, max, max, max], `nominal steps were ${nominal.join(',')}`)

  // Measured gaps sit inside the ±20% jitter band. A successful attempt opens a
  // probe and then the stream, so its two requests are only tens of ms apart;
  // reconnect gaps are the ones above the smallest jittered delay.
  const attempts = mock.eventsRequests.map((entry) => entry.at)
  const gaps = attempts.slice(1).map((at, index) => at - attempts[index])
  const reconnectGaps = gaps.filter((gap) => gap > base * 0.5)
  assert.ok(reconnectGaps.length >= 3, `expected reconnect gaps, saw ${gaps.join(',')}`)
  const slack = 80
  reconnectGaps.slice(0, 3).forEach((gap, index) => {
    const nominalGap = Math.min(base * 2 ** index, max)
    assert.ok(
      gap >= nominalGap * 0.8 - slack && gap <= nominalGap * 1.2 + slack,
      `gap ${index} was ${gap}ms, expected ~${nominalGap}ms ±20% (all gaps: ${gaps.join(',')})`,
    )
  })
})

test('liveness: a stable stream resets the backoff attempt counter', async (t) => {
  const { mock, home } = await setup(t)
  await enrollAgent(mock, home)
  mock.setEventsFence([
    { status: 200, body: '', contentType: 'text/event-stream; charset=utf-8' },
    { status: 200, body: '', contentType: 'text/event-stream; charset=utf-8' },
  ])
  const agent = startAgent({
    home,
    env: {
      DSH_COMPUTERS_RECONNECT_BASE_MS: '20',
      DSH_COMPUTERS_RECONNECT_MAX_MS: '320',
      // Any hello-proving session counts as stable, so the reset is observable fast.
      DSH_COMPUTERS_STABLE_RESET_MS: '0',
    },
  })
  t.after(() => agent.stop())
  await waitUntil(() => mock.eventsRequests.length >= 3, { timeoutMs: 20_000, label: 'three connect attempts' })
  await agent.waitForOutput(/已连接/)

  // End the healthy session, then fail once: a reset counter means base again.
  mock.closeStreams()
  mock.setEventsFence([{ status: 200, body: '', contentType: 'text/event-stream; charset=utf-8' }])
  await waitUntil(() => mock.eventsRequests.length >= 4, { timeoutMs: 20_000, label: 'a fourth connect attempt' })

  const log = agent.output + (await readLog(home))
  const nominal = [...log.matchAll(/标称 (\d+)ms/g)].map((match) => Number(match[1]))
  assert.deepEqual(nominal.slice(0, 3), [20, 40, 20], `nominal steps were ${nominal.join(',')}`)
})
