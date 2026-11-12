# 没有服务器也能用：免费隧道方案

> 目标：让主控（hub）有一个**公网可达的 HTTPS 地址**，其他机器和手机就能连上来。
> 不一定需要自己买服务器、也不一定需要本项目的 relay。

---

## 0. 先明确：relay 不是必需的

`relay` 只是"让 hub 可达"的一种手段，而且是最重的一种（要自己部署、自己运维）。
任何能给出**稳定 HTTPS 地址**的东西都能替代它：

```
hub（任何一台电脑） ──▶ 免费隧道 ──▶ https://xxx.example.com
                                          ▲
                        其他机器 / 手机 ───┘
```

插件侧零改动：把那个地址填进 `publicUrl`（或让它自动从请求头识别），接入地址就会用它。

---

## 1. 方案对比

| 方案 | 需要服务器 | 花钱 | 域名 | 上手难度 | 说明 |
| --- | --- | --- | --- | --- | --- |
| **Cloudflare Tunnel（临时）** | ❌ | 免费 | 随机 `*.trycloudflare.com` | ⭐ 一条命令 | 最适合试用，重启会换域名 |
| **Cloudflare Tunnel（命名）** | ❌ | 免费 | 你自己的域名 | ⭐⭐ | 需要 Cloudflare 账号 + 域名托管 |
| **Tailscale Funnel** | ❌ | 免费（个人版） | `<机器>.<tailnet>.ts.net` | ⭐⭐ | 自带 TLS，稳定，插件可自动管理 |
| **ngrok** | ❌ | 免费额度 | 随机/固定 | ⭐ | 免费版有连接数和提示页限制 |
| **bore**（开源） | ❌ | 免费 | `bore.pub:<端口>` | ⭐ | 公共 relay，仅 TCP，无 TLS |
| **本项目的 relay** | ✅ | 服务器钱 | 你自己的域名 | ⭐⭐⭐ | 完全自托管、可控、可审计 |
| **Cloudflare Workers 版中继** | ❌ | 免费额度 | 你的域名 | ⭐⭐⭐ | 需要移植（见 §5） |
| **同 Tailscale / 同局域网直连** | ❌ | 免费 | 内网地址 | ⭐ | 最简单，但只能在同网内 |

---

## 2. 最快上手：Cloudflare 临时隧道

```bash
# 在当 hub 的那台机器上（先确认 DSH 的端口，例如 3081）
cloudflared tunnel --url http://127.0.0.1:3081
```

输出会给一个 `https://<随机>.trycloudflare.com` 地址。把它填进插件的 `publicUrl`：

```yaml
- id: dsh-computers
  config:
    publicUrl: https://<随机>.trycloudflare.com
```

或者直接用它打开 DSH 界面，插件会从请求头自动识别（`x-forwarded-proto` / `host`），
接入地址会自动变成这个域名。

⚠️ 临时隧道**每次重启都换域名**，适合试用；长期用走下面的命名隧道。

---

## 3. 长期用：Cloudflare 命名隧道（免费）

前置：一个域名托管在 Cloudflare（免费计划即可）。

```bash
cloudflared tunnel login
cloudflared tunnel create dsh
cloudflared tunnel route dns dsh dsh.example.com
cloudflared tunnel run --url http://127.0.0.1:3081 dsh
```

之后 `https://dsh.example.com` 就是固定的 hub 地址，重启不变。

---

## 4. Tailscale Funnel（插件可自动管理）

```bash
tailscale funnel --bg --https=8443 http://127.0.0.1:3081
tailscale funnel status
```

得到 `https://<机器>.<tailnet>.ts.net:8443`，自带证书、免费、稳定。

本项目已经能自动管理 Tailscale Serve（v1.4.0 的 `tailscaleServe`）。
把命令换成 funnel 即可，或用 `tailscaleServe` 先对内、需要公网时再手工开 funnel。

---

## 5. Cloudflare Workers 版中继（给想自托管但没服务器的人）

参考实现：`getpaseo/paseo` 的 `packages/relay/src/cloudflare-adapter.ts`
（一个 session 一个 Durable Object，WebSocket 双向转发）。

移植要点：

- Worker 里没有 `node:http`，用 `fetch` handler + `WebSocketPair`
- 每个 hub 一个 Durable Object（按 `hubId` 做 key），负责配对与转发
- 免费额度：Workers 10 万请求/天；Durable Objects 有免费额度但有限流
- 我们的隧道协议是"WS 上多路复用 HTTP"，Worker 里能原样跑（`WebSocketPair` 就是 WS）

