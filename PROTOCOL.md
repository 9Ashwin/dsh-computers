# dsh-computers — implementation contract (v1)

A DSH Web plugin that turns DSH-Web on a server into a controller for the user's own
machines. Each machine runs a small outbound-only agent; the server can then run shell
commands there through a model-facing tool. Modeled on Memoh's "cloud computer" feature
(enroll key + one-line install + online presence + exec from the agent).

Read this file completely before writing code. Every name here is a contract between
three independently written surfaces:

| Surface | Owner scope | Files |
|---|---|---|
| Host plugin | teammate `host-dev` | `index.js`, `lib/**` |
| Machine agent | teammate `agent-dev` | `agent/**` |
| Web client (settings page) | teammate `ui-dev` | `client.js` |
| Package metadata, locales, docs, install/verify | Lead | `package.json`, `cordis.patch.yml`, `locale/**`, `icon.svg`, `README.md`, `PROTOCOL.md`, `scripts/**` |

Node 22+ (server runs Node 24 here). No third-party runtime dependencies anywhere:
host, agent and client are plain ESM / plain browser JS.

---

## 1. Deployment shape

```
┌─────────────── server ───────────────┐          ┌──────── Mac A ────────┐
│ dsh web (dsh-web-app + this plugin)  │  ◀─SSE── │ dsh-computers-agent   │
│  · registry (state.json)             │  ──HTTP─▶│  · shell exec         │
│  · SSE hub / exec dispatch           │          │  · launchd service    │
│  · agent tools + settings page       │          └───────────────────────┘
└──────────────────────────────────────┘          ┌──────── Mac B ────────┐
        ▲  browser (settings page)                 │ dsh-computers-agent   │
        └──────────────────────────────────────────┴───────────────────────┘
```

The machine agent only makes **outbound** connections (enroll → SSE stream → result
POSTs), so no port has to be opened on the Macs and NAT is a non-issue.

The browser page talks to the host plugin over the same origin, using document-relative
URLs (`api/dsh-computers/...`, no leading slash) because the harness serves the GUI with
`<base href="./">`.

## 2. Persisted state (host)

Path: `${DSH_HOME:-~/.dsh}/computers/state.json` (override with plugin config `stateDir`).
Written atomically (tmp file + rename), mode 0600 where the platform allows it.

```jsonc
{
  "version": 1,
  "computers": [
    {
      "id": "cmp_9f3a...",            // cmp_ + 12 lowercase hex, generated on enroll
      "name": "AshwindeMac-mini.local", // display name; defaults to hostname
      "hostname": "AshwindeMac-mini.local",
      "os": "darwin",                  // node os.platform()
      "arch": "arm64",
      "platformLabel": "macOS",        // macOS | Linux | Windows | Unknown
      "cpuModel": "Apple M4 Pro",
      "memoryBytes": 17179869184,
      "nodeVersion": "v24.18.1",
      "agentVersion": "1.0.0",
      "tokenHash": "<sha256 hex of the agent token>",
      "createdAt": "2026-11-11T10:00:00.000Z",
      "lastSeenAt": "2026-11-11T10:00:05.000Z"
    }
  ],
  "pendingKeys": [
    {
      "key": "dshc_<43 base64url chars>",
      "createdAt": "…", "expiresAt": "…",
      "os": "macos",              // requested OS tab, informational only
      "label": null,              // optional display name for the joining machine
      "usedAt": null,             // set when consumed (single use)
      "computerId": null          // set on successful enroll
    }
  ]
}
```

Rules:
- Enrollment key: `dshc_` + `crypto.randomBytes(32).toString('base64url')`, single use,
  TTL **15 min** (config `keyTtlMinutes`).
- Agent token: `dshc_` + `crypto.randomBytes(32).toString('base64url')`, long lived,
  returned to the agent exactly once at enroll; the server keeps only `sha256(token)`.
- Presence: a computer is **online** while it holds an open SSE stream; `lastSeenAt` is
  refreshed on stream open, on heartbeat and on result POST. If a stream is absent, a
  heartbeat newer than 2× `heartbeatMs` also counts as online (belt and braces).
- Prune: a `pendingKeys` entry whose `usedAt` is set and is older than 1 h, or whose
  `expiresAt` passed 1 h ago, may be dropped on the next write.

## 3. Agent → host API

