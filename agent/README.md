# dsh-computers-agent

The machine-side half of **dsh-computers**: a single, dependency-free Node.js
script that runs on your own Mac/Linux box, dials **out** to a DSH Web server,
and executes shell commands the server's agent asks for. It is the "cloud
computer" client — no inbound port, no NAT/firewall change, no daemon port.

```
dsh web  ──SSE (outbound from the Mac)──▶  dsh-computers-agent  ──▶  /bin/sh -lc
                                            │
                                            ├─ ~/.dsh-computers/config.json  (0600, token + join token)
                                            ├─ ~/.dsh-computers/agent.log    (5 MiB rotate)
                                            └─ launchd / systemd user service
```

The same file is used two ways, with one implementation:

- **CLI / service** (headless, always-on): `enroll` + `run` + `launchd`/`systemd`
  from the installer one-liner.
- **Embedded runtime** (desktop DSH app): the plugin's Settings → 电脑 →
  *本机运行时* card calls the module's exported `startRuntime()` in-process, so
  the user never opens a terminal (PROTOCOL §10.4).

Since v1.3.0 the agent implements PROTOCOL §11: it advertises the `exec` and
`fs` capabilities, streams live output when the host asks for it, serves remote
file operations over the same SSE stream, and reports §11.6 handshake metadata
(`agentVersion`, `hostname`, `os`, `arch`, `capabilities`, `workspaceBase`) at
enroll and on every reconnect. Old hosts that advertise no `features` get
exactly the v1 behaviour.

The file is served verbatim by the host plugin at
`/api/dsh-computers/agent.mjs`, so what you run is exactly what the repository
contains. It imports only Node built-ins, never opens a listening socket, and
never prints the token.

The wire contract lives in [`../PROTOCOL.md`](../PROTOCOL.md) (§3 and §6).

## Requirements

- Node.js **22 or newer** (`node -v`)
- macOS (launchd), Linux (systemd `--user`) or Windows (manual, v1)
- Outbound HTTP(S) to the dsh-web server

## Install

### Recommended: paste one address

Since v1.7.0 joining needs **one string**. On the hub, Settings → 电脑 →
已连接的电脑 → **复制接入地址** copies a capability URL like:

```
https://relay.example.com/r/hub_xxx#join=dshf_…
```

Paste that whole string as the server — no `--key`:

```sh
mkdir -p ~/.dsh-computers
# the agent is served by the same server — the address without its #join= part
curl -fsSL 'https://relay.example.com/r/hub_xxx/api/dsh-computers/agent.mjs' -o ~/.dsh-computers/agent.mjs
node ~/.dsh-computers/agent.mjs enroll --server 'https://relay.example.com/r/hub_xxx#join=dshf_…'
node ~/.dsh-computers/agent.mjs service install
node ~/.dsh-computers/agent.mjs service start
```

The `#join=…` fragment is parsed **locally** and never stored or transmitted as
part of a URL: `config.json` keeps the fragment-free `serverUrl`, the join token
is kept next to it (`joinToken`, same `0600` file), and it is sent exactly once —
in the enroll body. It never rides the SSE stream, a heartbeat or a result POST.
Because it stays on disk, a later `enroll --server <url>` (no `--key`, no
fragment) re-registers the machine — useful when its token was revoked on the
hub — without asking the user to paste the address again.

A successful `enroll` prints `✓ 已连接 <server>，这台电脑现在是 <name>`.
If the stream probe fails, the credentials are still saved and `run` retries.

### The key form (one-time key)

The pre-1.7 flow is unchanged and still supported: the server's **Connect
computer** dialog can generate a one-liner with a single-use key:

```sh
curl -fsSL 'http://<server>/api/dsh-computers/join.sh?key=dshc_…' | sh
```

or manually:

```sh
node ~/.dsh-computers/agent.mjs enroll --server http://<server> --key dshc_…
```

Enrollment keys are single use and expire (15 minutes by default). When the
server says the machine is already connected, re-run with `--replace`:

```sh
node ~/.dsh-computers/agent.mjs enroll --server http://<server> --key dshc_… --replace
```

`--key` wins if both credentials are present: a `#join=` fragment on the same
`--server` is then ignored (and not persisted). With neither a key nor a
`#join=` fragment, `enroll` exits non-zero and names both forms.

