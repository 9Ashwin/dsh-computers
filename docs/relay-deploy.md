# 中继部署（relay.example.com）

> `relay.example.com` 是占位示例。中继跑在你自己机器上，域名和端口由你决定（配置文件或界面里填），项目不绑定任何域名。

> 目标：让 **mini、air、服务器的 dsh web** 任意一台都能当主控，且都不需要公网 IP、不需要开放端口。
> 中继是**哑管道**：只按 `hubId` 把两端配对，不解析业务内容。

---

## 1. 它是怎么工作的

```
┌─ 主控（mini / air / server 的 dsh web）────────────────┐
│  DSH Web + agent 循环 + computer_* 工具               │
│  插件启动后主动拨出：wss://relay.example.com/ws?hub=hub_xxx&role=hub
└───────────────────────┬───────────────────────────────┘
                        │ 出站 WSS（无需入站端口）
              ┌─────────▼─────────┐
              │  中继（本文件部署）│  只做：鉴权 hub、配对、转发字节
              └─────────┬─────────┘
      ┌─────────────────┼─────────────────┐
      │                 │                 │
 被控的 Mac          手机浏览器        另一台主控
 (serverUrl 填       (打开 /r/hub_xxx   (各自的 hubId
  https://dsh-relay…/r/   就是那台的 UI)     互不干扰)
  hub_xxx + 密钥)
```

关键性质：

- **中继不是"总控"**：它同时托管多个 `hubId`，每台机器一个，互不影响。
- **每台都能当主控**：可达性不再是约束，`role` 由你决定。
- **被控端零改动**：agent 只会看到一个不同的 `serverUrl`。
- **不经过中继也能用**：直连 / Tailscale / 局域网路径全部保留，中继是可选的第三条入口。

---

## 2. 在中继服务器上部署

中继是**独立零依赖 Node 服务**，和 `dsh web` 无关，单独进程跑。

```bash
# 1) 拿到代码（或从 npm 包）
git clone https://github.com/9Ashwin/dsh-computers.git /opt/dsh-computers
cd /opt/dsh-computers

# 2) 试跑（前台，确认能起）
node bin/dsh-computers-relay.mjs --port 8445 --host 127.0.0.1

# 3) 常驻（systemd 示例）
sudo tee /etc/systemd/system/dsh-computers-relay.service >/dev/null <<'EOF'
[Unit]
Description=dsh-computers relay
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/dsh-computers
ExecStart=/usr/bin/node bin/dsh-computers-relay.mjs --port 8445 --host 127.0.0.1
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now dsh-computers-relay
curl -s http://127.0.0.1:8445/health      # → {"ok":true,"hubs":[]}
```

> 中继只监听 `127.0.0.1`，对外一律走 nginx 终止 TLS。

---

## 3. nginx：`relay.example.com`

```nginx
server {
    listen 443 ssl http2;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    # 中继需要长连接与 WebSocket 升级
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;              # SSE / 流式响应不能被缓冲
    proxy_read_timeout 3600s;         # hub 链路是长连接
    client_max_body_size 8m;          # 与中继的请求上限一致

    location / {
        proxy_pass http://127.0.0.1:8445;
    }
}
```

```bash
sudo certbot --nginx -d relay.example.com
sudo nginx -t && sudo systemctl reload nginx
curl -s https://relay.example.com/health   # → {"ok":true,"hubs":[]}
```

**为什么用子域名而不是 `/relay/` 路径**：中继要转发 `/r/<hubId>/…` 下的**任意路径**和 WebSocket 升级，挂在子路径下会和 `dsh web` 自己的路由打架，nginx 的 `proxy_pass` 路径改写也更容易出错。子域名零冲突。

---

## 4. 每台机器开启中继

在每台想当主控的机器上（mini / air / 服务器的 `dsh web`）加配置：

```yaml
- id: dsh-computers
  name: dsh-computers
  config:
    role: both
    relay:
      enabled: true
      url: wss://relay.example.com
      # 可选：对外地址覆盖（默认自动生成 https://relay.example.com/r/<hubId>）
      publicUrl: ''
      # 可选：中继入口口令（中继配置了 accessKey 时必填）
      accessKey: ''
      # 可选：展示名（默认主机名）
      name: ''
```