Base path **`/api/dsh-computers`**. These routes are exact `webServer.register` routes and
must NOT go through the browser request gate (they are machine-to-machine and
authenticated by token). JSON in/out, `content-type: application/json; charset=utf-8`,
`cache-control: no-store`.

Auth: `authorization: Bearer <token>` on every route except `enroll`, `join.sh`,
`agent.mjs`, `health`. Compare with `crypto.timingSafeEqual` on the sha256 digests.

### 3.1 `POST /api/dsh-computers/agent/enroll`

Request body (max 16 KiB):

```json
{
  "key": "dshc_…",
  "agentVersion": "1.0.0",
  "machine": {
    "hostname": "AshwindeMac-mini.local",
    "name": "AshwindeMac-mini.local",
    "os": "darwin", "arch": "arm64", "platform": "macOS",
    "cpuModel": "Apple M4 Pro", "memoryBytes": 17179869184, "nodeVersion": "v24.18.1"
  }
}
```

Responses:
- `200 { "computerId": "cmp_…", "token": "dshc_…", "name": "AshwindeMac-mini.local", "serverUrl": "http://…" }`
  Creating a new computer, or re-enrolling a machine whose name/hostname matches an
  existing computer **and** the key was created with `replace: true` (then the old
  token hash is replaced in place, same `id`). Otherwise a new record is created.
- `401 { "error": "invalid-key", "message": "…" }` unknown key
- `410 { "error": "key-expired", "message": "…" }` past `expiresAt`
- `409 { "error": "key-used", "message": "…" }` already consumed
- `400 { "error": "bad-request", "message": "…" }`

### 3.2 `GET /api/dsh-computers/agent/events` (SSE, auth)

Response headers: `content-type: text/event-stream; charset=utf-8`,
`cache-control: no-store`, `connection: keep-alive`, `x-accel-buffering: no`; send an
initial `retry: 2000\n\n` and flush headers immediately.

Events (SSE framing `event: <name>\ndata: <json>\n\n`):

| event | data | meaning |
|---|---|---|
| `hello` | `{ "computerId", "name", "heartbeatMs": 20000 }` | stream accepted |
| `exec` | `{ "requestId": "req_…", "command": "…", "cwd": "…or null", "timeoutMs": 120000, "shell": "sh" }` | run a command |
| `cancel` | `{ "requestId": "req_…" }` | abort a running command |
| `ping` | `{ "t": 1763000000000 }` | liveness, every `heartbeatMs` |
| `config` | `{ "name": "…", "execEnabled": true }` | optional, sent after rename |

Only one live stream per computer: a new stream for the same computer replaces the old
one (old response is ended). Closing the stream marks the computer offline.

### 3.3 `POST /api/dsh-computers/agent/results` (auth)

```json
{
  "requestId": "req_…",
  "ok": true,
  "exitCode": 0,
  "signal": null,
  "stdout": "…",
  "stderr": "…",
  "durationMs": 42,
  "truncated": false,
  "timedOut": false,
  "error": null
}
```

→ `200 { "ok": true }`; `404 { "error": "unknown-request" }` when the server already
settled/timed out that request (agent ignores it).

### 3.4 `POST /api/dsh-computers/agent/heartbeat` (auth)

Body `{ "meta": { "cpuModel"?, "memoryBytes"?, "agentVersion"? } }` →
`200 { "ok": true, "name": "…" }` (host echoes the current display name).

## 4. Browser → host API