## Commands

```
dsh-computers-agent enroll --server '<url>#join=<token>' [--name <name>] [--workspace-base <path>] [--replace]
dsh-computers-agent enroll --server <url> --key <key> [--name <name>] [--workspace-base <path>] [--replace]
dsh-computers-agent run
dsh-computers-agent service install|uninstall|start|stop|restart|status
dsh-computers-agent status
dsh-computers-agent --version | --help
```

| Command | What it does |
| --- | --- |
| `enroll` | POSTs the join credential — `{ join }` parsed from `--server '<url>#join=<token>'`, or the one-time `--key` — plus `capabilities` and §11.6 `metadata` to `/api/dsh-computers/agent/enroll`, saves `{serverUrl, computerId, token, name, enrolledAt, workspaceBase, joinToken?}` to `config.json` (atomic, `0600`), then opens the SSE stream for ~5 s to prove the round trip. `--workspace-base` sets the default working directory (default `$HOME`). Exits non-zero with the server's message on failure. |
| `run` | Foreground worker: one SSE stream to `/api/dsh-computers/agent/events`; executes `exec` events, kills the process group on `cancel`, POSTs results, sends heartbeats, reconnects with jittered 1 s → 30 s backoff. |
| `status` | Prints server, computer id/name, redacted token (last 6 chars only), config/log paths and service state. Exit `0` when enrolled, `1` when not. |
| `service` | Login/auto-restart service. See below. |

Ctrl-C / `SIGTERM` makes `run` exit cleanly (in-flight commands are killed).

## The service

**macOS (launchd).** `service install` writes
`~/Library/LaunchAgents/com.dsh.computers.agent.plist` with
`ProgramArguments = [node, <absolute agent path>, run]`, `RunAtLoad`,
`KeepAlive`, and `StandardOutPath`/`StandardErrorPath` pointing at
`~/.dsh-computers/agent.log`. `service start` runs
`launchctl bootstrap gui/$(id -u) <plist>` and falls back to `launchctl load -w`.
`stop` uses `launchctl bootout` (fallback `unload -w`). `stop` and `uninstall`
are idempotent: when nothing is loaded they still exit `0`.

**Linux (systemd `--user`).** `service install` writes
`~/.config/systemd/user/dsh-computers-agent.service`, runs
`systemctl --user daemon-reload`; `start` runs
`systemctl --user enable --now ...`; `stop` runs `disable --now`. Without a
usable `systemctl --user`, `start`/`stop` fall back to `nohup … run &` with a
pid file (`~/.dsh-computers/agent.pid`).

**Windows.** v1 prints the manual command and the Task Scheduler setup and exits
`0` (no service automation yet).

## Embedded runtime mode (`startRuntime`)

When the plugin runs inside the user's **desktop** DSH, `lib/runtime.js` imports
this same file and starts an in-process runtime — no CLI, no service, no
`~/.dsh-computers` config:

```js
import { startRuntime } from '../agent/dsh-computers-agent.mjs'

const runtime = startRuntime({
  serverUrl: 'https://dsh.example.com',   // or '<url>#join=<token>' (one-address join)
  token: 'dshc_…',            // from the hub's enroll response
  computerId: 'cmp_…',
  name: 'Desk Mac mini',      // optional display name
  mode: 'embedded',           // 'service' (default) or 'embedded'; shown to the UI
  heartbeatMs: 20000,         // optional; `hello` overrides it
  log: (level, message) => {}, // 'info' | 'warn' | 'error'
  onState: (state) => {},      // connect/disconnect/error/stop transitions
  onEnrolled: (info) => {},    // optional; see the one-address form below
})

runtime.status() // synchronous snapshot incl. mode, capabilities, caps, features (see below)
await runtime.stop() // idempotent: aborts SSE, SIGKILLs children, awaits the loop
```

