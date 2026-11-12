/**
 * dsh-computers — browser half (Settings → 电脑).
 *
 * A self-contained DSH Web client bundle: the settings page that lists the
 * user's connected machines and the "connect a computer" modal that mints a
 * one-time enrollment key, shows the one-line installer and waits for the
 * machine to come online.
 *
 * Contract: PROTOCOL.md §4 (browser → host API, document-relative paths) and
 * §7 (this surface). The module envelope and the `slots` / `locale` service
 * usage follow the cordis-plugin-development templates; every visible string
 * is localized here and no client-ui-* package is imported.
 */
window.__ModuleLoader__.load({
  id: 'dsh-computers',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    /* `react-dom` is a platform seed word of the Web client, so the dialogs
     * portal to <body> and no ancestor can clip or re-anchor them. A shell that
     * withholds it degrades to an in-place `position:fixed` layer. */
    let ReactDOM = null;
    try {
      const reactDom = require('react-dom');
      if (reactDom && typeof reactDom.createPortal === 'function') ReactDOM = reactDom;
    } catch (error) {
      ReactDOM = null;
    }

    const NS = 'dsh-computers';
    const SECTION_ID = 'computers';
    const SECTION_ORDER = 45;
    const TARGET_SLOT_ID = 'computers-target';
    const TARGET_SLOT_ORDER = 20;
    /* Sidebar panel-list row for the 电脑管理 main panel (order after the
     * shipped plugin-manager row, which uses 0). */
    const PANEL_ORDER = 20;
    const STYLE_ID = 'dsh-computers/client.css';
    const STATE_POLL_MS = 5000;
    const KEY_POLL_MS = 2000;
    const NOTICE_MS = 4200;

    /* Document-relative on purpose: the GUI is served with <base href="./">, so
     * a root-absolute "/api/..." escapes a sub-path deployment (PROTOCOL §4). */
    const API = {
      state: 'api/dsh-computers/state',
      keys: 'api/dsh-computers/keys',
      keyStatus: 'api/dsh-computers/key-status',
      remove: 'api/dsh-computers/delete',
      rename: 'api/dsh-computers/rename',
      /* Runtime mode (PROTOCOL §10.5): this machine joining a hub. */
      runtime: 'api/dsh-computers/runtime',
      runtimeConnect: 'api/dsh-computers/runtime/connect',
      runtimeEnable: 'api/dsh-computers/runtime/enable',
      runtimeDisconnect: 'api/dsh-computers/runtime/disconnect',
      /* Relay on/off (PROTOCOL relay): the 中继 card's switch. The host
       * answers with the fresh `state.relay` payload, so the card can
       * reconcile without waiting for the next 5 s poll. */
      relayEnable: 'api/dsh-computers/relay/enable',
      /* Account center (PROTOCOL account): one account on the relay; machines
       * sign into it instead of pairing with each other one by one. The host
       * may not have these routes yet — every call below degrades quietly. */
      account: 'api/dsh-computers/account',
      accountCreate: 'api/dsh-computers/account/create',
      accountLogin: 'api/dsh-computers/account/login',
      accountLogout: 'api/dsh-computers/account/logout',
      accountDiscover: 'api/dsh-computers/account/discover',
      /* 被控 (controllable): toggles THIS machine's own flag in the account
       * directory. Hosts that predate it answer 404 — the UI degrades to the
       * read-only label. */
      accountControllable: 'api/dsh-computers/account/controllable',
      /* Per-session target computer for the composer chip (task-9 host side). */
      selection: 'api/dsh-computers/selection',
      /* Access rules (task-11 host side): which computers a session may use,
       * and which agent presets may use a computer. */
      access: 'api/dsh-computers/access',
      accessComputer: 'api/dsh-computers/access/computer',
    };

    // #region locales

    /* Chinese is the key source; en mirrors every key (PROTOCOL §7). */
    const zh = {
      nav: '电脑',
      title: '电脑',
      description: '把你自己电脑接进来，agent 就能在它上面直接执行命令。',
      'badge.bots': '{used}/{total} 个 Bot',
      online: '在线',
      offline: '离线',
      'rename.action': '重命名',
      'delete.action': '删除',
      loading: '正在加载电脑列表…',
      'empty.title': '还没有连接任何电脑',
      'empty.hint': '把「复制接入地址」得到的地址粘贴到另一台电脑的 设置 → 电脑 → 接入；那台机器没有 DSH 时，用下面的命令行接入。',
      'empty.cliAction': '没有 DSH 的机器？用命令行接入',
      'join.blocked': '这台机器现在只有本机地址，没法生成给别的电脑用的接入地址：先在下面「高级 → 中继」里启用中继，或给它配一个公网地址。',
      'error.load': '无法读取电脑列表',
      'error.loadDetail': '{title}：{message}',
      'error.network': '无法连接到服务器，请检查网络后重试。',
      'error.badResponse': '服务器返回了无法识别的响应。',
      'error.generic': '操作失败，请稍后重试。',
      'error.http': '请求失败（HTTP {status}）',
      retry: '重试',
      'render.error': '这个页面遇到了意外错误。',
      'render.reload': '重新加载',

      'rename.title': '重命名这台电脑',
      'rename.field': '显示名称',
      'rename.placeholder': '例如：客厅 Mac mini',
      'rename.hint': '1–64 个字符，只影响这份列表和 agent 看到的名称。',
      'rename.failed': '重命名失败：{message}',
      'renamed.notice': '已重命名为「{name}」',

      'delete.title': '删除这台电脑？',
      'delete.body': '「{name}」会从列表移除，与它之间的连接会断开。需要时可以重新连接。',
      'delete.confirm': '删除',
      'delete.failed': '删除失败：{message}',
      'deleted.notice': '已删除「{name}」',

      'dialog.close': '关闭',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      deleting: '删除中…',

      'connect.title': '连接电脑',
      'connect.subtitle': '在另一台电脑的 设置 → 电脑 → 接入 里粘贴下面的服务器地址和加入密钥；没有 DSH 的机器用下面的命令行',
      'connect.osGroup': '选择电脑的系统',
      'connect.os.windows': 'Windows',
      'connect.os.macos': 'macOS',
      'connect.os.linux': 'Linux',
      'connect.replace.title': '覆盖这台电脑已保存的连接',
      'connect.replace.hint': '终端提示已有其他连接时开启，再重新复制命令',
      'connect.command.label': '终端命令',
      'connect.copy': '复制命令',
      'connect.copied': '已复制',
      'connect.copyFailed': '复制失败，请手动选中命令文本',
      'connect.creating': '正在生成命令…',
      'connect.createFailed': '命令生成失败：{message}',
      'connect.waiting': '等待电脑连接…',
      'connect.connected': '电脑已连接',
      'connect.expired': '命令已过期，请重新生成',
      'connect.used': '该命令已被使用，请重新生成',
      'connect.unknown': '命令已失效，请重新生成',
      'connect.regenerate': '重新生成',
      'connect.connected.notice': '已连接「{name}」',
      'connect.connected.noticeAnonymous': '电脑已连接',
      'connect.pendingCommand': '命令准备中…',
      'connect.serverUrl': '服务器地址',
      'connect.serverUrlHint': '在另一台电脑的「接入」里填这个地址',
      'connect.enrollmentKey': '加入密钥',
      'connect.enrollmentKeyHint': '15 分钟内有效，只能用一次',
      'connect.copyField': '复制{field}',
      'connect.cliToggle': '没有 DSH 的机器？用命令行接入',
      'connect.cliHint': '在要连接的电脑上安装 Node.js 22+，然后在终端运行下方命令',

      'computers.group': '已连接的电脑',
      /* v1.7.0 one-field join: the 接入 card is the whole page up top. */
      'join.title': '接入',
      'join.addressLabel': '接入地址',
      'join.addressPlaceholder': 'https://relay.example.com/r/hub_…',
      'join.hint': '在另一台电脑的 设置 → 电脑 → 已连接的电脑 里点「复制接入地址」，把整串粘贴到这里。',
      'join.keyToggle': '用加入密钥',
      'join.addressToggle': '用接入地址',
      'join.connected': '已连接',
      'join.invalid': '这不像一个接入地址：它应该形如 https://…/r/hub_…#join=…',
      'advanced.title': '高级',
      'advanced.summary': '中继与账号中心',
      'fleet.copy': '复制接入地址',

      /* Account center (PROTOCOL account): one account on the relay, so
       * machines signed into it find each other with no per-machine pairing. */
      'account.modesLabel': '接入方式',
      'account.mode.account': '登录账号',
      'account.mode.address': '接入地址',
      'account.login.hint': '用同一个账号密钥登录的电脑会自动出现在彼此的列表里，不需要逐台配对。',
      /* v1.9.1: ONE pasted account key (`dshk_<16hex>_<32hex>`) instead of the
       * old 账号 ID + 密码 pair. The client only checks the shape as a hint. */
      'account.login.key': '账号密钥',
      'account.login.keyPlaceholder': 'dshk_…',
      'account.login.keyShape': '这看起来不像账号密钥（一般以 dshk_ 开头），仍会提交给服务器。',
      'account.login.relay': '中继地址',
      'account.login.relayPlaceholder': 'wss://relay.example.com',
      'account.login.relayHint': '账号中心所在的中继地址',
      'account.login.submit': '登录',
      'account.login.submitting': '登录中…',
      'account.login.failed': '登录失败：{message}',
      'account.loggedIn': '已登录',
      'account.loggingOut': '退出中…',
      'account.logout': '退出登录',
      'account.logoutFailed': '退出登录失败：{message}',
      'account.loggedIn.notice': '已登录账号 {accountId}',
      'account.loggedOut.notice': '已退出账号',
      'account.devices.title': '账号里的电脑',
      'account.devices.count': '{count} 台电脑',
      'account.devices.empty': '这个账号还没有其他电脑',
      'account.devices.thisMachine': '本机',
      'account.devices.unknown': '未知设备',
      'account.platform.unknown': '未知系统',
      /* 被控 (controllable): whether other machines in the account may run
       * commands on this one. Only THIS machine can flip it. */
      'account.devices.controllable': '被控',
      'account.devices.allowed': '允许被控',
      'account.devices.blocked': '不允许被控',
      'account.devices.controllableAria': '允许账号里的其他电脑控制「{name}」',
      'account.devices.controllableFailed': '切换被控状态失败：{message}',
      'account.center.title': '账号中心',
      'account.center.hint': '在这台机器上创建账号中心，其他电脑用账号密钥登录，就能互相看到并连过来。',
      'account.center.create': '创建账号中心',
      'account.center.creating': '创建中…',
      'account.center.adminKey': '管理员密钥（可选）',
      'account.center.adminKeyPlaceholder': 'relay --admin-key',
      'account.center.name': '名称（可选）',
      'account.center.namePlaceholder': '例如：我的账号中心',
      'account.center.submit': '创建',
      'account.center.cancel': '取消',
      'account.center.failed': '创建账号中心失败：{message}',
      'account.center.created': '账号中心已创建',
      'account.center.createdHint': '其他电脑在 设置 → 电脑 → 接入 → 登录账号 里粘贴这串账号密钥。',
      'account.center.loggedIn': '这台机器已登录账号',
      /* The account key is retrievable at any time (v1.9.1): the card always
       * shows it with a copy button — that is how another machine is added. */
      'account.key.label': '账号密钥',
      'account.key.warning': '任何拿到这串密钥的人都能加入这个账号，请妥善保管。',
      'account.key.highlight': '这是你的账号密钥，随时可以回来复制',
      'account.key.unsupported': '这台机器还不支持查看密钥，请升级插件',
      'runtime.hint': '加入密钥来自服务器「连接电脑」弹窗，只能用一次，15 分钟内有效。',
      'runtime.serverLabel': '服务器地址',
      'runtime.serverPlaceholder': 'https://dsh.example.com',
      'runtime.keyLabel': '加入密钥',
      'runtime.keyPlaceholder': 'dshc_…',
      'runtime.connect': '连接',
      'runtime.connecting': '连接中…',
      'runtime.disconnect': '断开',
      'runtime.disconnectTitle': '断开这台电脑？',
      'runtime.disconnectBody': '这台电脑会停止向 {server} 保持连接，并在那台服务器的电脑列表里变为离线。记录会保留（可在服务器上删除），之后也可以随时重新连接。',
      'runtime.disconnectFailed': '断开失败：{message}',
      'runtime.connectFailed': '连接失败：{message}',
      'runtime.loading': '正在读取本机状态…',
      'runtime.loadFailed': '无法读取本机状态',
      'runtime.status.running': '运行中',
      'runtime.status.stopped': '已停止',
      'runtime.status.connecting': '连接中…',
      'runtime.status.failed': '连接失败',
      'runtime.connected.notice': '本机已接入 {server}',
      'runtime.disconnected.notice': '已断开接入',

      'target.label': '目标电脑',
      'target.cloud': '本地电脑',
      'target.cloudHint': '本机',
      'target.menuLabel': '选择这台会话使用的电脑',
      'target.chipLabel': '这台对话使用的电脑：{name}',
      'target.manage': '在 设置 → 电脑 中管理',
      'access.manage': '管理访问权',
      'access.session.title': '这台对话',
      'access.session.subtitle': '它可以使用哪些电脑?',
      'access.manageComputers': '管理电脑',
      'access.done': '完成',
      'access.cloudHint': '本机',
      'access.noneHint': '关闭全部后，这台对话不能使用任何远程电脑',
      'access.computer.subtitle': '哪些 Bot 可以使用它?',
      'access.defaultPreset': '默认',
      'access.loading': '正在读取权限…',
      'access.loadFailed': '无法读取权限设置',
      'access.saveFailed': '保存失败：{message}',
      'access.badgeAria': '管理「{name}」的使用权限',
      'access.presetsEmpty': '还没有可用的 Bot 预设',
      'access.computersEmpty': '还没有连接的电脑',
      'access.computer.titleFallback': '这台电脑',
      'access.presetDenied': '该电脑的 Bot 权限未包含当前预设',
      'cap.exec': '执行',
      'cap.fs': '文件',
      'cap.jobs': '后台任务',
      'cap.pty': '终端',
      'cap.exec.title': '可以在这台电脑上执行命令',
      'cap.fs.title': '可以读写这台电脑上的文件',
      'cap.jobs.title': '命令可以在后台继续跑',
      'cap.pty.title': '可以打开交互式终端',
      'drift.chip': '可升级',
      'drift.title': '升级这台电脑的 agent',
      'drift.body': '这台电脑运行的是 agent {current}，需要更新的版本才能使用全部能力。',
      'drift.expected': '当前服务器使用 agent {version}。',
      'drift.commandLabel': '在要升级的电脑上运行',
      'drift.hint': '升级会重启这台电脑上的 agent 服务，正在执行的命令会中断。',
      'drift.close': '关闭',
      'drift.unknownVersion': '未知版本',
      'drift.runtimeHint': '本机 agent 版本落后于服务器，升级 DSH 后重启生效',
      'drift.embedded.body': '这台电脑是通过 DSH 插件自带的本机运行时接入的，升级插件本身即可。',
      'drift.embedded.steps': '打开 设置 → 插件市场 → 已安装 → dsh-computers → 检查更新，然后重启 DSH。',
      'drift.embedded.cliLabel': '或者在命令行里安装',
      'mode.embedded': '插件运行时',
      'mode.service': '系统服务',
      /* Only the address-kind labels survive: the connect modal's combobox
       * still names each candidate. The 本机地址 block is gone. */
      'addr.unreachable': '未监听',
      'addr.loopbackOnlyShort': '只有本机地址可用，其他电脑连不上',
      'addr.kind.public': '公网',
      'addr.kind.forwarded': '代理',
      'addr.kind.host': '主机',
      'addr.kind.tailscale': 'Tailscale',
      'addr.kind.lan': '局域网',
      'addr.kind.mdns': '本机名',
      'addr.kind.loopback': '本机',
      'addr.kind.tunnel': 'Tailscale Serve',
      'addr.kind.relay': '中继',
      'addr.kind.other': '地址',
      'addr.listLabel': '可用的服务器地址',
            'relay.title': '中继',
      'relay.hubLabel': '中继 ID',
      'relay.urlLabel': '公网地址',
      'relay.status.connected': '已连接',
      'relay.status.connecting': '连接中…',
      'relay.status.failed': '失败',
      'relay.status.disabled': '已停用',
      'relay.connecting': '正在连接中继…',
      'relay.failedLine': '中继连接失败：{message}。检查中继服务是否在运行',
      'relay.unknownError': '未知错误',
      'relay.hint': '别的电脑和手机用这个地址连到这台电脑，不需要公网 IP 或开放端口',
      'relay.enable': '启用',
      /* The setup button; same word as the switch label in zh, but en needs
       * the verb for a button and the state word for the switch. */
      'relay.enableAction': '启用',
      /* The 中继 card sets itself up here: no config file, no restart. */
      'relay.urlField': '中继地址',
      'relay.urlPlaceholder': 'wss://relay.example.com',
      'relay.edit': '修改',
      'relay.save': '保存',
      'relay.cancel': '取消',
      'relay.upgradeHint': '这台机器还不支持在界面上配置中继，请升级插件',
      'relay.enableFailed': '切换中继失败：{message}',
      'relay.saveFailed': '保存中继地址失败：{message}',
      'target.offline': '离线',
      'target.failed': '切换失败：{message}',
      /* Account devices in the picker: a second group after the local ones. */
      'target.accountGroup': '账号里的电脑',
      'target.notControllable': '不允许被控',
      'target.deviceGone': '选中的电脑已不在账号里，已切回本地电脑',
    };

    const en = {
      nav: 'Computers',
      title: 'Computers',
      description: 'Bring your own machines in so the agent can run commands on them.',
      'badge.bots': '{used}/{total} Bot',
      online: 'Online',
      offline: 'Offline',
      'rename.action': 'Rename',
      'delete.action': 'Delete',
      loading: 'Loading computers…',
      'empty.title': 'No computers connected yet',
      'empty.hint': 'Paste the address from “Copy join address” into Settings → Computers → Join on the other computer. If that machine has no DSH, use the command line below.',
      'empty.cliAction': 'No DSH on that machine? Use the command line',
      'join.blocked': 'This machine only has a local address right now, so there is no join address for other computers yet. Enable the relay under Advanced → Relay below, or give it a public address.',
      'error.load': 'Could not load the computer list',
      'error.loadDetail': '{title}: {message}',
      'error.network': 'Could not reach the server. Check the network and try again.',
      'error.badResponse': 'The server returned an unrecognized response.',
      'error.generic': 'That did not work. Try again in a moment.',
      'error.http': 'Request failed (HTTP {status})',
      retry: 'Retry',
      'render.error': 'This page hit an unexpected error.',
      'render.reload': 'Reload',

      'rename.title': 'Rename this computer',
      'rename.field': 'Display name',
      'rename.placeholder': 'e.g. Living room Mac mini',
      'rename.hint': '1–64 characters. Only this list and the name the agent sees change.',
      'rename.failed': 'Rename failed: {message}',
      'renamed.notice': 'Renamed to “{name}”',

      'delete.title': 'Delete this computer?',
      'delete.body': '“{name}” leaves this list and its connection is dropped. You can connect it again later.',
      'delete.confirm': 'Delete',
      'delete.failed': 'Delete failed: {message}',
      'deleted.notice': 'Deleted “{name}”',

      'dialog.close': 'Close',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      deleting: 'Deleting…',

      'connect.title': 'Connect computer',
      'connect.subtitle': 'Open Settings → Computers → Join on the other machine and paste the server URL and join key below; use the command line below for a machine without DSH',
      'connect.osGroup': 'Choose the system of that computer',
      'connect.os.windows': 'Windows',
      'connect.os.macos': 'macOS',
      'connect.os.linux': 'Linux',
      'connect.replace.title': 'Replace the connection saved on this computer',
      'connect.replace.hint': 'Turn this on when the terminal says another connection already exists, then copy the command again',
      'connect.command.label': 'Terminal command',
      'connect.copy': 'Copy command',
      'connect.copied': 'Copied',
      'connect.copyFailed': 'Copy failed — select the command text manually',
      'connect.creating': 'Generating command…',
      'connect.createFailed': 'Could not generate the command: {message}',
      'connect.waiting': 'Waiting for the computer to connect…',
      'connect.connected': 'Connected',
      'connect.expired': 'This command expired — generate a new one',
      'connect.used': 'This command was already used — generate a new one',
      'connect.unknown': 'This command is no longer valid — generate a new one',
      'connect.regenerate': 'Generate again',
      'connect.connected.notice': 'Connected “{name}”',
      'connect.connected.noticeAnonymous': 'Computer connected',
      'connect.pendingCommand': 'Preparing the command…',
      'connect.serverUrl': 'Server URL',
      'connect.serverUrlHint': 'Paste this into “Join” on the other computer',
      'connect.enrollmentKey': 'Join key',
      'connect.enrollmentKeyHint': 'Valid for 15 minutes, single use',
      'connect.copyField': 'Copy {field}',
      'connect.cliToggle': 'No DSH on that machine? Use the command line',
      'connect.cliHint': 'Install Node.js 22+ on that machine, then run the command below in a terminal',

      'computers.group': 'Connected computers',
      /* v1.7.0 one-field join: the Join card is the whole page up top. */
      'join.title': 'Join',
      'join.addressLabel': 'Join address',
      'join.addressPlaceholder': 'https://relay.example.com/r/hub_…',
      'join.hint': 'On the other computer open Settings → Computers → Connected computers and click “Copy join address”, then paste the whole string here.',
      'join.keyToggle': 'Use a join key',
      'join.addressToggle': 'Use a join address',
      'join.connected': 'Connected to',
      'join.invalid': 'That does not look like a join address; it should look like https://…/r/hub_…#join=…',
      'advanced.title': 'Advanced',
      'advanced.summary': 'Relay and account center',
      'fleet.copy': 'Copy join address',

      /* Account center (PROTOCOL account): one account on the relay, so
       * machines signed into it find each other with no per-machine pairing. */
      'account.modesLabel': 'Join method',
      'account.mode.account': 'Sign in',
      'account.mode.address': 'Join address',
      'account.login.hint': 'Computers signed in with the same account key show up in each other’s list automatically — no per-machine pairing.',
      /* v1.9.1: ONE pasted account key (`dshk_<16hex>_<32hex>`) instead of the
       * old 账号 ID + 密码 pair. The client only checks the shape as a hint. */
      'account.login.key': 'Account key',
      'account.login.keyPlaceholder': 'dshk_…',
      'account.login.keyShape': 'That does not look like an account key (it usually starts with dshk_) — it will still be sent to the server.',
      'account.login.relay': 'Relay address',
      'account.login.relayPlaceholder': 'wss://relay.example.com',
      'account.login.relayHint': 'Relay address of the account center',
      'account.login.submit': 'Sign in',
      'account.login.submitting': 'Signing in…',
      'account.login.failed': 'Sign-in failed: {message}',
      'account.loggedIn': 'Signed in as',
      'account.loggingOut': 'Signing out…',
      'account.logout': 'Sign out',
      'account.logoutFailed': 'Sign-out failed: {message}',
      'account.loggedIn.notice': 'Signed in as {accountId}',
      'account.loggedOut.notice': 'Signed out',
      'account.devices.title': 'Computers in this account',
      'account.devices.count': '{count} computers',
      'account.devices.empty': 'No other computers in this account yet',
      'account.devices.thisMachine': 'This machine',
      'account.devices.unknown': 'Unknown device',
      'account.platform.unknown': 'Unknown system',
      'account.devices.controllable': 'Controllable',
      'account.devices.allowed': 'Controllable',
      'account.devices.blocked': 'Not controllable',
      'account.devices.controllableAria': 'Let other computers in this account control “{name}”',
      'account.devices.controllableFailed': 'Could not change controllability: {message}',
      'account.center.title': 'Account center',
      'account.center.hint': 'Create the account center on this machine; other computers sign in with the account key and can then see and reach each other.',
      'account.center.create': 'Create account center',
      'account.center.creating': 'Creating…',
      'account.center.adminKey': 'Admin key (optional)',
      'account.center.adminKeyPlaceholder': 'relay --admin-key',
      'account.center.name': 'Name (optional)',
      'account.center.namePlaceholder': 'e.g. My account center',
      'account.center.submit': 'Create',
      'account.center.cancel': 'Cancel',
      'account.center.failed': 'Could not create the account center: {message}',
      'account.center.created': 'Account center created',
      'account.center.createdHint': 'On another computer, open Settings → Computers → Join → Sign in and paste this account key.',
      'account.center.loggedIn': 'This machine is signed in as',
      /* The account key is retrievable at any time (v1.9.1): the card always
       * shows it with a copy button — that is how another machine is added. */
      'account.key.label': 'Account key',
      'account.key.warning': 'Anyone with this key can join this account — keep it safe.',
      'account.key.highlight': 'This is your account key — come back here to copy it any time',
      'account.key.unsupported': 'This machine cannot show the key yet — please update the plugin',
      'runtime.hint': 'The join key comes from the server’s “Connect computer” dialog; single use, valid for 15 minutes.',
      'runtime.serverLabel': 'Server URL',
      'runtime.serverPlaceholder': 'https://dsh.example.com',
      'runtime.keyLabel': 'Join key',
      'runtime.keyPlaceholder': 'dshc_…',
      'runtime.connect': 'Connect',
      'runtime.connecting': 'Connecting…',
      'runtime.disconnect': 'Disconnect',
      'runtime.disconnectTitle': 'Disconnect this computer?',
      'runtime.disconnectBody': 'This machine stops connecting to {server} and goes offline in that server’s computer list. The record stays until you delete it there, and you can connect again at any time.',
      'runtime.disconnectFailed': 'Disconnect failed: {message}',
      'runtime.connectFailed': 'Connect failed: {message}',
      'runtime.loading': 'Reading this computer’s status…',
      'runtime.loadFailed': 'Could not read this computer’s status',
      'runtime.status.running': 'Running',
      'runtime.status.stopped': 'Stopped',
      'runtime.status.connecting': 'Connecting…',
      'runtime.status.failed': 'Connection failed',
      'runtime.connected.notice': 'This computer joined {server}',
      'runtime.disconnected.notice': 'Disconnected',

      'target.label': 'Target computer',
      'target.cloud': 'Local computer',
      'target.cloudHint': 'This machine',
      'target.menuLabel': 'Choose the computer this session uses',
      'target.chipLabel': 'Computer for this chat: {name}',
      'target.manage': 'Manage in Settings → Computers',
      'access.manage': 'Manage access',
      'access.session.title': 'This chat',
      'access.session.subtitle': 'Which computers may it use?',
      'access.manageComputers': 'Manage computers',
      'access.done': 'Done',
      'access.cloudHint': 'This machine',
      'access.noneHint': 'With everything off, this chat cannot use any remote computer',
      'access.computer.subtitle': 'Which Bots may use it?',
      'access.defaultPreset': 'Default',
      'access.loading': 'Reading access rules…',
      'access.loadFailed': 'Could not read the access rules',
      'access.saveFailed': 'Could not save: {message}',
      'access.badgeAria': 'Manage who may use “{name}”',
      'access.presetsEmpty': 'No Bot presets available yet',
      'access.computersEmpty': 'No computers connected yet',
      'access.computer.titleFallback': 'This computer',
      'access.presetDenied': 'This computer’s Bot access does not include the current preset',
      'cap.exec': 'Exec',
      'cap.fs': 'Files',
      'cap.jobs': 'Jobs',
      'cap.pty': 'Terminal',
      'cap.exec.title': 'Can run commands on this computer',
      'cap.fs.title': 'Can read and write files on this computer',
      'cap.jobs.title': 'Commands can keep running in the background',
      'cap.pty.title': 'Can open an interactive terminal',
      'drift.chip': 'Upgradable',
      'drift.title': 'Upgrade this computer’s agent',
      'drift.body': 'This computer runs agent {current}; a newer version is needed for every capability.',
      'drift.expected': 'This server uses agent {version}.',
      'drift.commandLabel': 'Run this on the computer you want to upgrade',
      'drift.hint': 'Upgrading restarts the agent service on that computer; running commands are interrupted.',
      'drift.close': 'Close',
      'drift.unknownVersion': 'unknown version',
      'drift.runtimeHint': 'This computer’s agent is behind the server; update DSH and restart',
      'drift.embedded.body': 'This computer is connected through the DSH plugin’s own local runtime, so upgrading the plugin is what upgrades it.',
      'drift.embedded.steps': 'Open Settings → Plugin Market → Installed → dsh-computers → Check for updates, then restart DSH.',
      'drift.embedded.cliLabel': 'Or install it from the command line',
      'mode.embedded': 'Plugin runtime',
      'mode.service': 'System service',
      /* Only the address-kind labels survive: the connect modal's combobox
       * still names each candidate. The 本机地址 block is gone. */
      'addr.unreachable': 'Not listening',
      'addr.loopbackOnlyShort': 'Only a loopback address is available; other computers cannot connect',
      'addr.kind.public': 'Public',
      'addr.kind.forwarded': 'Proxy',
      'addr.kind.host': 'Host',
      'addr.kind.tailscale': 'Tailscale',
      'addr.kind.lan': 'LAN',
      'addr.kind.mdns': 'Local name',
      'addr.kind.loopback': 'Loopback',
      'addr.kind.tunnel': 'Tailscale Serve',
      'addr.kind.relay': 'Relay',
                  'addr.kind.other': 'Address',
      'addr.listLabel': 'Available server addresses',
            'relay.title': 'Relay',
      'relay.hubLabel': 'Relay ID',
      'relay.urlLabel': 'Public address',
      'relay.status.connected': 'Connected',
      'relay.status.connecting': 'Connecting…',
      'relay.status.failed': 'Failed',
      'relay.status.disabled': 'Disabled',
      'relay.connecting': 'Connecting to the relay…',
      'relay.failedLine': 'Relay connection failed: {message}. Check whether the relay service is running',
      'relay.unknownError': 'unknown error',
      'relay.hint': 'Other computers and phones use this address to reach this computer — no public IP or open port needed',
      'relay.enable': 'Enabled',
      'relay.enableAction': 'Enable',
      /* The relay card sets itself up here: no config file, no restart. */
      'relay.urlField': 'Relay address',
      'relay.urlPlaceholder': 'wss://relay.example.com',
      'relay.edit': 'Change',
      'relay.save': 'Save',
      'relay.cancel': 'Cancel',
      'relay.upgradeHint': 'This machine cannot configure the relay from the UI yet — please upgrade the plugin',
      'relay.enableFailed': 'Could not change the relay: {message}',
      'relay.saveFailed': 'Could not save the relay address: {message}',
      'target.offline': 'Offline',
      'target.failed': 'Could not switch: {message}',
      'target.accountGroup': 'Computers in this account',
      'target.notControllable': 'Not controllable',
      'target.deviceGone': 'The selected computer left the account; switched back to the local computer',
    };

    /* Active translate seat, wired by apply() to the locale service. The
     * dictionary fallback keeps the surface readable when the seat is missing
     * (module-scope callers, services not yet up, structural tests). */
    let runtimeT = null;
    let localeFace = null;

    function activeLocale() {
      let id = null;
      try {
        if (localeFace && typeof localeFace.getLocale === 'function') id = localeFace.getLocale().active;
      } catch (error) {
        id = null;
      }
      if (typeof id !== 'string' || id === '') {
        try {
          if (typeof document !== 'undefined' && document.documentElement) id = document.documentElement.lang;
        } catch (error) {
          id = null;
        }
      }
      return typeof id === 'string' ? id.toLowerCase() : '';
    }

    function dictionary() {
      return activeLocale().startsWith('en') ? en : zh;
    }

    function interpolate(text, values) {
      if (typeof text !== 'string' || values === undefined || values === null) return text;
      return text.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
      ));
    }

    /**
     * Translate one key for the current locale.
     * @param {string} key - dictionary key.
     * @param {object} [values] - `{name}` template values.
     * @returns {string} localized text.
     */
    function t(key, values) {
      let text;
      if (runtimeT !== null) {
        try {
          const translated = runtimeT(key);
          if (typeof translated === 'string' && translated !== key) text = translated;
        } catch (error) {
          text = undefined;
        }
      }
      if (text === undefined) {
        const dict = dictionary();
        text = dict[key] !== undefined ? dict[key] : (zh[key] !== undefined ? zh[key] : key);
      }
      return interpolate(text, values);
    }

    // #endregion

    // #region icons

    /**
     * Inline SVG icon in the shared 24px / 1.6px-stroke language.
     * @param {object} props - `size`, `shapes` ([tag, attrs] pairs).
     * @returns {object} svg element.
     */
    function SvgIcon(props) {
      const size = props.size === undefined ? 16 : props.size;
      const shapes = props.shapes === undefined ? [] : props.shapes;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        className: props.className,
      }, shapes.map((shape, index) => h(shape[0], Object.assign({ key: `s${index}` }, shape[1]))));
    }

    function IconClose(props) {
      return h(SvgIcon, { size: props.size, shapes: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]] });
    }

    function IconCheck(props) {
      return h(SvgIcon, { size: props.size, shapes: [['path', { d: 'M20 6 9 17l-5-5' }]] });
    }

    function IconGear(props) {
      return h(SvgIcon, {
        size: props.size,
        shapes: [
          ['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }],
          ['circle', { cx: 12, cy: 12, r: 3 }],
        ],
      });
    }

    function IconTrash(props) {
      return h(SvgIcon, {
        size: props.size,
        shapes: [
          ['path', { d: 'M3 6h18' }],
          ['path', { d: 'M8 6V4h8v2' }],
          ['path', { d: 'M19 6l-1 14H6L5 6' }],
          ['path', { d: 'M10 11v6' }],
          ['path', { d: 'M14 11v6' }],
        ],
      });
    }

    function IconCopy(props) {
      return h(SvgIcon, {
        size: props.size,
        shapes: [
          ['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }],
          ['path', { d: 'M5 15V5a2 2 0 0 1 2-2h10' }],
        ],
      });
    }

    function IconChevron(props) {
      return h(SvgIcon, {
        size: props.size,
        className: props.className,
        shapes: [['path', { d: 'm6 9 6 6 6-6' }]],
      });
    }

    function IconCloud(props) {
      return h(SvgIcon, {
        size: props.size,
        shapes: [[
          'path',
          { d: 'M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.6 12.7 3.5 3.5 0 0 0 6 19h11.5Z' },
        ]],
      });
    }

    function IconMonitor(props) {
      return h(SvgIcon, {
        size: props.size,
        shapes: [
          ['rect', { x: 2.5, y: 3.5, width: 19, height: 13, rx: 2 }],
          ['path', { d: 'M8.5 20.5h7' }],
          ['path', { d: 'M12 16.5v4' }],
        ],
      });
    }

    // #endregion

    // #region styles

    /* Only theme aliases carry color: light and dark resolve through the same
     * declarations, and every token falls back to its contract sibling rather
     * than to a hard-coded page color. */
    const CSS = String.raw`
.dshc-page {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 22px clamp(16px, 4vw, 48px) 32px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
}
.dshc-page *, .dshc-page *::before, .dshc-page *::after { box-sizing: border-box; }
.dshc-pageContent { max-width: 880px; margin: 0 auto; }
.dshc-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 4px 0 12px;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
}
.dshc-root *, .dshc-overlay * { box-sizing: border-box; }
.dshc-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 2px 0 16px;
}
.dshc-headMain { min-width: 0; flex: 1 1 auto; }
.dshc-title {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary);
}
.dshc-desc {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dshc-primary {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 34px;
  margin-top: 1px;
  padding: 0 14px 0 11px;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-brand-primary-invert, #fff));
  font: inherit;
  font-size: 13.5px;
  line-height: 20px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-primary:hover:not(:disabled) {
    background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));
  }
}
.dshc-primary:disabled { opacity: 0.45; cursor: not-allowed; }
.dshc-primary:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dshc-primary svg { flex: none; }

.dshc-notice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  max-width: 100%;
  margin: 0 0 14px;
  padding: 6px 11px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dshc-notice svg { flex: none; }
.dshc-notice[data-kind="success"] svg { color: var(--dsw-alias-state-success-primary); }
.dshc-notice[data-kind="error"] { color: var(--dsw-alias-state-error-primary); }

.dshc-list {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.dshc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 56px;
  padding: 8px 10px 8px 16px;
}
.dshc-row + .dshc-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.dshc-rowMain {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}
.dshc-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15.5px;
  line-height: 22px;
  font-weight: 500;
  letter-spacing: -0.005em;
  color: var(--dsw-alias-label-primary);
}
.dshc-badge {
  flex: none;
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
  font-weight: 500;
  white-space: nowrap;
}
.dshc-badgeBtn {
  border: none;
  font-family: inherit;
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-badgeBtn:hover {
    background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
    color: var(--dsw-alias-label-primary);
  }
}
.dshc-badgeBtn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dshc-status {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dshc-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
}
.dshc-row[data-online="true"] .dshc-dot { background: var(--dsw-alias-state-success-primary); }
.dshc-rowActions { display: flex; align-items: center; gap: 2px; flex: none; }
.dshc-iconBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-iconBtn:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
    color: var(--dsw-alias-label-primary);
  }
}
.dshc-iconBtn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.dshc-iconBtn:disabled { opacity: 0.45; cursor: not-allowed; }
.dshc-iconBtn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dshc-trash:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.dshc-trash:active:not(:disabled) { color: var(--dsw-alias-state-error-primary); }

.dshc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 44px 24px 46px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
  text-align: center;
}
.dshc-emptyIcon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-bottom: 6px;
  border-radius: 12px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary);
}
.dshc-emptyIcon svg { display: block; }
.dshc-emptyTitle {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dshc-emptyHint {
  max-width: 380px;
  margin: 0;
  font-size: 12.5px;
  line-height: 19px;
  color: var(--dsw-alias-label-secondary);
}

.dshc-skeleton {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.dshc-skeletonRow {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 0 16px;
}
.dshc-skeletonRow + .dshc-skeletonRow { border-top: 1px solid var(--dsw-alias-border-l1); }
.dshc-skeletonBar {
  height: 12px;
  border-radius: 6px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  animation: dshc-pulse 1.5s ease-in-out infinite;
}
.dshc-skeletonBar[data-wide="true"] { width: 34%; }
.dshc-skeletonBar[data-narrow="true"] { width: 18%; margin-left: auto; }

/* Runtime-mode card (PROTOCOL §10.6): this machine joining a hub. */
.dshc-groupTitle {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.dshc-card2 {
  margin-bottom: 18px;
  padding: 15px 16px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshc-card2Head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dshc-card2Title {
  font-size: 12.5px;
  line-height: 18px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--dsw-alias-label-secondary);
}
.dshc-runtimeName {
  margin-top: 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15.5px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dshc-runtimeMeta {
  display: flex;
  gap: 6px;
  min-width: 0;
  margin-top: 2px;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dshc-runtimeMetaKey { flex: none; }
.dshc-runtimeMetaValue {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 18px;
}
.dshc-runtimeActions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 13px;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dshc-switchLabel {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dshc-textBtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 4px 9px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-textBtn:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
    color: var(--dsw-alias-label-primary);
  }
}
.dshc-textBtn:disabled { opacity: 0.45; cursor: not-allowed; }
.dshc-textBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshc-formRow {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin-top: 12px;
}
.dshc-field {
  display: flex;
  flex: 1 1 175px;
  flex-direction: column;
  min-width: 0;
}
.dshc-field .dshc-fieldLabel { margin-bottom: 5px; }
.dshc-formSubmit {
  flex: none;
  height: 36px;
  padding: 0 16px;
  border-radius: 9px;
}
/* v1.7.0: the 接入 card — one address is the whole join flow. */
.dshc-joinHint { margin: 9px 0 0; }
.dshc-joinForm { margin-top: 10px; }
.dshc-joinField { flex: 1 1 260px; }
.dshc-joinToggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
  padding: 2px 0;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.dshc-joinToggle::after { content: '\203A'; margin-left: 1px; }
@media (hover: hover) {
  .dshc-joinToggle:hover { color: var(--dsw-alias-label-primary); }
}
.dshc-joinToggle:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
  border-radius: 6px;
}
.dshc-joinLine {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.dshc-joinText {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dshc-joinAddress {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dshc-joinDisconnect { margin-left: auto; }

/* 已连接的电脑 header: the hub's one copyable join address. */
.dshc-groupHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 0 10px;
}
.dshc-groupHead .dshc-groupTitle { margin: 0; }
.dshc-copyJoinBtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 3px 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-copyJoinBtn:hover {
    border-color: var(--dsw-alias-border-l2);
    background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
    color: var(--dsw-alias-label-primary);
  }
}
.dshc-copyJoinBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshc-copyJoinBtn[data-copied="true"] { color: var(--dsw-alias-state-success-primary); }
.dshc-emptyActions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
}
.dshc-emptyCli { margin-top: 2px; }

/* v1.7.0: everything power users need, behind one muted 「高级」 line. */
.dshc-advanced { margin-top: 2px; }
.dshc-advancedToggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 0;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-advancedToggle:hover { color: var(--dsw-alias-label-primary); }
}
.dshc-advancedToggle:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
  border-radius: 6px;
}
.dshc-advancedChevron {
  flex: none;
  opacity: 0.75;
  transition: transform 120ms ease;
}
.dshc-advancedToggle[aria-expanded="true"] .dshc-advancedChevron { transform: rotate(180deg); }
.dshc-advancedTitle { flex: none; }
.dshc-advancedHint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.85;
}
.dshc-advancedBody { margin-top: 10px; }

/* Account center (PROTOCOL account): the 接入 card's two modes, the signed-in
 * line and its read-only device list, plus the 高级 create form. */
.dshc-accountModes { margin-bottom: 11px; }
.dshc-accountHint { margin: 9px 0 0; }
.dshc-accountForm .dshc-field { flex: 1 1 150px; }
.dshc-accountForm .dshc-accountKeyField { flex: 1 1 220px; }
.dshc-accountForm .dshc-accountRelayField { flex: 1 1 220px; }
.dshc-accountRelayHint { margin: 7px 0 0; }
/* v1.9.1: the account key is the only credential field; the shape hint is
 * advisory (the host still receives whatever was pasted). */
.dshc-accountKeyShapeHint { margin: 7px 0 0; color: var(--dsw-alias-state-warn-primary); }
.dshc-accountLine {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.dshc-accountLine--spaced { margin-top: 10px; }
.dshc-accountText {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.dshc-accountId {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshc-accountCount {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
/* The account id under the key: small, secondary, never the headline. */
.dshc-accountSecondary {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
}
.dshc-accountSecondary .dshc-accountId { color: var(--dsw-alias-label-secondary); }
.dshc-accountLogout { margin-left: auto; }
.dshc-deviceList {
  display: flex;
  flex-direction: column;
  margin-top: 11px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dshc-deviceListHead {
  padding: 9px 2px 3px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
  font-weight: 500;
}
.dshc-deviceRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 7px 2px;
}
/* One wrapper per device: the row plus its inline 被控 error line. */
.dshc-deviceRowWrap { display: flex; flex-direction: column; min-width: 0; }
.dshc-deviceRowWrap + .dshc-deviceRowWrap { border-top: 1px solid var(--dsw-alias-border-l1); }
.dshc-deviceControl {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
}
.dshc-deviceControllable {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
  white-space: nowrap;
}
.dshc-deviceControllable[data-on="false"] { color: var(--dsw-alias-state-warn-primary); }
.dshc-deviceError {
  margin: 0 0 7px 14px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 11.5px;
  line-height: 16px;
  overflow-wrap: anywhere;
}
.dshc-deviceDot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
}
.dshc-deviceDot[data-online="true"] { background: var(--dsw-alias-state-success-primary); }
.dshc-deviceName {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 19px;
}
.dshc-devicePlatform,
.dshc-deviceState {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
}
.dshc-deviceRow[data-online="true"] .dshc-deviceState { color: var(--dsw-alias-state-success-primary); }
.dshc-deviceThis {
  flex: none;
  padding: 0 5px;
  border-radius: 5px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  line-height: 15px;
  font-weight: 500;
}
.dshc-accountCenterHint { margin: 9px 0 0; }
.dshc-accountCreateBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  margin-top: 10px;
  padding: 0 13px;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-brand-primary-invert, #fff));
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-accountCreateBtn:hover {
    background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));
  }
}
.dshc-accountCreateBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshc-accountCreateCancel { margin-top: 9px; }
.dshc-accountCreated {
  margin: 0 0 2px;
  color: var(--dsw-alias-state-success-primary);
  font-size: 13px;
  line-height: 19px;
  font-weight: 500;
}
.dshc-accountCredentials .dshc-copyStack { margin-top: 9px; }
/* v1.9.1: the key is always available, so the "shown once" box is gone. This
 * is the one-line warning that the key is a credential. */
.dshc-accountWarning {
  margin: 9px 0 0;
  color: var(--dsw-alias-state-warn-primary);
  font-size: 11.5px;
  line-height: 17px;
  overflow-wrap: anywhere;
}
/* Create success only: the key row is highlighted once with the "come back to
 * copy it any time" line. */
.dshc-accountKeyHighlight {
  margin: 9px 0 0;
  padding: 9px 11px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-brand-primary);
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
}
/* A host too old to return the key: the same row shape, muted text, no field. */
.dshc-accountKeyMissingHint { padding-left: 0; }
.dshc-accountCreatedHint { margin: 9px 0 0; }
.dshc-accountCenter { margin-top: 12px; }

.dshc-dot[data-state="running"] { background: var(--dsw-alias-state-success-primary); }
.dshc-dot[data-state="connecting"] { background: var(--dsw-alias-state-warn-primary); }
.dshc-dot[data-state="failed"] { background: var(--dsw-alias-state-error-primary); }

/* Composer target-computer chip + menu (slot conversation.input.left). */
.dshc-targetWrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dshc-target {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 200px;
  height: 28px;
  padding: 0 7px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  cursor: pointer;
}
.dshc-target svg { flex: none; }
@media (hover: hover) {
  .dshc-target:hover {
    background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
    color: var(--dsw-alias-label-primary);
  }
}
.dshc-target[data-open="true"] {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}
.dshc-target:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dshc-targetLabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshc-targetChevron { transition: transform 120ms ease; opacity: 0.75; }
.dshc-target[data-open="true"] .dshc-targetChevron { transform: rotate(180deg); }
.dshc-targetError {
  min-width: 0;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-state-error-primary);
  font-size: 11.5px;
  line-height: 16px;
}
.dshc-menu {
  position: fixed;
  z-index: 1200;
  min-width: 240px;
  max-width: min(280px, calc(100vw - 16px));
  padding: 4px;
  overflow-y: auto;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2)));
  box-shadow: var(--dsw-elevation-prominent, 0 16px 40px rgba(0, 0, 0, 0.24));
  color: var(--dsw-alias-label-primary);
}
.dshc-menuItem {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 30px;
  padding: 4px 7px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.dshc-menuItem:disabled { cursor: not-allowed; opacity: 0.45; }
/* Account-device rows stay focusable (aria-disabled) so the row's reason can
 * be read; a click is ignored by the handler. */
.dshc-menuItem[aria-disabled="true"] { cursor: not-allowed; }
.dshc-menuItem[aria-disabled="true"] .dshc-menuName { color: var(--dsw-alias-label-secondary); }
.dshc-menuGroup {
  padding: 6px 7px 2px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 15px;
  font-weight: 500;
}
@media (hover: hover) {
  .dshc-menuItem:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  }
}
.dshc-menuItem:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  outline: none;
}
.dshc-menuItem svg { flex: none; }
.dshc-menuName {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshc-menuItem[data-offline="true"] .dshc-menuName { color: var(--dsw-alias-label-secondary); }
.dshc-menuHint {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
}
.dshc-menuDot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
}
.dshc-menuDot[data-offline="true"] { background: var(--dsw-alias-state-idle-primary); }
.dshc-menuCheck { flex: none; color: var(--dsw-alias-brand-primary); }
.dshc-menuFooter {
  margin: 4px 2px 0;
  padding: 6px 7px 2px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
}

.dshc-errorCard {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshc-errorText {
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}

.dshc-ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
}
.dshc-ghost:disabled { opacity: 0.45; cursor: not-allowed; }
.dshc-ghost:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }

.dshc-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.dshc-mask {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.35));
}
.dshc-card {
  position: relative;
  width: 100%;
  max-width: 560px;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  padding: 24px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  box-shadow: var(--dsw-elevation-prominent, 0 24px 64px rgba(0, 0, 0, 0.28));
  outline: none;
}
.dshc-card[data-size="sm"] { max-width: 420px; }
.dshc-cardHead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}
.dshc-cardTitle {
  margin: 0;
  font-size: 17px;
  line-height: 24px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary);
}
.dshc-cardSub {
  margin: 2px 0 18px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dshc-dialogBody {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.dshc-closeBtn { margin: -4px -6px 0 0; }
.dshc-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
}
.dshc-footerSplit { justify-content: space-between; }

/* Access dialogs (task-12): one row per computer / per Bot preset. */
.dshc-accessList {
  max-height: min(320px, calc(100vh - 280px));
  overflow-y: auto;
  margin: 2px -4px 0;
  padding: 0 4px;
}
.dshc-accessRow {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 6px 0;
}
.dshc-accessRow + .dshc-accessRow { border-top: 1px solid var(--dsw-alias-border-l1); }
.dshc-accessIcon {
  flex: none;
  display: flex;
  color: var(--dsw-alias-label-secondary);
}
.dshc-accessText {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex: 1 1 auto;
}
.dshc-accessName {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dshc-accessHint {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
}
.dshc-accessStatus {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
  white-space: nowrap;
}
.dshc-accessEmpty {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 18px;
}
.dshc-switch:disabled { opacity: 0.6; cursor: not-allowed; }

/* Row capability chips + the amber upgrade chip (task-15). */
.dshc-capChip {
  flex: none;
  padding: 0 5px;
  border-radius: 5px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  line-height: 15px;
  font-weight: 500;
  white-space: nowrap;
}
.dshc-modeHint {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  line-height: 15px;
  white-space: nowrap;
}
.dshc-driftChip {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  border: 1px solid currentColor;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-state-warn-primary);
  font: inherit;
  font-size: 10.5px;
  line-height: 15px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-driftChip:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
}
.dshc-driftChip:focus-visible { outline: 2px solid var(--dsw-alias-state-warn-primary); outline-offset: 1px; }
.dshc-driftHint {
  margin: 8px 0 0;
  color: var(--dsw-alias-state-warn-primary);
  font-size: 11.5px;
  line-height: 16px;
}
.dshc-runtimeDirection {
  margin-top: 2px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
}
.dshc-runtimeAgent {
  margin-top: 2px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
  overflow-wrap: anywhere;
}
.dshc-accessReason {
  margin: 2px 0 4px 25px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
}

/* The connect-modal combobox (task-18). The 本机地址 rows are gone; only the
 * picker's kind labels and dropdown remain. */
.dshc-addrDot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
}
.dshc-addrDot[data-recommended="true"] { background: var(--dsw-alias-state-success-primary); }
.dshc-addrKind {
  flex: none;
  min-width: 44px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
  white-space: nowrap;
}
.dshc-addrComboUrl {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-primary);
  flex: 1 1 auto;
  text-align: left;
}
.dshc-addrBadge {
  flex: none;
  padding: 0 5px;
  border-radius: 5px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  line-height: 15px;
  font-weight: 500;
}
.dshc-addrBadge.dshc-addrUnreachable {
  border: 1px solid currentColor;
  background: transparent;
  color: var(--dsw-alias-state-warn-primary);
}
.dshc-addrOption[disabled] {
  opacity: 0.62;
  cursor: default;
}
@media (hover: hover) {
  .dshc-addrOption[disabled]:hover { background: transparent; }
}
.dshc-addrCombo[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.dshc-addrInlineWarn {
  margin: 6px 0 0;
  color: var(--dsw-alias-state-warn-primary);
  font-size: 11.5px;
  line-height: 16px;
}
.dshc-addrCombo {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-addrCombo:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
}
.dshc-addrCombo:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshc-addrCombo .dshc-targetChevron { margin-left: auto; }
.dshc-addrListbox {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshc-addrOption {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 28px;
  padding: 3px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 17px;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-addrOption:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
}
.dshc-addrOption:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  outline: none;
}
.dshc-addrOption[aria-selected="true"] { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.dshc-addrOption .dshc-addrKind { min-width: 40px; }

/* Relay link (中继): the status line on the 中继 card and the small card that
 * explains the public address. Muted while the link comes up, amber when it
 * failed (the line then carries the actionable hint). */
.dshc-relayLine {
  margin: 6px 0 0;
  font-size: 11.5px;
  line-height: 16px;
  overflow-wrap: anywhere;
}
.dshc-relayLine[data-kind="muted"] { color: var(--dsw-alias-label-secondary); }
.dshc-relayLine[data-kind="failed"] { color: var(--dsw-alias-state-warn-primary); }
.dshc-relayId {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
/* The card inherits .dshc-copyStack / .dshc-hint; scope the spacing so the
 * shared primitives keep their own defaults elsewhere. */
.dshc-relayCard .dshc-relayAddr { margin-top: 10px; }
.dshc-relayCard .dshc-relayUrl { margin-top: 10px; }
.dshc-relayCard .dshc-relayHint { margin-top: 10px; }
/* The address input sits on the same baseline as its action button(s); the
 * upgrade hint carries a long sentence and wraps at the narrow settings
 * column instead of forcing the card wider. */
.dshc-relayForm { align-items: flex-end; }
.dshc-relayFormActions { display: flex; flex: none; gap: 8px; }
.dshc-relayCard .dshc-relayUpgrade { overflow-wrap: anywhere; }

/* Composer menu: the manage-access row replaces the old muted footer. */
.dshc-menuSep {
  height: 1px;
  margin: 4px 4px;
  background: var(--dsw-alias-border-l1);
}
.dshc-menuManage { color: var(--dsw-alias-label-primary); }
.dshc-targetError[data-kind="info"] { color: var(--dsw-alias-label-secondary); }

.dshc-seg {
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 11px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1));
}
.dshc-segBtn {
  flex: 1 1 0;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.dshc-segBtn[data-active="true"] {
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.1),
    inset 0 0 0 0.5px var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
}
@media (hover: hover) {
  .dshc-segBtn[data-active="false"]:hover { color: var(--dsw-alias-label-primary); }
}
.dshc-segBtn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -1px;
}

.dshc-switchRow {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin: 14px 0;
  padding: 11px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
}
.dshc-switchText { min-width: 0; }
.dshc-switchTitle {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dshc-switchHint {
  margin-top: 2px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dshc-switch {
  position: relative;
  flex: none;
  width: 36px;
  height: 20px;
  margin-top: 1px;
  padding: 2px;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-border-l2);
  cursor: pointer;
}
.dshc-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.dshc-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshc-switchThumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-layer-1));
  transition: transform 120ms ease;
}
.dshc-switch[aria-checked="true"] .dshc-switchThumb {
  transform: translateX(16px);
  background: var(--dsw-alias-label-primary-foreground, #fff);
}

.dshc-cmd {
  position: relative;
  padding: 12px 44px 12px 14px;
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1));
}
.dshc-cmdLabel {
  display: block;
  margin-bottom: 5px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.dshc-cmdText {
  display: block;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12.5px;
  line-height: 19px;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.dshc-cmdText[data-placeholder="true"] { color: var(--dsw-alias-label-secondary); }
.dshc-cmdCopy {
  position: absolute;
  top: 7px;
  right: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-cmdCopy:hover:not(:disabled) {
    background: var(--dsw-alias-bg-layer-2);
    color: var(--dsw-alias-label-primary);
  }
}
.dshc-cmdCopy:disabled { opacity: 0.4; cursor: not-allowed; }
.dshc-cmdCopy:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshc-cmdCopy[data-copied="true"] { color: var(--dsw-alias-state-success-primary); }

.dshc-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  padding: 9px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 18px;
}
.dshc-strip svg { flex: none; }
.dshc-stripText { min-width: 0; overflow-wrap: anywhere; }
.dshc-strip[data-state="connected"] { color: var(--dsw-alias-state-success-primary); }
.dshc-strip[data-state="expired"] { color: var(--dsw-alias-state-warn-primary); }
.dshc-strip[data-state="used"] { color: var(--dsw-alias-state-warn-primary); }
.dshc-strip[data-state="error"] { color: var(--dsw-alias-state-error-primary); }
.dshc-stripAction {
  margin-left: auto;
  flex: none;
  padding: 3px 9px;
  border: 1px solid currentColor;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  cursor: pointer;
}
.dshc-stripAction:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }

.dshc-spinner {
  flex: none;
  width: 13px;
  height: 13px;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary);
  border-radius: 50%;
  animation: dshc-spin 0.72s linear infinite;
}
.dshc-fieldLabel {
  display: block;
  margin-bottom: 6px;
  font-size: 12.5px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dshc-input {
  display: block;
  width: 100%;
  height: 36px;
  padding: 0 11px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13.5px;
  line-height: 22px;
}
.dshc-input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -1px;
  border-color: transparent;
}
.dshc-hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dshc-formError {
  margin: 10px 0 0;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}
/* Hub modal: the desktop-path block (address + key for the local runtime card). */
.dshc-details { margin-top: 12px; }
.dshc-detailsSummary {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 18px;
  cursor: pointer;
  list-style: none;
}
.dshc-detailsLabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (hover: hover) {
  .dshc-detailsSummary:hover { color: var(--dsw-alias-label-primary); }
}
.dshc-detailsSummary::-webkit-details-marker { display: none; }
.dshc-detailsSummary::marker { content: ''; }
.dshc-detailsSummary::after {
  content: '\203A';
  display: inline-block;
  margin-left: 4px;
  transition: transform 120ms ease;
}
.dshc-details[open] > .dshc-detailsSummary::after { transform: rotate(90deg); }
.dshc-detailsSummary:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
  border-radius: 6px;
}
.dshc-detailsBody {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.dshc-cliBody {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}
.dshc-cliBody .dshc-switchRow { margin: 0; }
.dshc-copyStack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
}
.dshc-copyRow {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 6px 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1));
}
.dshc-copyRowTop {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dshc-copyRowKey {
  flex: 0 0 auto;
  min-width: 56px;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
}
/* Long label + long command (upgrade dialog): label on its own line, copy
 * pinned to the card's top-right corner. */
.dshc-copyRow--stacked { position: relative; padding-right: 36px; }
.dshc-copyRow--stacked .dshc-copyRowTop { flex-wrap: wrap; }
.dshc-copyRow--stacked .dshc-copyRowBtn { position: absolute; top: 6px; right: 6px; }
.dshc-copyRow--stacked .dshc-copyRowKey {
  flex: 0 0 100%;
  min-width: 0;
  margin-bottom: 2px;
}
.dshc-copyRow--stacked .dshc-copyRowHint { padding-left: 0; }
.dshc-copyRowHint {
  margin: 0;
  padding-left: 64px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
  overflow-wrap: anywhere;
}
.dshc-copyRowValue {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-primary);
}
.dshc-copyRowBtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
@media (hover: hover) {
  .dshc-copyRowBtn:hover:not(:disabled) {
    background: var(--dsw-alias-bg-layer-2);
    color: var(--dsw-alias-label-primary);
  }
}
.dshc-copyRowBtn:disabled { opacity: 0.4; cursor: not-allowed; }
.dshc-copyRowBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshc-copyRowBtn[data-copied="true"] { color: var(--dsw-alias-state-success-primary); }

.dshc-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
@keyframes dshc-spin { to { transform: rotate(360deg); } }
@keyframes dshc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) {
  .dshc-spinner { animation-duration: 2.4s; }
  .dshc-skeletonBar { animation: none; }
  .dshc-switchThumb { transition: none; }
}
@media (max-width: 480px) {
  .dshc-badge, .dshc-capChip, .dshc-modeHint { display: none; }
  .dshc-overlay { padding: 16px; }
  .dshc-card { padding: 20px 16px; border-radius: 14px; }
  .dshc-row { padding-left: 13px; }
  .dshc-formSubmit { flex: 1 1 100%; }
  /* 420px: the joined line stacks instead of pushing 断开 off the edge. */
  .dshc-joinLine { align-items: flex-start; }
  .dshc-joinText { flex: 1 1 100%; }
  .dshc-joinDisconnect { margin-left: 0; }
  .dshc-groupHead { flex-wrap: wrap; }
  .dshc-accountLine { align-items: flex-start; }
  .dshc-accountLogout { margin-left: 0; }
  /* 420px: the 被控 label + switch must not push 在线/离线 off the row. */
  .dshc-devicePlatform { display: none; }
  .dshc-deviceControl { gap: 5px; }
}
@media (prefers-reduced-motion: reduce) {
  .dshc-detailsSummary::after { transition: none; }
}
`;

    let styleRefs = 0;
    let styleElement = null;

    /** Install the bundle stylesheet once; the last unmount removes it. */
    function acquireStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {};
      if (styleElement === null) {
        const existing = typeof document.getElementById === 'function' ? document.getElementById(STYLE_ID) : null;
        if (existing) {
          styleElement = existing;
        } else {
          const tag = document.createElement('style');
          tag.id = STYLE_ID;
          tag.setAttribute('data-plugin', 'dsh-computers');
          tag.textContent = CSS;
          document.head.appendChild(tag);
          styleElement = tag;
        }
      }
      styleRefs += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        styleRefs = Math.max(0, styleRefs - 1);
        if (styleRefs > 0 || styleElement === null) return;
        const node = styleElement;
        styleElement = null;
        try {
          if (node.parentNode) node.parentNode.removeChild(node);
        } catch (error) {
          /* A detached document is not an error worth surfacing. */
        }
      };
    }

    // #endregion

    // #region http

    /**
     * One same-origin JSON request. Failures carry the host's message.
     * @param {string} url - document-relative route.
     * @param {object} [options] - `method`, `body` (JSON), `signal`.
     * @returns {Promise<object|null>} parsed payload.
     */
    async function requestJson(url, options) {
      const init = {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      };
      if (options !== undefined && options !== null) {
        if (options.method) init.method = options.method;
        if (options.signal) init.signal = options.signal;
        if (options.body !== undefined) {
          init.headers['content-type'] = 'application/json; charset=utf-8';
          init.body = JSON.stringify(options.body);
        }
      }
      let response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        throw new Error(t('error.network'));
      }
      let raw = '';
      try {
        raw = await response.text();
      } catch (error) {
        raw = '';
      }
      let payload = null;
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch (error) {
          payload = null;
        }
      }
      if (!response.ok) {
        const code = payload && typeof payload.error === 'string' ? payload.error : null;
        const message = payload && typeof payload.message === 'string' && payload.message
          ? payload.message
          : (code || t('error.http', { status: response.status }));
        const failure = new Error(message);
        failure.status = response.status;
        failure.code = code;
        throw failure;
      }
      if (payload === null && raw) throw new Error(t('error.badResponse'));
      return payload;
    }

    const api = {
      readState: (signal) => requestJson(API.state, { signal }),
      createKey: (os, replace, signal) => requestJson(API.keys, {
        method: 'POST',
        body: { os, replace, label: null },
        signal,
      }),
      readKeyStatus: (key, signal) => requestJson(`${API.keyStatus}?key=${encodeURIComponent(key)}`, { signal }),
      rename: (id, name, signal) => requestJson(API.rename, { method: 'POST', body: { id, name }, signal }),
      remove: (id, signal) => requestJson(API.remove, { method: 'POST', body: { id }, signal }),
      readRuntime: (signal) => requestJson(API.runtime, { signal }),
      /* One address (`{ serverUrl: '<url>#join=<token>' }`, handed over
       * verbatim) or the legacy pair (`{ serverUrl, key }`). */
      runtimeConnect: (payload, signal) => requestJson(API.runtimeConnect, {
        method: 'POST',
        body: payload,
        signal,
      }),
      runtimeEnable: (enabled, signal) => requestJson(API.runtimeEnable, {
        method: 'POST',
        body: { enabled },
        signal,
      }),
      runtimeDisconnect: (signal) => requestJson(API.runtimeDisconnect, { method: 'POST', body: {}, signal }),
      /* The 中继 card's whole setup path: `{ enabled }` flips the switch,
       * `{ url }` persists a UI override (and re-dials), and
       * `{ enabled: true, url }` is the one-click first setup. */
      relayEnable: (payload, signal) => requestJson(API.relayEnable, {
        method: 'POST',
        body: payload,
        signal,
      }),
      /* Account center (PROTOCOL account). The GET is the source of truth; the
       * POSTs answer with the same shape so the UI reconciles without a poll. */
      readAccount: (signal) => requestJson(API.account, { signal }),
      createAccount: (payload, signal) => requestJson(API.accountCreate, {
        method: 'POST',
        body: payload,
        signal,
      }),
      loginAccount: (payload, signal) => requestJson(API.accountLogin, {
        method: 'POST',
        body: payload,
        signal,
      }),
      logoutAccount: (signal) => requestJson(API.accountLogout, { method: 'POST', body: {}, signal }),
      discoverAccount: (signal) => requestJson(API.accountDiscover, { signal }),
      /* `{ enabled }` toggles this machine's own 被控 flag; the host answers
       * with the account status (same shape as GET /account). */
      setControllable: (enabled, signal) => requestJson(API.accountControllable, {
        method: 'POST',
        body: { enabled: enabled === true },
        signal,
      }),
      readSelection: (sessionId, signal) => requestJson(
        `${API.selection}?sessionId=${encodeURIComponent(sessionId)}`,
        { signal },
      ),
      selectTarget: (sessionId, computerId, signal) => requestJson(API.selection, {
        method: 'POST',
        body: { sessionId, computerId },
        signal,
      }),
      readAccess: (sessionId, signal) => requestJson(
        `${API.access}?sessionId=${encodeURIComponent(sessionId)}`,
        { signal },
      ),
      setAccess: (sessionId, allowedComputers, signal) => requestJson(API.access, {
        method: 'POST',
        body: { sessionId, allowedComputers },
        signal,
      }),
      readComputerAccess: (computerId, signal) => requestJson(
        `${API.accessComputer}?computerId=${encodeURIComponent(computerId)}`,
        { signal },
      ),
      setComputerAccess: (computerId, allowedPresets, signal) => requestJson(API.accessComputer, {
        method: 'POST',
        body: { computerId, allowedPresets },
        signal,
      }),
    };

    /* Address kind ids → localized labels (task-17 serverUrls[].kind). */
    const ADDRESS_KIND_KEYS = {
      public: 'addr.kind.public',
      forwarded: 'addr.kind.forwarded',
      host: 'addr.kind.host',
      tailscale: 'addr.kind.tailscale',
      lan: 'addr.kind.lan',
      mdns: 'addr.kind.mdns',
      loopback: 'addr.kind.loopback',
      tunnel: 'addr.kind.tunnel',
      relay: 'addr.kind.relay',
    };

    /** @param {string} kind - serverUrls[].kind. @returns {string} short label. */
    function addressKindLabel(kind) {
      const key = ADDRESS_KIND_KEYS[kind];
      return key === undefined ? t('addr.kind.other') : t(key);
    }

    /**
     * Whether another machine can actually reach this candidate.
     * Old hosts send no flag; treat a missing flag as reachable.
     * @param {object} entry - serverUrls[] item.
     * @returns {boolean} reachable.
     */
    function isReachableAddress(entry) {
      return !(entry === null || typeof entry !== 'object' || entry.reachable === false);
    }

    /**
     * Order candidates for display: a reachable recommended one first, other
     * reachable ones next, unreachable ones after them, loopback last.
     * @param {Array} urls - serverUrls.
     * @returns {Array} display order.
     */
    function orderServerUrls(urls) {
      const rank = (entry) => {
        if (entry === null || typeof entry !== 'object') return 50;
        if (!isReachableAddress(entry)) return entry.kind === 'loopback' ? 95 : 80;
        if (entry.kind === 'loopback') return 90;
        if (entry.recommended === true) return 0;
        return 10;
      };
      return urls
        .filter((entry) => entry && typeof entry.url === 'string' && entry.url !== '')
        .slice()
        .sort((a, b) => rank(a) - rank(b));
    }

    /**
     * The address that should be copied/used: the recommended reachable one,
     * else any reachable one, else the first candidate. A relay candidate only
     * becomes the address to hand out once its link is up — the host sets
     * `recommended` exactly then — so while it connects it stays informational
     * and the local candidates keep the preference.
     * @param {Array} urls - serverUrls.
     * @returns {string} url or ''.
     */
    function preferredServerUrl(urls) {
      const ordered = orderServerUrls(urls);
      const reachable = ordered.filter((entry) => isReachableAddress(entry));
      const usable = reachable.find((entry) => entry.kind !== 'relay' || entry.recommended === true);
      if (usable !== undefined) return usable.url;
      if (reachable.length > 0) return reachable[0].url;
      return ordered.length > 0 ? ordered[0].url : '';
    }

    /* Relay link states the host reports in `state.relay.state` (PROTOCOL
     * relay): the browser only needs "up", "coming up" or "broken". */
    const RELAY_PHASES = ['disabled', 'idle', 'connecting', 'connected', 'failed'];

    /**
     * Which relay state the payload describes, tolerating older hosts that
     * only send the flags. Anything unknown reads as "not connected".
     * @param {object|null} relay - `state.relay`.
     * @returns {string} 'disabled' | 'idle' | 'connecting' | 'connected' | 'failed'.
     */
    function relayPhaseOf(relay) {
      if (relay === null || typeof relay !== 'object') return 'disabled';
      if (typeof relay.state === 'string' && RELAY_PHASES.includes(relay.state)) return relay.state;
      if (relay.enabled !== true) return 'disabled';
      if (relay.lastError) return 'failed';
      return relay.connectedAt ? 'connected' : 'connecting';
    }

    /**
     * The relay error text, never empty (the amber line needs a message).
     * @param {object|null} relay - `state.relay`.
     * @returns {string} last error or a localized fallback.
     */
    function relayMessageOf(relay) {
      const error = relay !== null && typeof relay === 'object' && typeof relay.lastError === 'string'
        ? relay.lastError.trim()
        : '';
      return error === '' ? t('relay.unknownError') : error;
    }

    /**
     * Whether the connect modal may hand this candidate out. A relay
     * candidate is always selectable: its URL is stable and the link may
     * still be coming up, so the user can copy the address ahead of time.
     * @param {object} entry - serverUrls[] item.
     * @returns {boolean} selectable.
     */
    function isSelectableAddress(entry) {
      if (isReachableAddress(entry)) return true;
      return entry !== null && typeof entry === 'object' && entry.kind === 'relay';
    }

    /* Capability ids → localized chip labels; unknown ids render raw. */
    const CAPABILITY_KEYS = { exec: 'cap.exec', fs: 'cap.fs', jobs: 'cap.jobs', pty: 'cap.pty' };

    /* R2: user-facing chips, in a stable order. `tunnel` is deliberately not
     * a chip (it is relay plumbing, not something the machine can do). */
    const CAPABILITY_CHIPS = [
      { id: 'exec', label: 'cap.exec', title: 'cap.exec.title' },
      { id: 'fs', label: 'cap.fs', title: 'cap.fs.title' },
      { id: 'jobs', label: 'cap.jobs', title: 'cap.jobs.title' },
      { id: 'pty', label: 'cap.pty', title: 'cap.pty.title' },
    ];

    /** @param {string} capability - capability id. @returns {string} chip text. */
    function capabilityLabel(capability) {
      const key = CAPABILITY_KEYS[capability];
      return key === undefined ? String(capability) : t(key);
    }

    /**
     * Derive the capability chips for a computer (or a runtime status).
     * Prefers the host's boolean `caps` (R2); older hosts only send the
     * legacy `capabilities` id array, so that stays as the fallback.
     * @param {object|null} source - computer or runtime status.
     * @returns {Array<{id: string, label: string, title: string|null}>} chips.
     */
    function derivedCapabilityChips(source) {
      const caps = source !== null && typeof source === 'object' ? source.caps : null;
      if (caps !== null && typeof caps === 'object') {
        return CAPABILITY_CHIPS
          .filter((chip) => caps[chip.id] === true)
          .map((chip) => ({ id: chip.id, label: t(chip.label), title: t(chip.title) }));
      }
      const legacy = source !== null && typeof source === 'object' && Array.isArray(source.capabilities)
        ? source.capabilities.filter((capability) => typeof capability === 'string' && capability !== '')
        : [];
      return legacy.map((capability) => {
        const meta = CAPABILITY_CHIPS.find((chip) => chip.id === capability);
        return {
          id: capability,
          label: capabilityLabel(capability),
          title: meta === undefined ? null : t(meta.title),
        };
      });
    }

    /* The client root context, kept for the few late-bound services
     * (`layout` is optional: a shell without it still gets every surface). */
    let rootCtx = null;

    /**
     * Switch the central column to the 电脑管理 panel.
     * @returns {boolean} true when the shell accepted the navigation.
     */
    function selectMainPanel() {
      if (rootCtx === null) return false;
      let layout = null;
      try {
        layout = typeof rootCtx.get === 'function' ? rootCtx.get('layout') : null;
      } catch (error) {
        layout = null;
      }
      if (layout === null) {
        try {
          layout = rootCtx.layout === undefined ? null : rootCtx.layout;
        } catch (error) {
          layout = null;
        }
      }
      if (layout === null || typeof layout.selectPanel !== 'function') return false;
      try {
        layout.selectPanel(SECTION_ID);
        return true;
      } catch (error) {
        /* The panel is not registered in this shell (older build). */
        return false;
      }
    }

    /** @param {object|null} data - a /state payload. @returns {string} 'hub' | 'runtime' | 'both'. */
    function roleOf(data) {
      if (data && typeof data.role === 'string' && data.role !== '') return data.role;
      /* A host that predates §10.1 registers no runtime routes: assume hub. */
      return 'hub';
    }

    /** @param {unknown} error - thrown value. @returns {string} user-facing detail. */
    function messageOf(error) {
      if (error && typeof error.message === 'string' && error.message) return error.message;
      return t('error.generic');
    }

    /**
     * Track in-flight requests so unmount can abort them.
     * @returns {{run: Function, abortAll: Function}} request scope.
     */
    function createScope() {
      const controllers = new Set();
      return {
        run(task) {
          let controller = null;
          try {
            if (typeof AbortController === 'function') controller = new AbortController();
          } catch (error) {
            controller = null;
          }
          if (controller !== null) controllers.add(controller);
          const signal = controller === null ? undefined : controller.signal;
          return Promise.resolve()
            .then(() => task(signal))
            .finally(() => {
              if (controller !== null) controllers.delete(controller);
            });
        },
        abortAll() {
          for (const controller of controllers) {
            try {
              controller.abort();
            } catch (error) {
              /* ignore */
            }
          }
          controllers.clear();
        },
      };
    }

    /**
     * Copy text to the clipboard with an execCommand fallback.
     * @param {string} text - text to copy.
     * @returns {Promise<void>} resolves once the copy was issued.
     */
    async function copyText(text) {
      const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (clipboard && typeof clipboard.writeText === 'function') {
        await clipboard.writeText(text);
        return;
      }
      if (typeof document === 'undefined' || !document.body) throw new Error('clipboard-unavailable');
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '0';
      area.style.opacity = '0';
      document.body.appendChild(area);
      try {
        if (typeof area.select === 'function') area.select();
        const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
        if (!ok) throw new Error('clipboard-unavailable');
      } finally {
        document.body.removeChild(area);
      }
    }

    // #endregion

    // #region hooks

    /** Mount the bundle stylesheet for this panel's lifetime. */
    function useStyles() {
      React.useEffect(() => acquireStyles(), []);
    }

    /** Re-render on locale switches and late dictionary registration. */
    function useLocaleRevision() {
      const pair = React.useState(0);
      const setRevision = pair[1];
      React.useEffect(() => {
        if (localeFace === null || typeof localeFace.subscribe !== 'function') return undefined;
        try {
          return localeFace.subscribe(() => setRevision((value) => value + 1));
        } catch (error) {
          return undefined;
        }
      }, []);
    }

    /* Nested Escape owners: the topmost layer consumes Escape before the
     * dialog that contains it (a combobox inside the connect modal). */
    const escapeLayers = [];

    /**
     * Register an Escape handler that wins over the enclosing dialog's.
     * @param {boolean} active - whether this layer currently owns Escape.
     * @param {Function} handler - called on Escape.
     */
    function useEscapeLayer(active, handler) {
      const handlerRef = React.useRef(handler);
      handlerRef.current = handler;
      React.useEffect(() => {
        if (!active) return undefined;
        const entry = { handler: () => handlerRef.current() };
        escapeLayers.push(entry);
        return () => {
          const index = escapeLayers.indexOf(entry);
          if (index >= 0) escapeLayers.splice(index, 1);
        };
      }, [active]);
    }

    const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';

    /**
     * Modal keyboard ownership: Escape closes, Tab cycles inside the card, and
     * focus returns to the control that opened it.
     *
     * The listeners are capture-phase on `document`, and Tab is fully handled
     * here. That matters twice over: the settings shell owns Escape for its own
     * dialog on document bubble, and the dialog itself portals outside the
     * shell's panel element — which is exactly the case where the shell's own
     * Tab trap would otherwise pull focus back into the settings page.
     * @param {object} cardRef - ref to the dialog element.
     * @param {Function} onClose - close callback.
     */
    function useModalLayer(cardRef, onClose) {
      const closeRef = React.useRef(onClose);
      closeRef.current = onClose;
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const doc = document;
        const previous = doc.activeElement;
        const card = cardRef && cardRef.current ? cardRef.current : null;
        let initial = card;
        try {
          if (card && typeof card.querySelector === 'function') {
            initial = card.querySelector('[data-dshc-autofocus]') || card;
          }
        } catch (error) {
          initial = card;
        }
        try {
          if (initial && typeof initial.focus === 'function') initial.focus({ preventScroll: true });
        } catch (error) {
          /* focus is best effort */
        }
        const focusables = () => {
          const items = [];
          if (card === null || typeof card.querySelectorAll !== 'function') return items;
          try {
            const found = card.querySelectorAll(FOCUSABLE);
            for (let index = 0; index < found.length; index += 1) {
              const item = found[index];
              if (item.closest && item.closest('[inert], [hidden]')) continue;
              items.push(item);
            }
          } catch (error) {
            return items;
          }
          return items;
        };
        const onKeyDown = (event) => {
          if (event.defaultPrevented) return;
          if (event.key === 'Escape' && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            const top = escapeLayers.length > 0 ? escapeLayers[escapeLayers.length - 1] : null;
            if (top !== null) {
              top.handler();
              return;
            }
            closeRef.current();
            return;
          }
          if (event.key !== 'Tab') return;
          event.preventDefault();
          event.stopPropagation();
          const items = focusables();
          if (items.length === 0) {
            try {
              if (card && typeof card.focus === 'function') card.focus({ preventScroll: true });
            } catch (error) {
              /* ignore */
            }
            return;
          }
          const active = doc.activeElement;
          const current = items.indexOf(active);
          if (current === -1) {
            (event.shiftKey ? items[items.length - 1] : items[0]).focus();
            return;
          }
          const next = event.shiftKey
            ? (current - 1 + items.length) % items.length
            : (current + 1) % items.length;
          items[next].focus();
        };
        doc.addEventListener('keydown', onKeyDown, true);
        return () => {
          doc.removeEventListener('keydown', onKeyDown, true);
          try {
            if (previous && previous.isConnected && typeof previous.focus === 'function') {
              previous.focus({ preventScroll: true });
            }
          } catch (error) {
            /* ignore */
          }
        };
      }, []);
    }

    /**
     * Give an array of statically known children keys so React never warns
     * about a list rendered from a passed-down `props.children` array.
     * @param {*} children - one child or an array.
     * @returns {Array} children with keys.
     */
    function keyed(children) {
      const list = Array.isArray(children) ? children : (children === undefined || children === null ? [] : [children]);
      return list.map((child, index) => {
        if (child === null || typeof child !== 'object') return child;
        if (child.key !== undefined && child.key !== null) return child;
        if (typeof React.cloneElement !== 'function') return child;
        try {
          return React.cloneElement(child, { key: `dshc-child-${index}` });
        } catch (error) {
          return child;
        }
      });
    }

    // #endregion

    // #region surfaces

    function Spinner() {
      return h('span', { className: 'dshc-spinner', 'aria-hidden': 'true' });
    }

    function Notice(props) {
      return h('div', { className: 'dshc-notice', 'data-kind': props.kind, role: 'status', 'aria-live': 'polite' },
        props.kind === 'success' ? h(IconCheck, { size: 14 }) : null,
        h('span', null, props.text));
    }

    /**
     * Empty 已连接的电脑 list. When the hub publishes a fleet join address
     * (`/state.fleet.joinUrl`) the primary action is copying it — that is the
     * string the user pastes on the other machine. The connect dialog is
     * demoted to the command-line fallback for machines that cannot run DSH.
     * @param {object} props - `joinUrl`, `joinBlocked`, optional `onCliFallback()`.
     * @returns {object} empty card.
     */
    function EmptyState(props) {
      const joinUrl = typeof props.joinUrl === 'string' ? props.joinUrl : '';
      const joinBlocked = props.joinBlocked === true;
      return h('div', { className: 'dshc-empty' },
        h('div', { className: 'dshc-emptyIcon', 'aria-hidden': 'true' }, h(IconMonitor, { size: 20 })),
        h('div', { className: 'dshc-emptyTitle' }, t('empty.title')),
        h('p', { className: 'dshc-emptyHint' }, t('empty.hint')),
        joinUrl !== ''
          ? h('div', { className: 'dshc-emptyActions' }, h(CopyJoinButton, { value: joinUrl }))
          : null,
        joinBlocked
          ? h('p', { className: 'dshc-emptyHint dshc-joinBlocked' }, t('join.blocked'))
          : null,
        typeof props.onCliFallback === 'function'
          ? h('button', {
            type: 'button',
            className: 'dshc-joinToggle dshc-emptyCli',
            onClick: props.onCliFallback,
          }, t('empty.cliAction'))
          : null);
    }

    /**
     * Clipboard state for one value (check feedback for 1.6 s).
     * @param {string} value - text to copy.
     * @returns {{copied: boolean, failed: boolean, copy: Function}} copy state.
     */
    function useCopyText(value) {
      const [copied, setCopied] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const alive = React.useRef(true);
      React.useEffect(() => () => { alive.current = false; }, []);
      const copy = async () => {
        if (typeof value !== 'string' || value === '') return;
        try {
          await copyText(value);
          if (!alive.current) return;
          setCopied(true);
          setFailed(false);
          setTimeout(() => {
            if (alive.current) setCopied(false);
          }, 1600);
        } catch (error) {
          if (alive.current) setFailed(true);
        }
      };
      return { copied, failed, copy };
    }

    /**
     * One copyable value row — the primary content of the connect modal
     * (server URL and enrollment key).
     * @param {object} props - `label`, `value`, optional `hint`.
     * @returns {object} row element.
     */
    function CopyRow(props) {
      const state = useCopyText(props.value);
      const copied = state.copied;
      const failed = state.failed;
      const copy = state.copy;
      const action = t('connect.copyField', { field: props.label });
      return h('div', { className: props.stacked === true ? 'dshc-copyRow dshc-copyRow--stacked' : 'dshc-copyRow' },
        h('div', { className: 'dshc-copyRowTop' },
          h('span', { className: 'dshc-copyRowKey' }, props.label),
          h('span', { className: 'dshc-copyRowValue' }, typeof props.value === 'string' && props.value !== '' ? props.value : '—'),
          h('button', {
            type: 'button',
            className: 'dshc-copyRowBtn',
            'data-copied': copied ? 'true' : 'false',
            'aria-label': action,
            title: copied ? t('connect.copied') : action,
            disabled: typeof props.value !== 'string' || props.value === '',
            onClick: () => { void copy(); },
          }, copied ? h(IconCheck, { size: 13 }) : h(IconCopy, { size: 13 }))),
        props.hint ? h('p', { className: 'dshc-copyRowHint' }, props.hint) : null,
        /* The accessible name stays stable ("copy <field>"); the outcome is
         * announced here, so a screen reader hears the confirmation too. */
        h('span', { className: 'dshc-sr', role: 'status', 'aria-live': 'polite' },
          copied ? t('connect.copied') : (failed ? t('connect.copyFailed') : '')));
    }

    /**
     * 「复制接入地址」 — copies the hub's fleet join URL verbatim (it is the
     * credential the other machine pastes, so nothing is appended or stripped).
     * @param {object} props - `value` (`/state.fleet.joinUrl`).
     * @returns {object} copy button with check feedback.
     */
    function CopyJoinButton(props) {
      const state = useCopyText(props.value);
      const label = state.copied ? t('connect.copied') : t('fleet.copy');
      /* The visible label is the accessible name on purpose: it changes to
       * 已复制, so the copy is announced without a second hidden status. */
      return h('button', {
        type: 'button',
        className: 'dshc-copyJoinBtn',
        'data-copied': state.copied ? 'true' : 'false',
        title: label,
        onClick: () => { void state.copy(); },
      },
      state.copied ? h(IconCheck, { size: 13 }) : h(IconCopy, { size: 13 }),
      h('span', null, label));
    }

    /**
     * 「高级」 disclosure at the bottom of the page: exactly the two hub-side
     * surfaces live inside it — the 中继 card and the 账号中心 card — collapsed
     * by default behind one muted summary line.
     * @param {object} props - `children` (the relay + account cards).
     * @returns {object} disclosure element.
     */
    function AdvancedSection(props) {
      const [open, setOpen] = React.useState(false);
      return h('div', { className: 'dshc-advanced' },
        h('button', {
          type: 'button',
          className: 'dshc-advancedToggle',
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': 'dshc-advanced-body',
          onClick: () => setOpen((value) => !value),
        },
          h(IconChevron, { size: 13, className: 'dshc-advancedChevron' }),
          h('span', { className: 'dshc-advancedTitle' }, t('advanced.title')),
          open ? null : h('span', { className: 'dshc-advancedHint' }, t('advanced.summary'))),
        open
          ? h('div', { id: 'dshc-advanced-body', className: 'dshc-advancedBody' }, props.children)
          : null);
    }

    function Skeleton() {
      return h('div', { className: 'dshc-skeleton', 'aria-hidden': 'true' },
        h('div', { className: 'dshc-skeletonRow' },
          h('span', { className: 'dshc-skeletonBar', 'data-wide': 'true' }),
          h('span', { className: 'dshc-skeletonBar', 'data-narrow': 'true' })),
        h('div', { className: 'dshc-skeletonRow', key: 'second' },
          h('span', { className: 'dshc-skeletonBar', 'data-wide': 'true' }),
          h('span', { className: 'dshc-skeletonBar', 'data-narrow': 'true' })));
    }

    function ComputerRow(props) {
      const computer = props.computer;
      const online = computer.online === true;
      const bots = props.counts
        || (computer.bots && typeof computer.bots === 'object' ? computer.bots : null);
      const used = bots && typeof bots.used === 'number' ? bots.used : 1;
      const total = bots && typeof bots.total === 'number' ? bots.total : 1;
      const name = typeof computer.name === 'string' && computer.name !== ''
        ? computer.name
        : (typeof computer.hostname === 'string' ? computer.hostname : '');
      const capabilities = derivedCapabilityChips(computer);
      /* How this machine is connected decides the upgrade path (v1.3.2). */
      const modeLabel = computer.mode === 'embedded'
        ? t('mode.embedded')
        : (computer.mode === 'service' ? t('mode.service') : null);
      const drift = computer.updateRequired === true || computer.drift === true;
      return h('div', { className: 'dshc-row', 'data-online': online ? 'true' : 'false' },
        h('div', { className: 'dshc-rowMain' },
          h('span', { className: 'dshc-name', title: name }, name),
          h('button', {
            type: 'button',
            className: 'dshc-badge dshc-badgeBtn',
            'aria-label': t('access.badgeAria', { name }),
            title: t('access.badgeAria', { name }),
            onClick: () => props.onAccess(computer),
          }, t('badge.bots', { used, total })),
          capabilities.map((capability) => h('span', {
            key: `cap-${capability.id}`,
            className: 'dshc-capChip',
            title: capability.title === null ? undefined : capability.title,
          }, capability.label)),
          modeLabel !== null
            ? h('span', { key: 'mode', className: 'dshc-modeHint' }, modeLabel)
            : null,
          drift
            ? h('button', {
              key: 'drift',
              type: 'button',
              className: 'dshc-driftChip',
              'aria-label': t('drift.title'),
              title: t('drift.title'),
              onClick: () => props.onUpgrade(computer),
            }, t('drift.chip'))
            : null),
        h('span', { className: 'dshc-status' },
          h('span', { className: 'dshc-dot', 'aria-hidden': 'true' }),
          online ? t('online') : t('offline')),
        h('div', { className: 'dshc-rowActions' },
          h('button', {
            type: 'button',
            className: 'dshc-iconBtn',
            'aria-label': t('rename.action'),
            title: t('rename.action'),
            onClick: () => props.onRename(computer),
          }, h(IconGear, { size: 16 })),
          h('button', {
            type: 'button',
            className: 'dshc-iconBtn dshc-trash',
            'aria-label': t('delete.action'),
            title: t('delete.action'),
            onClick: () => props.onDelete(computer),
          }, h(IconTrash, { size: 16 }))));
    }

    /**
     * Portal a dialog layer to <body> when react-dom is available.
     * @param {object} node - dialog element.
     * @returns {object} element to render.
     */
    function renderLayer(node) {
      if (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined' && document.body) {
        try {
          return ReactDOM.createPortal(node, document.body);
        } catch (error) {
          return node;
        }
      }
      return node;
    }

    /**
     * Shared dialog chrome: mask, centered card, close button, footer.
     * @param {object} props - `title`, `subtitle`, `onClose`, `footer`, `size`, `children`.
     * @returns {object} dialog layer.
     */
    function Dialog(props) {
      const cardRef = React.useRef(null);
      useModalLayer(cardRef, props.onClose);
      const children = keyed(props.children);
      const footer = keyed(props.footer);
      return renderLayer(h('div', { className: 'dshc-overlay' },
        h('div', { className: 'dshc-mask', 'aria-hidden': 'true', onClick: props.onClose }),
        h('div', {
          ref: cardRef,
          className: 'dshc-card',
          'data-size': props.size === 'sm' ? 'sm' : undefined,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': props.title,
          tabIndex: -1,
          onClick: (event) => event.stopPropagation(),
        },
        h('div', { className: 'dshc-cardHead' },
          h('h2', { className: 'dshc-cardTitle' }, props.title),
          h('button', {
            type: 'button',
            className: 'dshc-iconBtn dshc-closeBtn',
            'aria-label': t('dialog.close'),
            onClick: props.onClose,
          }, h(IconClose, { size: 16 }))),
        props.subtitle ? h('p', { className: 'dshc-cardSub' }, props.subtitle) : null,
        h('div', null, children),
        footer.length > 0
          ? h('div', { className: props.footerClassName ? `dshc-footer ${props.footerClassName}` : 'dshc-footer' }, footer)
          : null)));
    }

    function RenameDialog(props) {
      const computer = props.computer;
      const [value, setValue] = React.useState(typeof computer.name === 'string' ? computer.name : '');
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const scope = React.useRef(null);
      if (scope.current === null) scope.current = createScope();
      React.useEffect(() => () => scope.current.abortAll(), []);

      const submit = async () => {
        const name = value.trim();
        if (name === '' || busy) return;
        setBusy(true);
        setFailure(null);
        try {
          const result = await scope.current.run((signal) => api.rename(computer.id, name, signal));
          props.onRenamed(result && typeof result.name === 'string' ? result.name : name);
        } catch (error) {
          if (error && error.name === 'AbortError') return;
          setFailure(messageOf(error));
          setBusy(false);
        }
      };

      return h(Dialog, {
        title: t('rename.title'),
        size: 'sm',
        onClose: () => { if (!busy) props.onClose(); },
        footer: [
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dshc-ghost',
            disabled: busy,
            onClick: props.onClose,
          }, t('cancel')),
          h('button', {
            key: 'save',
            type: 'button',
            className: 'dshc-primary',
            disabled: busy || value.trim() === '',
            onClick: () => { void submit(); },
          }, busy ? t('saving') : t('save')),
        ],
      },
      h('label', { className: 'dshc-fieldLabel', htmlFor: 'dshc-rename-input' }, t('rename.field')),
      h('input', {
        id: 'dshc-rename-input',
        className: 'dshc-input',
        'data-dshc-autofocus': '',
        type: 'text',
        value,
        maxLength: 64,
        placeholder: t('rename.placeholder'),
        disabled: busy,
        onChange: (event) => setValue(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
        },
      }),
      h('p', { className: 'dshc-hint' }, t('rename.hint')),
      failure !== null ? h('p', { className: 'dshc-formError', role: 'alert' }, t('rename.failed', { message: failure })) : null);
    }

    function DeleteDialog(props) {
      const computer = props.computer;
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const scope = React.useRef(null);
      if (scope.current === null) scope.current = createScope();
      React.useEffect(() => () => scope.current.abortAll(), []);

      const confirm = async () => {
        if (busy) return;
        setBusy(true);
        setFailure(null);
        try {
          await scope.current.run((signal) => api.remove(computer.id, signal));
          props.onDeleted(computer.name || '');
        } catch (error) {
          if (error && error.name === 'AbortError') return;
          setFailure(messageOf(error));
          setBusy(false);
        }
      };

      return h(Dialog, {
        title: t('delete.title'),
        size: 'sm',
        onClose: () => { if (!busy) props.onClose(); },
        footer: [
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dshc-ghost',
            disabled: busy,
            onClick: props.onClose,
          }, t('cancel')),
          h('button', {
            key: 'delete',
            type: 'button',
            className: 'dshc-primary',
            disabled: busy,
            onClick: () => { void confirm(); },
          }, busy ? t('deleting') : t('delete.confirm')),
        ],
      },
      h('p', { className: 'dshc-dialogBody' }, t('delete.body', { name: computer.name || '' })),
      failure !== null ? h('p', { className: 'dshc-formError', role: 'alert' }, t('delete.failed', { message: failure })) : null);
    }

    /**
     * The connect-computer modal: mint a key, show the installer, poll until the
     * machine appears (PROTOCOL §4.2–§4.3).
     * @param {object} props - `serverUrl`, `onClose`, `onConnected(computer|null)`.
     * @returns {object} dialog layer.
     */
    function ConnectModal(props) {
      const [os, setOs] = React.useState('macos');
      const [replace, setReplace] = React.useState(false);
      const [nonce, setNonce] = React.useState(0);
      const [keyInfo, setKeyInfo] = React.useState(null);
      const [creating, setCreating] = React.useState(true);
      const [createFailure, setCreateFailure] = React.useState(null);
      const [status, setStatus] = React.useState('waiting');
      const [copied, setCopied] = React.useState(false);
      const [copyFailure, setCopyFailure] = React.useState(false);
      const alive = React.useRef(true);
      const message = React.useRef(props.onConnected);
      message.current = props.onConnected;

      React.useEffect(() => () => { alive.current = false; }, []);

      /* One key per (os, replace, regenerate). A newer request supersedes the
       * older one; the switcher aborts the in-flight request entirely. */
      React.useEffect(() => {
        let cancelled = false;
        let controller = null;
        try {
          if (typeof AbortController === 'function') controller = new AbortController();
        } catch (error) {
          controller = null;
        }
        setCreating(true);
        setCreateFailure(null);
        setKeyInfo(null);
        setCopied(false);
        setCopyFailure(false);
        setStatus('waiting');
        api.createKey(os, replace, controller === null ? undefined : controller.signal)
          .then((info) => {
            if (cancelled || !alive.current) return;
            if (!info || typeof info.key !== 'string') {
              setCreating(false);
              setCreateFailure(t('error.badResponse'));
              return;
            }
            setKeyInfo(info);
            setCreating(false);
          })
          .catch((error) => {
            if (cancelled || !alive.current) return;
            if (error && error.name === 'AbortError') return;
            setCreating(false);
            setCreateFailure(messageOf(error));
          });
        return () => {
          cancelled = true;
          if (controller !== null) {
            try {
              controller.abort();
            } catch (error) {
              /* ignore */
            }
          }
        };
      }, [os, replace, nonce]);

      /* Poll the minted key every 2 s until connected / expired / used. */
      React.useEffect(() => {
        if (keyInfo === null || typeof keyInfo.key !== 'string') return undefined;
        const key = keyInfo.key;
        let cancelled = false;
        let timer = null;
        let controller = null;
        const tick = async () => {
          timer = null;
          try {
            if (typeof AbortController === 'function') controller = new AbortController();
          } catch (error) {
            controller = null;
          }
          try {
            const result = await api.readKeyStatus(key, controller === null ? undefined : controller.signal);
            if (cancelled || !alive.current) return;
            controller = null;
            const next = result && typeof result.status === 'string' ? result.status : 'unknown';
            if (next === 'connected') {
              setStatus('connected');
              message.current(result && result.computer ? result.computer : null);
              return;
            }
            if (next === 'expired' || next === 'used' || next === 'unknown') {
              setStatus(next);
              return;
            }
            timer = setTimeout(() => { void tick(); }, KEY_POLL_MS);
          } catch (error) {
            if (cancelled || !alive.current) return;
            controller = null;
            if (error && error.name === 'AbortError') return;
            timer = setTimeout(() => { void tick(); }, KEY_POLL_MS * 2);
          }
        };
        timer = setTimeout(() => { void tick(); }, 900);
        return () => {
          cancelled = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          if (controller !== null) {
            try {
              controller.abort();
            } catch (error) {
              /* ignore */
            }
          }
        };
      }, [keyInfo]);

      /* /keys carries the candidates it minted against; the live /state may
       * already know a relay candidate the key does not (the link can come up
       * after the key). Merge that in so the dropdown always matches /state
       * and the relay stays selectable. */
      const stateCandidates = Array.isArray(props.serverUrls) ? props.serverUrls : [];
      const mintedCandidates = Array.isArray(keyInfo && keyInfo.serverUrls)
        ? keyInfo.serverUrls.slice()
        : stateCandidates.slice();
      for (const entry of stateCandidates) {
        if (entry === null || typeof entry !== 'object' || entry.kind !== 'relay') continue;
        if (!mintedCandidates.some((candidate) => candidate && candidate.url === entry.url)) {
          mintedCandidates.push(entry);
        }
      }
      const allCandidates = orderServerUrls(mintedCandidates);
      /* Every candidate stays visible so the list matches the settings block,
       * but the picker only lets a reachable one be chosen, and the command
       * base prefers the recommended reachable address. */
      const urlCandidates = allCandidates;
      const baseServerUrl = keyInfo && typeof keyInfo.serverUrl === 'string' ? keyInfo.serverUrl : '';
      const [selectedUrl, setSelectedUrl] = React.useState('');
      React.useEffect(() => {
        const preferred = preferredServerUrl(urlCandidates);
        setSelectedUrl(preferred !== '' ? preferred : baseServerUrl);
      }, [keyInfo]);

      const rawCommand = keyInfo === null
        ? ''
        : (os === 'windows'
          ? (typeof keyInfo.windowsCommand === 'string' ? keyInfo.windowsCommand : '')
          : (typeof keyInfo.command === 'string' ? keyInfo.command : ''));
      /* /keys mints the command for the recommended address; switching the
       * candidate rewrites that base in the string we already have. */
      const command = (typeof rawCommand === 'string' && rawCommand !== '' && baseServerUrl !== ''
        && selectedUrl !== '' && selectedUrl !== baseServerUrl)
        ? rawCommand.split(baseServerUrl).join(selectedUrl)
        : (typeof rawCommand === 'string' ? rawCommand : '');

      const copy = async () => {
        if (command === '') return;
        try {
          await copyText(command);
          if (!alive.current) return;
          setCopied(true);
          setCopyFailure(false);
          setTimeout(() => {
            if (alive.current) setCopied(false);
          }, 1600);
        } catch (error) {
          if (!alive.current) return;
          setCopyFailure(true);
        }
      };

      const regenerate = () => {
        setCopyFailure(false);
        setNonce((value) => value + 1);
      };

      let stripText;
      let stripState = status;
      if (createFailure !== null) {
        stripText = t('connect.createFailed', { message: createFailure });
        stripState = 'error';
      } else if (creating) {
        stripText = t('connect.creating');
        stripState = 'waiting';
      } else if (status === 'connected') stripText = t('connect.connected');
      else if (status === 'expired') stripText = t('connect.expired');
      else if (status === 'used') stripText = t('connect.used');
      else if (status === 'unknown') stripText = t('connect.unknown');
      else stripText = t('connect.waiting');
      const canRegenerate = !creating
        && (status === 'expired' || status === 'used' || status === 'unknown' || createFailure !== null);

      const osOptions = [
        { id: 'windows', label: t('connect.os.windows') },
        { id: 'macos', label: t('connect.os.macos') },
        { id: 'linux', label: t('connect.os.linux') },
      ];

      const primaryServerUrl = selectedUrl !== ''
        ? selectedUrl
        : (keyInfo && typeof keyInfo.serverUrl === 'string' && keyInfo.serverUrl !== ''
          ? keyInfo.serverUrl
          : (typeof props.serverUrl === 'string' ? props.serverUrl : ''));
      const primaryKey = keyInfo && typeof keyInfo.key === 'string' ? keyInfo.key : '';

      return h(Dialog, {
        title: t('connect.title'),
        subtitle: t('connect.subtitle'),
        onClose: props.onClose,
        footer: [
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dshc-ghost',
            onClick: props.onClose,
          }, t('cancel')),
        ],
      },
      /* The demoted key path: this dialog and the 接入 card's 「用加入密钥」
       * hand over the same server URL + one-time key pair. */
      h('div', { className: 'dshc-copyStack' },
        urlCandidates.length > 1
          ? h(AddressPicker, {
            key: 'server',
            urls: urlCandidates,
            value: primaryServerUrl,
            loopbackOnly: (keyInfo && keyInfo.loopbackOnly === true) || props.loopbackOnly === true,
            onChange: (url) => setSelectedUrl(url),
          })
          : h(CopyRow, {
            key: 'server',
            label: t('connect.serverUrl'),
            hint: t('connect.serverUrlHint'),
            value: primaryServerUrl,
          }),
        h(CopyRow, {
          key: 'key',
          label: t('connect.enrollmentKey'),
          hint: t('connect.enrollmentKeyHint'),
          value: primaryKey,
        })),
      /* Waiting / connected / expired — the 2 s key-status poll drives it. */
      h('div', { className: 'dshc-strip', 'data-state': stripState, role: 'status', 'aria-live': 'polite' },
        stripState === 'waiting' ? h(Spinner) : null,
        stripState === 'connected' ? h(IconCheck, { size: 14 }) : null,
        h('span', { className: 'dshc-stripText' }, stripText),
        canRegenerate
          ? h('button', { type: 'button', className: 'dshc-stripAction', onClick: regenerate }, t('connect.regenerate'))
          : null),
      /* SECONDARY: machines without DSH — the terminal one-liner, collapsed. */
      h('details', { className: 'dshc-details' },
        h('summary', { className: 'dshc-detailsSummary' },
          h('span', { className: 'dshc-detailsLabel' }, t('connect.cliToggle'))),
        h('div', { className: 'dshc-cliBody' },
          h('p', { className: 'dshc-hint', style: { margin: '0' } }, t('connect.cliHint')),
          h('div', { className: 'dshc-seg', role: 'group', 'aria-label': t('connect.osGroup') },
            osOptions.map((option) => h('button', {
              key: option.id,
              type: 'button',
              className: 'dshc-segBtn',
              'data-active': option.id === os ? 'true' : 'false',
              'aria-pressed': option.id === os ? 'true' : 'false',
              onClick: () => setOs(option.id),
            }, option.label))),
          h('div', { className: 'dshc-switchRow' },
            h('div', { className: 'dshc-switchText' },
              h('div', { className: 'dshc-switchTitle' }, t('connect.replace.title')),
              h('div', { className: 'dshc-switchHint' }, t('connect.replace.hint'))),
            h('button', {
              type: 'button',
              className: 'dshc-switch',
              role: 'switch',
              'aria-checked': replace ? 'true' : 'false',
              'aria-label': t('connect.replace.title'),
              onClick: () => setReplace((value) => !value),
            }, h('span', { className: 'dshc-switchThumb' }))),
          h('div', { className: 'dshc-cmd' },
            h('span', { className: 'dshc-cmdLabel' }, t('connect.command.label')),
            h('button', {
              type: 'button',
              className: 'dshc-cmdCopy',
              'data-copied': copied ? 'true' : 'false',
              'aria-label': copied ? t('connect.copied') : t('connect.copy'),
              title: copied ? t('connect.copied') : t('connect.copy'),
              disabled: command === '',
              onClick: () => { void copy(); },
            }, copied ? h(IconCheck, { size: 15 }) : h(IconCopy, { size: 15 })),
            h('code', {
              className: 'dshc-cmdText',
              'data-placeholder': command === '' ? 'true' : 'false',
            }, command === '' ? t('connect.pendingCommand') : command),
            h('span', { className: 'dshc-sr', role: 'status', 'aria-live': 'polite' },
              copied ? t('connect.copied') : (copyFailure ? t('connect.copyFailed') : ''))),
          copyFailure ? h('p', { className: 'dshc-formError', role: 'alert' }, t('connect.copyFailed')) : null)));
    }

    /**
     * Which of the four §10.6 runtime states the status object describes.
     * @param {object|null} status - §10.3 status() plus serverUrl.
     * @returns {string} 'running' | 'stopped' | 'connecting' | 'failed'.
     */
    function runtimePhaseOf(status) {
      if (!status || status.configured !== true) return 'stopped';
      if (status.connected === true) return 'running';
      if (status.enabled === true) return status.lastError ? 'failed' : 'connecting';
      return 'stopped';
    }

    /**
     * Whether a pasted string carries a `#join=<token>` fragment — the
     * one-address form (v1.7.0). The client only checks the shape: it hands
     * the pasted string to the host verbatim, and the host's runtime manager
     * parses the fragment, strips it from the stored URL and enrolls with the
     * join token. The browser never re-assembles a credential.
     * @param {string} value - the pasted 接入地址.
     * @returns {boolean} whether a non-empty join token is present.
     */
    function hasJoinFragment(value) {
      if (typeof value !== 'string') return false;
      const at = value.indexOf('#');
      if (at < 0) return false;
      /* Same shape the host's runtime manager parses: a fragment that starts
       * with `join=` and carries a non-empty token. */
      const fragment = value.slice(at + 1);
      return fragment.startsWith('join=') && fragment.slice('join='.length).trim() !== '';
    }

    /**
     * The account id carried inside a composite account key
     * (`dshk_<accountIdHex16>_<secretHex32>`): the key is self-describing, so
     * the UI can still name the account when an older host answers a login
     * without `accountId`. Returns '' for any other shape.
     * @param {string} value - the pasted account key.
     * @returns {string} `acct_<16hex>` or ''.
     */
    function accountIdFromKey(value) {
      if (typeof value !== 'string') return '';
      const match = /^dshk_([0-9a-f]{16})_/i.exec(value.trim());
      return match === null ? '' : `acct_${match[1].toLowerCase()}`;
    }

    /** Human label for a device platform id (the relay stores os ids). */
    function platformLabelOf(platform) {
      const value = typeof platform === 'string' ? platform.trim() : '';
      if (value === '') return t('account.platform.unknown');
      const id = value.toLowerCase();
      if (id === 'darwin' || id === 'macos' || id === 'mac') return 'macOS';
      if (id === 'win32' || id === 'windows') return 'Windows';
      if (id === 'linux') return 'Linux';
      return value;
    }

    /**
     * Whether a device in the account directory is 被控 (other machines may
     * execute on it). The host may not send the field yet: absent means
     * allowed, the documented default.
     * @param {object|null} device - one `account.devices[]` entry.
     * @returns {boolean} the effective flag.
     */
    function deviceControllable(device) {
      return device !== null && typeof device === 'object' && typeof device.controllable === 'boolean'
        ? device.controllable
        : true;
    }

    /** Stable id of a directory device (`''` when the host sent none). */
    function deviceMachineId(device) {
      return device !== null && typeof device === 'object' && typeof device.machineId === 'string'
        ? device.machineId
        : '';
    }

    /** Display name of a directory device (never empty). */
    function deviceName(device) {
      const name = device !== null && typeof device === 'object' && typeof device.name === 'string'
        ? device.name
        : '';
      return name !== '' ? name : t('account.devices.unknown');
    }

    /**
     * One device row in the account's device list.
     *
     * THIS machine's row carries the real 被控 switch (it is the only machine
     * allowed to flip its own flag); every other row shows the read-only
     * 允许被控 / 不允许被控 state. `controllable` is the effective value — the
     * card passes the optimistic one while a toggle is in flight.
     * @param {object} props - `device`, `thisMachineId`, `controllable`,
     *   `pending`, `error`, `onToggle`.
     * @returns {object} row element.
     */
    function DeviceRow(props) {
      const device = props.device !== null && typeof props.device === 'object' ? props.device : {};
      const machineId = deviceMachineId(device);
      const name = deviceName(device);
      const online = device.online === true;
      const isThisMachine = props.thisMachineId !== '' && machineId === props.thisMachineId;
      const controllable = props.controllable === undefined ? deviceControllable(device) : props.controllable === true;
      const label = t(controllable ? 'account.devices.allowed' : 'account.devices.blocked');
      const control = isThisMachine
        ? h(SwitchControl, {
          checked: controllable,
          disabled: props.pending === true,
          label: t('account.devices.controllableAria', { name }),
          onChange: () => {
            if (typeof props.onToggle === 'function') props.onToggle(!controllable);
          },
        })
        : null;
      return h('div', { className: 'dshc-deviceRowWrap' },
        h('div', {
          className: 'dshc-deviceRow',
          'data-online': online ? 'true' : 'false',
          'data-controllable': controllable ? 'true' : 'false',
          'data-self': isThisMachine ? 'true' : 'false',
        },
        h('span', {
          className: 'dshc-deviceDot',
          'data-online': online ? 'true' : 'false',
          'aria-hidden': 'true',
        }),
        h('span', { className: 'dshc-deviceName', title: name }, name),
        h('span', { className: 'dshc-devicePlatform' }, platformLabelOf(device.platform)),
        h('span', { className: 'dshc-deviceState' }, online ? t('online') : t('offline')),
        h('span', { className: 'dshc-deviceControl' },
          h('span', {
            className: 'dshc-deviceControllable',
            'data-on': controllable ? 'true' : 'false',
          }, label),
          control),
        isThisMachine
          ? h('span', { className: 'dshc-deviceThis' }, t('account.devices.thisMachine'))
          : null),
        props.error
          ? h('p', { className: 'dshc-deviceError', role: 'alert' }, props.error)
          : null);
    }

    /**
     * 「接入」 card (PROTOCOL §10.6 + account): two ways in.
     *
     * 「登录账号」 (primary): sign into the relay's account center by pasting
     * ONE account key (`dshk_…`) and keeping the relay address. Every machine
     * signed into the same account sees the others in the account's device
     * directory, so there is no per-machine pairing. 「接入地址」 keeps the
     * v1.7.0 one-address flow unchanged (the demoted 服务器地址 + 加入密钥 form
     * included).
     *
     * Logged in: one line — 已登录 <accountId> + the device count + 退出登录 —
     * followed by the account's device list (read-only in this version).
     * @param {object} props - `view` (runtime request state), `account`
     *   (`{phase, data}`), `discover` (`{candidates, configuredRelayUrl}`),
     *   `onStatus`, `onRetry`, `onNeedAccount`, `onNeedDiscover`, `onAccount`.
     * @returns {object} card element.
     */
    function JoinCard(props) {
      const view = props.view;
      const status = view.data;
      const phase = runtimePhaseOf(status);
      const configured = Boolean(status && status.configured === true);
      const accountView = props.account !== null && typeof props.account === 'object' ? props.account : null;
      const account = accountView !== null && accountView.data !== null && typeof accountView.data === 'object'
        ? accountView.data
        : null;
      const loggedIn = account !== null && account.loggedIn === true;
      const devices = account !== null && Array.isArray(account.devices) ? account.devices : [];
      const thisMachineId = account !== null && typeof account.machineId === 'string' ? account.machineId : '';
      const discover = props.discover !== null && typeof props.discover === 'object' ? props.discover : null;
      /* The relay running on this machine is the suggested account center. It
       * is only a pre-fill: the field stays editable. */
      const prefill = discover !== null && Array.isArray(discover.candidates) && discover.candidates.length > 0
        ? (typeof discover.candidates[0].url === 'string' ? discover.candidates[0].url : '')
        : (discover !== null && typeof discover.configuredRelayUrl === 'string' ? discover.configuredRelayUrl : '');
      const [tab, setTab] = React.useState(null);
      const [address, setAddress] = React.useState('');
      const [serverUrl, setServerUrl] = React.useState('');
      const [key, setKey] = React.useState('');
      const [keyMode, setKeyMode] = React.useState(false);
      /* v1.9.1: ONE pasted account key (`dshk_…`) replaces the old 账号 ID +
       * 密码 pair. The host owns the format; the client only hints at it. */
      const [accountKey, setAccountKey] = React.useState('');
      const [relayUrl, setRelayUrl] = React.useState('');
      const relayTouched = React.useRef(false);
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const [confirming, setConfirming] = React.useState(false);
      /* 被控 toggle of THIS machine: `value` is the optimistic override while
       * the POST is in flight (null = trust the host's device row), `busy`
       * disables the switch, `error` is the inline revert message. */
      const [control, setControl] = React.useState({ value: null, busy: false, error: null });
      const controlBusy = React.useRef(false);
      const alive = React.useRef(true);
      const scope = React.useRef(null);
      if (scope.current === null) scope.current = createScope();
      React.useEffect(() => () => {
        alive.current = false;
        scope.current.abortAll();
      }, []);
      /* Ask the page for the account status and the local relay suggestion
       * once; both are optional (an older host has neither route). */
      React.useEffect(() => {
        if (typeof props.onNeedAccount === 'function') props.onNeedAccount();
        if (typeof props.onNeedDiscover === 'function') props.onNeedDiscover();
      }, []);
      /* Pre-fill 中继地址 while the user has not touched it yet. */
      React.useEffect(() => {
        if (relayTouched.current || relayUrl !== '' || prefill === '') return;
        setRelayUrl(prefill);
      }, [prefill]);

      /* The account tab leads; an already-joined machine keeps showing its
       * 接入地址 line first, so upgrading never hides the working state. */
      const effectiveTab = tab !== null ? tab : (loggedIn || !configured ? 'account' : 'address');
      /* The account key is the only credential: paste it, keep the relay, sign
       * in. A value that does not start with `dshk_` is only a hint — the host
       * is the one that decides (it still may accept another shape). */
      const accountKeyTrimmed = accountKey.trim();
      const accountKeyLooksValid = accountKeyTrimmed === '' || accountKeyTrimmed.startsWith('dshk_');
      const canSubmitLogin = accountKeyTrimmed !== '' && relayUrl.trim() !== '';
      const canSubmitAddress = keyMode
        ? (serverUrl.trim() !== '' && key.trim() !== '')
        : address.trim() !== '';

      const submitLogin = async () => {
        if (busy || !canSubmitLogin) return;
        const payload = { relayUrl: relayUrl.trim(), key: accountKeyTrimmed };
        setBusy(true);
        setFailure(null);
        try {
          const next = await scope.current.run((signal) => api.loginAccount(payload, signal));
          if (!alive.current) return;
          setAccountKey('');
          const id = next !== null && typeof next === 'object' && typeof next.accountId === 'string'
            ? next.accountId
            : accountIdFromKey(payload.key);
          if (typeof props.onAccount === 'function') {
            props.onAccount(next, t('account.loggedIn.notice', { accountId: id }));
          }
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setFailure(t('account.login.failed', { message: messageOf(error) }));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      const submitAddress = async () => {
        if (busy || !canSubmitAddress) return;
        let payload;
        let server;
        if (!keyMode) {
          const raw = address.trim();
          if (!hasJoinFragment(raw)) {
            setFailure(t('join.invalid'));
            return;
          }
          /* Verbatim: the host owns the fragment (see hasJoinFragment). */
          payload = { serverUrl: raw };
          server = raw.split('#')[0];
        } else {
          payload = { serverUrl: serverUrl.trim(), key: key.trim() };
          server = serverUrl.trim();
        }
        setBusy(true);
        setFailure(null);
        try {
          const next = await scope.current.run((signal) => api.runtimeConnect(payload, signal));
          if (!alive.current) return;
          setAddress('');
          setServerUrl('');
          setKey('');
          props.onStatus(next, t('runtime.connected.notice', { server }));
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setFailure(t('runtime.connectFailed', { message: messageOf(error) }));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      const submitLogout = async () => {
        if (busy) return;
        setBusy(true);
        setFailure(null);
        try {
          const next = await scope.current.run((signal) => api.logoutAccount(signal));
          if (!alive.current) return;
          if (typeof props.onAccount === 'function') {
            props.onAccount(next, t('account.loggedOut.notice'));
          }
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setFailure(t('account.logoutFailed', { message: messageOf(error) }));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      /* Optimistic 被控 switch: the row flips immediately, the host's account
       * status reconciles on success, and a failure reverts the row while
       * keeping an inline error (a host without the route answers 404). */
      const toggleControllable = async (enabled) => {
        if (controlBusy.current) return;
        controlBusy.current = true;
        setControl({ value: enabled === true, busy: true, error: null });
        try {
          const next = await scope.current.run((signal) => api.setControllable(enabled, signal));
          if (!alive.current) return;
          const applied = next !== null && typeof next === 'object';
          if (typeof props.onAccount === 'function' && applied) {
            props.onAccount(next, null);
          }
          /* A host that answers nothing keeps the optimistic value; one that
           * answers the status hands the truth back to the row. */
          setControl({ value: applied ? null : enabled === true, busy: false, error: null });
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setControl({
            value: null,
            busy: false,
            error: t('account.devices.controllableFailed', { message: messageOf(error) }),
          });
        } finally {
          controlBusy.current = false;
        }
      };

      const enterSubmits = (submit) => (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void submit();
        }
      };
      const toggleKeyMode = () => {
        setFailure(null);
        setKeyMode((current) => !current);
      };
      const selectTab = (next) => {
        setFailure(null);
        setTab(next);
      };
      const markRelayTouched = (value) => {
        relayTouched.current = true;
        setRelayUrl(value);
      };

      /* 被控: only THIS machine's row gets the live switch; the others are
       * read-only. `control.value` is the optimistic override in flight. */
      const thisDevice = devices.find((device) => thisMachineId !== ''
        && deviceMachineId(device) === thisMachineId) || null;
      const thisControllable = control.value !== null ? control.value : deviceControllable(thisDevice);

      let body;
      if (loggedIn) {
        body = h('div', null,
          h('div', { className: 'dshc-accountLine' },
            h('span', { className: 'dshc-accountText' },
              h('span', null, t('account.loggedIn')),
              h('code', {
                className: 'dshc-accountId',
                title: typeof account.accountId === 'string' ? account.accountId : '',
              }, typeof account.accountId === 'string' && account.accountId !== '' ? account.accountId : '—')),
            h('span', { className: 'dshc-accountCount' },
              t('account.devices.count', { count: devices.length })),
            h('button', {
              type: 'button',
              className: 'dshc-textBtn dshc-accountLogout',
              disabled: busy,
              onClick: () => { void submitLogout(); },
            }, busy ? t('account.loggingOut') : t('account.logout'))),
          devices.length > 0
            ? h('div', { className: 'dshc-deviceList' },
              h('div', { className: 'dshc-deviceListHead' }, t('account.devices.title')),
              devices.map((device, index) => {
                const machineId = deviceMachineId(device);
                const isThisMachine = thisMachineId !== '' && machineId === thisMachineId;
                return h(DeviceRow, {
                  key: machineId !== '' ? machineId : `device-${index}`,
                  device,
                  thisMachineId,
                  controllable: isThisMachine ? thisControllable : deviceControllable(device),
                  pending: isThisMachine && control.busy,
                  error: isThisMachine ? control.error : null,
                  onToggle: isThisMachine ? (enabled) => { void toggleControllable(enabled); } : undefined,
                });
              }))
            : h('p', { className: 'dshc-hint dshc-accountEmpty' }, t('account.devices.empty')));
      } else if (effectiveTab === 'account') {
        body = h('div', null,
          h('p', { className: 'dshc-hint dshc-accountHint' }, t('account.login.hint')),
          h('div', { className: 'dshc-formRow dshc-joinForm dshc-accountForm' },
            /* v1.9.1: ONE field — the pasted account key. The account id and
             * the secret live inside it (`dshk_<id>_<secret>`). */
            h('label', { className: 'dshc-field dshc-accountKeyField' },
              h('span', { className: 'dshc-fieldLabel' }, t('account.login.key')),
              h('input', {
                className: 'dshc-input dshc-accountKeyInput',
                type: 'text',
                autoComplete: 'off',
                spellCheck: false,
                value: accountKey,
                placeholder: t('account.login.keyPlaceholder'),
                disabled: busy,
                onChange: (event) => setAccountKey(event.target.value),
                onKeyDown: enterSubmits(submitLogin),
              })),
            h('label', { className: 'dshc-field dshc-accountRelayField' },
              h('span', { className: 'dshc-fieldLabel' }, t('account.login.relay')),
              h('input', {
                className: 'dshc-input dshc-accountRelayInput',
                type: 'url',
                inputMode: 'url',
                autoComplete: 'off',
                spellCheck: false,
                value: relayUrl,
                placeholder: t('account.login.relayPlaceholder'),
                disabled: busy,
                onChange: (event) => markRelayTouched(event.target.value),
                onKeyDown: enterSubmits(submitLogin),
              })),
            h('button', {
              type: 'button',
              className: 'dshc-primary dshc-formSubmit dshc-accountLogin',
              disabled: busy || !canSubmitLogin,
              onClick: () => { void submitLogin(); },
            }, busy ? t('account.login.submitting') : t('account.login.submit'))),
          h('p', { className: 'dshc-hint dshc-accountRelayHint' }, t('account.login.relayHint')),
          /* Shape hint only: the host still receives whatever was pasted. */
          accountKeyLooksValid
            ? null
            : h('p', {
              className: 'dshc-hint dshc-accountKeyShapeHint',
              role: 'status',
            }, t('account.login.keyShape')));
      } else {
        let addressBody;
        if (status === null && (view.phase === 'loading' || view.phase === 'idle')) {
          addressBody = h('div', { className: 'dshc-runtimeMeta' }, h(Spinner), h('span', null, t('runtime.loading')));
        } else if (status === null) {
          addressBody = h('div', { className: 'dshc-errorCard', role: 'alert' },
            h('span', { className: 'dshc-errorText' },
              t('error.loadDetail', { title: t('runtime.loadFailed'), message: view.error ? messageOf(view.error) : '' })),
            h('button', { type: 'button', className: 'dshc-ghost', onClick: props.onRetry }, t('retry')));
        } else if (!configured) {
          const fields = keyMode
            ? [
              h('label', { key: 'server', className: 'dshc-field' },
                h('span', { className: 'dshc-fieldLabel' }, t('runtime.serverLabel')),
                h('input', {
                  className: 'dshc-input',
                  type: 'url',
                  inputMode: 'url',
                  autoComplete: 'off',
                  spellCheck: false,
                  value: serverUrl,
                  placeholder: t('runtime.serverPlaceholder'),
                  disabled: busy,
                  onChange: (event) => setServerUrl(event.target.value),
                  onKeyDown: enterSubmits(submitAddress),
                })),
              h('label', { key: 'key', className: 'dshc-field' },
                h('span', { className: 'dshc-fieldLabel' }, t('runtime.keyLabel')),
                h('input', {
                  className: 'dshc-input',
                  type: 'text',
                  autoComplete: 'off',
                  spellCheck: false,
                  value: key,
                  placeholder: t('runtime.keyPlaceholder'),
                  disabled: busy,
                  onChange: (event) => setKey(event.target.value),
                  onKeyDown: enterSubmits(submitAddress),
                })),
            ]
            : h('label', { className: 'dshc-field dshc-joinField' },
              h('span', { className: 'dshc-fieldLabel' }, t('join.addressLabel')),
              h('input', {
                className: 'dshc-input dshc-joinAddressInput',
                type: 'url',
                inputMode: 'url',
                autoComplete: 'off',
                spellCheck: false,
                value: address,
                placeholder: t('join.addressPlaceholder'),
                disabled: busy,
                onChange: (event) => setAddress(event.target.value),
                onKeyDown: enterSubmits(submitAddress),
              }));
          addressBody = h('div', null,
            h('p', { className: 'dshc-hint dshc-joinHint' },
              keyMode ? t('runtime.hint') : t('join.hint')),
            h('div', { className: 'dshc-formRow dshc-joinForm' },
              fields,
              h('button', {
                type: 'button',
                className: 'dshc-primary dshc-formSubmit dshc-joinSubmit',
                disabled: busy || !canSubmitAddress,
                onClick: () => { void submitAddress(); },
              }, busy ? t('runtime.connecting') : t('runtime.connect'))),
            h('button', {
              type: 'button',
              className: 'dshc-joinToggle dshc-joinModeToggle',
              onClick: toggleKeyMode,
            }, keyMode ? t('join.addressToggle') : t('join.keyToggle')));
        } else {
          const server = typeof status.serverUrl === 'string' ? status.serverUrl : '';
          addressBody = h('div', { className: 'dshc-joinLine' },
            h('span', { className: 'dshc-joinText' },
              h('span', null, t('join.connected')),
              h('code', { className: 'dshc-joinAddress', title: server }, server)),
            h('span', { className: 'dshc-status', 'data-state': phase },
              h('span', { className: 'dshc-dot', 'data-state': phase, 'aria-hidden': 'true' }),
              t(`runtime.status.${phase}`)),
            h('button', {
              type: 'button',
              className: 'dshc-textBtn dshc-joinDisconnect',
              disabled: busy,
              onClick: () => setConfirming(true),
            }, t('runtime.disconnect')));
        }
        body = addressBody;
      }

      const tabBar = loggedIn
        ? null
        : h('div', {
          className: 'dshc-seg dshc-accountModes',
          role: 'tablist',
          'aria-label': t('account.modesLabel'),
        },
        h('button', {
          key: 'account',
          type: 'button',
          role: 'tab',
          className: 'dshc-segBtn dshc-accountModeBtn',
          'data-mode': 'account',
          'data-active': effectiveTab === 'account' ? 'true' : 'false',
          'aria-selected': effectiveTab === 'account' ? 'true' : 'false',
          disabled: busy,
          onClick: () => selectTab('account'),
        }, t('account.mode.account')),
        h('button', {
          key: 'address',
          type: 'button',
          role: 'tab',
          className: 'dshc-segBtn dshc-accountModeBtn',
          'data-mode': 'address',
          'data-active': effectiveTab === 'address' ? 'true' : 'false',
          'aria-selected': effectiveTab === 'address' ? 'true' : 'false',
          disabled: busy,
          onClick: () => selectTab('address'),
        }, t('account.mode.address')));

      return h('div', { className: 'dshc-card2 dshc-joinCard' },
        h('div', { className: 'dshc-card2Head' },
          h('span', { className: 'dshc-card2Title' }, t('join.title'))),
        tabBar,
        body,
        failure !== null ? h('p', { className: 'dshc-formError', role: 'alert' }, failure) : null,
        confirming
          ? h(RuntimeDisconnectDialog, {
            runtime: status,
            onClose: () => setConfirming(false),
            onDone: (next) => {
              setConfirming(false);
              props.onStatus(next, t('runtime.disconnected.notice'));
            },
          })
          : null);
    }

    /**
     * Confirm + perform §10.5 disconnect for the local runtime.
     * @param {object} props - `runtime`, `onClose`, `onDone(status)`.
     * @returns {object} dialog layer.
     */
    function RuntimeDisconnectDialog(props) {
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const scope = React.useRef(null);
      if (scope.current === null) scope.current = createScope();
      React.useEffect(() => () => scope.current.abortAll(), []);

      const confirm = async () => {
        if (busy) return;
        setBusy(true);
        setFailure(null);
        try {
          const next = await scope.current.run((signal) => api.runtimeDisconnect(signal));
          props.onDone(next && typeof next === 'object' ? next : { configured: false });
        } catch (error) {
          if (error && error.name === 'AbortError') return;
          setFailure(t('runtime.disconnectFailed', { message: messageOf(error) }));
          setBusy(false);
        }
      };

      const server = props.runtime && typeof props.runtime.serverUrl === 'string' ? props.runtime.serverUrl : '';
      return h(Dialog, {
        title: t('runtime.disconnectTitle'),
        size: 'sm',
        onClose: () => { if (!busy) props.onClose(); },
        footer: [
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dshc-ghost',
            disabled: busy,
            onClick: props.onClose,
          }, t('cancel')),
          h('button', {
            key: 'disconnect',
            type: 'button',
            className: 'dshc-primary',
            disabled: busy,
            onClick: () => { void confirm(); },
          }, t('runtime.disconnect')),
        ],
      },
      h('p', { className: 'dshc-dialogBody' }, t('runtime.disconnectBody', { server })),
      failure !== null ? h('p', { className: 'dshc-formError', role: 'alert' }, failure) : null);
    }

    /**
     * 「账号中心」 card in 高级 — for the machine that hosts the relay.
     *
     * Signed out it is one quiet line + 创建账号中心; the form (relay address
     * pre-filled from the local discovery, optional admin key and name) only
     * appears on request, so 高级 stays quiet by default. On success the host
     * answers with the composite account key (`dshk_…`) — and that key is
     * retrievable AT ANY TIME (v1.9.1): `GET /account` returns it, so a fresh
     * mount renders the same copyable row. That is how another machine is added
     * later, so the key is never "shown once": it gets a copy button, the
     * account id as small secondary text and one line saying anyone holding the
     * key can join. A host too old to return `key` gets a muted upgrade hint
     * instead of an empty field.
     * @param {object} props - `account` (`{phase, data}`), `discover`,
     *   `created` (`{accountId, key}` or null), `onNeedAccount`,
     *   `onNeedDiscover`, `onCreated(created, status)`, `onAccount(status, message)`.
     * @returns {object} card element.
     */
    function AccountCenterCard(props) {
      const accountView = props.account !== null && typeof props.account === 'object' ? props.account : null;
      const account = accountView !== null && accountView.data !== null && typeof accountView.data === 'object'
        ? accountView.data
        : null;
      const loggedIn = account !== null && account.loggedIn === true;
      const created = props.created !== null && typeof props.created === 'object' ? props.created : null;
      const discover = props.discover !== null && typeof props.discover === 'object' ? props.discover : null;
      const prefill = discover !== null && Array.isArray(discover.candidates) && discover.candidates.length > 0
        ? (typeof discover.candidates[0].url === 'string' ? discover.candidates[0].url : '')
        : (discover !== null && typeof discover.configuredRelayUrl === 'string' ? discover.configuredRelayUrl : '');
      const [form, setForm] = React.useState(false);
      const [relayUrl, setRelayUrl] = React.useState('');
      const [adminKey, setAdminKey] = React.useState('');
      const [name, setName] = React.useState('');
      const relayTouched = React.useRef(false);
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const alive = React.useRef(true);
      const scope = React.useRef(null);
      if (scope.current === null) scope.current = createScope();
      React.useEffect(() => () => {
        alive.current = false;
        scope.current.abortAll();
      }, []);
      React.useEffect(() => {
        if (typeof props.onNeedAccount === 'function') props.onNeedAccount();
        if (typeof props.onNeedDiscover === 'function') props.onNeedDiscover();
      }, []);
      React.useEffect(() => {
        if (relayTouched.current || relayUrl !== '' || prefill === '') return;
        setRelayUrl(prefill);
      }, [prefill]);

      const canCreate = relayUrl.trim() !== '';
      const submitCreate = async () => {
        if (busy || !canCreate) return;
        const body = { relayUrl: relayUrl.trim() };
        if (adminKey.trim() !== '') body.adminKey = adminKey.trim();
        if (name.trim() !== '') body.name = name.trim();
        setBusy(true);
        setFailure(null);
        try {
          const next = await scope.current.run((signal) => api.createAccount(body, signal));
          if (!alive.current) return;
          const accountId = next !== null && typeof next === 'object' && typeof next.accountId === 'string'
            ? next.accountId
            : '';
          const key = next !== null && typeof next === 'object' && typeof next.key === 'string'
            ? next.key
            : '';
          if (typeof props.onCreated === 'function') props.onCreated({ accountId, key }, next);
          setForm(false);
          setAdminKey('');
          setName('');
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setFailure(t('account.center.failed', { message: messageOf(error) }));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      const submitLogout = async () => {
        if (busy) return;
        setBusy(true);
        setFailure(null);
        try {
          const next = await scope.current.run((signal) => api.logoutAccount(signal));
          if (!alive.current) return;
          if (typeof props.onAccount === 'function') props.onAccount(next, t('account.loggedOut.notice'));
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setFailure(t('account.logoutFailed', { message: messageOf(error) }));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      /* The key shown by the card: this page session's create response first
       * (it is the freshest), else `GET /account` — which is what makes the key
       * copyable at any time, including after a reload. */
      const createdKey = created !== null && typeof created.key === 'string' ? created.key : '';
      const liveKey = account !== null && typeof account.key === 'string' ? account.key : '';
      const keyValue = createdKey !== '' ? createdKey : liveKey;
      const accountIdText = created !== null && typeof created.accountId === 'string' && created.accountId !== ''
        ? created.accountId
        : (account !== null && typeof account.accountId === 'string' ? account.accountId : '');
      /* No key at all means the host predates v1.9.1: say so instead of
       * rendering an empty copyable field. */
      const keyBlock = keyValue !== ''
        ? h(CopyRow, { label: t('account.key.label'), value: keyValue, stacked: true })
        : h('div', { className: 'dshc-copyRow dshc-accountKeyMissing' },
          h('div', { className: 'dshc-copyRowTop' },
            h('span', { className: 'dshc-copyRowKey' }, t('account.key.label'))),
          h('p', { className: 'dshc-copyRowHint dshc-accountKeyMissingHint' }, t('account.key.unsupported')));
      const accountLine = h('p', { className: 'dshc-accountSecondary' },
        h('span', null, `${t('account.center.loggedIn')} `),
        h('code', {
          className: 'dshc-accountId',
          title: accountIdText,
        }, accountIdText !== '' ? accountIdText : '—'));

      /* The key is a credential: the warning belongs to it, so it is only
       * rendered next to a real key (an old host gets the upgrade hint only). */
      const keyWarning = keyValue !== ''
        ? h('p', { className: 'dshc-accountWarning' }, t('account.key.warning'))
        : null;

      let body;
      if (created !== null) {
        /* Create success: the same always-available key row, highlighted once
         * with the "come back any time" line (v1.9.1 — no more "shown once"). */
        body = h('div', { className: 'dshc-accountCredentials' },
          h('p', { className: 'dshc-accountCreated' }, t('account.center.created')),
          h('div', { className: 'dshc-copyStack' }, keyBlock),
          keyValue !== ''
            ? h('p', { className: 'dshc-accountKeyHighlight', role: 'status' }, t('account.key.highlight'))
            : null,
          keyWarning,
          h('div', { className: 'dshc-accountLine dshc-accountLine--spaced' }, accountLine),
          h('p', { className: 'dshc-hint dshc-accountCreatedHint' }, t('account.center.createdHint')));
      } else if (loggedIn) {
        body = h('div', null,
          h('div', { className: 'dshc-copyStack' }, keyBlock),
          keyWarning,
          h('div', { className: 'dshc-accountLine dshc-accountLine--spaced' },
            accountLine,
            h('button', {
              type: 'button',
              className: 'dshc-textBtn dshc-accountCenterLogout',
              disabled: busy,
              onClick: () => { void submitLogout(); },
            }, busy ? t('account.loggingOut') : t('account.logout'))));
      } else if (form) {
        body = h('div', null,
          h('div', { className: 'dshc-formRow dshc-accountForm' },
            h('label', { className: 'dshc-field dshc-accountRelayField' },
              h('span', { className: 'dshc-fieldLabel' }, t('account.login.relay')),
              h('input', {
                className: 'dshc-input dshc-centerRelayInput',
                type: 'url',
                inputMode: 'url',
                autoComplete: 'off',
                spellCheck: false,
                value: relayUrl,
                placeholder: t('account.login.relayPlaceholder'),
                disabled: busy,
                onChange: (event) => {
                  relayTouched.current = true;
                  setRelayUrl(event.target.value);
                },
              })),
            h('label', { className: 'dshc-field' },
              h('span', { className: 'dshc-fieldLabel' }, t('account.center.adminKey')),
              h('input', {
                className: 'dshc-input dshc-centerAdminInput',
                type: 'password',
                autoComplete: 'off',
                spellCheck: false,
                value: adminKey,
                placeholder: t('account.center.adminKeyPlaceholder'),
                disabled: busy,
                onChange: (event) => setAdminKey(event.target.value),
              })),
            h('label', { className: 'dshc-field' },
              h('span', { className: 'dshc-fieldLabel' }, t('account.center.name')),
              h('input', {
                className: 'dshc-input dshc-centerNameInput',
                type: 'text',
                autoComplete: 'off',
                spellCheck: false,
                value: name,
                placeholder: t('account.center.namePlaceholder'),
                disabled: busy,
                onChange: (event) => setName(event.target.value),
              })),
            h('button', {
              type: 'button',
              className: 'dshc-primary dshc-accountCreateSubmit',
              disabled: busy || !canCreate,
              onClick: () => { void submitCreate(); },
            }, busy ? t('account.center.creating') : t('account.center.submit'))),
          h('button', {
            type: 'button',
            className: 'dshc-textBtn dshc-accountCreateCancel',
            disabled: busy,
            onClick: () => {
              setForm(false);
              setFailure(null);
            },
          }, t('account.center.cancel')));
      } else {
        body = h('div', null,
          h('p', { className: 'dshc-hint dshc-accountCenterHint' }, t('account.center.hint')),
          h('button', {
            type: 'button',
            className: 'dshc-accountCreateBtn',
            onClick: () => {
              setFailure(null);
              setForm(true);
            },
          }, t('account.center.create')));
      }

      return h('div', { className: 'dshc-card2 dshc-accountCenter' },
        h('div', { className: 'dshc-card2Head' },
          h('span', { className: 'dshc-card2Title' }, t('account.center.title'))),
        body,
        failure !== null ? h('p', { className: 'dshc-formError', role: 'alert' }, failure) : null);
    }

    /**
     * The page body: the 接入 card, the 已连接的电脑 list and the collapsed
     * 高级 block, plus their states.
     * @returns {object} the 电脑 page.
     */
    function ComputersBoard() {
      useStyles();
      useLocaleRevision();
      const [view, setView] = React.useState({ phase: 'loading', data: null });
      const [runtime, setRuntime] = React.useState({ phase: 'idle', data: null });
      /* Relay setup state: `pending` is the optimistic overlay for the POST
       * in flight (`enabled` and/or `url`), `error` is the inline failure
       * line. One state drives the switch, 启用 and 修改 alike. */
      const [relayAction, setRelayAction] = React.useState({ pending: null, error: null });
      const [relayBusy, setRelayBusy] = React.useState(false);
      const relayBusyRef = React.useRef(false);
      /* Bumped when a relay POST starts and again when it settles. A /state
       * response whose request began under an older epoch is stale for the
       * switch: applying it would flicker the optimistic value back. */
      const relayEpoch = React.useRef(0);
      const [dialog, setDialog] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      /* Account center (PROTOCOL account): the account this machine is signed
       * into, the relay discovered on this machine, and the credentials of an
       * account center created in this page session (shown once). */
      const [account, setAccount] = React.useState({ phase: 'idle', data: null, error: null });
      const [discover, setDiscover] = React.useState({ candidates: [], configuredRelayUrl: '' });
      const [createdAccount, setCreatedAccount] = React.useState(null);
      const alive = React.useRef(true);
      const scope = React.useRef(null);
      const noticeTimer = React.useRef(null);
      const runtimeRequested = React.useRef(false);
      const accountRequested = React.useRef(false);
      const discoverRequested = React.useRef(false);
      const accessCounts = React.useRef(new Map());
      const accessRequested = React.useRef(new Set());
      const [, setCountsVersion] = React.useState(0);
      if (scope.current === null) scope.current = createScope();

      /* The account routes are new: a host that predates them answers 404 (or
       * nothing), which must leave the page on "not signed in" — never an
       * error banner. */
      const loadAccount = React.useCallback(async () => {
        if (accountRequested.current) return;
        accountRequested.current = true;
        try {
          const payload = await scope.current.run((signal) => api.readAccount(signal));
          if (!alive.current) return;
          setAccount({
            phase: 'ready',
            data: payload !== null && typeof payload === 'object' ? payload : null,
            error: null,
          });
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setAccount({ phase: 'ready', data: null, error });
        }
      }, []);

      const loadDiscover = React.useCallback(async () => {
        if (discoverRequested.current) return;
        discoverRequested.current = true;
        try {
          const payload = await scope.current.run((signal) => api.discoverAccount(signal));
          if (!alive.current) return;
          const candidates = payload !== null && typeof payload === 'object' && Array.isArray(payload.candidates)
            ? payload.candidates.filter((entry) => entry !== null && typeof entry === 'object'
              && typeof entry.url === 'string' && entry.url !== '')
            : [];
          const configuredRelayUrl = payload !== null && typeof payload === 'object'
            && payload.configured !== null && typeof payload.configured === 'object'
            && typeof payload.configured.relayUrl === 'string'
            ? payload.configured.relayUrl
            : '';
          setDiscover({ candidates, configuredRelayUrl });
        } catch (error) {
          /* No suggestion is fine: the field stays empty and editable. */
        }
      }, []);

      const needAccount = React.useCallback(() => { void loadAccount(); }, [loadAccount]);
      const needDiscover = React.useCallback(() => { void loadDiscover(); }, [loadDiscover]);

      const loadRuntime = React.useCallback(async () => {
        try {
          const data = await scope.current.run((signal) => api.readRuntime(signal));
          if (!alive.current) return;
          setRuntime({ phase: 'ready', data: data && typeof data === 'object' ? data : null });
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setRuntime((current) => ({ phase: current.data === null ? 'error' : 'ready', data: current.data, error }));
        }
      }, []);

      const load = React.useCallback(async (options) => {
        const initial = options !== undefined && options !== null && options.initial === true;
        const relayEpochAtStart = relayEpoch.current;
        if (initial) setView((current) => ({ phase: current.data === null ? 'loading' : 'ready', data: current.data }));
        try {
          const data = await scope.current.run((signal) => api.readState(signal));
          if (!alive.current) return;
          const next = data && typeof data === 'object' ? data : { computers: [] };
          /* A poll that overlapped a relay POST is stale for `relay`: keep
           * the value the switch already applied instead of flickering. */
          const staleRelay = relayBusyRef.current || relayEpoch.current !== relayEpochAtStart;
          setView((current) => {
            if (!staleRelay) return { phase: 'ready', data: next };
            const currentRelay = current.data !== null && typeof current.data === 'object'
              && current.data.relay !== null && typeof current.data.relay === 'object'
              ? current.data.relay
              : null;
            return {
              phase: 'ready',
              data: currentRelay === null ? next : { ...next, relay: currentRelay },
            };
          });
          /* A fresh poll is authoritative: reconcile and clear the error,
           * except an address the server rejected — that one stays until the
           * user corrects it (or cancels), so it cannot vanish unread. */
          if (!staleRelay) {
            setRelayAction((current) => (current.sticky === true
              ? current
              : { pending: null, error: null }));
          }
          /* The local runtime card exists only where §10.5 routes do (§10.1). */
          if (roleOf(next) !== 'hub' && !runtimeRequested.current) {
            runtimeRequested.current = true;
            void loadRuntime();
          }
          /* /state may already carry the account (PROTOCOL account §4); when
           * it does not, ask the account route once. Runtime-only machines
           * have no account center at all. */
          if (next.account !== null && typeof next.account === 'object') {
            accountRequested.current = true;
            setAccount({ phase: 'ready', data: next.account, error: null });
          } else if (roleOf(next) !== 'runtime') {
            void loadAccount();
          }
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setView((current) => ({ phase: current.data === null ? 'error' : 'ready', data: current.data, error }));
        }
      }, [loadRuntime, loadAccount]);

      /**
       * Configure the relay (PROTOCOL relay): `{ enabled }` flips the switch,
       * `{ url }` persists a UI override and re-dials, `{ enabled, url }` is
       * the one-click first setup. Optimistic overlay, the host's returned
       * `state.relay` reconciles immediately, a failure reverts and leaves an
       * inline error (the server's message) until the next successful poll.
       * @param {object} payload - `enabled` and/or `url`.
       * @returns {Promise<boolean>} whether the host accepted the change.
       */
      const submitRelay = React.useCallback(async (payload) => {
        if (payload === null || typeof payload !== 'object' || relayBusyRef.current) return false;
        const body = {};
        if (typeof payload.enabled === 'boolean') body.enabled = payload.enabled;
        if (typeof payload.url === 'string') body.url = payload.url.trim();
        if (body.enabled === undefined && body.url === undefined) return false;
        const saving = body.enabled === undefined;
        relayBusyRef.current = true;
        relayEpoch.current += 1;
        setRelayBusy(true);
        setRelayAction({ pending: body, error: null });
        try {
          const result = await scope.current.run((signal) => api.relayEnable(body, signal));
          if (!alive.current) return false;
          relayEpoch.current += 1;
          if (result !== null && typeof result === 'object') {
            setRelayAction({ pending: null, error: null });
            setView((current) => {
              const currentData = current.data !== null && typeof current.data === 'object' ? current.data : {};
              return { ...current, data: { ...currentData, relay: result } };
            });
          } else {
            /* Empty answer: keep the optimistic value until the next poll. */
            setRelayAction({ pending: body, error: null });
          }
          return true;
        } catch (error) {
          if (error && error.name === 'AbortError') return false;
          relayEpoch.current += 1;
          setRelayAction({
            pending: null,
            error: t(saving ? 'relay.saveFailed' : 'relay.enableFailed', { message: messageOf(error) }),
            sticky: saving,
          });
          return false;
        } finally {
          relayBusyRef.current = false;
          if (alive.current) setRelayBusy(false);
        }
      }, []);

      const showNotice = React.useCallback((kind, text) => {
        setNotice({ kind, text });
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => {
          noticeTimer.current = null;
          if (alive.current) setNotice(null);
        }, NOTICE_MS);
      }, []);

      React.useEffect(() => {
        alive.current = true;
        void load({ initial: true });
        const poll = setInterval(() => {
          if (!alive.current) return;
          void load({});
          if (runtimeRequested.current) void loadRuntime();
        }, STATE_POLL_MS);
        return () => {
          alive.current = false;
          clearInterval(poll);
          if (noticeTimer.current !== null) {
            clearTimeout(noticeTimer.current);
            noticeTimer.current = null;
          }
          scope.current.abortAll();
        };
      }, [load, loadRuntime]);

      const handleConnected = React.useCallback((computer) => {
        setDialog(null);
        const name = computer && typeof computer.name === 'string' ? computer.name : '';
        showNotice('success', name ? t('connect.connected.notice', { name }) : t('connect.connected.noticeAnonymous'));
        void load({});
      }, [load, showNotice]);

      const handleRenamed = React.useCallback((name) => {
        setDialog(null);
        showNotice('success', t('renamed.notice', { name }));
        void load({});
      }, [load, showNotice]);

      const handleDeleted = React.useCallback((name) => {
        setDialog(null);
        showNotice('success', t('deleted.notice', { name }));
        void load({});
      }, [load, showNotice]);

      const handleRuntimeStatus = React.useCallback((status, message) => {
        if (status && typeof status === 'object') setRuntime({ phase: 'ready', data: status });
        else void loadRuntime();
        if (typeof message === 'string' && message !== '') showNotice('success', message);
      }, [loadRuntime, showNotice]);

      /* The account POSTs answer with the full status, so the card and the
       * 账号中心 reconcile without waiting for a poll. */
      const handleAccountStatus = React.useCallback((status, message) => {
        if (status !== null && typeof status === 'object') {
          accountRequested.current = true;
          setAccount({ phase: 'ready', data: status, error: null });
        }
        if (typeof message === 'string' && message !== '') showNotice('success', message);
      }, [showNotice]);

      const handleAccountCreated = React.useCallback((created, status) => {
        if (created !== null && typeof created === 'object') setCreatedAccount(created);
        handleAccountStatus(status, null);
      }, [handleAccountStatus]);

      const data = view.data;
      const role = data === null ? null : roleOf(data);
      const computers = data && Array.isArray(data.computers) ? data.computers : null;
      const baseRelay = data !== null && data.relay !== null && typeof data.relay === 'object'
        ? data.relay
        : null;
      /* Optimistic overlay while a relay POST is in flight: the switch and the
       * relay address follow the user's intent until a fresh poll lands. `url`
       * also covers a first-time setup, so the card leaves its input form as
       * soon as the address is submitted. */
      const relayPending = relayAction.pending;
      const pendingEnabled = relayPending !== null && typeof relayPending.enabled === 'boolean'
        ? relayPending.enabled
        : null;
      const pendingUrl = relayPending !== null && typeof relayPending.url === 'string'
        ? relayPending.url
        : null;
      const relay = baseRelay !== null && (pendingEnabled !== null || pendingUrl !== null)
        ? {
          ...baseRelay,
          ...(pendingEnabled !== null
            ? {
              enabled: pendingEnabled,
              state: pendingEnabled ? 'connecting' : 'disabled',
              lastError: null,
            }
            : {}),
          ...(pendingUrl !== null
            ? {
              /* The public address belongs to the old endpoint: hide it until
               * the host re-dials and reports the new one. */
              url: pendingUrl,
              publicUrl: '',
              lastError: null,
              ...(baseRelay.enabled === true ? { state: 'connecting' } : {}),
            }
            : {}),
        }
        : baseRelay;

      const countsFor = (computer) => {
        const id = computer && computer.id ? String(computer.id) : '';
        return id === '' ? null : (accessCounts.current.get(id) || null);
      };
      const showRuntime = role !== null && role !== 'hub';
      const showComputers = role !== 'runtime';
      const canConnect = role !== 'runtime';
      const serverUrls = data && Array.isArray(data.serverUrls) ? data.serverUrls : null;
      const loopbackOnly = data !== null && data.loopbackOnly === true;
      /* The hub's one copyable string (v1.7.0): `<advertised>#join=<token>`.
       * It is copied verbatim — the other machine pastes it into 接入. */
      const fleet = data !== null && data.fleet !== null && typeof data.fleet === 'object' ? data.fleet : null;
      const joinUrl = fleet !== null && typeof fleet.joinUrl === 'string' ? fleet.joinUrl : '';
      // v1.7.2: a loopback-only machine cannot publish a join address; the host
      // says why so we can tell the user what to do instead of showing one.
      const joinBlocked = fleet !== null && fleet.joinUrl === '' && fleet.hasToken === true;

      let body;
      if (view.phase === 'loading' && computers === null) body = h(Skeleton);
      else if (view.phase === 'error') {
        body = h('div', { className: 'dshc-errorCard', role: 'alert' },
          h('span', { className: 'dshc-errorText' },
            t('error.loadDetail', { title: t('error.load'), message: view.error ? messageOf(view.error) : '' })),
          h('button', {
            type: 'button',
            className: 'dshc-ghost',
            onClick: () => { void load({ initial: true }); },
          }, t('retry')));
      } else if (computers === null || computers.length === 0) {
        body = h(EmptyState, {
          joinUrl,
          joinBlocked,
          onCliFallback: canConnect ? () => setDialog({ kind: 'connect' }) : undefined,
        });
      }
      else {
        body = h('div', { className: 'dshc-list' }, computers.map((computer) => h(ComputerRow, {
          key: computer.id || computer.name,
          computer,
          counts: countsFor(computer),
          onRename: (target) => setDialog({ kind: 'rename', computer: target }),
          onDelete: (target) => setDialog({ kind: 'delete', computer: target }),
          onAccess: (target) => setDialog({ kind: 'access', computer: target }),
          onUpgrade: (target) => setDialog({ kind: 'upgrade', computer: target }),
        })));
      }

      let layer = null;
      if (dialog !== null && dialog.kind === 'connect') {
        layer = h(ConnectModal, {
          serverUrl: data && typeof data.serverUrl === 'string' ? data.serverUrl : '',
          serverUrls,
          loopbackOnly,
          onClose: () => setDialog(null),
          onConnected: handleConnected,
        });
      } else if (dialog !== null && dialog.kind === 'rename' && dialog.computer) {
        layer = h(RenameDialog, {
          computer: dialog.computer,
          onClose: () => setDialog(null),
          onRenamed: handleRenamed,
        });
      } else if (dialog !== null && dialog.kind === 'access' && dialog.computer) {
        layer = h(ComputerAccessDialog, {
          computer: dialog.computer,
          onClose: () => setDialog(null),
          onChanged: (counts) => {
            const id = dialog.computer && dialog.computer.id ? String(dialog.computer.id) : '';
            if (id === '' || !counts) return;
            accessCounts.current.set(id, counts);
            setCountsVersion((value) => value + 1);
          },
        });
      } else if (dialog !== null && dialog.kind === 'upgrade' && dialog.computer) {
        layer = h(UpgradeDialog, {
          computer: dialog.computer,
          serverUrl: data && typeof data.serverUrl === 'string' ? data.serverUrl : '',
          expectedVersion: data && typeof data.agentVersion === 'string' ? data.agentVersion : '',
          pluginVersion: data && typeof data.pluginVersion === 'string'
            ? data.pluginVersion
            : (data && typeof data.serverVersion === 'string' ? data.serverVersion : ''),
          onClose: () => setDialog(null),
        });
      } else if (dialog !== null && dialog.kind === 'delete' && dialog.computer) {
        layer = h(DeleteDialog, {
          computer: dialog.computer,
          onClose: () => setDialog(null),
          onDeleted: handleDeleted,
        });
      }

      /* Real badge counts: one light GET per computer, cached for the life of
       * the page and refreshed by the access dialog. /state's sugar stays as
       * the fallback until the first read lands. Keyed by the id list so the
       * 5 s /state poll does not re-request. */
      React.useEffect(() => {
        if (computers === null) return;
        for (const computer of computers) {
          const id = computer && computer.id ? String(computer.id) : '';
          if (id === '' || accessCounts.current.has(id) || accessRequested.current.has(id)) continue;
          accessRequested.current.add(id);
          void (async () => {
            try {
              const payload = await scope.current.run((signal) => api.readComputerAccess(id, signal));
              const presets = payload && Array.isArray(payload.presets) ? payload.presets : null;
              if (presets === null || !alive.current) return;
              accessCounts.current.set(id, {
                used: presets.filter((preset) => preset.allowed === true).length,
                total: presets.length,
              });
              setCountsVersion((value) => value + 1);
            } catch (error) {
              /* Keep the /state fallback count for this computer. */
            }
          })();
        }
      }, [computers === null ? '' : computers.map((computer) => (computer && computer.id ? computer.id : '')).join(',')]);

      return h('section', { className: 'dshc-root', 'aria-label': t('nav') },
        h('div', { className: 'dshc-head' },
          h('div', { className: 'dshc-headMain' },
            h('h2', { className: 'dshc-title' }, t('title')),
            h('p', { className: 'dshc-desc' }, t('description')))),
        notice !== null ? h(Notice, { kind: notice.kind, text: notice.text }) : null,
        /* PRIMARY (v1.7.0, v1.8.0): 登录账号 or one address joins this
         * machine. Everything else about being a hub is secondary and lives
         * in 高级 at the bottom. */
        showRuntime
          ? h(JoinCard, {
            view: runtime,
            account,
            discover,
            onStatus: handleRuntimeStatus,
            onRetry: () => { void loadRuntime(); },
            onNeedAccount: needAccount,
            onNeedDiscover: needDiscover,
            onAccount: handleAccountStatus,
          })
          : null,
        showComputers
          ? h('div', null,
            h('div', { className: 'dshc-groupHead' },
              h('div', { className: 'dshc-groupTitle' }, t('computers.group')),
              joinUrl !== '' ? h(CopyJoinButton, { value: joinUrl }) : null),
            body)
          : null,
        /* ADVANCED (v1.7.3, v1.8.0): exactly two cards — the relay setup and
         * the account center. The 本机地址 rows (relay/public/Tailscale/LAN/
         * loopback candidates, listener line and the loopback banner) were
         * removed from the UI on request: the copyable join address and the
         * blocked hint already say everything a user needs. */
        showComputers && data !== null
          ? h(AdvancedSection, null,
            h(RelayCard, {
              key: 'relay',
              relay,
              busy: relayBusy,
              error: relayAction.error,
              onToggle: (next) => submitRelay({ enabled: next === true }),
              onEnable: (url) => submitRelay({ enabled: true, url }),
              onSaveUrl: (url) => submitRelay({ url }),
              onDismissError: () => setRelayAction({ pending: null, error: null }),
            }),
            h(AccountCenterCard, {
              key: 'account',
              account,
              discover,
              created: createdAccount,
              onNeedDiscover: needDiscover,
              onNeedAccount: needAccount,
              onCreated: handleAccountCreated,
              onAccount: handleAccountStatus,
            }))
          : null,
        layer);
    }

    // #endregion

    // #region access dialogs

    /**
     * The on/off switch used by the access dialogs.
     * @param {object} props - `checked`, `label`, `onChange`, optional `disabled`.
     * @returns {object} switch button.
     */
    function SwitchControl(props) {
      return h('button', {
        type: 'button',
        className: 'dshc-switch',
        role: 'switch',
        'aria-checked': props.checked === true ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled === true,
        onClick: props.disabled === true ? undefined : props.onChange,
      }, h('span', { className: 'dshc-switchThumb' }));
    }

    /**
     * One dialog row: icon, name (+ hint / online state), trailing switch.
     * @param {object} props - `icon`, `name`, `hint`, `online`, `switch`.
     * @returns {object} row element.
     */
    function AccessRow(props) {
      return h('div', { className: 'dshc-accessRow' },
        props.icon ? h('span', { className: 'dshc-accessIcon', 'aria-hidden': 'true' }, props.icon) : null,
        h('div', { className: 'dshc-accessText' },
          h('span', { className: 'dshc-accessName', title: props.name }, props.name),
          props.hint ? h('span', { className: 'dshc-accessHint' }, props.hint) : null,
          props.online === undefined
            ? null
            : h('span', { className: 'dshc-accessStatus' },
              h('span', {
                className: 'dshc-dot',
                'data-state': props.online === true ? 'running' : 'stopped',
                'aria-hidden': 'true',
              }),
              props.online === true ? t('online') : t('offline'))),
        props.switch,
        props.reason ? h('p', { className: 'dshc-accessReason' }, props.reason) : null);
    }

    /**
     * Agent upgrade dialog: the manual one-liner for a machine whose agent is
     * behind the server (task-14 drift flag).
     * @param {object} props - `computer`, `serverUrl`, `expectedVersion`, `onClose`.
     * @returns {object} dialog layer.
     */
    function UpgradeDialog(props) {
      const computer = props.computer || {};
      const serverUrl = typeof props.serverUrl === 'string' && props.serverUrl !== '' ? props.serverUrl : '';
      const command = `node ~/.dsh-computers/agent.mjs service stop && curl -fsSL '${serverUrl}/api/dsh-computers/agent.mjs' -o ~/.dsh-computers/agent.mjs && node ~/.dsh-computers/agent.mjs service start`;
      const current = typeof computer.agentVersion === 'string' && computer.agentVersion !== ''
        ? computer.agentVersion
        : t('drift.unknownVersion');
      const expected = typeof props.expectedVersion === 'string' && props.expectedVersion !== ''
        ? props.expectedVersion
        : '';
      const pluginVersion = typeof props.pluginVersion === 'string' && props.pluginVersion !== ''
        ? props.pluginVersion
        : '';
      const cliCommand = pluginVersion === ''
        ? 'dsh plugin install dsh-computers'
        : `dsh plugin install dsh-computers@${pluginVersion}`;
      const footer = [
        h('button', {
          key: 'close',
          type: 'button',
          className: 'dshc-primary',
          onClick: props.onClose,
        }, t('drift.close')),
      ];

      /* A machine connected through the plugin's own runtime has no
       * ~/.dsh-computers/agent.mjs: the upgrade is a plugin update. */
      if (computer.mode === 'embedded') {
        return h(Dialog, {
          title: t('drift.title'),
          size: 'sm',
          onClose: props.onClose,
          footer,
        },
        h('p', { className: 'dshc-dialogBody' }, t('drift.embedded.body')),
        h('p', { className: 'dshc-dialogBody', style: { marginTop: '6px' } }, t('drift.embedded.steps')),
        h('div', { className: 'dshc-copyStack', style: { marginTop: '12px' } },
          h(CopyRow, { label: t('drift.embedded.cliLabel'), value: cliCommand, stacked: true })));
      }

      return h(Dialog, {
        title: t('drift.title'),
        size: 'sm',
        onClose: props.onClose,
        footer,
      },
      h('p', { className: 'dshc-dialogBody' }, t('drift.body', { current })),
      expected !== ''
        ? h('p', { className: 'dshc-dialogBody', style: { marginTop: '4px' } }, t('drift.expected', { version: expected }))
        : null,
      h('div', { className: 'dshc-copyStack', style: { marginTop: '12px' } },
        h(CopyRow, { label: t('drift.commandLabel'), value: command, stacked: true })),
      h('p', { className: 'dshc-hint' }, t('drift.hint')));
    }

    /**
     * Connect-modal address selector: a combobox over the reachable
     * candidates, so nobody copies a loopback address by accident.
     * @param {object} props - `urls`, `value`, `onChange`, `loopbackOnly`.
     * @returns {object} row element.
     */
    function AddressPicker(props) {
      const options = orderServerUrls(Array.isArray(props.urls) ? props.urls : []);
      const choices = options.some((entry) => isSelectableAddress(entry))
        ? options.filter((entry) => isSelectableAddress(entry))
        : options;
      const [open, setOpen] = React.useState(false);
      const listRef = React.useRef(null);
      const state = useCopyText(props.value);
      useEscapeLayer(open, () => setOpen(false));
      const current = choices.find((entry) => entry.url === props.value) || choices[0] || { url: '', kind: '' };

      React.useEffect(() => {
        if (!open) return undefined;
        const list = listRef.current;
        if (list === null || typeof list.querySelectorAll !== 'function') return undefined;
        const focusOption = (offset) => {
          let items = [];
          try {
            items = Array.prototype.slice.call(list.querySelectorAll('[role="option"]:not([disabled])'));
          } catch (error) {
            return;
          }
          if (items.length === 0) return;
          const active = typeof document !== 'undefined' ? document.activeElement : null;
          const index = items.indexOf(active);
          const next = offset === 'first'
            ? 0
            : (offset === 'last'
              ? items.length - 1
              : (index < 0 ? 0 : (index + offset + items.length) % items.length));
          try {
            items[next].focus();
          } catch (error) {
            /* ignore */
          }
        };
        focusOption(0);
        const onKeyDown = (event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            focusOption(1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            focusOption(-1);
          } else if (event.key === 'Home') {
            event.preventDefault();
            event.stopPropagation();
            focusOption('first');
          } else if (event.key === 'End') {
            event.preventDefault();
            event.stopPropagation();
            focusOption('last');
          }
        };
        list.addEventListener('keydown', onKeyDown);
        return () => list.removeEventListener('keydown', onKeyDown);
      }, [open]);

      const action = t('connect.copyField', { field: props.value });
      return h('div', { className: 'dshc-copyRow dshc-copyRow--stacked dshc-addrPicker' },
        h('div', { className: 'dshc-copyRowTop' },
          h('span', { className: 'dshc-copyRowKey' }, t('connect.serverUrl')),
          h('button', {
            type: 'button',
            className: 'dshc-addrCombo',
            role: 'combobox',
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': 'dshc-addr-listbox',
            'aria-label': t('addr.listLabel'),
            onClick: () => setOpen((value) => !value),
            onKeyDown: (event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setOpen(true);
              } else if ((event.key === 'Enter' || event.key === ' ') && open) {
                event.preventDefault();
                setOpen(false);
              }
            },
          },
            h('span', { className: 'dshc-addrKind' }, addressKindLabel(current.kind)),
            h('code', { className: 'dshc-addrComboUrl', title: current.url }, current.url),
            h(IconChevron, { size: 12, className: 'dshc-targetChevron' })),
          h('button', {
            type: 'button',
            className: 'dshc-copyRowBtn',
            'data-copied': state.copied ? 'true' : 'false',
            'aria-label': action,
            title: state.copied ? t('connect.copied') : action,
            disabled: typeof props.value !== 'string' || props.value === '',
            onClick: () => { void state.copy(); },
          }, state.copied ? h(IconCheck, { size: 13 }) : h(IconCopy, { size: 13 }))),
        open
          ? h('div', {
            ref: listRef,
            id: 'dshc-addr-listbox',
            className: 'dshc-addrListbox',
            role: 'listbox',
            'aria-label': t('addr.listLabel'),
          }, options.map((entry) => {
            const reachable = isReachableAddress(entry);
            const selectable = choices.some((choice) => choice.url === entry.url);
            return h('button', {
              key: entry.url,
              type: 'button',
              role: 'option',
              'aria-selected': entry.url === props.value ? 'true' : 'false',
              'aria-disabled': selectable ? 'false' : 'true',
              'data-unreachable': reachable ? 'false' : 'true',
              className: 'dshc-addrOption',
              tabIndex: -1,
              disabled: !selectable,
              onClick: () => {
                if (!selectable) return;
                props.onChange(entry.url);
                setOpen(false);
              },
            },
            h('span', { className: 'dshc-addrDot', 'data-recommended': entry.url === preferredServerUrl(options) ? 'true' : 'false', 'aria-hidden': 'true' }),
            h('span', { className: 'dshc-addrKind' }, addressKindLabel(entry.kind)),
            h('code', { className: 'dshc-addrComboUrl', title: entry.url }, entry.url),
            !reachable
              ? h('span', { className: 'dshc-addrBadge dshc-addrUnreachable' }, t('addr.unreachable'))
              : null,
            entry.url === props.value ? h(IconCheck, { size: 12, className: 'dshc-menuCheck' }) : null);
          }))
          : null,
        props.loopbackOnly === true
          ? h('p', { className: 'dshc-addrInlineWarn' }, t('addr.loopbackOnlyShort'))
          : null,
        h('p', { className: 'dshc-copyRowHint' }, t('connect.serverUrlHint')));
    }

    /**
     * Which source the effective relay url came from, when the host reports
     * it: `'ui'` is the override this card saved, `'config'` is the file
     * default. Hosts that predate the url override send nothing.
     * @param {object|null} relay - `state.relay`.
     * @returns {string|null} `'ui'`, `'config'` or null.
     */
    function relayUrlSourceOf(relay) {
      if (relay === null || typeof relay !== 'object') return null;
      return relay.urlSource === 'ui' || relay.urlSource === 'config' ? relay.urlSource : null;
    }

    /**
     * Whether the 中继 card has anything to say. An enabled relay always
     * renders. A disabled one renders when the host reports `urlSource` (the
     * card is then the setup surface, even with no address yet) or the older
     * `canEnable`; a host that predates both keeps the quiet-when-off
     * behaviour, and a host with no `state.relay` at all renders nothing.
     * @param {object|null} relay - `state.relay`.
     * @returns {boolean} whether to render the card.
     */
    function relayCardVisible(relay) {
      if (relay === null || typeof relay !== 'object') return false;
      if (relay.enabled === true) return true;
      if (relayUrlSourceOf(relay) !== null) return true;
      return typeof relay.canEnable === 'boolean';
    }

    /**
     * 「中继」 card in 高级: the relay link that makes this machine reachable
     * from other machines and phones without a public IP or an open port. The
     * card is self-sufficient — it takes the relay address, enables it, and
     * changes it, so setting the relay up is one click here instead of editing
     * a config file.
     * @param {object} props - `relay` (`state.relay`), `busy`, `error`,
     *   `onToggle(enabled)`, `onEnable(url)`, `onSaveUrl(url)`.
     * @returns {object|null} card element, or null when the host is silent.
     */
    function RelayCard(props) {
      const relay = props.relay;
      /* 修改 reveals the address input again; the draft survives a rejected
       * POST so the user can correct it in place. */
      const [editing, setEditing] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      if (!relayCardVisible(relay)) return null;
      const phase = relayPhaseOf(relay);
      const enabled = relay.enabled === true;
      const urlSource = relayUrlSourceOf(relay);
      /* A host that reports `urlSource` accepts `{ url }` overrides; older
       * hosts only know the enable route, so their card stays switch-only. */
      const urlCapable = urlSource !== null;
      /* On an old host `canEnable` is the only signal: true means the
       * enable route exists, false means the host cannot do it from here.
       * On a url-capable host the card owns the setup, so `canEnable:false`
       * just means "no address yet" and the form below is the way forward. */
      const legacySwitchable = relay.canEnable === true;
      const busy = props.busy === true;
      const error = typeof props.error === 'string' && props.error !== '' ? props.error : null;
      const effectiveUrl = typeof relay.url === 'string' ? relay.url.trim() : '';
      const hasUrl = effectiveUrl !== '';
      /* No address yet: the input + 启用 is the whole setup. 修改 opens the
       * same form over an existing address, with 保存/取消. */
      const formMode = !urlCapable ? null : (!hasUrl ? 'enable' : (editing ? 'edit' : null));
      /* The switch is the view-mode control; the one exception is an enabled
       * relay whose address was cleared (the host stays enabled and failed),
       * where the user must still be able to turn it off next to the form. */
      const showSwitch = formMode === null
        ? (urlCapable ? hasUrl : legacySwitchable)
        : (urlCapable && !hasUrl && enabled);
      const showUpgrade = !urlCapable && relay.canEnable === false;
      const dotState = phase === 'connected'
        ? 'running'
        : (phase === 'failed' ? 'failed' : (phase === 'disabled' ? 'stopped' : 'connecting'));
      const statusKey = phase === 'connected'
        ? 'relay.status.connected'
        : (phase === 'failed'
          ? 'relay.status.failed'
          : (phase === 'disabled' ? 'relay.status.disabled' : 'relay.status.connecting'));
      const hubId = typeof relay.hubId === 'string' ? relay.hubId.trim() : '';
      /* `publicUrl` is the address other machines use. `url` is the relay
       * endpoint itself (often wss://), so it only stands in when it is an
       * ordinary http(s) address; never label a socket URL 公网地址. */
      const publicUrl = typeof relay.publicUrl === 'string' && relay.publicUrl !== ''
        ? relay.publicUrl
        : (typeof relay.url === 'string' && /^https?:\/\//i.test(relay.url) ? relay.url : '');
      /* `enabledSource` says whether the current state came from the UI
       * override or the config file. It is exposed for tooling/debugging
       * rather than repeated as card copy, so the card stays quiet. */
      const source = relay.enabledSource === 'ui' || relay.enabledSource === 'config'
        ? relay.enabledSource
        : undefined;

      const submitToggle = async () => {
        if (busy || typeof props.onToggle !== 'function') return;
        await props.onToggle(!enabled);
      };
      const submitEnable = async () => {
        if (busy || typeof props.onEnable !== 'function' || draft.trim() === '') return;
        const ok = await props.onEnable(draft.trim());
        if (ok === true) setDraft('');
      };
      const submitSave = async () => {
        if (busy || typeof props.onSaveUrl !== 'function') return;
        const ok = await props.onSaveUrl(draft);
        if (ok === true) {
          setEditing(false);
          setDraft('');
        }
      };
      const startEdit = () => {
        setDraft(effectiveUrl);
        setEditing(true);
      };
      const cancelEdit = () => {
        setEditing(false);
        setDraft('');
        if (typeof props.onDismissError === 'function') props.onDismissError();
      };
      const submitForm = () => {
        void (formMode === 'edit' ? submitSave() : submitEnable());
      };

      return h('div', {
        className: 'dshc-card2 dshc-relayCard',
        'data-state': phase,
        'data-enabled': enabled ? 'true' : 'false',
        'data-source': source,
        'data-url-source': urlSource,
      },
        h('div', { className: 'dshc-card2Head' },
          h('span', { className: 'dshc-card2Title' }, t('relay.title')),
          h('span', { className: 'dshc-status', 'data-state': dotState },
            h('span', { className: 'dshc-dot', 'data-state': dotState, 'aria-hidden': 'true' }),
            t(statusKey))),
        hubId !== ''
          ? h('div', { className: 'dshc-runtimeMeta' },
            h('span', { className: 'dshc-runtimeMetaKey' }, t('relay.hubLabel')),
            h('code', { className: 'dshc-relayId', title: hubId }, hubId))
          : null,
        urlCapable && hasUrl
          ? h('div', { className: 'dshc-copyStack dshc-relayAddr' },
            h(CopyRow, { label: t('relay.urlField'), value: effectiveUrl, stacked: true }))
          : null,
        publicUrl !== ''
          ? h('div', { className: 'dshc-copyStack dshc-relayUrl' },
            h(CopyRow, { label: t('relay.urlLabel'), value: publicUrl, stacked: true }))
          : null,
        phase === 'failed'
          ? h('p', { className: 'dshc-relayLine', 'data-kind': 'failed', role: 'status' },
            t('relay.failedLine', { message: relayMessageOf(relay) }))
          : null,
        formMode !== null
          ? h('div', { className: 'dshc-formRow dshc-relayForm' },
            h('label', { className: 'dshc-field' },
              h('span', { className: 'dshc-fieldLabel' }, t('relay.urlField')),
              h('input', {
                className: 'dshc-input',
                type: 'url',
                value: draft,
                placeholder: t('relay.urlPlaceholder'),
                'aria-label': t('relay.urlField'),
                autoComplete: 'off',
                spellCheck: false,
                disabled: busy,
                onChange: (event) => { setDraft(event.target.value); },
                onKeyDown: (event) => {
                  if (event && event.key === 'Enter') {
                    event.preventDefault();
                    submitForm();
                  }
                },
              })),
            h('div', { className: 'dshc-relayFormActions' },
              formMode === 'edit'
                ? h('button', {
                  type: 'button',
                  className: 'dshc-ghost',
                  disabled: busy,
                  onClick: cancelEdit,
                }, t('relay.cancel'))
                : null,
              h('button', {
                type: 'button',
                className: 'dshc-primary dshc-formSubmit',
                disabled: busy || (formMode === 'enable' && draft.trim() === ''),
                onClick: submitForm,
              }, formMode === 'edit' ? t('relay.save') : t('relay.enableAction'))))
          : null,
        showSwitch
          ? h('div', { className: 'dshc-runtimeActions' },
            h('div', { className: 'dshc-switchLabel' },
              h('button', {
                type: 'button',
                className: 'dshc-switch',
                role: 'switch',
                'aria-checked': enabled ? 'true' : 'false',
                'aria-label': t('relay.enable'),
                disabled: busy,
                onClick: busy || typeof props.onToggle !== 'function'
                  ? undefined
                  : () => { void submitToggle(); },
              }, h('span', { className: 'dshc-switchThumb' })),
              h('span', null, t('relay.enable'))),
            urlCapable && typeof props.onSaveUrl === 'function'
              ? h('button', {
                type: 'button',
                className: 'dshc-textBtn dshc-relayEdit',
                disabled: busy,
                onClick: startEdit,
              }, t('relay.edit'))
              : null)
          : null,
        showUpgrade
          ? h('p', { className: 'dshc-hint dshc-relayHint dshc-relayUpgrade' }, t('relay.upgradeHint'))
          : null,
        h('p', { className: 'dshc-hint dshc-relayHint' }, t('relay.hint')),
        error !== null ? h('p', { className: 'dshc-formError', role: 'alert' }, error) : null);
    }

    /**
     * Session access dialog — which computers this conversation may use
     * (PROTOCOL access API, task-11). Toggles POST the whole allow-list.
     * @param {object} props - `sessionId`, `onClose`, `onSaved(payload)`, `onManageComputers()`.
     * @returns {object} dialog layer.
     */
    function SessionAccessDialog(props) {
      const [view, setView] = React.useState({ phase: 'loading', data: null });
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const alive = React.useRef(true);
      const scope = React.useRef(null);
      if (scope.current === null) scope.current = createScope();

      React.useEffect(() => {
        alive.current = true;
        scope.current.run((signal) => api.readAccess(props.sessionId, signal))
          .then((payload) => {
            if (!alive.current) return;
            if (payload && typeof payload === 'object') setView({ phase: 'ready', data: payload });
            else setView({ phase: 'error', data: null });
          })
          .catch((error) => {
            if (!alive.current || (error && error.name === 'AbortError')) return;
            setView({ phase: 'error', data: null, error });
          });
        return () => {
          alive.current = false;
          scope.current.abortAll();
        };
      }, [props.sessionId]);

      const computers = view.data && Array.isArray(view.data.computers) ? view.data.computers : null;
      const allowedCount = computers === null ? 0 : computers.filter((entry) => entry.allowed === true).length;

      const toggle = async (computer) => {
        if (computers === null || busy) return;
        const previous = view.data;
        /* The switch acts on the SESSION rule: `sessionAllowed` is the raw
         * rule (null = all), while each row's `allowed` is the effective
         * (session AND preset) state. */
        const rawRule = Array.isArray(previous.sessionAllowed)
          ? previous.sessionAllowed
          : computers.map((entry) => entry.id);
        const ruleSet = new Set(rawRule);
        if (ruleSet.has(computer.id)) ruleSet.delete(computer.id);
        else ruleSet.add(computer.id);
        const nextIds = Array.from(ruleSet).sort();
        /* Allowing every known computer posts null ("all, including future
         * machines"); an explicit list would freeze the set. */
        const allOn = computers.length > 0 && nextIds.length === computers.length;
        const optimistic = {
          ...previous,
          sessionAllowed: allOn ? null : nextIds,
          computers: computers.map((entry) => ({
            ...entry,
            sessionAllowed: ruleSet.has(entry.id),
            allowed: ruleSet.has(entry.id) && entry.presetAllowed !== false,
          })),
        };
        setFailure(null);
        setView({ phase: 'ready', data: optimistic });
        setBusy(true);
        try {
          const result = await scope.current.run((signal) => api.setAccess(props.sessionId, allOn ? null : nextIds, signal));
          if (!alive.current) return;
          const next = result && typeof result === 'object' ? result : optimistic;
          setView({ phase: 'ready', data: next });
          if (typeof props.onSaved === 'function') props.onSaved(next);
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setView({ phase: 'ready', data: previous });
          setFailure(t('access.saveFailed', { message: messageOf(error) }));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      let body;
      if (computers === null && view.phase === 'loading') {
        body = h('div', { className: 'dshc-accessRow' }, h(Spinner), h('span', { className: 'dshc-accessHint' }, t('access.loading')));
      } else if (computers === null) {
        body = h('div', { className: 'dshc-errorCard', role: 'alert' },
          h('span', { className: 'dshc-errorText' },
            t('error.loadDetail', { title: t('access.loadFailed'), message: view.error ? messageOf(view.error) : '' })));
      } else {
        const rows = [h(AccessRow, {
          key: 'cloud',
          icon: h(IconMonitor, { size: 15 }),
          name: t('target.cloud'),
          hint: t('access.cloudHint'),
          switch: h(SwitchControl, { checked: true, disabled: true, label: t('target.cloud') }),
        })].concat(computers.map((computer) => h(AccessRow, {
          key: computer.id || computer.name,
          icon: h(IconMonitor, { size: 15 }),
          name: typeof computer.name === 'string' && computer.name !== '' ? computer.name : String(computer.id || ''),
          online: computer.online === true,
          reason: computer.allowed !== true && computer.sessionAllowed === true && computer.presetAllowed === false
            ? t('access.presetDenied')
            : null,
          switch: h(SwitchControl, {
            checked: computer.allowed === true,
            disabled: busy,
            label: t('access.badgeAria', { name: computer.name || '' }),
            onChange: () => { void toggle(computer); },
          }),
        })));
        body = h('div', null,
          h('div', { className: 'dshc-accessList' }, rows),
          computers.length === 0 ? h('p', { className: 'dshc-accessEmpty' }, t('access.computersEmpty')) : null,
          computers.length > 0 && allowedCount === 0
            ? h('p', { className: 'dshc-hint' }, t('access.noneHint'))
            : null);
      }

      return h(Dialog, {
        title: t('access.session.title'),
        subtitle: t('access.session.subtitle'),
        size: 'sm',
        footerClassName: 'dshc-footerSplit',
        onClose: props.onClose,
        footer: [
          h('button', {
            key: 'manage',
            type: 'button',
            className: 'dshc-textBtn',
            onClick: () => {
              props.onClose();
              if (typeof props.onManageComputers === 'function') props.onManageComputers();
            },
          }, h(IconGear, { size: 13 }), t('access.manageComputers')),
          h('button', {
            key: 'done',
            type: 'button',
            className: 'dshc-primary',
            onClick: props.onClose,
          }, t('access.done')),
        ],
      },
      body,
      failure !== null ? h('p', { className: 'dshc-formError', role: 'alert' }, failure) : null);
    }

    /**
     * Computer access dialog — which agent presets ("Bots") may use this
     * computer (PROTOCOL access/computer, task-11).
     * @param {object} props - `computer`, `onClose`, `onChanged(counts)`.
     * @returns {object} dialog layer.
     */
    function ComputerAccessDialog(props) {
      const computerId = props.computer && props.computer.id ? String(props.computer.id) : '';
      const [view, setView] = React.useState({ phase: 'loading', data: null });
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const alive = React.useRef(true);
      const scope = React.useRef(null);
      if (scope.current === null) scope.current = createScope();

      const report = (payload) => {
        if (typeof props.onChanged !== 'function') return;
        const list = payload && Array.isArray(payload.presets) ? payload.presets : null;
        if (list === null) return;
        props.onChanged({
          used: list.filter((entry) => entry.allowed === true).length,
          total: list.length,
        });
      };

      React.useEffect(() => {
        alive.current = true;
        scope.current.run((signal) => api.readComputerAccess(computerId, signal))
          .then((payload) => {
            if (!alive.current) return;
            if (payload && typeof payload === 'object') {
              setView({ phase: 'ready', data: payload });
              report(payload);
            } else {
              setView({ phase: 'error', data: null });
            }
          })
          .catch((error) => {
            if (!alive.current || (error && error.name === 'AbortError')) return;
            setView({ phase: 'error', data: null, error });
          });
        return () => {
          alive.current = false;
          scope.current.abortAll();
        };
      }, [computerId]);

      const presets = view.data && Array.isArray(view.data.presets) ? view.data.presets : null;

      const toggle = async (preset) => {
        if (presets === null || busy) return;
        const previous = view.data;
        const rawRule = Array.isArray(previous.allowedPresets)
          ? previous.allowedPresets
          : presets.map((entry) => entry.id);
        const ruleSet = new Set(rawRule);
        if (ruleSet.has(preset.id)) ruleSet.delete(preset.id);
        else ruleSet.add(preset.id);
        const nextIds = Array.from(ruleSet).sort();
        /* All presets on posts null ("all, including presets added later"). */
        const allOn = presets.length > 0 && nextIds.length === presets.length;
        const optimistic = {
          ...previous,
          allowedPresets: allOn ? null : nextIds,
          presets: presets.map((entry) => ({ ...entry, allowed: ruleSet.has(entry.id) })),
        };
        setFailure(null);
        setView({ phase: 'ready', data: optimistic });
        setBusy(true);
        try {
          const result = await scope.current.run((signal) => api.setComputerAccess(computerId, allOn ? null : nextIds, signal));
          if (!alive.current) return;
          const next = result && typeof result === 'object' ? result : optimistic;
          setView({ phase: 'ready', data: next });
          report(next);
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setView({ phase: 'ready', data: previous });
          setFailure(t('access.saveFailed', { message: messageOf(error) }));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      let body;
      if (presets === null && view.phase === 'loading') {
        body = h('div', { className: 'dshc-accessRow' }, h(Spinner), h('span', { className: 'dshc-accessHint' }, t('access.loading')));
      } else if (presets === null) {
        body = h('div', { className: 'dshc-errorCard', role: 'alert' },
          h('span', { className: 'dshc-errorText' },
            t('error.loadDetail', { title: t('access.loadFailed'), message: view.error ? messageOf(view.error) : '' })));
      } else if (presets.length === 0) {
        body = h('p', { className: 'dshc-accessEmpty' }, t('access.presetsEmpty'));
      } else {
        body = h('div', { className: 'dshc-accessList' }, presets.map((preset) => {
          const name = preset.id === 'default'
            ? t('access.defaultPreset')
            : (typeof preset.name === 'string' && preset.name !== '' ? preset.name : String(preset.id || ''));
          return h(AccessRow, {
            key: preset.id || preset.name,
            name,
            switch: h(SwitchControl, {
              checked: preset.allowed === true,
              disabled: busy,
              label: t('access.badgeAria', { name }),
              onChange: () => { void toggle(preset); },
            }),
          });
        }));
      }

      return h(Dialog, {
        title: (props.computer && (props.computer.name || props.computer.hostname)) || t('access.computer.titleFallback', { id: computerId }),
        subtitle: t('access.computer.subtitle'),
        size: 'sm',
        onClose: props.onClose,
        footer: [
          h('button', {
            key: 'done',
            type: 'button',
            className: 'dshc-primary',
            onClick: props.onClose,
          }, t('access.done')),
        ],
      },
      body,
      failure !== null ? h('p', { className: 'dshc-formError', role: 'alert' }, failure) : null);
    }

    // #endregion

    // #region main panel

    /**
     * `sidebar.panellist` icon: the shell owns the row button, label and the
     * click that selects the matching `main` panel.
     * @param {object} props - `{ size, active }` from the sidebar.
     * @returns {object} monitor icon.
     */
    function SidebarPanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
      return h(IconMonitor, { size });
    }

    /**
     * The `main` panel page: the same 电脑管理 view as the settings section,
     * in a panel-scoped scroll container (the settings shell supplies its own
     * padding; a main panel has none).
     * @returns {object} page element.
     */
    function ComputersPanelPage() {
      useStyles();
      useLocaleRevision();
      return h('div', { className: 'dshc-page' },
        h('div', { className: 'dshc-pageContent' }, h(ComputersPanel)));
    }

    // #endregion

    // #region composer target chip

    /**
     * Composer target-computer chip (slot `conversation.input.left`, session scope).
     *
     * Shows which machine this session is aimed at and lets the user switch it:
     * 云端电脑 (the server itself) or one of the connected computers. The menu is
     * portaled to <body> because the composer clips its own overflow.
     * @param {object} props - `sessionId` plus whatever the composer passes.
     * @returns {object|null} chip element, or null when the chip does not apply.
     */
    function TargetChip(props) {
      useStyles();
      useLocaleRevision();
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : '';
      const [view, setView] = React.useState({ phase: 'loading', role: null, computers: [] });
      /* Account directory: the other machines signed into the same account are
       * selectable targets (`acct:<machineId>`). `known` stays false until the
       * host answers, so an older host simply offers the local computers. */
      const [account, setAccount] = React.useState({ known: false, loggedIn: false, machineId: '', devices: [] });
      const [selection, setSelection] = React.useState({ computerId: null, computer: null });
      const [open, setOpen] = React.useState(false);
      const [anchor, setAnchor] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const [allowedIds, setAllowedIds] = React.useState(null);
      const [accessOpen, setAccessOpen] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const alive = React.useRef(true);
      const scope = React.useRef(null);
      const chipRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const pending = React.useRef(false);
      const initialFocus = React.useRef(0);
      const failureTimer = React.useRef(null);
      const noticeTimer = React.useRef(null);
      const accountRequested = React.useRef(false);
      const goneCleared = React.useRef(null);
      if (scope.current === null) scope.current = createScope();

      const applySelection = React.useCallback((result) => {
        setSelection({
          computerId: result && typeof result.computerId === 'string' && result.computerId !== '' ? result.computerId : null,
          computer: result && result.computer && typeof result.computer === 'object' ? result.computer : null,
        });
      }, []);

      /* Which computers this session may use. Unknown → show everything; the
       * host still enforces, and a denied computer is never offered. */
      const loadAccess = React.useCallback(async () => {
        if (sessionId === '') return;
        try {
          const payload = await scope.current.run((signal) => api.readAccess(sessionId, signal));
          if (!alive.current) return;
          const list = payload && Array.isArray(payload.computers) ? payload.computers : null;
          setAllowedIds(list === null ? null : list
            .filter((entry) => entry.allowed === true)
            .map((entry) => entry.id));
        } catch (error) {
          if (!alive.current) return;
          setAllowedIds(null);
        }
      }, [sessionId]);

      /* Account status → the picker's second group. A payload without the
       * account (older host, logged out) is still authoritative: `known`
       * lets the chip fall back to 本地电脑 when a target vanishes. */
      const applyAccount = React.useCallback((payload) => {
        if (payload === null || typeof payload !== 'object') return;
        setAccount({
          known: true,
          loggedIn: payload.loggedIn === true,
          machineId: typeof payload.machineId === 'string' ? payload.machineId : '',
          devices: Array.isArray(payload.devices)
            ? payload.devices.filter((device) => device !== null && typeof device === 'object')
            : [],
        });
      }, []);

      const loadAccount = React.useCallback(async () => {
        if (sessionId === '') return;
        try {
          const payload = await scope.current.run((signal) => api.readAccount(signal));
          if (!alive.current) return;
          applyAccount(payload);
        } catch (error) {
          /* A host without the account route keeps `known: false`. */
        }
      }, [applyAccount, sessionId]);

      /* One /state + /selection round per tick; a state failure hides the chip
       * (there is no honest target to display). */
      const load = React.useCallback(async () => {
        if (sessionId === '') return;
        let state;
        try {
          state = await scope.current.run((signal) => api.readState(signal));
        } catch (error) {
          if (!alive.current || (error && error.name === 'AbortError')) return;
          setView({ phase: 'hidden', role: null, computers: [] });
          return;
        }
        if (!alive.current) return;
        const role = roleOf(state);
        if (role === 'runtime') {
          setView({ phase: 'hidden', role, computers: [] });
          return;
        }
        setView({
          phase: 'ready',
          role,
          computers: state && Array.isArray(state.computers) ? state.computers : [],
        });
        /* /state may already carry the account; otherwise ask once. */
        if (state && state.account !== null && typeof state.account === 'object') {
          accountRequested.current = true;
          applyAccount(state.account);
        } else if (!accountRequested.current) {
          accountRequested.current = true;
          void loadAccount();
        }
        try {
          const current = await scope.current.run((signal) => api.readSelection(sessionId, signal));
          if (!alive.current || pending.current) return;
          applySelection(current);
        } catch (error) {
          /* A selection read failure keeps the last known target on screen. */
        }
      }, [applyAccount, applySelection, loadAccount, sessionId]);

      React.useEffect(() => {
        alive.current = true;
        if (sessionId === '') {
          setView({ phase: 'hidden', role: null, computers: [] });
          return () => { alive.current = false; };
        }
        setAllowedIds(null);
        void load();
        void loadAccess();
        const poll = setInterval(() => {
          if (alive.current) void load();
        }, STATE_POLL_MS);
        return () => {
          alive.current = false;
          clearInterval(poll);
          if (failureTimer.current !== null) {
            clearTimeout(failureTimer.current);
            failureTimer.current = null;
          }
          if (noticeTimer.current !== null) {
            clearTimeout(noticeTimer.current);
            noticeTimer.current = null;
          }
          if (scope.current) scope.current.abortAll();
        };
      }, [load, loadAccess, sessionId]);

      const computers = view.computers;
      const selectedId = selection.computerId;
      const selectedComputer = selection.computer;
      /* `acct:<machineId>` names a directory device; anything else names a
       * locally connected computer. A target that no longer resolves falls
       * back to 本地电脑 — the effect below also clears the stored selection. */
      const selectedMachineId = typeof selectedId === 'string' && selectedId.slice(0, 5) === 'acct:'
        ? selectedId.slice(5)
        : '';
      const selectedDevice = selectedMachineId === ''
        ? null
        : (account.devices.find((device) => deviceMachineId(device) === selectedMachineId) || null);
      const currentLabel = (() => {
        if (selectedId === null || selectedId === '') return t('target.cloud');
        if (selectedMachineId !== '') {
          return selectedDevice !== null ? deviceName(selectedDevice) : t('target.cloud');
        }
        if (selectedComputer && typeof selectedComputer.name === 'string' && selectedComputer.name !== '') {
          return selectedComputer.name;
        }
        const local = computers.find((computer) => String(computer.id || '') === String(selectedId));
        const localName = local !== undefined && typeof local.name === 'string' ? local.name : '';
        return localName !== '' ? localName : t('target.cloud');
      })();

      /* The account's other machines: selectable targets pinned as
       * `acct:<machineId>`. Offline or 不被控 rows are listed but disabled,
       * with the reason on the row. */
      const accountRows = account.loggedIn
        ? account.devices
          .filter((device) => {
            const machineId = deviceMachineId(device);
            if (machineId === '') return false;
            return account.machineId === '' || machineId !== account.machineId;
          })
          .map((device) => {
            const machineId = deviceMachineId(device);
            const online = device.online === true;
            const controllable = deviceControllable(device);
            const reasons = [];
            if (!online) reasons.push(t('target.offline'));
            if (!controllable) reasons.push(t('target.notControllable'));
            return {
              key: `acct-${machineId}`,
              id: `acct:${machineId}`,
              label: deviceName(device),
              hint: platformLabelOf(device.platform),
              computer: null,
              device,
              offline: !online,
              disabled: reasons.length > 0,
              reason: reasons.join(' · '),
            };
          })
        : [];

      const menuRows = [
        {
          key: 'cloud',
          id: null,
          label: t('target.cloud'),
          hint: t('target.cloudHint'),
          computer: null,
          offline: false,
        },
      ].concat(computers
        .filter((computer) => allowedIds === null || allowedIds.indexOf(computer.id) >= 0)
        .map((computer) => ({
        key: String(computer.id || computer.name || ''),
        id: computer.id,
        label: typeof computer.name === 'string' && computer.name !== ''
          ? computer.name
          : (typeof computer.hostname === 'string' && computer.hostname !== '' ? computer.hostname : String(computer.id || '')),
        hint: typeof computer.platformLabel === 'string' ? computer.platformLabel : '',
        computer,
        offline: computer.online !== true,
      })))
        .concat(accountRows.length === 0
          ? []
          : [{ key: 'account-group', groupHeader: true, label: t('target.accountGroup') }].concat(accountRows));

      /* DOM menuitem index of a row: group headers are not focusable items. */
      const menuItemIndex = (row) => {
        let index = 0;
        for (const entry of menuRows) {
          if (entry === row) return index;
          if (entry.groupHeader !== true) index += 1;
        }
        return 0;
      };
      const menuItemCount = menuRows.filter((row) => row.groupHeader !== true).length;

      const menuItems = () => {
        if (menuRef.current === null || typeof menuRef.current.querySelectorAll !== 'function') return [];
        try {
          return Array.prototype.slice.call(menuRef.current.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'));
        } catch (error) {
          return [];
        }
      };

      const focusRow = (index) => {
        const items = menuItems();
        if (items.length === 0) return;
        const next = ((index % items.length) + items.length) % items.length;
        try {
          items[next].focus();
        } catch (error) {
          /* ignore */
        }
      };

      const openMenu = (preferLast) => {
        void loadAccess();
        /* Refresh the account directory so machines that just came online (or
         * vanished) are reflected before the list is read. */
        void loadAccount();
        const checked = menuRows.findIndex((row) => (row.id === null ? selectedId === null : row.id === selectedId));
        initialFocus.current = preferLast
          ? Math.max(0, menuItemCount - 1)
          : (checked >= 0 ? menuItemIndex(menuRows[checked]) : 0);
        setFailure(null);
        setOpen(true);
      };

      const showNotice = React.useCallback((text) => {
        setNotice(text);
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => {
          noticeTimer.current = null;
          if (alive.current) setNotice(null);
        }, 5000);
      }, []);

      const closeMenu = (restoreFocus) => {
        setOpen(false);
        if (!restoreFocus) return;
        try {
          if (chipRef.current && typeof chipRef.current.focus === 'function') chipRef.current.focus();
        } catch (error) {
          /* ignore */
        }
      };

      /* A selected account device that leaves the directory (or the account is
       * signed out) must not strand the session: fall back to 本地电脑, say so
       * once, and clear the stored target on the host. */
      React.useEffect(() => {
        const id = selection.computerId;
        if (typeof id !== 'string' || id.slice(0, 5) !== 'acct:') return;
        if (!account.known) return;
        const machineId = id.slice(5);
        if (machineId === '') return;
        if (account.devices.some((device) => deviceMachineId(device) === machineId)) return;
        setSelection({ computerId: null, computer: null });
        if (goneCleared.current === id) return;
        goneCleared.current = id;
        showNotice(t('target.deviceGone'));
        void (async () => {
          try {
            await scope.current.run((signal) => api.selectTarget(sessionId, null, signal));
          } catch (error) {
            /* The local fallback already happened; nothing else to do. */
          }
        })();
      }, [account, selection.computerId, sessionId, showNotice]);

      /* Anchor above the chip, focus the checked row, and own the outside
       * dismissals while open. */
      React.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined;
        const doc = document;
        const position = () => {
          const chip = chipRef.current;
          if (!chip || typeof chip.getBoundingClientRect !== 'function') return;
          const rect = chip.getBoundingClientRect();
          const viewportWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1024;
          const viewportHeight = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 768;
          const left = Math.max(8, Math.min(rect.left, viewportWidth - 248 - 8));
          const bottom = Math.max(8, viewportHeight - rect.top + 6);
          setAnchor({
            left,
            bottom,
            maxHeight: Math.max(160, Math.min(340, viewportHeight - bottom - 12)),
          });
        };
        position();
        focusRow(initialFocus.current);
        const onPointerDown = (event) => {
          const menu = menuRef.current;
          const chip = chipRef.current;
          if (menu && menu.contains && menu.contains(event.target)) return;
          if (chip && chip.contains && chip.contains(event.target)) return;
          setOpen(false);
        };
        doc.addEventListener('mousedown', onPointerDown, true);
        doc.addEventListener('touchstart', onPointerDown, true);
        doc.addEventListener('resize', position, true);
        doc.addEventListener('scroll', position, true);
        return () => {
          doc.removeEventListener('mousedown', onPointerDown, true);
          doc.removeEventListener('touchstart', onPointerDown, true);
          doc.removeEventListener('resize', position, true);
          doc.removeEventListener('scroll', position, true);
        };
      }, [open]);

      const onMenuKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeMenu(true);
          return;
        }
        const items = menuItems();
        if (event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          if (items.length === 0) return;
          const active = typeof document !== 'undefined' ? document.activeElement : null;
          const index = items.indexOf(active);
          const next = event.shiftKey
            ? (index <= 0 ? items.length - 1 : index - 1)
            : (index < 0 || index === items.length - 1 ? 0 : index + 1);
          try {
            items[next].focus();
          } catch (error) {
            /* ignore */
          }
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        if (items.length === 0) return;
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        const index = items.indexOf(active);
        let next = index;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = items.length - 1;
        else if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length;
        else next = index <= 0 ? items.length - 1 : index - 1;
        try {
          items[next].focus();
        } catch (error) {
          /* ignore */
        }
      };

      /* Optimistic switch: the chip moves first, then reverts on failure. */
      const choose = async (row) => {
        if (row.disabled === true) return;
        if (view.phase !== 'ready' || sessionId === '' || pending.current) return;
        const previous = selection;
        const nextId = row.id;
        const nextComputer = row.computer;
        setOpen(false);
        setFailure(null);
        setSelection({ computerId: nextId, computer: nextComputer });
        pending.current = true;
        try {
          const result = await scope.current.run((signal) => api.selectTarget(sessionId, nextId, signal));
          if (!alive.current) return;
          applySelection(result && typeof result === 'object' ? result : { computerId: nextId, computer: nextComputer });
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setSelection(previous);
          setFailure(t('target.failed', { message: messageOf(error) }));
          if (failureTimer.current !== null) clearTimeout(failureTimer.current);
          failureTimer.current = setTimeout(() => {
            failureTimer.current = null;
            if (alive.current) setFailure(null);
          }, 5000);
        } finally {
          pending.current = false;
        }
      };

      if (view.phase !== 'ready') return null;

      const chip = h('button', {
        ref: chipRef,
        type: 'button',
        className: 'dshc-target',
        'data-open': open ? 'true' : 'false',
        'aria-haspopup': 'menu',
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': t('target.chipLabel', { name: currentLabel }),
        title: currentLabel,
        onClick: () => {
          if (open) closeMenu(false);
          else openMenu(false);
        },
        onKeyDown: (event) => {
          if (open) return;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu(false);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu(true);
          }
        },
      },
        h(IconMonitor, { size: 14 }),
        h('span', { className: 'dshc-targetLabel' }, currentLabel),
        h(IconChevron, { size: 12, className: 'dshc-targetChevron' }));

      const menu = open && anchor !== null
        ? renderLayer(h('div', {
          ref: menuRef,
          className: 'dshc-menu',
          role: 'menu',
          'aria-label': t('target.menuLabel'),
          style: {
            left: `${anchor.left}px`,
            bottom: `${anchor.bottom}px`,
            maxHeight: `${anchor.maxHeight}px`,
          },
          onKeyDown: onMenuKeyDown,
          /* React portals bubble through the REACT tree, so a row click would
           * reach the composer's own handlers without this stop (the shipped
           * Menu primitive does the same). */
          onClick: (event) => event.stopPropagation(),
          onMouseDown: (event) => event.stopPropagation(),
        },
          menuRows.map((row) => {
            if (row.groupHeader === true) {
              return h('div', {
                key: row.key,
                className: 'dshc-menuGroup',
                role: 'group',
                'aria-label': row.label,
              }, row.label);
            }
            const checked = row.id === null ? selectedId === null : row.id === selectedId;
            const disabled = row.disabled === true;
            const isAccount = typeof row.id === 'string' && row.id.slice(0, 5) === 'acct:';
            const reason = row.reason ? row.reason : (row.offline ? t('target.offline') : '');
            return h('button', {
              key: row.key,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': checked ? 'true' : 'false',
              'aria-disabled': disabled ? 'true' : undefined,
              className: 'dshc-menuItem',
              'data-checked': checked ? 'true' : 'false',
              'data-offline': row.offline ? 'true' : 'false',
              'data-account': isAccount ? 'true' : undefined,
              'data-disabled': disabled ? 'true' : undefined,
              tabIndex: -1,
              title: reason !== '' ? reason : undefined,
              onClick: () => { void choose(row); },
            },
              row.id === null ? h(IconCloud, { size: 14 }) : h(IconMonitor, { size: 14 }),
              h('span', { className: 'dshc-menuName' }, row.label),
              row.hint ? h('span', { className: 'dshc-menuHint' }, row.hint) : null,
              row.id === null ? null : h('span', { className: 'dshc-menuDot', 'data-offline': row.offline ? 'true' : 'false' }),
              reason !== '' ? h('span', { className: 'dshc-menuHint dshc-menuReason' }, reason) : null,
              checked ? h(IconCheck, { size: 13, className: 'dshc-menuCheck' }) : null);
          }),
          h('div', { className: 'dshc-menuSep', role: 'separator' }),
          h('button', {
            key: 'manage-access',
            type: 'button',
            role: 'menuitem',
            className: 'dshc-menuItem dshc-menuManage',
            onClick: () => {
              setOpen(false);
              setAccessOpen(true);
            },
          }, h(IconGear, { size: 14 }), h('span', { className: 'dshc-menuName' }, t('access.manage')))))
        : null;

      return h('span', { className: 'dshc-targetWrap' },
        chip,
        failure !== null
          ? h('span', { className: 'dshc-targetError', role: 'status', title: failure }, failure)
          : null,
        notice !== null
          ? h('span', { className: 'dshc-targetError', 'data-kind': 'info', role: 'status', title: notice }, notice)
          : null,
        menu,
        accessOpen
          ? h(SessionAccessDialog, {
            sessionId,
            onClose: () => {
              setAccessOpen(false);
              try {
                if (chipRef.current && typeof chipRef.current.focus === 'function') chipRef.current.focus();
              } catch (error) {
                /* ignore */
              }
            },
            onSaved: (payload) => {
              const list = payload && Array.isArray(payload.computers) ? payload.computers : null;
              if (list === null) return;
              setAllowedIds(list.filter((entry) => entry.allowed === true).map((entry) => entry.id));
            },
            onManageComputers: () => {
              /* A real destination: the 电脑管理 main panel. The notice stays
               * as the fallback for a shell without ctx.layout. */
              if (selectMainPanel()) return;
              showNotice(t('target.manage'));
            },
          })
          : null);
    }

    // #endregion

    // #region error boundary

    /**
     * Keep a render failure from blanking the whole settings slot.
     * @returns {object} boundary component (passthrough when React.Component is absent).
     */
    const PanelBoundary = (() => {
      const Component = React.Component;
      if (typeof Component !== 'function') {
        return function PanelBoundaryPassthrough(props) {
          return props.children;
        };
      }
      return class PanelBoundary extends Component {
        constructor(props) {
          super(props);
          this.state = { failure: null };
          this.reset = this.reset.bind(this);
        }

        static getDerivedStateFromError(failure) {
          return { failure };
        }

        componentDidCatch(failure) {
          try {
            console.warn('[dsh-computers] panel render failed:', failure);
          } catch (error) {
            /* ignore */
          }
        }

        reset() {
          this.setState({ failure: null });
        }

        render() {
          if (this.state.failure !== null && this.state.failure !== undefined) {
            return h('section', { className: 'dshc-root', 'aria-label': t('nav') },
              h('div', { className: 'dshc-errorCard', role: 'alert' },
                h('span', { className: 'dshc-errorText' }, t('render.error')),
                h('button', { type: 'button', className: 'dshc-ghost', onClick: this.reset }, t('render.reload'))));
          }
          return this.props.children;
        }
      };
    })();

    // #endregion

    // #region plugin

    /**
     * The registered settings page: the board behind a render-error boundary.
     * @param {object} props - owner props `{ close }`; unused here.
     * @returns {object} the 电脑 page.
     */
    function ComputersPanel(props) {
      return h(PanelBoundary, null, h(ComputersBoard, { close: props ? props.close : undefined }));
    }

    /**
     * Mount the settings page (PROTOCOL §7).
     * @param {object} ctx - client root context (services: slots, locale).
     */
    function apply(ctx) {
      rootCtx = ctx;
      if (ctx && ctx.locale) {
        localeFace = ctx.locale;
        const register = () => ctx.locale.register(NS, { zh, en });
        const runRegister = () => {
          try {
            if (typeof ctx.effect === 'function') {
              ctx.effect(() => register(), 'dsh-computers: dictionaries');
              return null;
            }
            return register();
          } catch (error) {
            try {
              console.warn('[dsh-computers] locale registration failed:', error);
            } catch (ignored) {
              /* ignore */
            }
            return null;
          }
        };
        const dispose = runRegister();
        if (typeof dispose === 'function' && typeof ctx.on === 'function') {
          try {
            ctx.on('dispose', () => {
              try {
                dispose();
              } catch (error) {
                /* ignore */
              }
            });
          } catch (error) {
            /* ignore */
          }
        }
        try {
          runtimeT = ctx.locale.bind(NS);
        } catch (error) {
          runtimeT = null;
        }
      }

      /* Both seats are declared by shell plugins this package does not depend
       * on, so each registration goes through slots.inject: a shell without the
       * seat leaves that surface simply absent instead of failing boot. */
      const mount = (slotName, register) => {
        try {
          const stop = ctx.slots.inject(slotName, register);
          return typeof stop === 'function' ? stop : null;
        } catch (error) {
          try {
            console.warn(`[dsh-computers] ${slotName} registration failed:`, error);
          } catch (ignored) {
            /* ignore */
          }
          return null;
        }
      };

      const mountAll = () => {
        const stops = [];
        const settingsStop = mount('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: () => t('nav'),
        }, ComputersPanel));
        if (settingsStop !== null) stops.push(settingsStop);
        const targetStop = mount('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: TARGET_SLOT_ID,
          order: TARGET_SLOT_ORDER,
          label: () => t('target.label'),
        }, TargetChip));
        if (targetStop !== null) stops.push(targetStop);
        /* Keyed main panel: the destination behind 管理电脑 and the sidebar row. */
        const panelStop = mount('main', () => ctx.slots.register({
          name: 'main',
          key: SECTION_ID,
        }, ComputersPanelPage));
        if (panelStop !== null) stops.push(panelStop);
        return () => {
          for (const stop of stops) {
            try {
              stop();
            } catch (error) {
              /* ignore */
            }
          }
        };
      };

      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(mountAll, 'dsh-computers: slots');
        } else {
          mountAll();
        }
      } catch (error) {
        try {
          console.warn('[dsh-computers] slot registration failed:', error);
        } catch (ignored) {
          /* ignore */
        }
      }

      /* The sidebar row is only a destination where there is a hub list to
       * manage: a runtime-only deployment has none (§10.1). The role comes
       * from /state, so the row appears one round trip after load; a failed
       * read registers it (the settings page hides itself if it must). */
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => {
            let cancelled = false;
            let stop = null;
            const register = () => {
              stop = mount('sidebar.panellist', () => ctx.slots.register({
                name: 'sidebar.panellist',
                id: SECTION_ID,
                order: PANEL_ORDER,
                label: () => t('nav'),
              }, SidebarPanelIcon));
            };
            void api.readState()
              .then((payload) => {
                if (cancelled) return;
                if (roleOf(payload) !== 'runtime') register();
              })
              .catch(() => {
                if (cancelled) return;
                register();
              });
            return () => {
              cancelled = true;
              if (stop !== null) {
                try {
                  stop();
                } catch (error) {
                  /* ignore */
                }
              }
            };
          }, 'dsh-computers: sidebar panel');
        }
      } catch (error) {
        try {
          console.warn('[dsh-computers] sidebar panel registration failed:', error);
        } catch (ignored) {
          /* ignore */
        }
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };

    // #endregion
  },
});
