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
dsh-computers-agent enroll --server <url> --key <key> [--name <name>] [--replace]
dsh-computers-agent run
dsh-computers-agent service install|uninstall|start|stop|restart|status
dsh-computers-agent status
dsh-computers-agent --version | --help
```

| Command | What it does |
| --- | --- |
| `enroll` | POSTs the join key to `/api/dsh-computers/agent/enroll`, saves `{serverUrl, computerId, token, name, enrolledAt}` to `config.json` (atomic, `0600`), then opens the SSE stream for ~5 s to prove the round trip. Exits non-zero with the server's message on failure. |
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

## Files and environment

| Path | Purpose |
| --- | --- |
| `${DSH_COMPUTERS_HOME:-$HOME/.dsh-computers}/config.json` | Credentials, mode `0600`, atomic tmp+rename |
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
- **Outbound only**: enroll, SSE stream, result POSTs, heartbeats. No listener.
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
| `run` exits with `✗ 服务器拒绝了已保存的凭据（HTTP 401）` | The token was revoked or the server state was reset. Generate a new key and `enroll` again. This is the one error the agent does **not** retry, on purpose. |
| `status` says 未注册, exit 1 | No `config.json`; enroll first. |
| `注册失败（invalid-key / key-expired / key-used）` | The one-time key is wrong, older than 15 min, or already used — create a new one in Settings → 连接电脑. |
| Service not running (`service status`) | `service start`, then check `~/.dsh-computers/agent.log`. `KeepAlive` restarts it after crashes with a 10 s throttle. |
| `launchctl bootstrap` fails (`5: Input/output error` / domain unsupported) | The `gui/<uid>` domain is unavailable — usually an SSH session without a GUI login. The agent falls back to `launchctl load -w`; if both fail, run `service start` once from a logged-in desktop terminal. |
| `✗ 需要 Node.js >= 22` | Upgrade Node; the script relies on global `fetch` and modern ESM. |
| Computer shows offline in the UI | Check `agent.log` for reconnect lines; the stream reconnects with 1 s → 30 s backoff. |

## Protocol notes (intentional choices)

- **401 on the SSE connect is fatal.** PROTOCOL §6 asks for backoff on
  disconnect; a rejected **token** cannot heal by retrying, so `run` logs
  `✗ … HTTP 401` and exits non-zero (the process supervisor will keep
  restarting it, but the message is in the log and `status` shows the state).
  The user must re-enroll.
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
server-driven rename, 401 exit without retry, log rotation, and idempotent
launchd install/status/stop/uninstall.
