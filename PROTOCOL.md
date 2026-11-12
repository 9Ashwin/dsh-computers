# dsh-computers — implementation contract (v1)

A DSH Web plugin that turns DSH-Web on a server into a controller for the user's own
machines. Each machine runs a small outbound-only agent; the server can then run shell
commands there through a model-facing tool. One server owns the registry and dispatches;
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
      "name": "my-mac-mini.local", // display name; defaults to hostname
      "hostname": "my-mac-mini.local",
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
- Presence: a computer is **online exactly while it holds an open SSE stream**
  (`online === streams.has(id)`). The heartbeat route still refreshes `lastSeenAt` and
  echoes the display name, but a fresh heartbeat never makes a stream-less computer
  online: closing the stream (including a killed agent) flips it offline on the next
  state read. A half-dead peer without FIN is detected when the next `ping` write fails,
  so stale presence is bounded by one `heartbeatMs`, not by a separate grace window.
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
    "hostname": "my-mac-mini.local",
    "name": "my-mac-mini.local",
    "os": "darwin", "arch": "arm64", "platform": "macOS",
    "cpuModel": "Apple M4 Pro", "memoryBytes": 17179869184, "nodeVersion": "v24.18.1"
  }
}
```

Responses:
- `200 { "computerId": "cmp_…", "token": "dshc_…", "name": "my-mac-mini.local", "serverUrl": "http://…" }`
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
  "serverUrl": "https://dsh.example.com",   // resolved, see §4.2
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

`bots` is display sugar for the "1/1 Bot" badge: `used = 1` when a computer
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
  "command": "curl -fsSL 'https://dsh.example.com/api/dsh-computers/join.sh?key=dshc_…' | sh",
  "windowsCommand": "irm 'https://dsh.example.com/api/dsh-computers/join.ps1?key=dshc_…' | iex",
  "installUrl": "https://dsh.example.com/api/dsh-computers/join.sh?key=dshc_…"
}
```

Only one pending key at a time: creating a new one invalidates earlier pending keys
(mark them used).

`serverUrl` (here and in §4.1) is the **externally reachable base**, resolved per request by
`resolveBaseUrl({ ctx, config, req })`, first match wins:

1. config `publicUrl` — an explicit operator override always wins. It MAY carry a path prefix for
   a sub-path deployment (e.g. `https://host/dsh`); it is used verbatim, minus a trailing slash.
2. `x-forwarded-proto` + `x-forwarded-host` (first comma entry of each; both required), or the
   first element of an RFC 7239 `forwarded:` header (`proto=`/`host=`), or `x-forwarded-ssl: on`
   as a protocol-only hint.
3. the request's own `host` header plus a protocol hint: `x-forwarded-proto` / `x-forwarded-ssl`,
   else the `origin` header's protocol when its host equals the resolved authority, else
   `ctx.webServer.protocol`. This is what makes an HTTPS reverse proxy that forgets
   `X-Forwarded-Proto` still produce `https://` — the browser's own `Origin` agrees.
4. `ctx.webServer.getOrigin()` (wrapped — it throws before the socket binds).
5. `http://127.0.0.1:<port>` from `ctx.webServer.port`, else `''`.

Auto-detected values are bare origins with no trailing slash. Any candidate that is not a clean
authority (a path, userinfo, whitespace, CR/LF, or over-long text) is rejected and the next
source is tried; an incomplete forwarded pair never mixes with the local protocol.

Why forwarded headers are trusted: a deployment behind a reverse proxy or tunnel is exactly the
case where the browser's own origin is the address another machine can actually reach, so the
generated one-liner is right with zero configuration (auto-detected public address).
An operator who does not trust their proxy keeps authority by setting `publicUrl`.

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
- value: `{ computer: {id,name}, command, exitCode, stdout, stderr, durationMs, ok, timedOut, truncated, terminal? }`
  (`terminal` is the typed terminal state below; v1.4.1)
- `render` → one text block: a `$ command` line, `exit <code> · <ms>ms · <name>`, then
  stdout, then stderr under a `stderr:` label. Cap the rendered text at ~20 000 chars.
- Failures (unknown computer, offline, timeout) throw an `Error` with a message the model
  can act on ("computer 'x' is offline; run computer_list").

