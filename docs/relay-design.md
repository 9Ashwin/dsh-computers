# Relay 组网设计（参考 Paseo）

> 状态：设计稿，未实现。目标版本 1.5.0。
> 本文只描述**协议与结构**，不含实现；实现进度见 §13。
> 当前代码基线：`main@cf2306e`（v1.4.0），已备份为分支 `backup/pre-relay-1.4.0`
> 与 tag `v1.4.0-backup`。

---

## 1. 要解决的问题

1.4.0 的拓扑是纯 hub-and-spoke，且有个硬前提：**hub 必须自己可达**。

- 被控端（电脑/agent）只出站，NAT 不是问题 —— 这部分已经成立。
- 但 hub 这一侧必须有一个能连进来的地址：公网部署、反向代理、或 Tailscale。

由此产生三个实际缺口：

| 缺口 | 现状 |
| --- | --- |
| A. 本地 Mac 想当主控 | 必须在公网/反代/tailnet 上暴露，否则别的机器连不进来 |
| B. 手机/外网浏览器访问本地 hub | 同上；DSH 的 Web UI 由 hub 自己提供，hub 不可达就整站不可达 |
| C. 角色不对称 | 「哪台当主控」被网络可达性绑架，而不是被用户选择绑架 |

**目标：让 hub 也能只出站。** 只要 hub 能向外拨一条连接，它就可以被访问 —— 于是「服务器当主控」和「本地电脑当主控」变成同一件事，只是把 `role` 换个值。

## 2. 非目标

- **不做 P2P。** 见 §3。
- 不做电脑之间互相控制（拓扑仍是 hub-and-spoke，relay 只是让 hub 可达）。
- 不改 agent 的应用层协议（agent 侧 MCP 语义、`PROTOCOL.md` §3 的 enroll/exec 契约不变）。
- 不做多 relay 选播/负载均衡（一条 relay 挂了就重连，不做 primary/secondary 切换）。

## 3. 为什么不做 P2P

参考实现 Paseo 也**没有** P2P：全仓库没有 `webrtc` / `RTCPeerConnection` / ICE / libp2p。它只有 SSH、relay、Tailscale 三种连通方式。

真 P2P 需要 WebRTC DataChannel + 信令服务器，NAT 打不通还要 TURN（中继）——**TURN 本质上就是 relay**。也就是说「P2P」实为「relay + 尽力直连的优化」，不是 relay 的替代品。

对本插件收益更低：

- 命令与结果是几十字节到几 MB 的 JSON/文本，中继多一跳的几十毫秒无感；
- 真正受益的是 `computer_read` / `computer_write` 搬 GB 级文件，那是独立需求；
- P2P 会把「中枢可审计」变成「点对点不可审计」，而现有 `lib/access.js` 的准入模型是按 hub 收口的，要重做。

结论：先做 relay，P2P 留作文件传输的可选快路径（不在本期）。

---

## 4. 参考实现：Paseo 的 relay

代码位置（已克隆在 `~/workspaces/reference/paseo`，Apache-2.0）：

- `packages/relay/src/cloudflare-adapter.ts`（614 行）：Cloudflare Durable Object 版 relay，一 session 一个 DO
- `packages/relay/src/secure-channel.ts`（833 行）：E2EE 通道，`legacy`/`protected` 双模式
- `packages/relay/src/noise/`：自实现 Noise 状态机 + 官方向量测试
- `packages/server/src/server/relay-transport.ts`：daemon 侧拨号与重连
- `docs/relay-endpoint-security.md`：端到端加密的完整规格
- `public-docs/connectivity.md`：面向用户的三种连通方式
- 另有独立仓库 `getpaseo/paseo-relay`（Elixir）可自托管

### 4.1 值得照搬的部分