**One-address form (v1.7.0).** The desktop plugin hands over whatever the user
pasted, so `serverUrl` may be the capability URL `'<url>#join=<token>'`. In that
form `token`/`computerId` may be omitted: the runtime enrolls once with
`{ join }`, adopts the returned credentials **in memory**, strips the fragment
from `status().serverUrl`, and calls `onEnrolled({ serverUrl, computerId, token,
name })` so the embedder can persist them (the embedded runtime still never
writes `~/.dsh-computers`). When `token` + `computerId` are also passed they
win and the fragment is ignored, exactly like `--key` on the CLI. A rejected
join token ends the loop like `invalid-token` (`lastError: 'invalid-join'`,
`exitCode: 1`); transport failures are retried with the normal backoff.

`status()` returns
`{ running, connected, serverUrl, computerId, name, heartbeatMs, since, lastConnectedAt, lastError, attempts, exitCode }`
(`since`/`lastConnectedAt` are ISO strings; `lastError` is `null` when healthy).
`onState` receives the same shape and is de-duplicated to real transitions.

Semantics guaranteed to the host:

- `startRuntime()` returns immediately; the SSE loop/backoff runs in the
  background. The module is **import-safe**: importing it never runs CLI code,
  touches the filesystem, prints, or starts child processes (the CLI main only
  runs when this file is the process entry point, via `process.argv[1]` +
  `pathToFileURL`, handling relative and symlinked paths).
- `stop()` aborts the SSE fetch, retains no timers, sends `SIGKILL` to every
  in-flight command's process group and **waits** for those children to be
  reaped before resolving. It is safe to call twice (and from inside `onState`).
- A fatal `{"error":"invalid-token"}` 401 never throws: the loop ends,
  `status()` reports `lastError: 'invalid-token'` and `exitCode: 1`, and
  `onState` fires so the host can surface it. Any other 401/403/404/5xx is
  treated as a transient server condition and retried with backoff.
- The embedded runtime never writes `~/.dsh-computers`; the host persists its
  own `runtime.json` (PROTOCOL §10.2) and the CLI remains the only writer of
  `config.json`.

`AGENT_VERSION` is exported too (the host can put it in the §3.1 enroll body).
`scanLocalSkills(workspaceBase)` is exported as well — it is the v1.9.0 skills
report described below; its optional second argument `{ home }` overrides `$HOME`
for tests.

## Protocol v1.3.0 / §11 features

### Capabilities and gating (§11.1, §11.5)

The agent reports the legacy `capabilities: ["exec", "fs"]` array (kept
unchanged for older hosts) **and** an R2 `caps` object describing what this
instance can actually do — the host/UI should use `caps`, not version numbers:

```json
{ "exec": true, "fs": true, "jobs": true, "pty": false, "tunnel": false }
```

| flag | meaning |
| --- | --- |
| `exec` | can run shell commands, cancel them, stream chunks and post results |
| `fs` | §11.3 remote file handlers are wired; `false` only when started with the test/advanced `fs: false` option |
| `jobs` | supports the host's background-job path (accepts `cancel`, streams output, always posts one final result) |
| `pty` | terminal backend (§11.4) — not implemented: always `false` |
| `tunnel` | relay/tunnel transport — not implemented: always `false` |

`caps` rides inside the existing §11.6 metadata (`version: 1`); no second
envelope is introduced, and unknown keys are ignored by older hosts. `caps` is
also in the heartbeat `meta`, in every connect header and in
`startRuntime().status()`. Nothing new is *sent* to an old host: the `hello`
event's `features` list still decides what is enabled per connection —

| `hello.features` | behaviour |
| --- | --- |
| absent / no `stream`, no `fs` | exactly v1: `exec` results only, `fs` events ignored, no chunk POSTs |
| `stream` | `exec` with `"stream": true` gets incremental chunk POSTs |
| `fs` | `fs` events are served and answered on `/agent/fs/result` |

### Handshake metadata (§11.6)

Enroll sends `metadata: { version: 1, agentVersion, mode, hostname, os, arch,
capabilities, caps, workspaceBase }`, and every SSE connect (probe and each
reconnect) carries the same JSON in the `x-dsh-computers-metadata` header as
base64url — an SSE GET has no body, so the header is how the reference-product
handshake metadata maps onto this wire. `mode` is `service` for the CLI/launchd
install (there *is* `~/.dsh-computers/agent.mjs` to upgrade) and `embedded` for
the plugin's in-process runtime (upgrade the DSH plugin instead); it is also in
the heartbeat `meta` and in `startRuntime().status()`. `workspaceBase` comes
from `config.json` (`--workspace-base`, default `$HOME`), is the default `cwd`
for `exec`, and is the base for relative `glob`/`grep` patterns.

