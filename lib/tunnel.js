/**
 * Owned Tailscale Serve mapping (v1.4.0).
 *
 * The desktop app picks a random web port on every launch, so a manually
 * pinned `tailscale serve --https=8443 http://127.0.0.1:<port>` line goes stale
 * after each restart — and pinning the port in DSH config caused an
 * EADDRINUSE race with the previous instance. Instead the plugin re-points the
 * Serve mapping to the port it actually bound, on every load.
 *
 * Behaviour (PROTOCOL §4, v1.4.0):
 * - opt-in via `tailscaleServe: { enabled, httpsPort }` (default disabled);
 * - after the web server binds, run
 *   `tailscale serve --bg --https=<httpsPort> http://127.0.0.1:<port>`
 *   (PATH binary, then the macOS app bundle);
 * - read the tailnet DNS name from `tailscale status --json` (`.Self.DNSName`);
 * - expose `{ enabled, configured, url, targetPort, error }` for `/state.tunnel`
 *   and make the connect UI prefer that URL;
 * - be idempotent: if the existing Serve status already points at our port,
 *   skip the serve command (an operator's 8443 mapping is not fought);
 * - never throw, never block the host: all failures are recorded in `error`.
 *
 * Node builtins only.
 */

import { execFile } from 'node:child_process'

/** Budget for the `tailscale serve` invocation (it is `--bg` and returns fast). */
const SERVE_START_TIMEOUT_MS = 500

/** Budget for the whole activation (bind wait + serve + status reads). */
const TOTAL_TIMEOUT_MS = 10_000

/** Budget for one status read. */
const STATUS_TIMEOUT_MS = 5_000

/** How often to look for the freshly bound web port. */
const PORT_POLL_MS = 50

/** PATH binary first, then the macOS app bundle. */
const TAILSCALE_BINARIES = Object.freeze(['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'])

const readyTunnel = (enabled) => ({ enabled, configured: false, url: '', targetPort: null, error: null })

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

/** Await `value`, rejecting after `ms`. */
function withTimeout(value, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
    Promise.resolve(value).then((result) => {
      clearTimeout(timer)
      resolve(result)
    }, (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** Default runner: execFile with a hard timeout. Never rejects. */
function execTailscale({ binary, args, timeoutMs }) {
  return new Promise((resolve) => {
    try {
      execFile(binary, args, {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        resolve({
          code: error === null || error === undefined
            ? 0
            : (typeof error.code === 'number' ? error.code : null),
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          error: error === null || error === undefined ? null : String(error.message ?? error),
        })
      })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: String(error?.message ?? error) })
    }
  })
}

/** True when `stderr`/`error` look like the binary does not exist. */
const isMissingBinary = (result) => result.code === null
  && typeof result.error === 'string'
  && /ENOENT/.test(result.error)

/** Strip the trailing dot Tailscale puts on DNS names. */
function cleanDnsName(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\.+$/, '')
  return trimmed === '' ? null : trimmed
}

/**
 * Create the tunnel manager for one plugin mount.
 * @param {object} options - wiring.
 * @param {object} options.ctx - Cordis context (`webServer.port` getter, optional `tunnelExec` seam).
 * @param {{ enabled?: boolean, httpsPort?: number }} options.config - resolved tailscaleServe config.
 * @param {(message: string) => void} [options.onWarn] - warning sink.
 * @returns {{ start: () => Promise<void>, status: () => object, dispose: () => void }} manager.
 */
