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
  assert.equal(enrollment.agentVersion, '1.0.0')
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
  assert.equal(heartbeat.body.meta.agentVersion, '1.0.0')
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