#### Terminal states (v1.4.1)

Every execution (foreground, promoted, background job) settles with one typed object:

```ts
terminal: {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout'
  disposition: 'reusable' | 'broken'
  confirmed: boolean            // false when a stop was requested but never acknowledged
  exitCode: number | null
  signal: string | null
  error: string | null
}
```

| status | when | disposition | confirmed |
|---|---|---|---|
| `completed` | final result with `ok: true` | `reusable` | `true` |
| `failed` | final result with `ok: false` (non-zero exit, spawn error) | `reusable` | `true` |
| `timeout` | final result carried `timedOut: true` (the agent enforced its own deadline) | `reusable` | `true` |
| `timeout` | the host's silence deadline expired and a `cancel` was sent with no final result | `broken` | `false` |
| `cancelled` | `cancel` was requested **and** the agent reported a final result | `reusable` | `true` |
| `cancelled` | `cancel` was requested, the grace period expired with no final result | `broken` | `false` |

`broken` means the machine's state is unknown — the command **may still be running**.
A host must never report a plain "cancelled" for the unconfirmed case; it reports
`cancelled` with `confirmed: false` and `disposition: 'broken'` instead. A stream drop
or a host-side abort has the same shape (`failed`/`broken`, or `cancelled`/`broken` when a
cancel had been requested).

The tool render adds a `status: …` line only when the terminal state is not a clean
`completed`/`reusable` one, so successful executions keep their byte-identical output.

### 5.3 System prompt section

`ctx.systemPrompt.section({ name: 'computers', order: …, text: () => … })` — a short
paragraph: "You can run shell commands on the user's connected computers with
`computer_exec`." followed by one line per computer, `- <name> (<platform>, online|offline)`.
Keep it under ~15 lines; return `''` when there are no computers. Verify the exact
`section()` argument shape with `cordis_inspect_query` (host `Service` → `systemPrompt`)
before wiring it; if it costs a request, read
`<dsh-source-checkout>/packages/core/system-prompt/src/index.ts`.

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
- Page layout: title `电脑`, right-aligned primary button
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

---

## 10. Runtime mode (v1.1): the plugin can also BE the controlled machine

Motivation: a user who installs this plugin in their **desktop** DSH instance should not
have to run a terminal command at all. Starting the desktop app (or enabling a switch in
Settings → 电脑) makes that machine a runtime and it appears on the hub's computer list.

**Topology is explicitly hub-and-spoke, and only hub-and-spoke**: exactly one server is the
controller; a runtime only ever dials out to the single hub it was enrolled against. There
is no machine-to-machine control, no mesh, no peer discovery, and a runtime never accepts
inbound connections. Any machine may however run the plugin in `role: 'both'` and be a hub
for its own machines *and* a runtime of another hub — that is two independent spokes, not a
mesh.

The standalone `agent/dsh-computers-agent.mjs` one-liner stays as the headless / always-on
fallback (launchd/systemd machines that do not run DSH), and both paths share one
implementation.

### 10.1 Role

New plugin config `role: 'hub' | 'runtime' | 'both'` (default `'both'`).

| role | hub routes + tools + computer list | local runtime card |
|---|---|---|
| `hub` | yes | hidden |
| `runtime` | no controller routes (no `/agent/*`, `/keys`, `/key-status`, `/delete`, `/rename`, `/join.*`, no `computer_*` tools, no prompt section) — but `/state` and `/health` stay registered, because the client learns its role from `/state` | yes |
| `both` | yes | yes |

Deployments that serve others set `role: 'hub'`; a desktop install leaves the default and
gets both cards. `/api/dsh-computers/state` gains `"role": "<role>"` so the client can
decide what to render.

### 10.2 Runtime state (local, per plugin instance)

`${stateDir}/runtime.json`, mode 0600, atomic:

```jsonc
{
  "version": 1,
  "serverUrl": "https://dsh.example.com",
  "computerId": "cmp_…",
  "token": "dshc_…",
  "name": "my-mac-mini.local",
  "enabled": true,
  "enrolledAt": "…",
  "lastConnectedAt": "…",   // optional diagnostics
  "lastError": null
}
```

