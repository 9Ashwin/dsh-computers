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

## 11.7 在线判定（应用层 lease）与路由健康

### 在线 = 有 lease，不是"有连接"

socket 保持 OPEN 不能证明对端活着（OS 挂起、代理假死、半开 TCP 都是这样）。所以：

| 项 | 值 |
| --- | --- |
| `LEASE_MS` | 45 000 |
| `LEASE_CHECK_MS` | 10 000 |
| 刷新条件 | **只有已校验的入站帧**：`hello`、heartbeat、chunk、result、fs result |
| 过期后果 | 10s 扫描把该电脑判为离线、关闭旧流、在飞执行以 `offline` 收尾 |
| `/state` 字段 | `leaseExpiresAt`（离线时为 `null`） |

agent 侧配合：心跳 10s，连续 2 次无响应即判定连接死亡并重连（`min(1500·2^n, 30000)`，±20% 抖动，稳定 30s 后计数归零）。

### 路由健康（`serverUrls[].health`）

每个地址候选带运行时健康：

```json
{ "state": "unknown|ok|failed", "checkedAt": 0, "failures": 0, "cooldownUntil": 0 }
```

- 探针：`GET <url>/api/dsh-computers/health`，1.5s 预算，后台执行，不阻塞浏览器请求；
- 失败 → `state:"failed"` + 60s 冷却，冷却期内**不重复探测**；
- 冷却到期后重试；成功清零；
- `recommended` 只从"未冷却且可达"的候选里选，所以坏掉的路由会立刻让位给下一个；
- 候选数组**保持 kind 顺序**（公网 → 转发 → Tailscale → 局域网 → 本机名 → 本机），只有选择会变；
- 身份锚定电脑记录（`computerId` + token），与地址无关。

## 12

## 12 Relay（中继）

> 状态：v1.6.0。设计细节见 `docs/relay-design.md`，部署见 `docs/relay-deploy.md`。

### 12.1 目的

让**主控（hub）也只需要出站**。hub 拨号到中继，客户端（agent / 浏览器）访问
`<relay>/r/<hubId>/…`，中继按 `hubId` 配对并转发字节。于是「哪台当主控」由配置决定，
不再受"谁有公网"约束。

### 12.2 拓扑与端点

| 端点 | 用途 |
| --- | --- |
| `GET /health` | `{ ok, hubs: [...] }` |
| `GET /ws?hub=<hubId>&role=hub` | hub 拨号（WebSocket 升级）；重复注册 → 409 `hub_taken` |
| `GET /ws?hub=<hubId>&role=client` | 客户端拨号（S2 起） |
| `*/r/<hubId>/<rest>` | 转发到该 hub：HTTP、SSE 与 **WebSocket 升级** |
| 未知 / 离线 hub | `502 hub_offline` |

### 12.3 隧道内协议

一条 WSS 上多路复用多个流（`lib/relay/wire.js` + `mux.js`）：

```
frame = opcode(1) | metaLen(4, BE) | meta(JSON) | payload
```

| opcode | 语义 |
| --- | --- |
| `http_open` / `http_head` / `http_data` / `http_end` / `http_error` | 一条 HTTP 请求/响应流 |
| `ws_open` / `ws_frame` / `ws_close` | 一条 WebSocket 流（S2） |
| `ping` / `pong` / `goaway` | 链路保活与优雅关闭 |

上限：meta ≤ 8 KiB、payload ≤ 64 KiB、每 hub ≤ 256 条流、请求体 ≤ 8 MiB。

### 12.4 hub 侧身份与持久化

- `hubId`：`hub_` + 32 位十六进制（`lib/relay-identity.js` 负责持久化），首次启用中继时生成
- 持久化：`<stateDir>/relay.json`（0600，原子写）——**不放在 `state.json`**，重置电脑列表不得让别人的收藏地址失效
- 中继记录 `hubId ↔ hub 密钥` 绑定，防止抢占；撤销 = 关闭中继或换 `hubId`

### 12.5 安全边界

- hub 侧 bridge **只允许**打到本机 `127.0.0.1:<自己的 webServer 端口>`：路径必须以 `/` 开头，拒绝绝对 URL、拒绝 `..`，`Host` 头强制覆盖 → 隧道不能变成内网 SSRF 代理
- 浏览器仍走 DSH 自己的登录态，中继不参与鉴权
- 端到端加密未实现（信任假设等同 cloudflared/nginx）

### 12.6 `/state.relay`

```json
{ "enabled": false, "configured": false, "hubId": "", "url": "", "publicUrl": "",
  "state": "disabled", "connectedAt": null, "lastError": null, "streams": 0 }
```

