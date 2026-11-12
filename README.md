# dsh-computers

把你自己电脑（Mac / Windows / Linux）接到一个 **DSH Web** 部署上，让部署里的智能体在这些电脑上执行 shell 命令。

形态是「**一台服务器作为唯一主控，其余电脑作为被控端接进来**」：被控端只向外发起一条长连接，主控端负责注册表、在线状态和命令派发。

- **每台电脑都装同一个插件**，所以不需要在终端里粘命令：桌面端 DSH 打开 设置 → 电脑 → **本机运行时**，填服务器地址 + 加入密钥，点「连接」即可。
- 服务器那一侧是 **电脑** 列表：在线状态、重命名、删除，以及 `+ 连接电脑` 生成的兜底命令（给不装 DSH 的机器，比如跑 launchd/systemd 的 Mac mini、Linux 服务器）。
- 对话里智能体用 `computer_exec` 把命令派到指定电脑上跑，用 `computer_list` 看有哪些机器。

**没有内网穿透、没有开放端口**：被控端只向外发起一条 SSE 长连接，所以两台 Mac 在 NAT/家用网络后面也能连上。拓扑明确是 hub-and-spoke，**不支持**电脑之间互相控制，也不做 P2P。

```
┌──────────── 服务器（dsh web，role: hub）────────────┐
│ dsh-computers 插件                                  │
│  · 电脑注册表 + SSE hub + 命令派发                  │ ◀──SSE──── ┌─ 这台 Mac（桌面端 DSH + 插件）─┐
│  · computer_list / computer_exec 工具               │ ──命令──▶ │  设置 → 电脑 → 本机运行时      │
│  · 设置 → 电脑 列表 + 连接电脑                      │ ◀─结果─── │  连接后即成为被控端            │
└─────────────────────────────────────────────────────┘           └───────────────────────────────┘
        ▲ 浏览器（手机/笔记本都能控制全部电脑）          ◀──SSE──── ┌─ 另一台 Mac / Linux ──────────┐
        │                                                          │  同样装插件，或跑 agent 兜底   │
        └─────────────────────────────────────────────────────────┴───────────────────────────────┘
```

## 1. 服务器：装插件（主控）

插件是纯 JavaScript，无构建、无第三方依赖，直接从 GitHub 装：

**推荐从 npm 安装**（和官方插件包一样）：

```bash
# 方式 A：CLI
dsh plugin install dsh-computers

# 方式 B：DSH 设置 → 插件市场 → 安装，搜 dsh-computers
```

也可以直接从 GitHub 装（跟随仓库最新提交）：

```bash
dsh plugin install github:9Ashwin/dsh-computers
```

### 更新

**npm 安装**：插件市场 → 已安装 → 「检查更新」即可，或者在 CLI 里装具体版本：

```bash
dsh plugin install dsh-computers@1.5.0
```

**GitHub 安装**：profile 里是按 spec + commit 固定的（`github:user/repo` 或 `#v1.0.2`），所以

- 用**同一个 spec** 再装一次只会得到 `already-installed`（这就是「再安装没法更新」的原因）；
- 装 **tag** 会被冻住，市场永远检测不到更新；装**分支**（不带 `#`）才能被市场「检查更新」发现新提交；
- 手动升级到某个版本要**换 spec**：`dsh plugin install github:9Ashwin/dsh-computers#v1.5.0`。

> 更新完记得重启 Host 并刷新页面，具体见 [docs/deploy.md](./docs/deploy.md)。

装好后重启 `dsh web`，设置里会出现 **电脑** 页。

