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
      /* Per-session target computer for the composer chip (task-9 host side). */
      selection: 'api/dsh-computers/selection',
    };

    // #region locales

    /* Chinese is the key source; en mirrors every key (PROTOCOL §7). */
    const zh = {
      nav: '电脑',
      title: '电脑',
      description: '把你自己电脑接进来，agent 就能在它上面直接执行命令。',
      'connect.action': '连接电脑',
      'badge.bots': '{used}/{total} Bot',
      online: '在线',
      offline: '离线',
      'rename.action': '重命名',
      'delete.action': '删除',
      loading: '正在加载电脑列表…',
      'empty.title': '还没有连接任何电脑',
      'empty.hint': '点击右上角「连接电脑」，用一行命令把 Mac、Linux 或 Windows 接进来。',
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
      'connect.subtitle': '在这台电脑的 DSH 里打开 设置 → 电脑 → 本机运行时，填入下面的服务器地址和加入密钥',
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
      'connect.serverUrlHint': '本机运行时卡片里填这个地址',
      'connect.enrollmentKey': '加入密钥',
      'connect.enrollmentKeyHint': '15 分钟内有效，只能用一次',
      'connect.copyField': '复制{field}',
      'connect.cliToggle': '没有 DSH 的机器？用命令行接入',
      'connect.cliHint': '在要连接的电脑上安装 Node.js 22+，然后在终端运行下方命令',

      'computers.group': '已连接的电脑',
      'runtime.title': '本机运行时',
      'runtime.desc': '把这台电脑接到一个 DSH 服务器，它就会出现在那台服务器的电脑列表里。',
      'runtime.hint': '加入密钥来自服务器「连接电脑」弹窗里的命令。',
      'runtime.serverLabel': '服务器地址',
      'runtime.serverPlaceholder': 'https://dsh.example.com',
      'runtime.keyLabel': '加入密钥',
      'runtime.keyPlaceholder': 'dshc_…',
      'runtime.connect': '连接',
      'runtime.connecting': '连接中…',
      'runtime.target': '目标服务器',
      'runtime.enable': '启用',
      'runtime.disconnect': '断开',
      'runtime.disconnectTitle': '断开这台电脑？',
      'runtime.disconnectBody': '这台电脑会停止向 {server} 保持连接，并在那台服务器的电脑列表里变为离线。记录会保留（可在服务器上删除），之后也可以随时重新连接。',
      'runtime.disconnectFailed': '断开失败：{message}',
      'runtime.enableFailed': '切换启用状态失败：{message}',
      'runtime.connectFailed': '连接失败：{message}',
      'runtime.loading': '正在读取本机状态…',
      'runtime.loadFailed': '无法读取本机状态',
      'runtime.nameUnknown': '未命名的这台电脑',
      'runtime.status.running': '运行中',
      'runtime.status.stopped': '已停止',
      'runtime.status.connecting': '连接中…',
      'runtime.status.failed': '连接失败',
      'runtime.lastError': '最近错误：{message}',
      'runtime.connected.notice': '本机已接入 {server}',
      'runtime.disconnected.notice': '已断开本机运行时',

      'target.label': '目标电脑',
      'target.cloud': '云端电脑',
      'target.cloudHint': '服务器本机',
      'target.menuLabel': '选择这台会话使用的电脑',
      'target.chipLabel': '这台对话使用的电脑：{name}',
      'target.manage': '在 设置 → 电脑 中管理',
      'target.offline': '离线',
      'target.failed': '切换失败：{message}',
    };

    const en = {
      nav: 'Computers',
      title: 'Computers',
      description: 'Bring your own machines in so the agent can run commands on them.',
      'connect.action': 'Connect computer',
      'badge.bots': '{used}/{total} Bot',
      online: 'Online',
      offline: 'Offline',
      'rename.action': 'Rename',
      'delete.action': 'Delete',
      loading: 'Loading computers…',
      'empty.title': 'No computers connected yet',
      'empty.hint': 'Use “Connect computer” in the top right and run one line in a terminal on a Mac, Linux or Windows machine.',
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
      'connect.subtitle': 'Open Settings → Computers → This computer in the DSH on that machine and paste the server URL and join key below',
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
      'connect.serverUrlHint': 'Paste this into the “This computer” card',
      'connect.enrollmentKey': 'Join key',
      'connect.enrollmentKeyHint': 'Valid for 15 minutes, single use',
      'connect.copyField': 'Copy {field}',
      'connect.cliToggle': 'No DSH on that machine? Use the command line',
      'connect.cliHint': 'Install Node.js 22+ on that machine, then run the command below in a terminal',

      'computers.group': 'Connected computers',
      'runtime.title': 'This computer',
      'runtime.desc': 'Connect this machine to a DSH server and it shows up in that server’s computer list.',
      'runtime.hint': 'The join key comes from the “Connect computer” dialog on that server.',
      'runtime.serverLabel': 'Server URL',
      'runtime.serverPlaceholder': 'https://dsh.example.com',
      'runtime.keyLabel': 'Join key',
      'runtime.keyPlaceholder': 'dshc_…',
      'runtime.connect': 'Connect',
      'runtime.connecting': 'Connecting…',
      'runtime.target': 'Target server',
      'runtime.enable': 'Enabled',
      'runtime.disconnect': 'Disconnect',
      'runtime.disconnectTitle': 'Disconnect this computer?',
      'runtime.disconnectBody': 'This machine stops connecting to {server} and goes offline in that server’s computer list. The record stays until you delete it there, and you can connect again at any time.',
      'runtime.disconnectFailed': 'Disconnect failed: {message}',
      'runtime.enableFailed': 'Could not change the enabled state: {message}',
      'runtime.connectFailed': 'Connect failed: {message}',
      'runtime.loading': 'Reading this computer’s status…',
      'runtime.loadFailed': 'Could not read this computer’s status',
      'runtime.nameUnknown': 'This computer',
      'runtime.status.running': 'Running',
      'runtime.status.stopped': 'Stopped',
      'runtime.status.connecting': 'Connecting…',
      'runtime.status.failed': 'Connection failed',
      'runtime.lastError': 'Last error: {message}',
      'runtime.connected.notice': 'This computer joined {server}',
      'runtime.disconnected.notice': 'This computer’s runtime is disconnected',

      'target.label': 'Target computer',
      'target.cloud': 'Cloud computer',
      'target.cloudHint': 'Server itself',
      'target.menuLabel': 'Choose the computer this session uses',
      'target.chipLabel': 'Computer for this chat: {name}',
      'target.manage': 'Manage in Settings → Computers',
      'target.offline': 'Offline',
      'target.failed': 'Could not switch: {message}',
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

    function IconPlus(props) {
      return h(SvgIcon, { size: props.size, shapes: [['path', { d: 'M12 5v14' }], ['path', { d: 'M5 12h14' }]] });
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
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
}
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
  .dshc-badge { display: none; }
  .dshc-overlay { padding: 16px; }
  .dshc-card { padding: 20px 16px; border-radius: 14px; }
  .dshc-row { padding-left: 13px; }
  .dshc-formSubmit { flex: 1 1 100%; }
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
      runtimeConnect: (serverUrl, key, signal) => requestJson(API.runtimeConnect, {
        method: 'POST',
        body: { serverUrl, key },
        signal,
      }),
      runtimeEnable: (enabled, signal) => requestJson(API.runtimeEnable, {
        method: 'POST',
        body: { enabled },
        signal,
      }),
      runtimeDisconnect: (signal) => requestJson(API.runtimeDisconnect, { method: 'POST', body: {}, signal }),
      readSelection: (sessionId, signal) => requestJson(
        `${API.selection}?sessionId=${encodeURIComponent(sessionId)}`,
        { signal },
      ),
      selectTarget: (sessionId, computerId, signal) => requestJson(API.selection, {
        method: 'POST',
        body: { sessionId, computerId },
        signal,
      }),
    };

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

    function EmptyState() {
      return h('div', { className: 'dshc-empty' },
        h('div', { className: 'dshc-emptyIcon', 'aria-hidden': 'true' }, h(IconMonitor, { size: 20 })),
        h('div', { className: 'dshc-emptyTitle' }, t('empty.title')),
        h('p', { className: 'dshc-emptyHint' }, t('empty.hint')));
    }

    /**
     * One copyable value row — the primary content of the connect modal
     * (server URL and enrollment key).
     * @param {object} props - `label`, `value`, optional `hint`.
     * @returns {object} row element.
     */
    function CopyRow(props) {
      const [copied, setCopied] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const alive = React.useRef(true);
      React.useEffect(() => () => { alive.current = false; }, []);
      const copy = async () => {
        if (typeof props.value !== 'string' || props.value === '') return;
        try {
          await copyText(props.value);
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
      const action = t('connect.copyField', { field: props.label });
      return h('div', { className: 'dshc-copyRow' },
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
      const bots = computer.bots && typeof computer.bots === 'object' ? computer.bots : null;
      const used = bots && typeof bots.used === 'number' ? bots.used : 1;
      const total = bots && typeof bots.total === 'number' ? bots.total : 1;
      const name = typeof computer.name === 'string' && computer.name !== ''
        ? computer.name
        : (typeof computer.hostname === 'string' ? computer.hostname : '');
      return h('div', { className: 'dshc-row', 'data-online': online ? 'true' : 'false' },
        h('div', { className: 'dshc-rowMain' },
          h('span', { className: 'dshc-name', title: name }, name),
          h('span', { className: 'dshc-badge' }, t('badge.bots', { used, total }))),
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
        footer.length > 0 ? h('div', { className: 'dshc-footer' }, footer) : null)));
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

      const command = keyInfo === null
        ? ''
        : (os === 'windows'
          ? (typeof keyInfo.windowsCommand === 'string' ? keyInfo.windowsCommand : '')
          : (typeof keyInfo.command === 'string' ? keyInfo.command : ''));

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

      const primaryServerUrl = keyInfo && typeof keyInfo.serverUrl === 'string' && keyInfo.serverUrl !== ''
        ? keyInfo.serverUrl
        : (typeof props.serverUrl === 'string' ? props.serverUrl : '');
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
      /* PRIMARY (task-8): the plugin path — paste these into 本机运行时. */
      h('div', { className: 'dshc-copyStack' },
        h(CopyRow, {
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
     * The 本机运行时 card (PROTOCOL §10.6): this machine joining a hub.
     * @param {object} props - `view` (runtime request state), `onStatus`, `onRetry`.
     * @returns {object} card element.
     */
    function RuntimeCard(props) {
      const view = props.view;
      const status = view.data;
      const phase = runtimePhaseOf(status);
      const configured = Boolean(status && status.configured === true);
      const [serverUrl, setServerUrl] = React.useState('');
      const [key, setKey] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState(null);
      const [confirming, setConfirming] = React.useState(false);
      const alive = React.useRef(true);
      const scope = React.useRef(null);
      if (scope.current === null) scope.current = createScope();
      React.useEffect(() => () => {
        alive.current = false;
        scope.current.abortAll();
      }, []);

      const submit = async () => {
        const url = serverUrl.trim();
        const enrollmentKey = key.trim();
        if (url === '' || enrollmentKey === '' || busy) return;
        setBusy(true);
        setFailure(null);
        try {
          const next = await scope.current.run((signal) => api.runtimeConnect(url, enrollmentKey, signal));
          if (!alive.current) return;
          setServerUrl('');
          setKey('');
          props.onStatus(next, t('runtime.connected.notice', { server: url }));
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setFailure(t('runtime.connectFailed', { message: messageOf(error) }));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      const toggle = async (next) => {
        if (busy) return;
        setBusy(true);
        setFailure(null);
        try {
          const result = await scope.current.run((signal) => api.runtimeEnable(next, signal));
          if (!alive.current) return;
          props.onStatus(result, null);
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setFailure(t('runtime.enableFailed', { message: messageOf(error) }));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      const enterSubmits = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void submit();
        }
      };

      let body;
      if (status === null && (view.phase === 'loading' || view.phase === 'idle')) {
        body = h('div', { className: 'dshc-runtimeMeta' }, h(Spinner), h('span', null, t('runtime.loading')));
      } else if (status === null) {
        body = h('div', { className: 'dshc-errorCard', role: 'alert' },
          h('span', { className: 'dshc-errorText' },
            t('error.loadDetail', { title: t('runtime.loadFailed'), message: view.error ? messageOf(view.error) : '' })),
          h('button', { type: 'button', className: 'dshc-ghost', onClick: props.onRetry }, t('retry')));
      } else if (!configured) {
        body = h('div', null,
          h('p', { className: 'dshc-hint', style: { margin: '10px 0 0' } }, t('runtime.desc')),
          h('div', { className: 'dshc-formRow' },
            h('label', { className: 'dshc-field' },
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
                onKeyDown: enterSubmits,
              })),
            h('label', { className: 'dshc-field' },
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
                onKeyDown: enterSubmits,
              })),
            h('button', {
              type: 'button',
              className: 'dshc-primary dshc-formSubmit',
              disabled: busy || serverUrl.trim() === '' || key.trim() === '',
              onClick: () => { void submit(); },
            }, busy ? t('runtime.connecting') : t('runtime.connect'))),
          h('p', { className: 'dshc-hint' }, t('runtime.hint')));
      } else {
        const name = typeof status.name === 'string' && status.name !== '' ? status.name : t('runtime.nameUnknown');
        body = h('div', null,
          h('div', { className: 'dshc-runtimeName', title: name }, name),
          h('div', { className: 'dshc-runtimeMeta' },
            h('span', { className: 'dshc-runtimeMetaKey' }, t('runtime.target')),
            h('span', { className: 'dshc-runtimeMetaValue' }, typeof status.serverUrl === 'string' ? status.serverUrl : '')),
          h('div', { className: 'dshc-runtimeActions' },
            h('div', { className: 'dshc-switchLabel' },
              h('button', {
                type: 'button',
                className: 'dshc-switch',
                role: 'switch',
                'aria-checked': status.enabled === true ? 'true' : 'false',
                'aria-label': t('runtime.enable'),
                disabled: busy,
                onClick: () => { void toggle(status.enabled !== true); },
              }, h('span', { className: 'dshc-switchThumb' })),
              h('span', null, t('runtime.enable'))),
            h('button', {
              type: 'button',
              className: 'dshc-textBtn',
              disabled: busy,
              onClick: () => setConfirming(true),
            }, t('runtime.disconnect'))),
          status.lastError
            ? h('p', { className: 'dshc-formError', role: 'status' },
              t('runtime.lastError', { message: String(status.lastError) }))
            : null);
      }

      return h('div', { className: 'dshc-card2' },
        h('div', { className: 'dshc-card2Head' },
          h('span', { className: 'dshc-card2Title' }, t('runtime.title')),
          configured
            ? h('span', { className: 'dshc-status', 'data-state': phase },
              h('span', { className: 'dshc-dot', 'data-state': phase, 'aria-hidden': 'true' }),
              t(`runtime.status.${phase}`))
            : null),
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
     * The page body: the 本机运行时 card, the 已连接的电脑 list, and their states.
     * @returns {object} the 电脑 page.
     */
    function ComputersBoard() {
      useStyles();
      useLocaleRevision();
      const [view, setView] = React.useState({ phase: 'loading', data: null });
      const [runtime, setRuntime] = React.useState({ phase: 'idle', data: null });
      const [dialog, setDialog] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const alive = React.useRef(true);
      const scope = React.useRef(null);
      const noticeTimer = React.useRef(null);
      const runtimeRequested = React.useRef(false);
      if (scope.current === null) scope.current = createScope();

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
        if (initial) setView((current) => ({ phase: current.data === null ? 'loading' : 'ready', data: current.data }));
        try {
          const data = await scope.current.run((signal) => api.readState(signal));
          if (!alive.current) return;
          const next = data && typeof data === 'object' ? data : { computers: [] };
          setView({ phase: 'ready', data: next });
          /* The local runtime card exists only where §10.5 routes do (§10.1). */
          if (roleOf(next) !== 'hub' && !runtimeRequested.current) {
            runtimeRequested.current = true;
            void loadRuntime();
          }
        } catch (error) {
          if (!alive.current) return;
          if (error && error.name === 'AbortError') return;
          setView((current) => ({ phase: current.data === null ? 'error' : 'ready', data: current.data, error }));
        }
      }, [loadRuntime]);

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

      const data = view.data;
      const role = data === null ? null : roleOf(data);
      const computers = data && Array.isArray(data.computers) ? data.computers : null;
      const showRuntime = role !== null && role !== 'hub';
      const showComputers = role !== 'runtime';
      const canConnect = role !== 'runtime';

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
      } else if (computers === null || computers.length === 0) body = h(EmptyState);
      else {
        body = h('div', { className: 'dshc-list' }, computers.map((computer) => h(ComputerRow, {
          key: computer.id || computer.name,
          computer,
          onRename: (target) => setDialog({ kind: 'rename', computer: target }),
          onDelete: (target) => setDialog({ kind: 'delete', computer: target }),
        })));
      }

      let layer = null;
      if (dialog !== null && dialog.kind === 'connect') {
        layer = h(ConnectModal, {
          serverUrl: data && typeof data.serverUrl === 'string' ? data.serverUrl : '',
          onClose: () => setDialog(null),
          onConnected: handleConnected,
        });
      } else if (dialog !== null && dialog.kind === 'rename' && dialog.computer) {
        layer = h(RenameDialog, {
          computer: dialog.computer,
          onClose: () => setDialog(null),
          onRenamed: handleRenamed,
        });
      } else if (dialog !== null && dialog.kind === 'delete' && dialog.computer) {
        layer = h(DeleteDialog, {
          computer: dialog.computer,
          onClose: () => setDialog(null),
          onDeleted: handleDeleted,
        });
      }

      return h('section', { className: 'dshc-root', 'aria-label': t('nav') },
        h('div', { className: 'dshc-head' },
          h('div', { className: 'dshc-headMain' },
            h('h2', { className: 'dshc-title' }, t('title')),
            h('p', { className: 'dshc-desc' }, t('description'))),
          canConnect
            ? h('button', {
              type: 'button',
              className: 'dshc-primary',
              onClick: () => setDialog({ kind: 'connect' }),
            }, h(IconPlus, { size: 15 }), t('connect.action'))
            : null),
        notice !== null ? h(Notice, { kind: notice.kind, text: notice.text }) : null,
        showRuntime
          ? h(RuntimeCard, {
            view: runtime,
            onStatus: handleRuntimeStatus,
            onRetry: () => { void loadRuntime(); },
          })
          : null,
        showComputers
          ? h('div', null,
            h('div', { className: 'dshc-groupTitle' }, t('computers.group')),
            body)
          : null,
        layer);
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
      const [selection, setSelection] = React.useState({ computerId: null, computer: null });
      const [open, setOpen] = React.useState(false);
      const [anchor, setAnchor] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const alive = React.useRef(true);
      const scope = React.useRef(null);
      const chipRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const pending = React.useRef(false);
      const initialFocus = React.useRef(0);
      const failureTimer = React.useRef(null);
      if (scope.current === null) scope.current = createScope();

      const applySelection = React.useCallback((result) => {
        setSelection({
          computerId: result && typeof result.computerId === 'string' && result.computerId !== '' ? result.computerId : null,
          computer: result && result.computer && typeof result.computer === 'object' ? result.computer : null,
        });
      }, []);

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
        try {
          const current = await scope.current.run((signal) => api.readSelection(sessionId, signal));
          if (!alive.current || pending.current) return;
          applySelection(current);
        } catch (error) {
          /* A selection read failure keeps the last known target on screen. */
        }
      }, [applySelection, sessionId]);

      React.useEffect(() => {
        alive.current = true;
        if (sessionId === '') {
          setView({ phase: 'hidden', role: null, computers: [] });
          return () => { alive.current = false; };
        }
        void load();
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
          if (scope.current) scope.current.abortAll();
        };
      }, [load, sessionId]);

      const computers = view.computers;
      const selectedId = selection.computerId;
      const selectedComputer = selection.computer;
      const currentLabel = selectedId === null || selectedId === ''
        ? t('target.cloud')
        : (selectedComputer && typeof selectedComputer.name === 'string' && selectedComputer.name !== ''
          ? selectedComputer.name
          : t('target.cloud'));

      const menuRows = [
        {
          key: 'cloud',
          id: null,
          label: t('target.cloud'),
          hint: t('target.cloudHint'),
          computer: null,
          offline: false,
        },
      ].concat(computers.map((computer) => ({
        key: String(computer.id || computer.name || ''),
        id: computer.id,
        label: typeof computer.name === 'string' && computer.name !== ''
          ? computer.name
          : (typeof computer.hostname === 'string' && computer.hostname !== '' ? computer.hostname : String(computer.id || '')),
        hint: typeof computer.platformLabel === 'string' ? computer.platformLabel : '',
        computer,
        offline: computer.online !== true,
      })));

      const menuItems = () => {
        if (menuRef.current === null || typeof menuRef.current.querySelectorAll !== 'function') return [];
        try {
          return Array.prototype.slice.call(menuRef.current.querySelectorAll('[role="menuitemradio"]'));
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
        const checked = menuRows.findIndex((row) => (row.id === null ? selectedId === null : row.id === selectedId));
        initialFocus.current = preferLast ? menuRows.length - 1 : (checked >= 0 ? checked : 0);
        setFailure(null);
        setOpen(true);
      };

      const closeMenu = (restoreFocus) => {
        setOpen(false);
        if (!restoreFocus) return;
        try {
          if (chipRef.current && typeof chipRef.current.focus === 'function') chipRef.current.focus();
        } catch (error) {
          /* ignore */
        }
      };

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
            const checked = row.id === null ? selectedId === null : row.id === selectedId;
            return h('button', {
              key: row.key,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': checked ? 'true' : 'false',
              className: 'dshc-menuItem',
              'data-checked': checked ? 'true' : 'false',
              'data-offline': row.offline ? 'true' : 'false',
              tabIndex: -1,
              onClick: () => { void choose(row); },
            },
              row.id === null ? h(IconCloud, { size: 14 }) : h(IconMonitor, { size: 14 }),
              h('span', { className: 'dshc-menuName' }, row.label),
              row.hint ? h('span', { className: 'dshc-menuHint' }, row.hint) : null,
              row.id === null ? null : h('span', { className: 'dshc-menuDot', 'data-offline': row.offline ? 'true' : 'false' }),
              row.offline ? h('span', { className: 'dshc-menuHint' }, t('target.offline')) : null,
              checked ? h(IconCheck, { size: 13, className: 'dshc-menuCheck' }) : null);
          }),
          h('div', { className: 'dshc-menuFooter' }, t('target.manage'))))
        : null;

      return h('span', { className: 'dshc-targetWrap' },
        chip,
        failure !== null
          ? h('span', { className: 'dshc-targetError', role: 'status', title: failure }, failure)
          : null,
        menu);
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
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };

    // #endregion
  },
});
