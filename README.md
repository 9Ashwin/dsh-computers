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

```bash
# 方式 A：CLI
dsh plugin install github:9Ashwin/dsh-computers

# 方式 B：DSH 设置 → 插件市场 → 安装，粘贴
#   https://github.com/9Ashwin/dsh-computers
```

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

智能体会看到两个工具：

- `computer_list` —— 列出已连接电脑（名字、平台、在线状态）
- `computer_exec` —— 在指定电脑上执行命令：`{"computer": "my-mac-mini.local", "command": "sysctl -n hw.memsize"}`

系统提示里会自动附上当前电脑清单，所以直接说「看看两台 mac 的内存」它就会分别调用。

## 4. 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/dsh-computers/agent/enroll` | 加入密钥换取电脑 token（runtime 卡片也走这里） |
| GET | `/api/dsh-computers/agent/events` | 被控端的 SSE 长连接（Bearer token） |
| POST | `/api/dsh-computers/agent/results` | 命令执行结果回传 |
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