服务端建议把 `role` 固定成 `hub`（只当主控）。**对外地址会自动识别**：你从哪个域名打开设置页（含反向代理的 `X-Forwarded-Proto/Host`、`Forwarded` 头），生成的命令就用哪个地址，通常不用配。需要强制指定时才写 `publicUrl`：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: dsh-computers
  name: dsh-computers
  config:
    role: hub
    # 留空 = 按浏览器请求自动推导（含反代的 X-Forwarded-* / Forwarded）；
    # 只有不想信任代理时才显式写死，例如 https://dsh.example.com
    publicUrl: ''
    execEnabled: true          # false 时拒绝所有远程执行
    execTimeoutMs: 120000      # 单条命令默认超时
    keyTtlMinutes: 15          # 加入密钥有效期
```

> **安全前提**：请开启 DSH 的浏览器登录/可信来源（`dsh web` 默认就有），不要把裸端口暴露给公网。插件给"能使用这个 DSH 的智能体"的权限，等于能在这台电脑上执行任意命令。

## 2. 每台电脑：装同一个插件（被控）

1. 按上一节的方式在**这台电脑**的 DSH 里装上 `dsh-computers`（桌面端 / 命令行装法相同）。
2. 打开 DSH → 设置 → 电脑，在 **本机运行时** 卡片里填：
   - **服务器地址**：你服务器的对外地址，如 `https://dsh.example.com`
   - **加入密钥**：在服务器的 设置 → 电脑 → `+ 连接电脑` 里复制的 `dshc_…`
3. 点 **连接**，卡片变成「运行中」，服务器列表里随即出现这台电脑（在线）。

被控端默认 `role: both`，所以这台电脑自己也能当主控；只想当被控端就设 `role: runtime`。

运行时的开关是持久的：**DSH 一启动就自动连回服务器**，不用每次手动点。关掉 DSH 就离线。

### 兜底：不装 DSH 的机器

Mac mini 常驻、Linux 服务器这类不跑桌面的机器，用服务器生成的命令（launchd / systemd 常驻）：

```bash
curl -fsSL 'https://<你的服务器>/api/dsh-computers/join.sh?key=dshc_xxx' | sh
```

它会下载 agent 到 `~/.dsh-computers/`、注册系统服务并启动。手动管理：

```bash
node ~/.dsh-computers/agent.mjs status
node ~/.dsh-computers/agent.mjs service restart
node ~/.dsh-computers/agent.mjs service uninstall
tail -f ~/.dsh-computers/agent.log
```

## 3. 对话里怎么用

智能体会看到这些工具（`computer` 参数都可省略，省略时用输入框左侧选中的目标电脑）：

| 工具 | 作用 |
|---|---|
| `computer_list` | 列出可用电脑（名字、平台、在线、能力、当前固定目标） |
| `computer_exec` | 执行命令，支持 `run_in_background`；超时默认**转后台**而不是杀掉 |
| `computer_read` | 读远端文件（offset/limit 行） |
| `computer_write` | 写远端文件（会自动建目录） |
| `computer_edit` | 字面替换（`old` 必须唯一，除非 `replaceAll`） |
| `computer_glob` | 远端 glob（`*`、`?`、`**`、`{a,b}`） |
| `computer_grep` | 远端正则搜索（支持 `include`、命中上限） |

文件类工具需要那台电脑的 agent 上报 `fs` 能力（见下）。

系统提示里会自动附上当前电脑清单，所以直接说「看看两台 mac 的内存」它就会分别调用。

## 3.1 能力、流式与后台任务

- **能力协商**：agent 在握手时上报 `capabilities`（`exec` / `fs`，以后还有 `pty`）和 `workspaceBase`（默认工作目录）。服务器据此决定是否提供文件类工具——**旧 agent 不会因为版本落后而被拒绝**，只是没有新能力；设置页会用 `可升级` 徽标提示（版本落后不影响 `computer_exec`）。只有在配置里显式写 `minAgentVersion` 才会强制拦截旧 agent。
- **流式**：长命令的分块输出会随帧回传（含心跳），后台任务的输出可在 DSH 的任务里查看。
- **超时转后台**：前台命令超时默认不杀（`promoteOnTimeout: true`），而是转入后台任务并返回 jobId，之后用内置的 `job_output` / `job_kill` 接管。
- **激活时机**：新电脑要等 agent 首次建流后才出现在列表（从生成密钥到真正连上之间，弹窗会一直显示"等待电脑连接…"）。