export function createTunnel({ ctx, config, onWarn = () => {} }) {
  const enabled = config?.enabled === true
  const httpsPort = Number.isSafeInteger(config?.httpsPort) && config.httpsPort > 0 && config.httpsPort <= 65535
    ? config.httpsPort
    : 8443
  const status = readyTunnel(enabled)
  let stopped = false

  /** Run one tailscale invocation, falling back to the app-bundle binary. */
  const runTailscale = async (args, timeoutMs) => {
    const seam = ctx?.tunnelExec
    if (typeof seam === 'function') {
      try {
        const result = await withTimeout(Promise.resolve(seam({ binary: TAILSCALE_BINARIES[0], args, timeoutMs })), timeoutMs + 500, 'tunnel command')
        return result !== null && typeof result === 'object' ? result : { code: null, stdout: '', stderr: '', error: 'bad tunnel result' }
      } catch (error) {
        return { code: null, stdout: '', stderr: '', error: String(error?.message ?? error) }
      }
    }
    for (let index = 0; index < TAILSCALE_BINARIES.length; index += 1) {
      const result = await execTailscale({ binary: TAILSCALE_BINARIES[index], args, timeoutMs })
      if (!isMissingBinary(result)) return result
    }
    return { code: null, stdout: '', stderr: '', error: 'tailscale binary not found' }
  }

  /** Read `tailscale status --json` once. */
  const readStatusJson = async () => {
    const result = await runTailscale(['status', '--json'], STATUS_TIMEOUT_MS)
    if (result.code !== 0 || typeof result.stdout !== 'string' || result.stdout.trim() === '') {
      return { payload: null, error: result.error ?? (result.stderr.trim() !== '' ? result.stderr.trim() : `tailscale status exited with code ${result.code}`) }
    }
    try {
      return { payload: JSON.parse(result.stdout), error: null }
    } catch {
      return { payload: null, error: 'tailscale status --json returned invalid JSON' }
    }
  }

  /** True when the current Serve status already forwards to our loopback port. */
  const serveTargetsPort = async (port) => {
    const needle = `127.0.0.1:${port}`
    const json = await runTailscale(['serve', 'status', '--json'], STATUS_TIMEOUT_MS)
    if (json.code === 0 && typeof json.stdout === 'string' && json.stdout.trim() !== '') {
      try {
        if (JSON.stringify(JSON.parse(json.stdout)).includes(needle)) return true
      } catch {
        // Fall through to the text form.
      }
    }
    const text = await runTailscale(['serve', 'status'], STATUS_TIMEOUT_MS)
    return text.code === 0 && typeof text.stdout === 'string' && text.stdout.includes(needle)
  }

  /** Wait for the web server to bind (the getter throws/returns undefined before that). */
  const waitForPort = async (deadline) => {
    while (Date.now() < deadline) {
      if (stopped) return null
      try {
        const port = ctx?.webServer?.port
        if (Number.isSafeInteger(port) && port > 0 && port <= 65535) return port
      } catch {
        // Not bound yet.
      }
      await sleep(PORT_POLL_MS)
    }
    return null
  }

  /** One activation attempt. Errors are recorded in `status.error`, never thrown. */
  const activate = async () => {
    status.error = null
    const deadline = Date.now() + TOTAL_TIMEOUT_MS
    const port = await waitForPort(deadline)
    if (port === null) {
      status.error = 'the DSH web server did not bind a port, so Tailscale Serve was not configured'
      return
    }
    status.targetPort = port

    // Re-point on every load, but do not fight an operator's existing mapping.
    let alreadyPointed = false
    try {
      alreadyPointed = await serveTargetsPort(port)
    } catch {
      alreadyPointed = false
    }

    if (!alreadyPointed && !stopped) {
      const serve = await runTailscale(
        ['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${port}`],
        SERVE_START_TIMEOUT_MS,
      )
      if (serve.code !== 0) {
        // A start-timeout kill may still have applied the mapping; confirm it.
        const applied = await serveTargetsPort(port).catch(() => false)
        if (!applied) {
          status.error = serve.error
            ?? (serve.stderr.trim() !== '' ? serve.stderr.trim() : `tailscale serve exited with code ${serve.code}`)
          return
        }
      }
    }

    const { payload, error } = await readStatusJson()
    if (payload === null) {
      status.error = error ?? 'could not read tailscale status'
      return
    }
    const dnsName = cleanDnsName(payload?.Self?.DNSName)
    if (dnsName === null) {
      status.error = 'tailscale status did not report a tailnet DNS name (.Self.DNSName)'
      return
    }
    status.url = `https://${dnsName}:${httpsPort}`
    status.configured = true
  }

  return {
    /** Start (or re-point) the tunnel. Never rejects. */
    async start() {
      if (!enabled) return
      try {
        await withTimeout(activate(), TOTAL_TIMEOUT_MS + 1_000, 'tailscale serve setup')
      } catch (error) {
        status.configured = false
        status.url = ''
        status.error = String(error?.message ?? error)
        try {
          onWarn(`dsh-computers: Tailscale Serve setup failed: ${status.error}`)
        } catch {
          // A broken logger must not break the plugin.
        }
      }
    },
    /** Snapshot for /state.tunnel. */
    status() {
      return {
        enabled: status.enabled,
        configured: status.configured,
        url: status.url,
        targetPort: status.targetPort,
        error: status.error,
      }
    },
    /** Stop polling (a plugin reload starts a fresh manager). */
    dispose() {
      stopped = true
    },
  }
}