1. **反向连接**：daemon 默认只听 `127.0.0.1:6767`，同时主动拨出 WebSocket 到 relay，会话号 `srv_<id>`。relay 不知道 daemon 在哪。
2. **v2 socket 模型**：每个 `serverId` 一条 **control socket**（只走 `sync` / `connected` / `disconnected` / `ping` / `pong` 控制帧），每个客户端连接一条 **data socket**。relay 用 tag 配对两端，双向转发、不解析内容。
3. **端点与参数**：`wss://<relay>/ws?serverId=srv_x&role=server|client&v=2[&connectionId=...]`。`connectionId` 由 relay 分配给客户端，daemon 收到 `connected` 后才为它开 data socket。
4. **relay 不可信**：文档原话 *"The relay is untrusted, so the two endpoints secure the session themselves."*
5. **E2EE**：`Noise_NK_25519_ChaChaPoly_SHA256`，daemon 静态 X25519 就是配对时分发的那把公钥；prologue 是固定 ASCII 串。
6. **重放/降级防护**：64-bit 计数器 nonce（发前预留、验签通过才推进）、每次新通道都换临时密钥、客户端按 daemon 公钥 pinning（`minimumSecurityMode: "protected"`）、daemon 侧 `requireProtectedSecurity` 强制拒绝旧端。
7. **配对即分发**：一个 URI 同时携带地址、身份、传输参数：`relay://relay.paseo.sh:443/srv_x?key=<pubkey>&security=protected`。
8. **运维参数**：control ping 10s、30s 判死、8s ready 超时；relay 会**替换** daemon 的 close code，所以拒绝只能靠客户端自己的 `4002`/`4003` 识别，不能靠 socket close code。

### 4.2 不能照搬的部分

Paseo 能把 relay 做成"哑管道 + 端到端加密"，是因为**它的客户端自己说 Paseo 协议**：手机 App 和 `app.paseo.sh` 的 Web 端都在客户端侧跑 Noise 握手（`packages/app/src/polyfills/install-crypto-polyfills.ts`、`pair-link-credentials.ts`），relay 只转发密文。

DSH 不一样：**Web UI 是 hub 自己 `dsh web` 提供的**。浏览器打开的是 hub 的整站（HTML/JS/CSS + WS），不是某个"客户端协议"。因此：

- 想转发浏览器流量，隧道里必须是**通用 HTTP + WebSocket**，不是应用帧；
- 浏览器不跑 Noise 的话，relay 就必须解密转发 —— 这时 E2EE 退化为"hop 加密"，不再是"relay 不可信"。

这个差异是本设计与 Paseo 的最大偏离点，见 §6.3 的加密分层。

---

## 5. 目标拓扑

三种部署形状，可共存：

```
A) 直连（现状，不变）
   agent ──出站 SSE/HTTP──▶ hub(公网/反代/tailnet) ◀──浏览器

B) hub 出站到 relay（新增，本设计主体）
   agent ─┐                        ┌─ 浏览器（手机/外网）
          ├─▶ relay ◀──────────────┤
   hub ───┘   （只配对转发）        └─ 其他 hub（可选）
        └──出站 WSS──▶ relay

C) 双模式
   hub 同时保留本地直连 + relay 入口
```

关键性质：

- **任一机器都能当 hub**：`role` 是配置，不再受"谁有公网"约束。服务器和本地 Mac 都能设 `role: hub` 并各自向 relay 注册，手机书签两个地址即可。
- **agent 无需改动**：因为隧道是通用 HTTP，agent 的 `serverUrl` 直接填 `https://<relay>/r/<hubId>` 就能工作（enroll / SSE / result POST 全部原样）。
- **可叠加**：直连、Tailscale Serve、relay 三者互不排斥，谁可用走谁。

---

## 6. 关键设计决策

### 6.1 D1：relay 承载通用 HTTP，而不是应用协议

**选择：通用 HTTP/WS 隧道（reverse tunnel）。**

理由：这是唯一能让「手机浏览器打开完整 DSH UI」成立的形状；同时让 agent（HTTP+SSE）零改动获得 relay 能力。应用层协议隧道（Paseo 式）在这里做不到，因为 UI 不是一个可重放的协议客户端。

代价：需要自己实现「一条 WS 上多路复用多个 HTTP 请求 + WebSocket 升级」的 mux，比转发应用帧复杂。

### 6.2 D2：relay 是一个独立可部署的小服务

**选择：新增 `relay/` 目录，产出 `dsh-computers-relay` 可执行入口（Node，零依赖）；不自带 Cloudflare Worker。**

理由：自托管一个 Node 服务最省事，和插件同栈、同一套测试；Cloudflare DO 版留作后续可选适配（Paseo 两种都做了，但那是它自己的运维需要）。