## 3.1 能力位与执行终态

- **能力位（caps）**：agent 在握手里上报 `caps: { exec, fs, jobs, pty, tunnel }`，服务器据此决定提供哪些工具，**不再用版本号推断功能**。`minAgentVersion` 只剩"运维强制升级"这一个作用；版本落后只在 UI 显示 `可升级`。
- **能力标签**：设置页按 caps 显示 `执行` / `文件` / `后台任务` / `终端`，每项带一句人话说明；缺哪项能力时，工具报错会直接点名缺什么、怎么补。
- **执行终态**：每次执行都以 `{ status, disposition, confirmed, exitCode, signal, error }` 收尾——
  `status`: `completed | failed | cancelled | timeout`，`disposition`: `reusable | broken`。
  **取消不再一律报"已取消"**：agent 确认停止 → `cancelled / confirmed:true`；只发出取消但没等到确认 → `cancelled / confirmed:false / broken`，并明确提示"命令可能还在那台机器上运行"；流中断 → `failed / broken`。
- **协议与常量**：所有 wire 形状、错误码、能力与状态词表集中在 `lib/contracts.js`（零依赖、零状态），协议文档见 [PROTOCOL.md](./PROTOCOL.md) §5.2 / §11。

## 3.1.1 权限、在线判定与路由健康（v1.5.0）

- **一张权限表**：所有操作（exec / 后台 exec / cancel / 文件五件套 / fs 请求 / list）都在 `lib/policy.js` 的冻结表里，加载时自检"没有操作漏登记"；准入由唯一的 `authorize()` 决定，拒绝时给出**码 + 被哪条规则挡住 + 怎么改**（`capability-missing` / `session-denied` / `preset-denied` / `offline` / `version-below-minimum` …）。
- **在线 = 有 lease**：只有已校验的入站帧（hello / 心跳 / chunk / result / fs result）才刷新在场，45 秒租约 + 10 秒扫描。OS 睡眠、代理假死、半开连接都会正确掉线，而不是一直显示在线。
- **路由健康**：每个地址候选带 `health { state, checkedAt, failures, cooldownUntil }`。后台探活 `GET /api/dsh-computers/health`（1.5 秒预算，不阻塞页面），失败即冷却 60 秒并**让位给下一个可用地址**——坏掉的隧道不会被复制进别人的连接命令。
- **relay 传输层（预览，未接线）**：`relay/main.mjs` 独立零依赖中继 + `lib/relay/{wire,mux,hub-link,bridge}.js` 已落地并有 47 项测试（S0/S1）。**尚未接入插件**：hub 目前还不能经 relay 出站，S2（WebSocket 升级）与接线在后续版本。

## 3.2 地址、可达性与 Tailscale

- **地址候选**：设置 → 电脑 顶部「本机地址」会列出本机所有候选地址并标注是否可达——
  `公网`（publicUrl）→ `转发地址` → `Tailscale` → `局域网` → `本机名` → `本机`。
  只有**真正在监听**的地址才会被推荐（例如桌面端只监听 127.0.0.1 时，Tailscale 那行会标「未监听」，推荐回落到 loopback），避免把连不上的地址复制给别人。
- **`+ 连接电脑` 里的服务器地址是可下拉选择的**，默认选中推荐地址，切换后命令/地址随之变化。
- **自动 Tailscale Serve**（可选）：

  ```yaml
  - id: dsh-computers
    config:
      tailscaleServe:
        enabled: true
        httpsPort: 8443
  ```
  插件加载后自动执行 `tailscale serve --bg --https=8443 http://127.0.0.1:<当前端口>`，把本机 DSH 暴露到 tailnet，并读取 `tailscale status` 的真实 DNSName 作为推荐地址。**幂等**（已指向本端口就跳过），端口每次随机变也会重新对接，失败只记录 `tunnel.error` 不推荐假地址。