工作量约 1–2 天（独立的 `relay/worker/` 实现，复用 `lib/relay/wire.js` 的帧格式）。

---

## 6. 我们的建议

| 你的情况 | 建议 |
| --- | --- |
| 只是自己几台机器 + 手机 | **Cloudflare 命名隧道**（免费、稳定、零运维） |
| 已经有 Tailscale | **Tailscale Funnel** 或干脆同 tailnet 直连 |
| 想完全掌控、要审计 | **自建 relay**（本项目） |
| 想"什么都不装" | Cloudflare 临时隧道试一下 |

---

## 7. 注意

- 隧道把 DSH 暴露到公网，**登录态就是唯一门禁**；建议只在需要时开
- 接入地址（`#join=`）本身就是凭据，别贴到公开地方
- 免费隧道服务方的条款/限流各不相同，长期用请看清

---

## 8. 国内网络环境（中国大陆）

上面的 Cloudflare / Tailscale 在国内**能用但可能慢或不稳**（走境外节点）。国内可选：

| 方案 | 类型 | 免费额度 | 说明 |
| --- | --- | --- | --- |
| **IPv6 直连 + DDNS** | 直连 | 免费、无限速 | **家宽通常有公网 IPv6**：给 hub 一个 AAAA 记录，其他机器直接用 `https://[v6]:端口` 连。零成本、延迟最低 |
| **花生壳（Oray）内网穿透** | 隧道 | 有免费档（限流量/带宽/随机域名） | 与向日葵同门，**这才是端口映射产品**；给一个 http(s) 域名，插件填进 `publicUrl` 即可 |
| **frp + 国内轻量服务器** | 自建 | 服务器约 24–40 元/月 | 最可控：`frps` 放服务器，`frpc` 在 hub 上；带宽/流量自己说了算 |
| **natapp / 神卓互联 / 巴比达** | 隧道 | 有免费档 | 国内 ngrok 类服务，给随机或固定域名 |
| **本项目 relay + 国内轻量服务器** | 自建 | 服务器钱 | 同 frp 的成本，但完全自主、可审计 |

### 关于向日葵

**向日葵不是隧道，是远程桌面**：它把"屏幕画面"传给你，不给任何 URL/端口。

| | 向日葵 | 我们需要的 |
| --- | --- | --- |
| 传什么 | 屏幕画面 + 键鼠 | HTTP/WebSocket 流量 |
| 给不给地址 | ❌ | ✅ 必须有一个 URL |
| 能不能让"其他电脑 join" | ❌ | ✅ |

所以**向日葵不能替代中继/隧道**。如果你的目的只是"在外面看看家里那台机器的桌面"，向日葵够用；
但要让 DSH 的 agent 去**驱动**其他电脑（执行命令、读写文件），必须是网络可达，不是屏幕可达。

> 同门的 **花生壳** 才是内网穿透（端口映射）产品，那个可以用。

### 国内推荐顺序

1. **家宽有 IPv6** → AAAA + DDNS，零成本、无限速（先在 hub 上 `curl -6 ifconfig.co` 确认）
2. **没有 IPv6** → 花生壳免费档，或 natapp 之类
3. **要求稳定/可控** → 国内轻量服务器 + frp（或本项目 relay），月成本一杯咖啡

### 阿里云这类国内云厂商

阿里云**没有**面向个人的"内网穿透"产品（花生壳那种）。它的路线是"买一台有公网 IP 的服务器"：

| 产品 | 能不能当隧道 | 说明 |
| --- | --- | --- |
| **轻量应用服务器 / ECS** | ✅ 可以 | 24–40 元/月起，跑本项目 relay 或 frp 都行；国内节点延迟低 |
| **函数计算 FC** | ⚠️ 勉强 | 按调用计费 + 冷启动，对"常驻 WebSocket 长连接"不友好，不推荐做 relay |
| **ESA / CDN / 全站加速** | ❌ | 只是加速，源站仍需可达，解决不了"没有公网 IP" |
| **NAT 网关 / EIP** | ❌ | 面向 VPC 内网，不是给家用宽带的 |

**备案**：阿里云**中国大陆**节点绑定域名走 80/443 需要 ICP 备案。
不想备案就选**香港 / 新加坡 / 日本**节点（延迟仍比欧美低），或者用非标端口（如 8443）。

> 已经在国内云上买了服务器？直接按 [relay-deploy.md](./relay-deploy.md) 部署本项目 relay 即可，
> 只需把文档里的示例域名换成你自己的。