`enabled` is the user's switch and survives restarts: on plugin load, if `enabled` is true
the runtime starts automatically (that is the whole point — starting DSH = starting the
runtime).

### 10.3 Runtime manager

`lib/runtime.js` owns one instance per plugin load:

- `configure({ serverUrl, enrollmentKey })` — POST `<serverUrl>/api/dsh-computers/agent/enroll`
  (the §3.1 contract, same body the CLI sends), persist §10.2 with `enabled: true`, start.
- `start()` / `stop()` / `enable(bool)` / `disconnect()` (stop + delete runtime.json).
- `status()` → `{ configured, enabled, connected, serverUrl, computerId, name, since, lastError }`.
- Reconnection, backoff, exec and result POSTs are **the agent's** code: import
  `startRuntime` from `../agent/dsh-computers-agent.mjs` (see §10.4). The manager is a thin
  lifecycle + persistence wrapper; it must not reimplement the wire protocol.
- Plugin unload stops the runtime (effect cleanup). Exceptions never escape into the host.

### 10.4 Agent export contract (agent file must stay self-contained)

`agent/dsh-computers-agent.mjs` keeps working when downloaded and executed standalone, and
additionally exports:

```js
export function startRuntime(options) // → { stop(): Promise<void>, status(): object }
```

`options = { serverUrl, token, computerId, name?, heartbeatMs?, log?, onState?(state) }`.
It owns the SSE loop, exec, results, heartbeat. `log` is `(level, message) => void` and
defaults to console in CLI mode / the host warning sink in embedded mode. The CLI `run`
subcommand becomes a thin wrapper around it, and the module must be import-safe (CLI main
runs only when the file is the process entry point). No relative imports, no deps.

### 10.5 Runtime routes (browser-gated, same fence as §4)

| method | path | body → response |
|---|---|---|
| GET | `/api/dsh-computers/runtime` | → §10.3 `status()` + `{ serverUrl }` |
| POST | `/api/dsh-computers/runtime/connect` | `{ serverUrl, key }` → validate URL (`http`/`https` only), call `configure`, → status. Errors: `400 bad-request` (bad URL/key shape), `401 invalid-key`, `410 key-expired`, `409 key-used` mapped from the hub, `502 hub-unreachable` with the underlying message |
| POST | `/api/dsh-computers/runtime/enable` | `{ enabled: boolean }` → status |
| POST | `/api/dsh-computers/runtime/disconnect` | → status (now unconfigured) |

All responses include the full status object so the client needs no second round trip.

### 10.6 Client

Settings → 电脑, when `role !== 'hub'`, renders a **本机运行时** card above the computer list:

