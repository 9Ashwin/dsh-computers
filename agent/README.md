# dsh-computers-agent

The machine-side half of **dsh-computers**: a single, dependency-free Node.js
script that runs on your own Mac/Linux box, dials **out** to a DSH Web server,
and executes shell commands the server's agent asks for. It is the "cloud
computer" client — no inbound port, no NAT/firewall change, no daemon port.

```
dsh web  ──SSE (outbound from the Mac)──▶  dsh-computers-agent  ──▶  /bin/sh -lc
                                            │
                                            ├─ ~/.dsh-computers/config.json  (0600, token)
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

### Recommended: the one-liner from Settings → 电脑

The server's **Connect computer** dialog generates a command like:

```sh
curl -fsSL 'http://<server>/api/dsh-computers/join.sh?key=dshc_…' | sh
```

It downloads this script to `~/.dsh-computers/agent.mjs`, enrolls with the
one-time key, installs the login service, and starts it.

### Manual

```sh
mkdir -p ~/.dsh-computers
curl -fsSL 'http://<server>/api/dsh-computers/agent.mjs' -o ~/.dsh-computers/agent.mjs
node ~/.dsh-computers/agent.mjs enroll --server http://<server> --key dshc_…
node ~/.dsh-computers/agent.mjs service install
node ~/.dsh-computers/agent.mjs service start
```

Enrollment keys are single use and expire (15 minutes by default). When the
server says the machine is already connected, re-run with `--replace`:

```sh
node ~/.dsh-computers/agent.mjs enroll --server http://<server> --key dshc_… --replace
```

> A successful `enroll` prints `✓ 已连接 <server>，这台电脑现在是 <name>`.
> If the stream probe fails, the credentials are still saved and `run` retries.

## Commands

```
dsh-computers-agent enroll --server <url> --key <key> [--name <name>] [--workspace-base <path>] [--replace]
dsh-computers-agent run
dsh-computers-agent service install|uninstall|start|stop|restart|status
dsh-computers-agent status
dsh-computers-agent --version | --help
```

| Command | What it does |
| --- | --- |
| `enroll` | POSTs the join key (plus `capabilities` and §11.6 `metadata`) to `/api/dsh-computers/agent/enroll`, saves `{serverUrl, computerId, token, name, enrolledAt, workspaceBase}` to `config.json` (atomic, `0600`), then opens the SSE stream for ~5 s to prove the round trip. `--workspace-base` sets the default working directory (default `$HOME`). Exits non-zero with the server's message on failure. |
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
  serverUrl: 'https://dsh.example.com',
  token: 'dshc_…',            // from the hub's enroll response
  computerId: 'cmp_…',
  name: 'Desk Mac mini',      // optional display name
  mode: 'embedded',           // 'service' (default) or 'embedded'; shown to the UI
  heartbeatMs: 20000,         // optional; `hello` overrides it
  log: (level, message) => {}, // 'info' | 'warn' | 'error'
  onState: (state) => {},      // connect/disconnect/error/stop transitions
})

runtime.status() // synchronous snapshot (see below)
await runtime.stop() // idempotent: aborts SSE, SIGKILLs children, awaits the loop
```

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

## Protocol v1.3.0 / §11 features

### Capabilities and gating (§11.1, §11.5)

The agent reports `capabilities: ["exec", "fs"]` in the enroll body, in the
heartbeat `meta`, in the §11.6 metadata and in `startRuntime().status()`.
Nothing new is sent to an old host: the `hello` event's `features` list decides
what is enabled per connection —

| `hello.features` | behaviour |
| --- | --- |
| absent / no `stream`, no `fs` | exactly v1: `exec` results only, `fs` events ignored, no chunk POSTs |
| `stream` | `exec` with `"stream": true` gets incremental chunk POSTs |
| `fs` | `fs` events are served and answered on `/agent/fs/result` |

### Handshake metadata (§11.6)

Enroll sends `metadata: { version: 1, agentVersion, mode, hostname, os, arch,
capabilities, workspaceBase }`, and every SSE connect (probe and each
reconnect) carries the same JSON in the `x-dsh-computers-metadata` header as
base64url — an SSE GET has no body, so the header is how the reference-product
handshake metadata maps onto this wire. `mode` is `service` for the CLI/launchd
install (there *is* `~/.dsh-computers/agent.mjs` to upgrade) and `embedded` for
the plugin's in-process runtime (upgrade the DSH plugin instead); it is also in
the heartbeat `meta` and in `startRuntime().status()`. `workspaceBase` comes
from `config.json` (`--workspace-base`, default `$HOME`), is the default `cwd`
for `exec`, and is the base for relative `glob`/`grep` patterns.

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
| `${DSH_COMPUTERS_HOME:-$HOME/.dsh-computers}/config.json` | Credentials + `workspaceBase`, mode `0600`, atomic tmp+rename |
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
| `注册失败（invalid-key / key-expired / key-used）` | The one-time key is wrong, older than 15 min, or already used — create a new one in Settings → 连接电脑. |
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
`--replace` re-enroll, token redaction, `0600` + atomic config, SSE connect →
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
  in-flight fs request leaves no result POST).
