# 部署与重启

插件更新后，**Host 端（插件主进程）必须重启**才会加载新代码；浏览器端只需刷新页面（Client 代码会随刷新重新拉取）。

重启会断开所有已连接电脑的 SSE 长连接，但它们会自动重连（1s→30s 退避），**不需要重新 enroll**；会话与电脑注册表都是持久化的。

日常最省事的做法是把 `dsh web` 交给进程管理器，之后重启只需一条命令。

## Linux：systemd（推荐）

```ini
# /etc/systemd/system/dsh-web.service
[Unit]
Description=DSH Web
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER
# 监听对外地址；反向代理场景可用 127.0.0.1:8080，只让代理连进来
ExecStart=/usr/local/bin/dsh web --host 127.0.0.1 --port 8080
Restart=always
RestartSec=3
# 让 Host 端能读到代理传来的 X-Forwarded-*（本插件据此生成对外地址）
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-web
sudo systemctl restart dsh-web     # ← 以后更新插件后只需要这一条
journalctl -u dsh-web -f           # 看日志
```

> 只给当前用户装可以用 `systemctl --user`，配 `loginctl enable-linger YOUR_USER` 让它开机自启。

## macOS：launchd

```xml
<!-- ~/Library/LaunchAgents/com.dsh.web.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dsh.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/dsh</string><string>web</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>8080</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/dsh-web.log</string>
  <key>StandardErrorPath</key><string>/tmp/dsh-web.log</string>
</dict></plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dsh.web.plist
launchctl kickstart -k gui/$(id -u)/com.dsh.web     # ← 重启
```

## Docker

```bash
docker compose restart dsh-web
```

## 前台 / tmux（不装管理器）

```bash
# Ctrl-C 后重跑同一行；或用 tmux 保留会话
tmux new -s dsh 'dsh web --host 127.0.0.1 --port 8080'
tmux attach -t dsh        # 之后 Ctrl-C、↑、Enter 即可重启
```

## 关于「插件市场」里的重启入口

插件市场在检测到「需重启后生效」时会提供重启入口，但它**只在自己不是被监督进程时**才自行重启；检测到 systemd 时会把重启交给 systemd（它不能杀掉自己的 cgroup）。所以：

- 前台 / tmux 跑 → 用市场的重启入口，或 Ctrl-C 重跑；
- systemd / launchd / Docker / pm2 托管 → 用上面的 `restart` 命令。

## 更新插件的正确姿势

profile 里的 git 依赖会被钉到 spec + commit，所以**用同样的 spec 再装一次不会更新**（返回 `already-installed`）：

```bash
# 换 spec = 真正更新（不用先卸载）
dsh plugin install github:9Ashwin/dsh-computers#v1.0.2

# 或者装分支，让插件市场的「检查更新」能发现新提交
dsh plugin install github:9Ashwin/dsh-computers
```

装 tag 的实例永远不会被市场判为"有更新"（tag 本身不动），要升级只能显式换 tag。装分支则可以在市场里一键检查更新。

更新完 → 重启 Host（本节上面的命令）→ 刷新浏览器。

## 用 Tailscale 让机器互相直连（无公网服务器）

同一 tailnet 内的机器可以互相直连：每台机器**既能当主控（被别人连），也能当被控端（连别人）**。两种让 hub 可达的做法：

### 做法一：把 DSH 绑到 Tailscale 地址（**仅限 `dsh web` 独立部署**）

> ⚠️ **桌面端（DeepSeek Harness.app）不要用这个做法。** 桌面版 Host 里写死了窗口连接地址
> （`dsh-desktop-host`：`${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`），
> 一旦把 `webserver.host` 改成非 loopback 地址，窗口会去连 `127.0.0.1:<port>` 而那里没有监听，
> 界面直接卡在「重新连接中」。桌面端只能用做法二。

```bash
# 只适用于独立部署的 dsh web（有自己的 CLI）
dsh web --host 100.x.y.z --port 8080
```

查地址：`tailscale ip -4`；MagicDNS 名字：`tailscale status --json | jq -r .Self.DNSName`。

### 做法二：保持 127.0.0.1，用 tailscale serve 反代（桌面端唯一可行做法）

```bash
# 先看当前 DSH 端口（桌面端每次启动可能不同，看设置里的 GUI URL 或 lsof）
lsof -nP -iTCP -sTCP:LISTEN | grep DeepSeek

# 用 tailscale serve 把它暴露到 tailnet（HTTPS 默认 443，被占用时显式换端口）
tailscale serve --bg --https=8443 http://127.0.0.1:<DSH端口>
tailscale serve status            # 分到 https://<machine>.<tailnet>.ts.net:8443
```

然后把分到的地址写进插件配置 `publicUrl`（连接弹窗就会用它）。

> 端口提示：443 可能已被其它服务占用（例如 im-toolbox 反代到 127.0.0.1:8000），
> 用 `tailscale serve status` 先看，再挑一个空闲端口。

### 连接另一台机器

任一台机器的 设置 → 电脑 → **本机运行时**，服务器地址填对方的 Tailscale 地址（`http://100.x.y.z:8080`）或 ts.net 域名，加入密钥从对方 设置 → 电脑 → `+ 连接电脑` 拿。不装插件的机器用 `curl … join.sh | sh`。

### 地址自动识别

插件的 设置 → 电脑 会列出本机所有可被访问的地址并标出推荐项：

| kind | 说明 |
|---|---|
| `public` | 配置的 `publicUrl`（永远优先） |
| `forwarded` / `host` | 浏览器请求来源（非 loopback 时） |
| `tailscale` | `tailscale ip -4` 探测（500ms 超时，60s 缓存），或扫描 `100.64.0.0/10` 网卡 |
| `lan` | 第一个非内部 IPv4（如 192.168.x） |
| `mdns` | `<hostname>.local`（hostname 已带 `.local` 时省略） |
| `loopback` | 127.0.0.1，永远最后 |

`+ 连接电脑` 生成的命令默认用推荐地址；只有 loopback 可用时会明确警告"其他电脑连不上"。想强制某一类地址用配置 `preferAddress: auto | public | tailscale | lan | loopback`。