`state` ∈ `disabled | idle | connecting | reconnecting | connected | failed | closed`（`connectedAt` 为 epoch 毫秒或 `null`）。
v1.6.1 起另有 `enabledSource: 'ui' | 'config'` 与 `canEnable: boolean`（未配置 `relay.url` 时为 false）。

开关（v1.6.1，UI 用，不必改配置）：

| 路由 | 语义 |
| --- | --- |
| `GET /api/dsh-computers/relay` | 返回 `/state.relay`（轻量轮询） |
| `POST /api/dsh-computers/relay/enable` | body `{ enabled?, url? }`；持久化覆盖到 `relay.json`（`enabled` / `url`），**现场启停与换址**，无需重载插件。`url:''` 清除覆盖回落配置 |

`relay.json` 为 `{ version, hubId, createdAt, enabled: boolean | null, url: string | null }`；`null` = 跟随配置默认值。
v1.7.1 起 `url` 也能在界面里配置（`/state.relay.urlSource: 'ui' | 'config'`），所以 `cordis.patch.yml` 可以完全留空。

### 12.7 enroll 返回的 `serverUrl`

`POST /agent/enroll` 的响应里 `serverUrl` **必须是本 hub 对外公布的地址**（中继 > 公网 > 局域网），
不能是请求来源地址：经中继转发时 bridge 会强制 `Host: 127.0.0.1:<port>`，回显它会让那台机器
把自己的回环地址存成上游（v1.6.0 的真实故障）。启用且连接成功时，
`serverUrls` 首位出现 `{ "kind": "relay", "label": "中继" }` 候选并被推荐。

## 13 接入地址（v1.7.0）

一个地址完成接入，不再需要一次性密钥。

### 13.1 地址形态

```
<advertisedBase>#join=<fleetToken>
例：https://dsh.example.com#join=dshf_<32 hex>
    https://relay.example.com/r/hub_xxx#join=dshf_<32 hex>
```

`#` 之后是 fragment：**浏览器与代理都不会把它发到服务器**，token 不会进访问日志。

v1.7.2 起 `joinUrl` **永远不是回环地址**：它要粘到另一台机器上，`127.0.0.1` 在那台机器上指的是它自己。
没有任何对外可达地址时 `joinUrl` 为空并给出 `reason`，UI 会提示去「高级 → 中继」启用中继或配置公网地址。
`fleetToken` 持久化在 `${stateDir}/fleet.json`（0600），与 `state.json` / `relay.json` 分离——
重置电脑列表不会让已发出的接入地址失效。

### 13.2 端点

| 路由 | 语义 |
| --- | --- |
| `GET /state` | 新增 `fleet: { joinUrl, hasToken, reason }`（`joinUrl` 就是上面那串；`reason:'loopback-only'` 表示这台机器只有本机地址，**不会**给你一个 `127.0.0.1` 的假地址） |
| `POST /agent/enroll` | `{ key }` 与 `{ join }` 二选一；**两者都有时 key 优先**；join 错误 → `401 invalid-join` |
| `POST /fleet/rotate` | 重新生成 token，旧地址立刻失效（已接入的机器不受影响） |
| `POST /runtime/connect` | `{ serverUrl }` 里带 `#join=` 时可省略 `key`；存入的 URL 永远不含 fragment |

### 13.3 兼容

- 一次性密钥路径完全保留（15 分钟、一次一用），适合"用完即废"的场景
- 老 agent（不认 `#join=`）不受影响：它们只会用 `--key`
- `role` 仍可配置，但 `both` 是默认值，日常无需写配置


> `relay.example.com` 是占位示例。中继跑在你自己机器上，域名和端口由你决定（配置文件或界面里填），项目不绑定任何域名。

## 14 账号中心（v1.8.0）

同一个账号下的机器自动出现在彼此的列表里，不需要逐台配对。

### 14.1 中继侧（账号中心 + 设备目录）

| 方法 | 路径 | 鉴权 | 返回 |
| --- | --- | --- | --- |
| `POST` | `/api/fleet/accounts` | `x-admin-key`（中继配置了的话；否则仅首次引导） | `201 { accountId, secret, name }` |
| `POST` | `/api/fleet/accounts/<id>/devices` | body `secret` 或 `x-fleet-secret` | `200 { ok, deviceId }`（按 `machineId` upsert） |
| `GET` | `/api/fleet/accounts/<id>/devices` | `x-fleet-secret` | `200 { devices: [{ machineId, name, platform, hubId, entryUrl, online, lastSeenAt }] }` |
| `DELETE` | `/api/fleet/accounts/<id>/devices/<machineId>` | `x-fleet-secret` | `200 { ok:true }` |
| `GET` | `/health` | 无 | `{ ok, hubs, accounts }`（只给数量） |