- **强制偏好**：`preferAddress: auto | public | tailscale | lan | loopback`（只在可达的候选里选，选不到就回落 auto）。
- **管理电脑**：访问权限弹窗里的 `⚙ 管理电脑` 会直接跳到独立的「电脑管理」主面板（侧栏也有入口），不再只是文字提示。

> 桌面端注意：**不要**把 `webserver.host` 改成非 loopback 地址（窗口写死连 `127.0.0.1:<port>`，会连不上）。桌面端请用上面的 `tailscaleServe`，独立 `dsh web` 才用 `--host`。详见 [docs/deploy.md](./docs/deploy.md)。

## 4. 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/dsh-computers/agent/enroll` | 加入密钥换取电脑 token（runtime 卡片也走这里） |
| GET | `/api/dsh-computers/agent/events` | 被控端的 SSE 长连接（Bearer token） |
| POST | `/api/dsh-computers/agent/results` | 命令执行结果回传（最终结果，权威） |
| POST | `/api/dsh-computers/agent/results/chunk` | 流式输出分块（stdout/stderr/heartbeat） |
| POST | `/api/dsh-computers/agent/fs/result` | 远端文件操作结果 |
| POST | `/api/dsh-computers/agent/heartbeat` | 心跳 |
| GET | `/api/dsh-computers/state` | 设置页数据（角色、电脑列表，需要浏览器会话） |
| POST | `/api/dsh-computers/keys` | 生成一次性加入密钥 |
| GET | `/api/dsh-computers/key-status` | 弹窗轮询用 |
| POST | `/api/dsh-computers/delete` / `rename` | 删除 / 重命名电脑 |
| GET | `/api/dsh-computers/runtime` | 本机运行时状态 |
| POST | `/api/dsh-computers/runtime/connect` / `enable` / `disconnect` | 连接 / 启用开关 / 断开本机运行时 |
| GET | `/api/dsh-computers/join.sh` | 兜底安装脚本 |
| GET | `/api/dsh-computers/agent.mjs` | agent 本体（兜底脚本下载） |
| GET | `/api/dsh-computers/health` | 健康检查 |

浏览器端点都先过 DSH 的请求闸门（`connection.requestRejection`），未登录/不可信来源直接拒绝；被控端端点用 Bearer token 认证（服务端只存 `sha256(token)`）。

## 5. 开发与验证

```bash
node scripts/host-smoke.mjs     # Host 半：真实 HTTP 监听 + 假 agent/hub，覆盖注册/SSE/exec/超时/runtime
node --test agent/test/         # agent 半：enroll / SSE / exec / 超时 / 截断 / 内嵌运行时
node --check client.js          # 浏览器半
```

协议细节（所有路由、SSE 事件、状态文件、工具 schema、runtime 契约）见 [PROTOCOL.md](./PROTOCOL.md)。

## 6. 已知限制

- 一次执行返回一次性结果（不流式），长命令靠 `timeoutMs`；输出单流上限 1 MiB。
- 一台电脑同一时刻只保留一条连接（新的会顶掉旧的）。
- 在线判定只看 SSE 是否存活：杀掉进程立刻离线；网络静默（无 FIN）最多差一个心跳周期。
- Windows 被控端目前可用 `node agent.mjs run` 手动运行，服务安装只覆盖 macOS/Linux。
- 电脑与 Bot 的绑定还没有（列表里的 `1/1 Bot` 是占位徽标）；v1 里所有电脑对智能体都可选。
- 不做 P2P / 电脑互控；要隔离环境请用 VPN，或把某台桌面端当 hub、另一台连过去（仍是单向）。

## License

MIT