- unconfigured: 说明一行 + 服务器地址输入框 + 加入密钥输入框 + `连接` 按钮 (both fields
  required; paste the key from the hub's 连接电脑 modal). Inline error on failure.
- configured: machine name + 目标服务器 + 状态点（`运行中` / `已停止` / `连接中…` / `连接失败`）
  + a `启用` switch (§10.3 enable) + `断开` text button (confirm) + last error line.
- The computer list card title becomes 「已连接的电脑」 and is shown only when
  `role !== 'runtime'`; both cards can be visible at once.
- Poll `/api/dsh-computers/runtime` every 5 s with the same interval as `/state`.

On the **hub** side the 连接电脑 modal keeps the one-line command and additionally exposes
the raw materials for the desktop path: below the command box, a muted line
「也可以在这台电脑的 DSH 桌面端打开 设置 → 电脑 → 本机运行时，填入下面的地址和密钥」 plus
two compact copyable rows — the server URL and the enrollment key (`/keys` already returns
`serverUrl` and `key`). That is how a user connects a machine without a terminal.

---

## 11. Stage 1 (v1.3.0): capabilities, streaming, remote files

Everything here is additive: an agent that reports no capabilities keeps the v1 behaviour
exactly. The wire stays SSE (host → agent) + HTTP POST (agent → host); no inbound ports.

### 11.1 Capabilities and version gate

`POST /agent/enroll` and `POST /agent/heartbeat` carry
`"capabilities": ["exec" | "fs" | "pty"]` and `agentVersion` (already present). The registry
stores the last reported set and `capabilitiesUpdatedAt`. Rules:

- A computer with no reported capabilities is treated as `["exec"]` (v1 agents).
- Host tool availability is gated per session: the `computer_*_file` tools are only
  registered/offered when at least one allowed computer reports `fs`; the terminal backend
  only serves computers reporting `pty`. Gating uses `ctx.tools.restrict`-style filtering
  (drop the schema) rather than failing at call time, so the model never sees a tool it
  cannot use; a call that still arrives for an incapable computer answers with an
  actionable "this machine's agent does not support file access (upgrade the agent)".
- `hello` echoes the host's view: `{ computerId, name, heartbeatMs, capabilities }`.
- `/state` and `/health` expose each computer's `agentVersion` and `capabilities`; the
  settings page shows a drift badge when `agentVersion` differs from the host plugin's.

### 11.2 Streaming results

`exec` gains `"stream": true`. The agent then POSTs incremental output to
`POST /api/dsh-computers/agent/results/chunk`:

```json
{ "requestId": "req_…", "seq": 0, "stdout": "<base64>", "stderr": "<base64>" }
```

- `seq` starts at 0 and increases by 1; the host drops out-of-order duplicates and
  reassembles. Batches are sent at most every 100 ms (or 32 KiB, whichever first).
- The final `POST /agent/results` stays authoritative for `exitCode`/`durationMs`/
  `timedOut`/`truncated` and carries the same capped buffers as v1 (so a host that missed
  chunks still ends with the tail).
- Host side, a streaming execution feeds the **DSH jobs** registry: `computer_exec` with
  `run_in_background: true` registers one job (`kind: 'computer-exec'`, label
  `<name>: <command>`, owner = calling session), returns its id immediately, and appends
  every chunk to the job's output ring so the built-in `job_output` / `job_kill` tools work
  unchanged. Killing the job sends `cancel` to the agent and settles the job.
- A foreground call still returns the complete result (v1 shape) but the host keeps the
  tail in the job ring for the conversation's progress view.
- Job terminal mapping (v1.4.1): the job's `done` result carries the same `terminal`
  object. `completed`→`completed`; `failed`/`timeout`→`failed`; `cancelled` (confirmed)
  →`killed`; `cancelled` (unconfirmed, `broken`)→`killed` with a detail that says the
  command may still be running. `job_output`/`job_kill` therefore surface the honest
  state instead of the old "killed = stopped" assumption.

### 11.3 Remote file access

Host → agent, over the same SSE stream:

```json
{ "event": "fs", "data": { "requestId": "fsr_…", "op": "read", "path": "/abs", "encoding": "utf8", "offset": 0, "limit": 2000 } }
```

`op` ∈ `read | write | list | stat | mkdir | rename | delete | glob | grep`.
Agent → host: `POST /api/dsh-computers/agent/fs/result`

```json
{ "requestId": "fsr_…", "ok": true, "op": "read", "path": "/abs",
  "content": "<base64 for write/read binary>", "text": "<utf8 for text reads>",
  "encoding": "utf8|base64", "bytes": 123, "lines": 20, "truncated": false,
  "entries": [{ "name": "a", "path": "/abs/a", "type": "file|dir|symlink", "size": 1, "mtimeMs": 0 }],
  "stat": { "type": "file", "size": 1, "mtimeMs": 0, "mode": 420 },
  "matches": [{ "path": "/abs/a", "line": 3, "text": "…" }],
  "error": null }
```

Limits: read 1 MiB / 20 000 lines, write 4 MiB, list 5 000 entries, glob 2 000 paths,
grep 500 matches, per-request timeout 15 s. Paths must be absolute; the agent rejects a
relative path with `ok:false, error:"path must be absolute"`.

Host tools (registered only when a `fs`-capable computer is available, §11.1):

| tool | arguments (JSON Schema) | value |
|---|---|---|
| `computer_read` | `computer?`, `path`, `offset?`, `limit?` | `{ computer, path, text, lines, bytes, truncated }` |
| `computer_write` | `computer?`, `path`, `content`, `createDirs?` | `{ computer, path, bytes, created }` |
| `computer_edit` | `computer?`, `path`, `old`, `new`, `replaceAll?` | `{ computer, path, replacements, bytes }` |
| `computer_glob` | `computer?`, `pattern`, `cwd?` | `{ computer, paths }` |
| `computer_grep` | `computer?`, `pattern`, `path?`, `include?`, `maxMatches?` | `{ computer, matches }` |

`computer` is optional in all of them and falls back to the session pin (§10/§9 selection),
same as `computer_exec`. Renders mirror the built-in `read`/`write`/`edit`/`glob`/`grep`
tool output style so the model reads them the same way. A write/edit to a path the agent
cannot touch answers `ok:false` with the OS error text, surfaced as a tool error.

### 11.4 PTY (terminal backend) — follows in v1.4.0

Reserved events, not implemented in v1.3.0:
`{"event":"pty.open"|"pty.input"|"pty.resize"|"pty.close", data:{ ptyId, … }}` and
`POST /agent/pty/out` `{ ptyId, seq, data(base64) }` + `POST /agent/pty/exit` `{ ptyId, exitCode }`.
The host will register a DSH `terminals` backend (`ctx.terminals.registerBackend`) so the
built-in terminal tools and UI work against a connected computer; agents advertise `pty`
only once they implement it.

### 11.5 Compatibility

- v1 agents: no capabilities, no streaming, no fs — everything above degrades to §3/§4.
- New host + old agent: `computer_exec` unchanged; file tools hidden; a manual call errors
  with the upgrade hint.
- New agent + old host: the agent never sends `stream:true` payloads unless the host's
  `hello` advertises `"features":["stream","fs","pty"]`, so an old host is unaffected.

### 11.6 Interaction details aligned with the reference product

These mirror the reference implementation's runtime protocol *behaviour* (handshake metadata,
stream frames, background adoption, update-required) without copying any of its code.