端口形态：一个 HTTP 服务同时承担
- `GET /r/<hubId>/...` 浏览器/agent 入口（含 WS 升级）
- `GET /ws?hub=<hubId>&role=hub|client` hub 拨号端点
- `GET /health`、`GET /pair`（配对页，可选）

### 6.3 D3：加密分两层，MVP 只做 hop 加密

| 层 | 范围 | MVP | 说明 |
| --- | --- | --- | --- |
| L1 传输 | 浏览器 ↔ relay | ✅ | 标准 TLS（relay 证书） |
| L2 hub 通道 | hub ↔ relay | ✅ | WSS + **hub 身份密钥对**（relay 用它认证 hub，防冒名顶替/串号） |
| L3 端到端 | 浏览器/agent ↔ hub | ⏳ S3 | 两端都会 Noise 时才有意义；浏览器侧需要把握手搬进 `client.js` |

明确说明 L2 ≠ Paseo 的 E2EE：relay 仍能看到明文。L2 只保证「relay 不能冒充 hub、别人不能抢注你的 hubId」。真正的"relay 不可信"是 L3。

**S3 的浏览器加密路线（预留）**：`client.js` 里用 WebCrypto 的 ECDH **P-256** + HKDF-SHA256 + AES-256-GCM（都是内置，不用打包第三方）；hub 侧用 `node:crypto` 的 EC P-256 等价实现。注意这是 **Noise NK 形状的自有握手，不是标准 Noise**，落地前必须单独做安全评审。若坚持标准 Noise，就得把 X25519 实现 vendor 进 `client.js`（约 2–3 KB），破坏"零依赖"但要重写 `libsodium` 级代码，风险更高。

> 结论：MVP 不自己做密码学，先靠 TLS + 密钥认证 + DSH 登录；L3 单独立项。

### 6.4 D4：hubId 与身份

- `hubId`：`hub_` + 32 位随机 base32，首次启用 relay 时生成，存 `~/.dsh/computers/relay.json`（0600）。
- **不复用** `computerId`（那是被控端标识），两者命名空间分开。
- hub 密钥对：X25519，`relay.json` 里存私钥；配对 URI 分发公钥。
- 支持**轮换**：重新生成密钥对 → 所有配对链接失效，需重新配对。删掉 relay 配置 = 吊销。

### 6.5 D5：谁是"客户端"

浏览器不需要注册、不需要配对客户端 —— 它只是打到 `https://<relay>/r/<hubId>/...`。授权靠：
1. relay 侧：`/r/<hubId>` 是否需要 `?k=<accessKey>`（可配置；默认需要，防止 hubId 泄漏后被人乱扫）
2. hub 侧：沿用 DSH 自己的登录/可信来源机制 + 新增 IP/UA 无关的 **relay 入口白名单**（可选）

agent 则**必须**带 `?k=`（或走 relay 的 `Authorization` 透传），因为它没有 DSH 登录态。

---

## 7. 线协议 v1

一层 WSS，两种角色。所有帧是二进制（首字节 opcode），文本帧仅用于控制。

### 7.1 连接

```
hub  → wss://<relay>/ws?hub=hub_xxx&role=hub&k=<accessKey>
client → wss://<relay>/r/hub_xxx/<path>?k=<accessKey>      （浏览器，普通 HTTP）
agent  → wss://<relay>/r/hub_xxx/<path>?k=<accessKey>      （HTTP 客户端，普通 HTTP）
```

> agent 走的是普通 HTTP，不是 WS —— 它和浏览器同一条 ingress 路径。

### 7.2 控制帧（hub 通道）

| 帧 | 方向 | 载荷 | 含义 |
| --- | --- | --- | --- |
| `hello` | hub→relay | `{v:1, hubId, pubKey, name, version}` | 注册；relay 校验 `k` 与 `hubId` 归属 |
| `welcome` | relay→hub | `{v:1, relayId, pingMs:10000}` | 接受 |
| `ping`/`pong` | 双向 | `{t}` | 10s 心跳，30s 无 `pong` 判死 |
| `reject` | relay→hub | `{code, message}` | `bad_key` / `hub_taken` / `version` |

### 7.3 数据帧（hub 通道，多路复用）

一条 hub 数据通道上并发跑多个流，按 `streamId` 复用（uint32，hub 侧自增）。