- 账号 `acct_<16hex>`，密钥 `dshf_<32hex>`；**服务端只存 sha256**，用 `timingSafeEqual` 比较
- `online` 在读取时计算（120 秒内有心跳），不落盘
- 上限：每账号 200 台设备、请求体 8 KiB、创建账号按 IP 限流

### 14.2 插件侧

| 路由 | 语义 |
| --- | --- |
| `GET /api/dsh-computers/account` | `{ loggedIn, relayUrl, accountId, name, machineId, devices, lastError, registeredAt }`（**不含密钥**） |
| `POST /api/dsh-computers/account/create` | 在中继上创建账号，持久化并注册本机；**响应里返回一次 `secret`**（只此一次） |
| `POST /api/dsh-computers/account/login` | 用 `accountId + secret` 登录，校验通过后持久化并注册 |
| `POST /api/dsh-computers/account/logout` | 清除凭据、停止心跳（`machineId` 保留） |
| `GET /api/dsh-computers/account/discover` | 探测本机是否有中继在跑，给出可直接使用的候选地址 |

- 凭据存 `${stateDir}/account.json`（0600），`machineId` 存 `${stateDir}/machine.json`，两者分离——换账号/登出不会让中继里的设备记录变成孤儿
- 每 60 秒注册一次；`entryUrl` 优先用中继入口（`https://<relay>/r/<hubId>`），否则用对外可达地址
- `/state` 增加 `account`（缓存值，不额外打中继）

### 14.3 会话目标电脑的持久化（v1.8.1）

`selections.json` 现在记录 `{ computerId, name, updatedAt }`。被选中的电脑之后被删除时：
报错会**点名那台机器**（「你之前选定的电脑『X』已被删除或断开」），而不是含糊的"没有选择电脑"。

## 15 远端技能（v1.9.0）

每台电脑把自己的技能报给主控，主控把它们放进 DSH 的斜杠菜单。

### 15.1 上报

- 运行时 agent 扫描 `~/.dsh/skills`、`~/.agents/skills`、`<workspace>/.dsh/skills`、`<workspace>/.agents/skills`
- 每项读 `SKILL.md` 的前 4 KiB，取 frontmatter 的 `name` / `description` / `whenToUse`
- **enroll body 与每次 heartbeat 都带顶层 `skills: [{ name, description, path?, whenToUse? }]`**
  （不放进 `metadata`：那串同时是 SSE 连接的 base64url 头，放技能列表会撑爆）
- 上限：50 项、kebab-case 名 ≤64、文本 ≤200、序列化后 ≤10 KiB；不合格的条目丢弃

### 15.2 斜杠菜单

主控注册一个 `skills` provider（DSH 官方扩展点 `ctx.skills.registerProvider`）：

| 字段 | 值 |
| --- | --- |
| 名字 | `<机器slug>-<技能名>`（如 `air-image-compress`），重名加 `-2`/`-3` |
| 描述 | `[<机器名>] <技能描述>` |
| 来源 | `custom`，`rank: 50` |
| 选中后 | 通过运行时读那台机器的 `SKILL.md`，正文返回给 agent，`resourceBase` 提示用 `computer_read` / `computer_exec` 在那台机器上取资源 |

离线机器不贡献技能；机器下线后对应条目从菜单消失。

### 15.3 `computer_skills` 工具

`{ computer?: string }` → `{ computers: [{ id, name, online, skillCount }], skills: [{ computer, name, catalogName, description, whenToUse, path, online }] }`。
与 `computer_list` 同一套授权（operation `list`）。

## 16 账号密钥、自运行时与跨机执行（v1.9.1）

### 16.1 一把钥匙

账号密钥是**自描述**的复合串，不需要服务端额外查表：

```
dshk_<16 hex 账号体>_<32 hex 密钥体>        例：dshk_6d56dbd4988a3fe3_887d4f25…
```

- `POST /api/fleet/accounts` 返回 `{ accountId, secret, key }`
- 任何接受 secret 的地方都接受 `x-fleet-key: dshk_…` 或 body 里的 `key`（优先级：body key → header key → body secret → header secret）
- 格式错误 → `400 invalid-key`；key 里的账号与路径账号不一致 → `401 invalid-secret`
- 服务端仍然**只存 sha256**，无法反推 key；key 存在插件侧的 `account.json`（0600），所以界面可以随时显示/复制