1. **Handshake metadata.** The agent's enroll body and every reconnect carry a metadata block:
   `{ version: 1, agentVersion, hostname, os, arch, capabilities, workspaceBase }`, where
   `workspaceBase` is the agent's default working directory (config `workspaceBase`, default
   `os.homedir()`), reported back to the host at connect and used as the default `cwd` for
   `exec` and the base for relative `glob`/`grep`. The host stores it and shows it in the
   computer detail view. Same shape as the reference product's `RuntimeHandshakeMetadataV1`.
2. **Stream frames.** Chunk payloads carry a `type`:
   `{ type: 'stdout' | 'stderr' | 'heartbeat', data(base64, empty for heartbeat) }`.
   The agent emits a `heartbeat` frame for every 10 s of a silent command so the host can keep
   the execution alive and the conversation's progress view ticking instead of timing out.
   Exit code still arrives exactly once in the final `/agent/results`.
3. **Timeout adopts instead of killing.** When a foreground `computer_exec` reaches
   `timeoutMs`, the host does NOT kill it by default: it moves the still-running execution
   into the background-job path (config `promoteOnTimeout`, default true), returns `{ jobId,
   promoted: true }`, and the model continues with `job_output`/`job_kill`. With
   `promoteOnTimeout: false` the v1 cancel-and-error behaviour applies.
4. **Pending → activated lifecycle.** An enrollment key is `pending` until the agent's first
   successful stream; that moment sets `activatedAt` and marks the key used. A never-activated
   computer is hidden from the list (only `pendingKey` shows in the connect dialog), matching
   the reference product's activation lifecycle.
5. **Update-required (opt-in).** Config `minAgentVersion` is empty by default, which means
   **no version gate**: an older agent keeps working for everything it advertises, because
   feature availability is decided by the capability handshake (`fs`/`pty`), not by version.
   Operators who want to force upgrades set `minAgentVersion: '1.3'` (or similar); an older
   agent then gets an actionable "upgrade this computer's agent" error and `/state` marks it
   `updateRequired: true`. Independently, `drift` is always reported when the agent version
   differs from the host plugin's, and the settings page shows it as an advisory badge.
6. **Revoke kicks the stream.** Deleting a computer ends its live SSE stream in the same
   request and invalidates the token, so a stale agent gets `401 invalid-token` and stops
   retrying until re-enrolled.