| opcode | 名称 | 载荷 |
| --- | --- | --- |
| `0x01` | `http_open` | `{id, method, path, headers, bodyLen?}` |
| `0x02` | `http_body` | `{id, last}` + 紧随其后的原始字节 |
| `0x03` | `http_head` | `{id, status, headers}`（响应头） |
| `0x04` | `http_chunk` | `{id, last}` + 原始字节（响应体 / SSE 流） |
| `0x05` | `http_abort` | `{id, reason}` 双向取消 |
| `0x06` | `ws_open` | `{id, path, headers}` 请求升级 |
| `0x07` | `ws_accept` | `{id}` |
| `0x08` | `ws_frame` | `{id, kind:'text'\|'bin'}` + 原始字节 |
| `0x09` | `ws_close` | `{id, code, reason}` |
| `0x0a` | `stream_end` | `{id}` 终结并回收 |

规则：

- 每个 `http_body`/`http_chunk` 的载荷上限 **64 KiB**，超了拆帧（避免一次大帧卡住 mux）。
- `http_head` 之后必须紧跟 `http_chunk`，`last:true` 收尾；SSE 就是持续 `http_chunk` 直到 `stream_end`。
- 任一方向 `stream_end` 后，该 `id` 立即不可用；收到未知 `id` 帧直接丢弃并计数。
- `ws_frame` 与 `http_*` 共用 `streamId` 空间，`ws_open` 与 `http_open` 互斥。
- 帧头固定 8 字节：`opcode(1) | streamId(4, BE) | metaLen(2, BE) | flags(1)`，其后 `metaLen` 字节 JSON，再其后是原始载荷。

### 7.4 错误码

| code | 场景 |
| --- | --- |
| `hub_offline` | 目标 hub 没有活跃通道 → relay 直接回 502 `hub offline` |
| `bad_key` | `k` 不匹配 |
| `too_many` | 单 hub 并发流超过 `maxStreams`（默认 256） |
| `payload_too_large` | 单帧或单请求体超限（默认请求体 8 MiB） |
| `timeout` | 上游无响应（默认 30s 无首字节） |

---

## 8. 配对与授权

### 8.1 URI

```
dshc+relay://<relay-host>/<hubId>?k=<accessKey>&pk=<hubPubKey>&v=1
```

- `k`：relay 入口的访问口令（可省，取决于 relay 配置）
- `pk`：hub 公钥，S3 起用于 L3 握手；MVP 存下来做**身份固定（TOFU）**，relay 换 key 时 UI 报警
- 二维码由 `client.js` 渲染（纯 JS 生成 SVG，不引第三方）

### 8.2 生成与吊销

- 生成：设置 → 电脑 →「远程接入」→「启用 relay」→ 填 relay 地址 → 产出 URI + 二维码 + 一键复制
- 令牌：`k` 由 relay 侧签发（`/pair` 页面）或用户自定；hub 侧只存"我的入口 URL"
- 吊销：删 `relay.json` 的 `accessKey` / 在 relay 侧删 hub 记录 → 立刻 502
- **不引入**一次性的 `pendingKey`（那是 agent enroll 的机制，两者不要混）

### 8.3 与现有 `publicUrl` 的关系

`lib/http.js#resolveBaseUrl` 决定 join 命令里的地址。新增：

```
relay.publicUrl = 'https://relay.example.com/r/hub_xxx'
```

当它非空时，**优先于**自动探测的地址 —— 否则 relayed hub 生成的连接命令会指向 `127.0.0.1`，别的机器永远连不上。这条必须写进 `collectServerUrls`（`lib/addresses.js`）的候选序列，kind 记为 `relay`，且 `recommended` 优先级最高。

---

## 9. 组件与文件规划

```
lib/relay/
  wire.js         帧编解码（opcode + metaLen + payload），无状态，纯函数
  mux.js          streamId 分配、并发上限、背压（highWaterMark）
  hub-link.js     hub 侧拨号：控制通道、重连退避、状态机、心跳
  bridge.js       把 http_open/ws_open 打到本地 webServer origin，回流 http_* / ws_*
  identity.js     hubId / 密钥对 / relay.json 读写（0600，原子写）
  pairing.js      URI 构造与解析、二维码载荷
  limits.js       所有上限常量集中一处（便于 smoke 断言）
relay/
  main.mjs        独立 relay 服务（HTTP + WS + 路由 + 限流 + 日志）
  README.md       自托管说明（systemd / Docker / 一条命令）
bin/
  dsh-computers-relay.mjs   可执行入口（bin 字段）
```