### 16.2 自运行时（本地电脑可执行）

主控机器自己也要有一个运行时，否则「本地电脑」只是个占位。

- 插件在 hub 面挂载时自动起一个**独立 agent 子进程**（不是内嵌，互不干扰）：
  `node <pkg>/agent/dsh-computers-agent.mjs run`，凭据由插件写入
  `${stateDir}/self-runtime/config.json`（0600），走 loopback `#join=` 注册
- 崩溃退避：5 分钟内最多自动重启 3 次（1s/2s/4s），之后 `state: 'failed'` 并给出原因
- 日志保留最后 ~50 行（凭据已擦除）
- `GET /api/dsh-computers/self` → `{ controllable, runtime: { state, pid, since, lastError, computerId, logs } }`
- `POST /api/dsh-computers/account/controllable { enabled }` → 启停自运行时并持久化到 `account.json`

### 16.3 跨机执行

每台 hub 暴露一个机器面 API，用**自己的账号密钥**鉴权：

| 路由 | 语义 |
| --- | --- |
| `POST /api/dsh-computers/fleet/exec` | `{ command, cwd?, timeoutMs? }` → `{ ok, exitCode, stdout, stderr, durationMs, timedOut, truncated, computerId }` |
| `POST /api/dsh-computers/fleet/fs` | `{ op, payload }` → agent 的 fs 结果 |

- 鉴权：`x-fleet-key` / `x-fleet-secret`，常数时间比较；**不接受浏览器 cookie**，不是浏览器路由
- `403 not-controllable`（这台机器关了被控）、`503 self-runtime-unavailable`（自运行时没跑）、`401 invalid-key`
- 工具侧路由：`null` 选中 = 本地电脑 → 自运行时；`acct:<machineId>` → `<entryUrl>/api/dsh-computers/fleet/*` 带 `x-fleet-key`；
  `computer_list` / `computer_skills` 会把账号设备合并进来并标 `via: 'account'`

## 17 托管中继与单列表界面（v1.9.2）

### 17.1 本机中继（一键）

中继代码在插件包里，所以插件可以自己起中继——**升级插件 = 升级中继**，不需要 git/systemd/root。

| 路由 | 语义 |
| --- | --- |
| `GET /api/dsh-computers/relay/supervisor` | `{ supervisor: { state, pid, port, since, lastError, logs, adopted }, localUrl }` |
| `POST /api/dsh-computers/relay/supervisor` | `{ action: 'start' | 'stop' | 'restart', port? }` → 同样的形状 + `suggestedUrl` |

- spawn：`node <pkg>/bin/dsh-computers-relay.mjs --port <port> --host 127.0.0.1 --data-dir <stateDir>/relay-data`
- 端口已被别的中继占用时**接管**（`adopted: true`，不重复起进程；停用只放弃接管，不杀别人的进程）
- 崩溃退避：5 分钟最多 3 次（1s/2s/4s），之后 `failed` 并给出原因
- `relay.localAutoStart` 默认 **false**：绝不在用户没要求时起服务器
- 启动**不会**自动启用中继链路（那仍是「启用」开关的事）

### 17.2 单个列表（只留账号）

界面收敛为一个列表：**账号**。`/agent/enroll` 的加入地址流程保留在 API/CLI 里（自运行时与无 DSH 的机器用），但**界面上不再出现**。

### 17.3 被控与自运行时

- 自运行时**不再在加载时启动**：第一次需要「本地电脑」时才懒启动（等待注册最多 5 秒）
- **被控开关只控制 fleet API**（`403 not-controllable`），不会停掉本机运行时——否则自己的「本地电脑」就用不了
- `/state.computers[]` 里本机那条带 `self: true`，UI 与 `computer_list` 都把它从"远端电脑"里排除；`computer_list` 用 `localComputer` 单独返回

### 17.4 斜杠菜单只显示选中机器的技能

DSH 把**当前 agent** 作为 `options.scope` 传给技能提供者，插件据此查该会话的选择器：
选中某台 → 只列那台的技能；选「本地电脑」→ 只列本机；选中账号设备 → 不列（它的技能在自己 hub 上）。

### 17.5 账号目录携带被控状态

`POST /api/fleet/accounts/<id>/devices` 接受 `controllable: boolean`（默认 true），设备列表原样返回，
于是同账号的其他机器能提前看到"不允许被控"并拒绝调度（真正的门禁仍在该机器的 hub 上）。
