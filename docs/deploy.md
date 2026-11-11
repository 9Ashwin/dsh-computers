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