重启该机器的 DSH 后：

- `hubId` 自动生成并持久化到 `<stateDir>/relay.json`（0600）——**不会**因为重置电脑列表而改变，别人收藏的地址不会失效
- 设置 → 电脑 → 本机地址 出现一行 **中继**：`https://relay.example.com/r/hub_xxx`，状态「已连接」时就是推荐地址
- 中继断开时该行标「未监听」，推荐回落到直连地址（不会给你一个连不上的地址）

### 让另一台电脑接进来

在被控那台的 设置 → 电脑 → **本机运行时**：

| 字段 | 值 |
|---|---|
| 服务器地址 | `https://relay.example.com/r/hub_xxx` |
| 加入密钥 | 主控那台 设置 → 电脑 → `+ 连接电脑` 里生成（15 分钟、一次性） |

### 手机 / 外网浏览器

直接打开 `https://relay.example.com/r/hub_xxx`，就是那台机器完整的 DSH UI（带它自己的登录态）。

---

## 5. 三台机器各当主控的形态

三台都开 `relay.enabled: true`，各自拿到不同的 `hubId`：

| 机器 | 自己的入口 | 谁连它 |
|---|---|---|
| mini | `https://relay.example.com/r/hub_mini…` | air、手机 |
| air | `https://relay.example.com/r/hub_air…` | mini、手机 |
| server | `https://relay.example.com/r/hub_srv…` | 两台 Mac、手机 |

**注意**：主控 = 跑 agent 循环的那台，模型调用与 token 消耗都在它身上。三台都能当主控 ⇒ 三台都要配好模型凭据（或指向同一账号）。

---

## 6. 安全边界

| 项 | 做法 |
|---|---|
| 中继看不到什么 | 业务内容走 TLS 到中继后由它转发明文（MVP 如此，等同 cloudflared/nginx 的信任假设） |
| 中继能不能打你的内网 | **不能**。hub 侧的 bridge 只允许打到本机 `127.0.0.1:<自己的端口>`，路径必须 `/` 开头、拒绝绝对 URL、拒绝 `..`、`Host` 强制覆盖 |
| 别人能不能抢你的 hubId | 中继记录 `hubId ↔ hub 密钥` 绑定，重复注册回 `hub_taken` |
| 浏览器要不要另外登录 | 不要。DSH 自己的登录态照常生效，中继不知道你是谁 |
| 撤销 | 主控上关掉 `relay.enabled` 或换 `hubId`；旧入口立刻 502 |
| 限流 | 每 IP 令牌桶（60 次 / 30 每秒补充）、每 hub 最多 256 条流、请求体 8 MiB、分片 64 KiB |

> 端到端加密（中继也看不到明文）**未做**。要做需在浏览器侧跑密钥协商（WebCrypto ECDH + AES-GCM），单独立项 + 安全评审。当前信任假设与「用 cloudflared 暴露本地服务」相同。

---

## 7. 排障

| 现象 | 原因 / 处理 |
|---|---|
| 本机地址里没有「中继」行 | `relay.enabled` 没开、`url` 不是 `ws(s)://`，或中继没起 |
| 中继行显示「未监听」 | 链路没连上：看 `curl https://relay.example.com/health` 的 `hubs` 里有没有你的 `hubId` |
| 连接失败：`hub_offline` | 主控那台的 DSH 没运行，或它的中继链路断了（会按 1.5s→30s 自动重连） |
| 连接失败：`hub_taken` | 同一 `hubId` 已有一台在线（两台机器复制了同一份 `relay.json`） |
| 浏览器打开白屏 | 中继版本过旧（WebSocket 透传未上线），或 nginx 没配 `Upgrade`/`Connection` 头 |
| 手机能开页面但一直转圈 | 同上：WS 透传或 nginx 的 `proxy_read_timeout` 太短 |

日志：`journalctl -u dsh-computers-relay -f`；主控侧看 DSH 日志里 `relay link:` 开头的行。