改动面：

| 文件 | 改动 |
| --- | --- |
| `index.js` | 新增 `relay` 配置解析；hub 分支里创建 `hub-link`；effect 释放 |
| `lib/hub.js` | **不动**（SSE 语义与 relay 无交集，relay 是另一条 ingress） |
| `lib/routes.js` | 新增 `/relay/*` 设置 API（状态、启用/停用、重新生成） |
| `lib/addresses.js` | 新增 `relay` 候选 kind，最高优先级 |
| `client.js` | 设置页新增「远程接入」卡片：开关、地址、URI、二维码、状态/延迟 |
| `agent/*` | **不动**（agent 只会看到一个不同的 `serverUrl`） |
| `PROTOCOL.md` | 新增 §12 Relay（本文 §7 的正式化版本） |
| `docs/relay-deploy.md` | relay 自托管 + 反向代理 + TLS 终止 |

`lib/hub.js` 不动是刻意的：把 relay 做成**第二条独立入口**，而不是改造现有 SSE 通道。这样 1.4.0 的直连路径零回归风险，回滚只需关掉 `relay.enabled`。

---

## 10. 配置

```yaml
- id: dsh-computers
  name: dsh-computers
  config:
    role: hub
    # 新增
    relay:
      enabled: false
      url: ''                 # wss://relay.example.com，必填才有意义
      publicUrl: ''           # https://relay.example.com/r/hub_xxx，生成命令用
      accessKey: ''           # relay 入口口令，可空
      name: ''                # 展示名，默认主机名
      maxStreams: 256
      connectTimeoutMs: 10000
      requestTimeoutMs: 30000
      # S3 才有：requireE2EE: true
```

校验规则沿用 `resolveConfig` 的手写风格（不引 schemastery）：`url` 必须 `ws(s)://`，`publicUrl` 必须 `http(s)://`，未知键忽略但打 warn。

---

## 11. 重构分期

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **S0** | `wire.js` + `mux.js` + 单测 | 帧往返、乱序/超限/未知 id 全部按 §7.3 拒绝；`node --test` 绿 |
| **S1** | `relay/main.mjs` + `hub-link.js` + 无加密本地环回 | 本机起 relay，hub 拨入，`curl https://relay/r/<id>/api/dsh-computers/health` 返回 1.5.0；hub 断线 5s 内 `hub_offline`，重连后恢复 |
| **S2** | WS 升级（`ws_*`）+ SSE 流式验证 | 浏览器经 relay 打开完整 DSH UI：能开会话、能看到 agent 流式输出；`computer_exec` 流式帧不积压（内存平稳） |
| **S3** | 身份密钥 + 配对 URI + `client.js` UI + `addresses.js` | 未配对者拿到 403；生成的 join 命令指向 relay 且能 enroll 成功 |
| **S4** | 可选 L3 端到端（**单独立项 + 安全评审**） | 待定 |
| **S5** | 文档、部署、README、CHANGELOG、版本 1.5.0 | 全部文档跑通；`host-smoke.mjs` 全绿 |

S1 之前不要动 `client.js`，S2 之前不要碰 WS，避免把"能通"和"能用"混在一起调试。

---

## 12. 测试方案

1. **单测（`node --test`）**：`wire` 编解码、`mux` 生命周期、`pairing` URI 往返、`identity` 文件权限。
2. **扩展 `scripts/host-smoke.mjs`**：沿用现有"假 Cordis ctx + 真 ephemeral http listener"模式，加：relay 配置校验、`/relay/state`、`relay` 候选地址排在最前、关掉 relay 后直连路径无回归。
3. **新 `scripts/relay-e2e.mjs`**：三进程（relay、hub、client-fake），断言
   - 健康检查经 relay 可达
   - SSE 流不丢帧、顺序正确
   - 大响应（> 1 MiB）分片正确
   - hub 掉线 → 502；重连 → 恢复
   - 并发 50 条 curl 不串流
   - WS 双向往返
4. **回归门槛**：`node scripts/host-smoke.mjs` 与 `node scripts/relay-e2e.mjs` 都绿才算完成；CI 里两者都跑。

---

## 13. 安全与威胁模型

