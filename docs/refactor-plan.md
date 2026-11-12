# 重构参考分析（Paseo / t3code）

> 状态：R1–R6 全部完成（v1.4.1 / v1.5.0）；relay S0/S1 已落地但未接线。基线 `main@d76de8b`（v1.4.0 + relay 设计稿）。
> 参考仓库（本机只读克隆，partial clone）：
> - `~/workspaces/github/paseo` — `getpaseo/paseo`
> - `~/workspaces/github/t3code` — `pingdotgg/t3code`

---

## 1. 一句话结论

**结构看 Paseo，问题模型看 t3code，两个都只取其"契约层"，都不取其工程规模。**

- **Paseo 与我们同尺度**：protocol 是零依赖叶子包、权限用穷举表、liveness 用应用层 lease、配对带 pinned key。可以小步照搬。
- **t3code 与我们同问题**：服务端持有执行权、客户端通过**可互换的多条路由**接入、外加一条只出站的隧道；用**能力位**而不是版本号做兼容。
- 两者都**反向**或**超规模**的部分不要碰：Paseo 的 daemon 是入站监听、relay 是应用帧 + Noise E2EE；t3code 是 30 包 Effect monorepo + 218 方法 RPC + CQRS/outbox。

---

## 2. 两条最值钱的洞察

### 2.1 socket 活着 ≠ 对端活着（Paseo）

OS 挂起时 TCP/WS 会保持 OPEN，只有**入站且已校验的帧**能证明存活。

- Paseo：45s 应用层 lease、10s 检查；客户端 10s ping、连续两次 miss 断开；重连 `min(1500·2^n, 30000)`。
- 我们：目前是"流存在即在线"，仍有假在线窗口（1.4.0 之前的 40s 假在线就是这一类）。
- 详情：Paseo `docs/architecture.md:279`，`packages/client/src/daemon-client.ts:1150-1165`，`packages/server/src/websocket/physical-socket.ts:7-8`。

### 2.2 能力位而不是版本号（t3code）

版本号存在，但兼容机制是一袋可选布尔：客户端对缺席的 flag 直接隐藏功能，服务端不假设"你应该是新版本"。

- t3code：`packages/contracts/src/environment.ts:77-120`（`ExecutionEnvironmentCapabilities`）、`docs/internals/remote.md:176-179`。
- 我们：`minAgentVersion` + 散落的特性判断；握手已经有 `capabilities`，但只用来支持 `fs`，其余仍靠版本/存在性猜。
- 另一条同源结论：**取消必须区分"已停止"与"发出了停止但没确认"**（t3code 把它拆成两个错误类型，`provider-core/src/server/ProviderAdapter.ts:400-413`）。

---

## 3. 重构项（按性价比排序）

| 编号 | 内容 | 参考 | 交付物 | 风险 |
|---|---|---|---|---|
| **R1** | wire 词汇收敛成零依赖叶子模块：帧构造、错误码、事件类型 + 漂移容忍的 `optional()` | Paseo `packages/protocol`、t3code `packages/contracts` | 新增 `lib/contracts.js`；`routes/hub/tools/state/runtime` 改调用 | 低（纯搬运 + 断言） |
| **R2** | 能力位取代版本判断：hello 上报 `caps:{exec,fs,jobs,pty,tunnel}`，UI/工具按 flag 隐藏；`minAgentVersion` 降级为运维强制项 | t3code | agent 握手 + `policy` 判断 + 设置页能力标签 | 中（协议追加字段，向后兼容） |
| **R3** | 后台任务终态语义：`status: completed｜failed｜cancelled｜timeout` + `disposition: reusable｜broken`；取消分"已停止/未确认" | t3code | `lib/hub.js` job 收尾 + 工具渲染 + smoke | 中（假成功风险点） |
| **R4** | 权限穷举表 + 单入口 `authorize(computer, op, session)`，测试断言覆盖全部 op | Paseo `operation-permissions.ts` | 新增 `lib/policy.js`，`access.js`/`tools.js` 收口 | 低 |
| **R5** | 应用层 lease 替换"流存在即在线" | Paseo | `lib/hub.js` presence + agent 心跳/退避 | 中（影响在线判定） |
| **R6** | 候选地址升级为"带探活与冷却的路由列表"，身份锚定电脑记录而非地址 | t3code `connection/driver.ts` | `lib/addresses.js` + `lib/selection.js` | 低（relay 前置） |

顺序：**R1 → R2 → R3**（发 1.4.1），然后 R4 / R5 / R6 与 `docs/relay-design.md` 的 S0/S1 并行（发 1.5.0）。

> R1/R2 必须先于 relay S0：relay 的 wire 帧与 `tunnel` 能力要落在这两者之上，否则会出现第二套帧格式。

---

## 4. 明确不做

| 不采用 | 原因 |
|---|---|
| monorepo / 多包拆分 | 10k 行 12 个文件是资产：无构建、无 lockfile、`require` 即用 |
| Effect / Schema / Stream / Scope | 直接牺牲零依赖与可读性 |
| 218 方法 RPC + CQRS + outbox | 没有多客户端并发写需求 |
| provider 矩阵 / driver 多实例 | 我们只有一个 agent 后端 |
| Noise / E2EE / 自实现密码学 | 见 relay 设计 §6.3：MVP 只做 TLS + 密钥认证 |
| 多用户 principal / 二进制分帧 / zod codegen | 单 owner、SSE + POST 足够 |

---

## 5. 与 relay 设计的衔接

- `docs/relay-design.md` 的方向（hub 只出站、通用 HTTP/WS mux、hubId + 密钥对）保持不变，**这正是 Paseo 做不到而我们不得不自己做的部分**：DSH Web UI 是 hub 自己提供的，隧道里必须是通用 HTTP/WS，而不是可重放的应用帧。
- t3code 的 T3 Connect 值得一看的是 **"身份与路由解耦"**：一台环境保存有序路由列表（局域网 / Tailscale / SSH / 隧道），客户端先探活再花凭据、失败路由冷却。这与 R6 是同一件事，可以直接服务 relay 的"多入口"目标。
- t3code 的 relay Worker **不代理** HTTP/WS 会话，只签发一次性 DPoP 凭据——这一点在深入 relay 时值得回头评估（我们的 mux 代理方案更重，但无需账号体系）。

---

## 6. 验收

每个重构项都要求：`node --check` 全绿、`node scripts/host-smoke.mjs` 全绿（当前 150 组）、`node --test agent/test/`（当前 38 项）全绿；协议相关改动同步 `PROTOCOL.md`。