### Local skills report (v1.9.0)

Every enroll body and every heartbeat carries the skills that exist **on this
machine**, so the hub can list them in DSH's slash menu:

```json
"skills": [
  {
    "name": "lark-doc",
    "description": "飞书云文档（Docx / Wiki）内容操作…",
    "path": "/Users/me/.dsh/skills/lark-doc",
    "whenToUse": "用户提供文档 URL/token 时使用"
  }
]
```

`path` is the skill's **directory** on this machine (the hub appends
`SKILL.md`); it is optional in the shape but reported whenever it is absolute and
≤ 512 chars, because the hub cannot re-derive a `~/.dsh/skills` path from
`workspaceBase`.

`skills` is top-level — a sibling of `meta` in a heartbeat and of `metadata` in
the enroll body. It is deliberately **not** inside `metadata`: that object is
also the base64url `x-dsh-computers-metadata` header on every SSE connect, and a
skill list has no business in an HTTP header.

Scan roots, each `<root>/<skill>/SKILL.md`:

| root | scope |
| --- | --- |
| `~/.dsh/skills` | this user |
| `~/.agents/skills` | this user (agents convention) |
| `<workspaceBase>/.dsh/skills` | this workspace |
| `<workspaceBase>/.agents/skills` | this workspace |

Rules:

- Only the first **4 KiB** of each `SKILL.md` is read. The `---`-fenced
  frontmatter subset `name`, `description`, `whenToUse` is parsed (single-line
  scalars, optional quotes; block scalars like `description: |` are not
  supported and fall back). A missing `name` falls back to the directory name; a
  missing `description` falls back to the first non-empty body line (markdown
  heading/bullet markers stripped). Unterminated frontmatter is malformed and
  falls back to the directory name.
- Caps: **50 entries**; `name` must be kebab-case
  (`^[a-z0-9]+(-[a-z0-9]+)*$`) and ≤ 64 chars — an entry that violates the name
  rule is **dropped**. `description` / `whenToUse` are clamped to 200 chars, and
  the serialized array stays ≤ **10 KiB** (verbose skills that no longer fit are
  skipped) so it can never crowd the 16 KiB enroll body or the heartbeat.
- Duplicate names: the first root wins (user roots before workspace roots).
- Unreadable or missing directories/files (ENOENT/EACCES, races) are skipped.
  The scan never throws and never fails an enroll or a heartbeat.