| 威胁 | 缓解 |
| --- | --- |
| hubId 被扫到 → 任意人打到 hub | `accessKey` + DSH 登录双重；relay 侧按 IP 限流 |
| 冒充别的 hub 抢占 hubId | hub 密钥认证（L2）；relay 记录 hubId↔公钥绑定，冲突回 `hub_taken` |
| relay 运营方看明文 | MVP 承认（与 cloudflared/nginx 同等信任假设）；L3 才解决 |
| SSRF：借 bridge 打到内网其他服务 | bridge **只允许**打到 `127.0.0.1:<本机 webServer 端口>`，路径经 `webServer` 路由表；禁止自定义 Host |
| 路径穿越到别的本地服务 | bridge 不做通用代理，只把请求原样交给本机 origin，且强制覆盖 `Host` 头为本机监听地址 |
| 大请求打爆内存 | 请求体 8 MiB 上限、响应分片 64 KiB、`maxStreams` 256、`mux` 背压 |
| 重放历史请求 | 每次浏览器请求天然是新 TCP；WS 升级握手在 hub 侧校验 Origin/登录态，relay 不透传 cookie 到别的 hub |
| 元数据泄漏 | relay 可见目标 hubId 与 URL 路径，看不到 body（L2 后 body 也加密） |

补充：relay 必须**默认拒绝**未配置过的 hubId；不做"自动注册"。

---

## 14. 与 1.4.0 的兼容与迁移

- 默认 `relay.enabled: false`，1.4.0 行为完全不变；`host-smoke.mjs` 里所有直连断言不需要改写。
- `PROTOCOL.md` 现有章节编号不动，relay 追加为 §12，避免外部实现（如 agent）对不上。
- `relay.json` 与 `state.json` / `runtime.json` 同级、独立文件；删掉即回滚。
- 版本号：本次重构 → **1.5.0**；`PLUGIN_VERSION` 同步，`/health` 断言跟着改。
- 分支策略：`backup/pre-relay-1.4.0` 保留 1.4.0 全量代码；`v1.4.0-backup` tag 同点。要发 1.4.x 补丁从该分支切。

---

## 15. 备选方案对比

| 方案 | 手机免装客户端 | 不暴露公网 | 运维成本 | 结论 |
| --- | --- | --- | --- | --- |
| **relay（本设计）** | ✅ | ✅ | 自建一个服务 | 选它 |
| Tailscale Serve（1.4.0 已有） | ❌ 每台设备都要进 tailnet | ✅ | 低 | 保留，作为不想自建 relay 时的备选 |
| cloudflared / frp | ✅ | ✅（依赖第三方） | 低，但引入外部依赖 | 临时可用，不内置 |
| DSH LiveShare（官方可选插件） | ✅ | ✅ | 低 | 面向"共享一个 session"，不是"整站可达"，需求不同 |
| 应用层 relay（Paseo 式） | ✅ | ✅ | 中 | 做不到整站 UI，只能隧道化——即本设计 |

---

## 16. 工作量估算

| 阶段 | 估时 |
| --- | --- |
| S0 wire + mux + 单测 | 0.5–1 天 |
| S1 relay 服务 + hub-link（无加密） | 1–1.5 天 |
| S2 WS 升级 + SSE 流式 | 1–2 天（最容易踩坑的一段） |
| S3 身份/配对/UI/地址序列 | 1–1.5 天 |
| S5 文档与发布 | 0.5 天 |
| 合计 | **4–6 天**（不含 L3） |

风险最高的两处：**WS 升级的正确性**（升级/关闭/半关闭、ping 透传）和 **SSE 长时间流的背压**。

---

## 17. 待确认

1. **relay 放在本仓库还是独立仓库？** 本文按"本仓库 `relay/` 目录 + 同一套测试"设计；若想独立发版（像 `paseo-relay`），把 `relay/` 拆包即可，协议不变。
2. **要不要 L3 端到端？** 它会让 relay 真正成为哑管道，但需要浏览器侧密码学，且必须单独评审。若只需要"手机能打开我的 DSH"，S1–S3 就够了。
3. **`accessKey` 由谁签发？** 设计里两种都留了（relay 签发 / 用户自定），实现时任选其一但要写进文档。
4. **relay 是否支持多 hub 并发？** 按设计是（`/r/<hubId>` 天然多租户），但 MVP 可以先只服务单 hub，代码结构保持多租户。