Same base path. Every route here must consult the host request gate first:
`ctx.get('connection')?.requestRejection(req)` → a status number means refuse with that
status and a JSON body `{ "error": "unadmitted" }`. When the service is absent, fall back
to accepting loopback/absent-Origin the way `dshmarket/src/http.ts` documents (copy that
file's `sameOrigin` logic into `lib/http.js`; keep it small and comment the reason).

All responses JSON + `cache-control: no-store`. Errors: `{ "error": "<code>", "message": "…" }`.

### 4.1 `GET /api/dsh-computers/state`

```json
{
  "version": 2,
  "serverUrl": "http://127.0.0.1:52083",
  "heartbeatMs": 20000,
  "computers": [
    { "id": "cmp_…", "name": "…", "hostname": "…", "os": "darwin",
      "platformLabel": "macOS", "online": true, "lastSeenAt": "…",
      "createdAt": "…", "agentVersion": "1.0.0",
      "cpuModel": "…", "memoryBytes": 17179869184,
      "bots": { "used": 1, "total": 1 } }
  ],
  "pendingKey": { "key": "dshc_…", "expiresAt": "…", "os": "macos" } | null
}
```

`bots` is display sugar mirroring Memoh's "1/1 Bot" badge: `used = 1` when a computer
switches from offline → online, `total = 1`. (No per-computer bot ownership in v1; keep
the field so the UI can show the badge.)

### 4.2 `POST /api/dsh-computers/keys`

Body `{ "os": "macos" | "windows" | "linux", "replace": false, "label": null }` → `200`

```json
{
  "key": "dshc_…",
  "os": "macos",
  "expiresAt": "…",
  "serverUrl": "http://host:port",
  "command": "curl -fsSL 'http://host:port/api/dsh-computers/join.sh?key=dshc_…' | sh",
  "windowsCommand": "irm 'http://host:port/api/dsh-computers/join.ps1?key=dshc_…' | iex",
  "installUrl": "http://host:port/api/dsh-computers/join.sh?key=dshc_…"
}
```

Only one pending key at a time: creating a new one invalidates earlier pending keys
(mark them used). `serverUrl` = config `publicUrl` if set, else `ctx.webServer.getOrigin()`.

### 4.3 `GET /api/dsh-computers/key-status?key=…`

```json
{ "status": "waiting" | "connected" | "expired" | "used" | "unknown",
  "computer": { "id": "cmp_…", "name": "…", "online": true } | null }
```

The connect modal polls this every 2 s and closes on `connected`.

### 4.4 `POST /api/dsh-computers/delete`

Body `{ "id": "cmp_…" }` → `200 { "ok": true }`. Ends the live stream and drops the
record. Unknown id → `404 { "error": "not-found" }`.

### 4.5 `POST /api/dsh-computers/rename`

Body `{ "id": "cmp_…", "name": "Desk Mac mini" }` (1–64 visible chars, trimmed) →
`200 { "ok": true, "name": "Desk Mac mini" }`. Pushes a `config` SSE event to the agent.

### 4.6 `GET /api/dsh-computers/join.sh?key=…`

Plain-text shell installer, **no browser gate**, key-validated (unknown/expired → 410 with
a short text body). Concretely it must:

1. `set -eu`; require `node` >= 22 (`node -v`), `curl`; print a clear error otherwise.
2. `mkdir -p "$HOME/.dsh-computers"`.
3. Download `"$SERVER/api/dsh-computers/agent.mjs"` → `$HOME/.dsh-computers/agent.mjs`.
4. `node "$HOME/.dsh-computers/agent.mjs" enroll --server "$SERVER" --key "$KEY"`.
5. `node "$HOME/.dsh-computers/agent.mjs" service install && … service start` on macOS
   (launchd) and Linux (systemd --user); on failure print the manual `… run` fallback.
6. Print a short success banner.

`SERVER` comes from the same `serverUrl` the UI shows; the script is generated by the host
(a template string in `lib/http.js` or `lib/join.js`) so it never drifts from the routes.

`GET /api/dsh-computers/join.ps1` is the Windows variant (`irm … | iex`), best effort.

### 4.7 `GET /api/dsh-computers/agent.mjs`

Serves `agent/dsh-computers-agent.mjs` from the bundle directory
(`new URL('./agent/dsh-computers-agent.mjs', import.meta.url)`), `content-type:
text/javascript; charset=utf-8`, `cache-control: no-store`. Public.

### 4.8 `GET /api/dsh-computers/health`

`{ "ok": true, "version": "1.0.0", "computers": <count>, "online": <count> }`.

## 5. Model-facing tools (host plugin)

Registered with `ctx.tools.register(...)` in `apply`, `inject = ['tools', 'webServer']`
(plus optional `systemPrompt`, `connection` read via `ctx.get`).

### 5.1 `computer_list`

- parameters: `{ "type": "object", "properties": {}, "additionalProperties": false }`
- output schema: `{ "type": "object", "properties": { "computers": { "type": "array", "items": { … } } }, "required": ["computers"] }`
- value: `{ computers: [{ id, name, online, platformLabel, os, hostname, lastSeenAt, agentVersion }] }`
- `output.render(args, value)` returns `[{ "type": "text", "text": "<markdown table or list>" }]`.

### 5.2 `computer_exec`

- parameters:
  `{ "type": "object", "properties": { "computer": {"type":"string","description":"Computer id or name from computer_list"}, "command": {"type":"string"}, "cwd": {"type":"string"}, "timeoutMs": {"type":"number"} }, "required": ["computer","command"], "additionalProperties": false }`
- Resolve `computer` by exact `id`, else case-insensitive exact `name`, else unique
  substring match; ambiguity → error listing candidates.
- Dispatch through the hub, respect `exec.signal` (send `cancel` on abort, reject with a
  clear "aborted" message).
- value: `{ computer: {id,name}, command, exitCode, stdout, stderr, durationMs, ok, timedOut, truncated }`
- `render` → one text block: a `$ command` line, `exit <code> · <ms>ms · <name>`, then
  stdout, then stderr under a `stderr:` label. Cap the rendered text at ~20 000 chars.
- Failures (unknown computer, offline, timeout) throw an `Error` with a message the model
  can act on ("computer 'x' is offline; run computer_list").

### 5.3 System prompt section

`ctx.systemPrompt.section({ name: 'computers', order: …, text: () => … })` — a short
paragraph: "You can run shell commands on the user's connected computers with
`computer_exec`." followed by one line per computer, `- <name> (<platform>, online|offline)`.
Keep it under ~15 lines; return `''` when there are no computers. Verify the exact
`section()` argument shape with `cordis_inspect_query` (host `Service` → `systemPrompt`)
before wiring it; if it costs a request, read
`/Users/ashwin/workspaces/github/deepseek-harness/packages/core/system-prompt/src/index.ts`.

## 6. Machine agent (`agent/dsh-computers-agent.mjs`)

Single self-contained ESM file, Node >= 22, zero dependencies, shebang `#!/usr/bin/env node`.

```
dsh-computers-agent <command> [options]

  enroll --server <url> --key <key> [--name <name>] [--replace]
  run                      connect and serve commands in the foreground
  service install|uninstall|start|stop|restart|status
  status                   print config + whether the service is loaded
  --version | --help
```

- Config: `${DSH_COMPUTERS_HOME:-$HOME/.dsh-computers}/config.json`
  `{ "version": 1, "serverUrl": "…", "computerId": "cmp_…", "token": "dshc_…", "name": "…", "enrolledAt": "…" }`, mode 0600.
- Log: `${DSH_COMPUTERS_HOME}/agent.log`, append, rotate at 5 MiB (keep one `.1`).
- `enroll`: POST §3.1, persist config, then open the SSE stream once for ~5 s to prove the
  round trip and print `✓ 已连接 <server>，这台电脑现在是 <name>` (Chinese is fine in CLI
  output; keep it short). Exit non-zero with the server's message on failure.
- `run`: SSE loop (§3.2) with backoff 1 s → 30 s (jitter), re-enrolls nothing (token is
  durable); on `exec` spawn the shell, stream nothing (v1 returns one result), POST §3.3;
  `cancel` kills the process group; `ping` refreshes nothing (host handles presence).
  Print a heartbeat log line at most every 60 s.
- Exec: POSIX `/bin/sh -lc <command>`, Windows `cmd.exe /d /s /c <command>`;
  `cwd` default `os.homedir()`; env inherits; `detached: true` and kill with
  `process.kill(-pid, 'SIGKILL')` on timeout/abort; cap each stream at 1 MiB, set
  `truncated: true` and append `\n[output truncated]`.
- Service: macOS launchd user agent `~/Library/LaunchAgents/com.dsh.computers.agent.plist`,
  `RunAtLoad` + `KeepAlive`, `StandardOutPath`/`StandardErrorPath` → the log; uses
  `process.execPath` and the absolute agent path. Linux: systemd user unit at
  `~/.config/systemd/user/dsh-computers-agent.service` + `systemctl --user daemon-reload`
  and `enable --now` (fall back to `nohup … run &` when systemd is unavailable).
  Windows: print the manual command and exit 0 with a note (v1).
- Never print the token. `status` redacts it.

### Agent-side mock server for tests

`agent/test/mock-server.mjs`: a tiny Node HTTP server implementing §3.1–§3.4 (in-memory),
so `agent-dev` can verify enroll/SSE/exec without the real plugin. `agent/test/*.test.mjs`
must be runnable with plain `node --test agent/test/`.

## 7. Web client (`client.js`)

Single self-contained file in the Module-Loader format (copy
`templates/decoration/client.js` from the cordis-plugin-development skill for the envelope):

```js
window.__ModuleLoader__.load({
  id: 'dsh-computers',
  factory(require) { const React = require('react'); … return { inject: ['slots', 'locale'], apply(ctx) { … } } },
})
```

- `inject: ['slots', 'locale']`.
- Register exactly one `settings.section` entry:
  `ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'computers', order: 45, label: () => t('Computers') }, ComputersPanel))`.
- `ctx.locale.register('dsh-computers', { zh, en })` + `const t = ctx.locale.bind('dsh-computers')`.
  All visible text goes through `t`; `locale/en.json` and `locale/zh.json` in the bundle
  are for the *plugin listing* metadata (`meta.title` / `meta.description`) only.
- Page layout mirrors Memoh's screenshot: title `电脑`, right-aligned primary button
  `+ 连接电脑`, then a bordered list; each row: name, a `1/1 Bot` badge, right side
  online/offline dot + label (`在线` / `离线`), a gear button (rename dialog) and a trash
  button (delete with confirm). Empty state when no computers.
- Connect modal: title `连接电脑`, subtitle `在要连接的电脑上安装 Node.js 22+，然后在终端运行下方命令`,
  three segmented tabs `Windows` / `macOS` (`Linux`), a switch row
  `覆盖这台电脑已保存的连接` + hint `终端提示已有其他连接时开启，再重新复制命令`,
  a read-only command box (monospace, wraps) with a copy button, a status row
  `等待电脑连接…` (spinner) that polls §4.3 every 2 s, and `取消`. On connected: close
  modal, refresh list, toast/inline success.
- Data: `fetch` document-relative (`api/dsh-computers/…`) with `credentials: 'same-origin'`
  and `content-type: application/json` on POSTs. Poll §4.1 every 5 s while the page is
  mounted (clear on unmount) so presence updates.
- Styling: only `--dsw-alias-*` theme tokens (bg-layer-1/2, border-l1/l2, label-primary/
  secondary, brand-primary, state-success/error/idle-primary, bg-overlay). No hard-coded
  page colors. Own CSS classes prefixed `dshc-`; inject one `<style>` element from the
  component (or a module-level stylesheet inside `apply` with `ctx.effect` cleanup).
- Controls must be accessible: `role="switch"` + `aria-checked` on the replacement toggle,
  real `<button>`s, Escape closes the modal, click-outside closes it, focus stays inside
  while open.
- No React bits from `@deepseek-ai/dsh-client-ui-*` packages — write the controls.
- The panel receives owner props `{ close }`; a page may ignore it.

## 8. Config (host plugin)

```yaml
- id: dsh-computers
  name: dsh-computers
  config:
    publicUrl: ''            # e.g. https://dsh.example.com ; empty → ctx.webServer.getOrigin()
    stateDir: ''             # empty → $DSH_HOME/computers
    keyTtlMinutes: 15
    heartbeatMs: 20000
    execTimeoutMs: 120000
    execEnabled: true        # false rejects computer_exec and tells the agent
    maxOutputBytes: 1048576
```

Validate with `export const Config` (schemastery is available to host plugins in the
profile; if importing it is fragile, validate manually in `apply` and throw a clear error).
Prefer the plain-object export form `export function apply(ctx, config)` +
`export const inject = [...]`.

## 9. Definition of done (per surface)

- Host: `node --check` on every file; a `scripts/host-smoke.mjs` (Lead-owned harness) starts
  the plugin's modules against a fake `ctx` and exercises state, keys, SSE, exec dispatch.
- Agent: `node --test agent/test/` green, including enroll → SSE → exec → result against
  the mock server, timeout kill, truncation, and `--help`/`status` output.
- Client: `node --check client.js`; loads in the real page (Lead verifies with Playwright
  screenshot of Settings → 电脑).
- Lead: install the bundle into the desktop profile, enroll this Mac with the real
  one-liner, confirm `computer_list` + `computer_exec` from a live session, screenshot the
  page, then write `README.md` (deployment + security notes) and report.