- The scan is synchronous and cached behind a cheap signature (directory entry
  counts plus each `SKILL.md`'s mtime/size), so an unchanged skill tree costs no
  file reads on the 10 s heartbeat; adding or editing a skill re-scans on the
  next heartbeat. A full scan of dozens of skills stays in single-digit ms.

### Streaming results (§11.2 + §11.6 frames)

When the host advertises `stream` and an `exec` event has `stream: true`, the
agent POSTs frames to `/api/dsh-computers/agent/results/chunk`:

```json
{ "requestId": "req_…", "seq": 0, "type": "stdout", "data": "<base64>" }
```

- `type` is `stdout`, `stderr`, or `heartbeat` (empty `data`).
- `seq` starts at 0 and increases by one per frame; frames are posted strictly
  sequentially so arrival order matches `seq` (the host can still drop dupes).
- Batches flush at most every 100 ms or 32 KiB (whichever first); a heartbeat
  frame is emitted after each 10 s of silence from a running command.
- A failed chunk POST retries once, then that batch is dropped — the command
  keeps running and the final authoritative `POST /agent/results` still carries
  the capped `stdout`/`stderr` buffers, `exitCode`, `durationMs`, `timedOut`
  and `truncated`.
- `stop()` drops buffered frames, clears every chunk timer and leaves no pending
  POSTs (they are aborted with the runtime).

### Remote file access (§11.3)

`fs` events are served in-process (no shell) and answered on
`POST /api/dsh-computers/agent/fs/result` with the §11.3 field set.

| op | request fields | response highlights |
| --- | --- | --- |
| `read` | `path`, `offset?`, `limit?`, `encoding?` (`utf8`/`base64`) | `encoding`, `text` (utf8) or `content` (base64), `bytes`, `lines`, `truncated` |
| `write` | `path`, `content`, `encoding?`, `createDirs?` | `bytes`, `created` |
| `list` | `path` | `entries[{name,path,type,size,mtimeMs}]`, `truncated` |
| `stat` | `path` | `stat{type,size,mtimeMs,mode}` |
| `mkdir` | `path`, `recursive?` | `created` |
| `rename` | `path`, `to` | `path` (new) |
| `delete` | `path`, `recursive?` | `ok` |
| `glob` | `pattern` (`*`, `?`, `**`, `{a,b}`) | `paths`, `truncated` |
| `grep` | `pattern` (RegExp), `path?`, `include?` (glob), `maxMatches?` | `matches[{path,line,text}]`, `truncated` |

Rules and limits:

- `read`/`write`/`list`/`stat`/`mkdir`/`rename`/`delete` require **absolute**
  paths (`ok:false, error:"path must be absolute"`); `glob`/`grep` accept
  relative paths/patterns resolved against `workspaceBase`.
- read 1 MiB / 20 000 lines, write 4 MiB, list 5 000 entries, glob 2 000
  paths, grep 500 matches, 15 s per request (a timed-out request answers
  `ok:false, error:"request timed out"`).
- Text vs binary: a NUL byte in the first 8 KiB (or `encoding:"base64"`) makes
  the read return base64 `content`; everything else returns utf8 `text`.
- Symlinks: `read` follows them like `cat`; `stat`/`list` report the link
  itself; directory walks never follow symlinked directories (loop safety) and
  skip `.git`; `write` follows an existing symlink.
- grep skips binary files and files larger than 8 MiB; `include` matches the
  basename or workspace-relative path.
- OS errors are returned verbatim in `error` (e.g. `ENOENT: no such file or
  directory, open '…'`); a request never throws out of the loop.

`startRuntime().status()` additionally exposes `workspaceBase`, `capabilities`
and the last advertised `features`.

## Files and environment

| Path | Purpose |
| --- | --- |
| `${DSH_COMPUTERS_HOME:-$HOME/.dsh-computers}/config.json` | Credentials + `workspaceBase` + the fleet `joinToken` from a one-address enroll, mode `0600`, atomic tmp+rename |
| `${DSH_COMPUTERS_HOME}/agent.log` | Append-only log, rotates at 5 MiB (keeps one `agent.log.1`) |
| `~/Library/LaunchAgents/com.dsh.computers.agent.plist` | macOS service unit |
| `~/.config/systemd/user/dsh-computers-agent.service` | Linux service unit |
| `~/.dsh-computers/agent.pid` | Only used by the `nohup` fallback |

Environment variables:

- `DSH_COMPUTERS_HOME` — relocate config + log (useful for tests and for
  multiple installs). Also written into the service unit so the service reads
  the same credentials.
- `DSH_COMPUTERS_SERVICE_LABEL` — override the launchd/systemd label
  (advanced/tests; default `com.dsh.computers.agent`).

## Security notes

- **Token**: generated by the server, stored only on this machine in a `0600`
  file, sent as `authorization: Bearer …` on every request. It is never printed,
  never logged, and `status` shows only its last 6 characters.
- **Join address**: `<url>#join=<token>` is a capability URL — whoever holds it
  can join machines. The token lives in the fragment, which browsers and
  proxies never send to the server, so it stays out of access logs. The agent
  parses it locally, stores it only in the `0600` `config.json` (`joinToken`),
  keeps `serverUrl` fragment-free, and sends it exactly once, in the enroll
  body — never on the stream, in a heartbeat or in a result POST.
- **Outbound only**: enroll, SSE stream, result POSTs, heartbeats, chunk/fs
  result POSTs. No listener.
- **Remote files**: when the server advertises the `fs` feature it can read and
  write files as your user, but only through the ops above; paths outside
  `workspaceBase` are allowed when absolute (documented §11.3 semantics), while
  relative paths are anchored at `workspaceBase`. Directory walks skip `.git`
  and symlinked directories.
- **Execution identity**: commands run as your user through
  `/bin/sh -lc '<command>'` (Windows: `cmd.exe /d /s /c`), inheriting your
  environment — the same power as your own terminal. Only connect your server
  to machines and networks you trust.
- **Process control**: each command is spawned `detached`, so on timeout/cancel
  the whole process group is killed with `SIGKILL` (`process.kill(-pid)`),
  including pipelines and grandchildren. Output is capped at 1 MiB per stream
  with `\n[output truncated]` appended and `truncated: true` in the result.
- **Log**: rotates at 5 MiB; also captures launchd's stdout/stderr. Contains
  command text and exit codes, never the token.

## Uninstall

```sh
node ~/.dsh-computers/agent.mjs service uninstall   # idempotent
rm -rf ~/.dsh-computers                             # credentials + logs
```

On the server side, delete the computer entry in Settings → 电脑 (its token is
hashed at rest there and every stored token stops working once the record is
removed).

## Troubleshooting

| Symptom | Meaning / fix |
| --- | --- |
| `run` exits with `✗ 服务器拒绝了已保存的凭据（HTTP 401 invalid-token）` | The server explicitly answered JSON `{"error":"invalid-token"}`: the token was revoked or the server state was reset. Generate a new key and `enroll` again. This is the one error the agent does **not** retry. |
| A bare `401` / `403` / `404` / `503` while connecting | That is **not** a token rejection (plugin reloading, generic `/api` gateway fence, proxy). The agent logs a throttled `⚠ 服务器暂时不可用…` at most once a minute and keeps retrying — machines survive plugin disable/enable and upgrades. |
| `status` says 未注册, exit 1 | No `config.json`; enroll first. |
| `注册失败（invalid-key / key-expired / key-used）` | The one-time key is wrong, older than 15 min, or already used — create a new one in Settings → 连接电脑, or use the one-address form instead. |
| `注册失败（invalid-join）` | The hub no longer accepts that `#join=` token (the address was regenerated, or it came from another server). Copy a fresh 接入地址 from Settings → 电脑 and `enroll --server '<url>#join=<token>'` again. The token is long-lived, so a rejected one is not retried. |
| Service not running (`service status`) | `service start`, then check `~/.dsh-computers/agent.log`. `KeepAlive` restarts it after crashes with a 10 s throttle. |
| `launchctl bootstrap` fails (`5: Input/output error` / domain unsupported) | The `gui/<uid>` domain is unavailable — usually an SSH session without a GUI login. The agent falls back to `launchctl load -w`; if both fail, run `service start` once from a logged-in desktop terminal. |
| `✗ 需要 Node.js >= 22` | Upgrade Node; the script relies on global `fetch` and modern ESM. |
| Computer shows offline in the UI | Check `agent.log` for reconnect lines; the stream reconnects with 1 s → 30 s backoff. |
| Streaming/file tools unavailable after upgrading | The host must advertise `stream`/`fs` in `hello.features`; old hosts get v1 behaviour by design (§11.5). The agent log line `已连接 … features=…` shows what the host offered. |

## Protocol notes (intentional choices)

- **Only our own `invalid-token` 401 is fatal.** A rejected **token** cannot
  heal by retrying, so `run` logs `✗ … HTTP 401 invalid-token` and exits
  non-zero. The classification is deliberately narrow: HTTP 401 **and** a JSON
  body with `error === 'invalid-token'` (the host plugin's rejection shape).
  Any other 401 (bare text, another JSON error, empty body) — and 403/404/5xx —
  is a transient server-side condition (plugin reload, gateway fence, proxy)
  and is retried with the normal 1 s → 30 s backoff, warning at most once per
  60 s. Without this, disabling/enabling or upgrading the hub plugin would
  knock every connected machine offline until the user re-ran the installer.
- **Heartbeats** call `POST /api/dsh-computers/agent/heartbeat` every
  `heartbeatMs` (from `hello`). This is belt-and-braces next to the open
  stream and also picks up renames echoed by the server.
- **One-address join (v1.7.0).** `--server '<url>#join=<token>'` (or the same
  string as `startRuntime({ serverUrl })`) parses the fragment locally, sends
  `{ join: '<token>' }` instead of `{ key }`, and stores the fragment-free URL.
  The join token is persisted in the same `0600` `config.json` so a later
  `enroll --server <url>` can re-register; it is sent only on enroll. `--key`
  still works and wins when both are present. A rejected join is fatal on the
  enroll side (401 `invalid-join`) but transient join failures (network, 5xx)
  are retried by the embedded runtime with the normal backoff.
- **`enroll --replace`** sends `"replace": true` in the enroll body (the host
  also keys replacement off the pending key). It does not change local
  behaviour otherwise.
- **`DSH_COMPUTERS_SERVICE_LABEL`** exists only so tests can install/remove a
  throw-away launchd job instead of touching a real one.

## Development

`agent/test/mock-server.mjs` is an in-memory implementation of PROTOCOL
§3.1–§3.4 (enroll, SSE events, results, heartbeat) on an ephemeral port; the
tests drive the real CLI against it.

```sh
node --check agent/dsh-computers-agent.mjs

# The documented gate. Node 24 no longer expands a directory positional, so
# agent/test/package.json only carries a "main" shim that keeps this exact
# command working. The explicit glob form works on its own too:
node --test agent/test/
node --test "agent/test/**/*.test.mjs"
```

To poke at the agent by hand:

```sh
node agent/test/mock-server.mjs --port 0 --verbose
# prints a ready-to-paste enroll command and the mock URL
```

Covered by the suite: enroll happy path / invalid / expired / used key,
one-address `#join=` enroll (posts `{ join }`, stores a fragment-free
`serverUrl` + `joinToken`, never prints or streams the token), `--key` wins
over a fragment, the "neither form" error, a rejected join (401 `invalid-join`)
failing with the server message, reuse of the saved join token for a later
`enroll --server`, `startRuntime({ serverUrl: '<url>#join=…' })` enrolling once
and reporting credentials through `onEnrolled`, `--replace` re-enroll, token
redaction, `0600` + atomic config, SSE connect →
exec → result, exit codes + stdout/stderr, default and explicit `cwd`,
environment inheritance, timeout process-group kill, truncation at 1 MiB,
cancel process-group kill, reconnect after a dropped stream, heartbeats,
server-driven rename, log rotation, idempotent launchd
install/status/stop/uninstall, plus the runtime-mode and 401-classification
paths:

- import is side-effect free and exports `startRuntime` + `AGENT_VERSION`;
- embedded `startRuntime()` connects to the mock, executes a command,
  `status()` reports `connected`/`since`, `stop()` closes the stream, reaps the
  `sleep` child (process group), posts no result after shutdown, and returns
  `running: false, connected: false, exitCode: 0`;
- a foreign bare/other-JSON 401 is retried and the machine reconnects (throttled
  single warning), while JSON `invalid-token` exits 1 without retry;
- 404/503 during connect are retried and the stream recovers;
- §11: enroll reports `capabilities:['exec','fs']` + full handshake metadata,
  the metadata header is on every SSE connect, `exec` defaults to
  `workspaceBase`, typed chunk frames arrive with contiguous `seq` (stdout,
  stderr and silent-command heartbeats), chunk POSTs retry once / drop without
  killing the command, an old host (no `features`) gets no chunks and no fs,
  and the fs ops round-trip (read text/binary + windows + limits, relative-path
  rejection, write/list/stat/mkdir/rename/delete, glob with `**` and `{a,b}`,
  grep with `include`/`maxMatches`/binary skip, and `stop()` during an
  in-flight fs request leaves no result POST);
- R2a caps: enroll metadata, every connect header and heartbeat `meta` carry
  `{exec:true,fs:true,jobs:true,pty:false,tunnel:false}`; `startRuntime({fs:false})`
  reports `fs:false`, ignores fs events, and leaves the legacy `capabilities`
  array + `mode` unchanged; old metadata fields are untouched.
- v1.9.0 skills (temp `HOME` + workspace fixtures): the enroll body and every
  heartbeat carry `skills` from the four roots (frontmatter, directory-name and
  first-body-line fallbacks, malformed/unterminated frontmatter), invalid
  kebab-case names are dropped, `description`/`whenToUse` are clamped to 200
  chars, the 50-entry / 10 KiB caps hold, unreadable dirs and `SKILL.md` files are
  skipped without failing enroll, a machine with no skills reports `[]`, and the
  scan re-runs when a `SKILL.md` changes while an unchanged tree reuses the cache.
