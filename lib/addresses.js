/**
 * Reachable-address candidates for this deployment (v1.3.3).
 *
 * The hub commonly binds `127.0.0.1` (the desktop app always does), so the
 * connect dialog used to hand other machines `http://127.0.0.1:<port>` — an
 * address that can only ever work on the hub itself. This module collects every
 * plausible way another machine could reach the hub, in preference order, so
 * the settings page can show a picker and generate a one-liner that works.
 *
 * Nothing here is authoritative: the listener may not actually be bound to a
 * Tailscale/LAN interface. `loopbackOnly` tells the UI that only the local
 * address is a safe recommendation; the rest are candidates the user may know
 * are reachable (e.g. a reverse proxy in front, or a `--host 0.0.0.0` bind).
 *
 * Never throws, never blocks for long: the Tailscale probe is best-effort with
 * a hard timeout and a ~60 s cache (a missing binary is normal on Linux
 * servers and inside containers).
 *
 * Node builtins only.
 */

import { execFile } from 'node:child_process'
import { hostname as osHostname, networkInterfaces as osNetworkInterfaces } from 'node:os'

import { resolveBaseUrl } from './http.js'

/** Candidate kinds, in auto-preference order. */
export const ADDRESS_KINDS = Object.freeze(['relay', 'tunnel', 'public', 'forwarded', 'host', 'tailscale', 'lan', 'mdns', 'loopback'])

/** Display labels for each kind (the client uses them verbatim). */
export const ADDRESS_LABELS = Object.freeze({
  relay: '中继',
  tunnel: 'Tailscale Serve',
  public: '公网',
  forwarded: '转发地址',
  host: '当前访问地址',
  tailscale: 'Tailscale',
  lan: '局域网',
  mdns: '本机名',
  loopback: '本机',
})

/** Values accepted by the `preferAddress` config key. */
export const PREFER_ADDRESS_VALUES = Object.freeze(['auto', 'public', 'tailscale', 'lan', 'loopback'])

/** Total probe budget per binary attempt (PROTOCOL task: ~500 ms). */
const TAILSCALE_TIMEOUT_MS = 500

/** How long a probe result (including "none") is reused. */
const TAILSCALE_CACHE_MS = 60_000

/** macOS app-bundle binary, used when `tailscale` is not on PATH. */
const TAILSCALE_APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

/** Module-level cache: one machine has one Tailscale address at a time. */
let tailscaleCache = { at: 0, ip: null }

/** Reset the probe cache (tests / diagnostics). */
export function resetTailscaleCache() {
  tailscaleCache = { at: 0, ip: null }
}

/** True for a valid dotted-quad IPv4 string. */
const isIpv4 = (value) => typeof value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.trim())
  && value.trim().split('.').every((part) => Number(part) <= 255)

/** True for `100.64.0.0/10` (Tailscale / CGNAT). */
export const isCgnatIpv4 = (value) => {
  if (!isIpv4(value)) return false
  const [first, second] = value.trim().split('.').map(Number)
  return first === 100 && second >= 64 && second <= 127
}

/** True for any loopback IPv4/hostname (127.0.0.0/8, localhost, ::1). */
export const isLoopbackHost = (value) => {
  if (typeof value !== 'string') return false
  const host = value.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

/** True for a wildcard bind (`0.0.0.0`/`::`/empty): every interface is reachable. */
export const isWildcardHost = (value) => {
  if (typeof value !== 'string') return true
  const host = value.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return host === '' || host === '0.0.0.0' || host === '::'
}

/** Normalize a bind host or URL hostname: strip IPv6 brackets, lowercase. */
function normalizeHost(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
}

/** A URL's hostname without brackets, lowercase ('' when malformed). */
function hostOfUrl(url) {
  try {
    return normalizeHost(new URL(url).hostname)
  } catch {
    return ''
  }
}

/** Put an IPv6 host back in brackets for use inside a URL. */
function formatHost(host) {
  const normalized = normalizeHost(host)
  return normalized.includes(':') ? `[${normalized}]` : normalized
}

/**
 * The listener's bind facts (v1.4.0): `ctx.webServer` exposes `host`, `port`
 * and `protocol` getters. A missing host is treated as loopback — the desktop
 * app's default, and the conservative assumption for reachability.
 * `wildcard` is internal (not part of the public payload).
 */
function listenerOf(ctx) {
  let host = null
  try {
    const value = ctx?.webServer?.host
    if (typeof value === 'string' && value.trim() !== '') host = value.trim()
  } catch {
    host = null
  }
  const normalized = normalizeHost(host ?? '127.0.0.1')
  const port = boundPortOf(ctx)
  return { host: normalized, port, loopback: isLoopbackHost(normalized), wildcard: isWildcardHost(normalized) }
}

/**
 * Is a candidate actually reachable given where the listener is bound (v1.4.0)?
 * The desktop app binds 127.0.0.1 only, so advertising a Tailscale/LAN address
 * there is a lie that cost a real user an outage.
 */
function candidateReachable(kind, host, listener) {
  // A ready Tailscale Serve mapping is proven by the successful serve command:
  // Tailscale terminates TLS and forwards to our loopback listener.
  if (kind === 'tunnel') return true
  // The relay address (v1.6.0) is only offered while the hub's outbound link is
  // up (the caller filters on that), so its reachability is proven too.
  if (kind === 'relay') return true
  if (kind === 'public') return true // operator promise (proxy/tunnel may front it)
  if (kind === 'forwarded' || kind === 'host') return !isLoopbackHost(host) // it arrived through a proxy
  if (kind === 'loopback') return listener.loopback || listener.wildcard
  // tailscale/lan/mdns: binding is per-interface.
  return listener.wildcard || normalizeHost(host) === listener.host
}

/** True when a URL's host is loopback (malformed URLs are not loopback). */
export function isLoopbackUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    return isLoopbackHost(new URL(value.trim()).hostname)
  } catch {
    return false
  }
}

/** First IPv4 of `tailscale ip -4` output. */
function firstIpv4(text) {
  if (typeof text !== 'string') return null
  for (const line of text.split('\n')) {
    const candidate = line.trim()
    if (isIpv4(candidate)) return candidate
  }
  return null
}

/** Run one tailscale binary; null when missing/timed out/invalid. */
function probeBinary(binary) {
  return new Promise((resolve) => {
    try {
      execFile(binary, ['ip', '-4'], {
        timeout: TAILSCALE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 64 * 1024,
      }, (error, stdout) => {
        if (error) {
          resolve({ missing: error.code === 'ENOENT', ip: null })
          return
        }
        const ip = firstIpv4(stdout)
        resolve({ missing: false, ip })
      })
    } catch {
      resolve({ missing: true, ip: null })
    }
  })
}

/**
 * Best-effort Tailscale IPv4 probe: PATH binary first, then the macOS app
 * bundle. Cached for ~60 s, including failures. Never throws.
 * @returns {Promise<string | null>} the Tailscale IPv4, or null.
 */
export async function probeTailscaleIp() {
  const now = Date.now()
  if (now - tailscaleCache.at < TAILSCALE_CACHE_MS) return tailscaleCache.ip
  try {
    const first = await probeBinary('tailscale')
    if (first.ip !== null) {
      tailscaleCache = { at: Date.now(), ip: first.ip }
      return first.ip
    }
    if (!first.missing) {
      // An installed binary that timed out or printed nothing: do not spawn a
      // second copy of the same client just to fail slower.
      tailscaleCache = { at: Date.now(), ip: null }
      return null
    }
    const bundled = await probeBinary(TAILSCALE_APP_BINARY)
    const ip = bundled.ip
    tailscaleCache = { at: Date.now(), ip }
    return ip
  } catch {
    tailscaleCache = { at: Date.now(), ip: null }
    return null
  }
}

/** Normalize `os.networkInterfaces()` into a flat IPv4 list. */
function ipv4Addresses(interfaces) {
  const out = []
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if (entry === null || typeof entry !== 'object') continue
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      if (typeof entry.address !== 'string') continue
      out.push({ address: entry.address.trim(), internal: entry.internal === true })
    }
  }
  return out
}

/** The bound port (or the port implied by the resolved request origin). */
function boundPortOf(ctx) {
  const direct = ctx?.webServer?.port
  if (Number.isSafeInteger(direct) && direct > 0 && direct <= 65535) return direct
  return null
}

/** Append `:port` when known. */
function withPort(host, port) {
  return port === null ? `http://${host}` : `http://${host}:${port}`
}

/** Trim a trailing slash without touching a path prefix. */
const trimTrailing = (value) => value.replace(/\/+$/, '')

/**
 * Collect reachable-address candidates, ordered, deduped, exactly one
 * recommended.
 *
 * Order: relay (v1.6.0, only while connected) → Tailscale Serve → publicUrl →
 * request-derived non-loopback → Tailscale → LAN → mDNS `<hostname>.local` →
 * loopback. `preferAddress` overrides which kind is recommended (falling back to
 * the auto order when that kind is absent).
 *
 * @param {object} options - inputs (all optional; production passes ctx/config/req).
 * @param {object} [options.ctx] - Cordis context (`webServer.port`/`getOrigin`).
 * @param {{ publicUrl?: string, preferAddress?: string }} [options.config] - plugin config.
 * @param {import('node:http').IncomingMessage} [options.req] - the request being served.
 * @param {() => Promise<string | null>} [options.probeTailscale] - probe override (tests).
 * @param {object} [options.interfaces] - `os.networkInterfaces()` override (tests).
 * @param {string} [options.hostname] - hostname override (tests).
 * @param {number} [options.port] - bound-port override (tests).
 * @param {string} [options.tunnel] - ready Tailscale Serve URL (v1.4.0).
 * @param {string | { publicUrl?: string, connected?: boolean }} [options.relay] - relay entry URL (v1.6.0); an object carries its live state.
 * @param {boolean} [options.relayConnected] - relay link state when `relay` is a plain URL.
 * @returns {Array<{ url: string, kind: string, label: string, recommended: boolean, reachable: boolean }>} candidates.
 */
export async function collectServerUrls({
  ctx, config, req, probeTailscale, interfaces, hostname, port, tunnel, relay, relayConnected,
} = {}) {
  try {
    const candidates = []
    const listener = listenerOf(ctx)
    if (Number.isSafeInteger(port) && port > 0) listener.port = port
    const add = (kind, url) => {
      if (typeof url !== 'string' || url.trim() === '') return
      const cleaned = trimTrailing(url.trim())
      if (cleaned === '' || candidates.some((candidate) => candidate.url === cleaned)) return
      const host = hostOfUrl(cleaned)
      candidates.push({
        url: cleaned,
        kind,
        label: ADDRESS_LABELS[kind] ?? kind,
        recommended: false,
        reachable: candidateReachable(kind, host, listener),
      })
    }

    const configured = typeof config?.publicUrl === 'string' ? config.publicUrl.trim() : ''
    const baseUrl = safeResolveBaseUrl({ ctx, config, req })
    const boundPort = listener.port

    // 0. The relay entry (v1.6.0): only while the outbound link is connected —
    //    a dead address is worse than no address. First, because it is the only
    //    candidate that works from anywhere, including mobile networks.
    const relayUrl = typeof relay === 'string'
      ? relay.trim()
      : (relay !== null && typeof relay === 'object' && typeof relay.publicUrl === 'string' ? relay.publicUrl.trim() : '')
    const relayUp = typeof relayConnected === 'boolean'
      ? relayConnected
      : relay !== null && typeof relay === 'object' && relay.connected === true
    if (relayUrl !== '' && relayUp) add('relay', relayUrl)

    // 1. The plugin's own Tailscale Serve mapping (v1.4.0): only present when
    //    the serve command succeeded, so it is genuinely reachable and wins.
    if (typeof tunnel === 'string' && tunnel.trim() !== '') add('tunnel', tunnel)

    // 2. Explicit operator override.
    if (configured !== '') add('public', configured)

    // 3. The address the current request itself names (only when not loopback:
    //    a loopback request origin is exactly what other machines cannot use).
    let derivedKind = null
    if (baseUrl !== '' && !isLoopbackUrl(baseUrl)) {
      const headers = req?.headers ?? {}
      const forwarded = headers['x-forwarded-proto'] !== undefined
        || headers['x-forwarded-host'] !== undefined
        || headers['x-forwarded-ssl'] !== undefined
        || headers.forwarded !== undefined
      derivedKind = forwarded ? 'forwarded' : 'host'
      add(derivedKind, baseUrl)
    }

    // 4. Tailscale (probe or CGNAT interface scan).
    const probe = typeof probeTailscale === 'function' ? probeTailscale : probeTailscaleIp
    let tailscaleIp = null
    try {
      const probed = await withTimeout(Promise.resolve(probe()), TAILSCALE_TIMEOUT_MS + 100)
      tailscaleIp = typeof probed === 'string' ? probed : null
    } catch {
      tailscaleIp = null
    }
    const resolvedInterfaces = interfaces ?? osNetworkInterfaces()
    const ipv4 = ipv4Addresses(resolvedInterfaces)
    if (tailscaleIp === null) {
      const scanned = ipv4.find((entry) => !entry.internal && isCgnatIpv4(entry.address))
      if (scanned !== undefined) tailscaleIp = scanned.address
    }
    if (isIpv4(tailscaleIp)) add('tailscale', withPort(tailscaleIp, boundPort))

    // 5. LAN IPv4.
    const lan = ipv4.find((entry) => !entry.internal
      && !isLoopbackHost(entry.address)
      && !isCgnatIpv4(entry.address))
    if (lan !== undefined) add('lan', withPort(lan.address, boundPort))

    // 6. mDNS hostname.
    const name = typeof hostname === 'string' && hostname.trim() !== '' ? hostname.trim() : osHostname()
    if (name !== '' && !/\.local$/i.test(name)) add('mdns', withPort(`${name}.local`, boundPort))

    // 7. Loopback — always last.
    if (boundPort !== null) add('loopback', withPort('127.0.0.1', boundPort))
    else if (baseUrl !== '' && isLoopbackUrl(baseUrl)) add('loopback', baseUrl)

    // v1.4.0: only an actually reachable candidate may be recommended. When the
    // listener binds a specific non-loopback address that no candidate covers,
    // offer that bind address itself (it is reachable by construction).
    const reachable = candidates.filter((candidate) => candidate.reachable)
    if (reachable.length === 0 && !listener.loopback && !listener.wildcard) {
      let scheme = 'http:'
      try {
        if (baseUrl !== '') scheme = new URL(baseUrl).protocol
      } catch {
        scheme = 'http:'
      }
      const suffix = listener.port === null ? '' : `:${listener.port}`
      add('host', `${scheme}//${formatHost(listener.host)}${suffix}`)
    }

    // Preference order among reachable candidates: public → request-derived →
    // the candidate matching the bind host (tailscale/lan/mdns order) → loopback.
    const preferred = typeof config?.preferAddress === 'string' ? config.preferAddress : 'auto'
    const preferredCandidate = preferred === 'auto'
      ? undefined
      : candidates.find((candidate) => candidate.kind === preferred && candidate.reachable)
    const chosen = preferredCandidate ?? candidates.find((candidate) => candidate.reachable)
    if (chosen !== undefined) chosen.recommended = true
    return candidates
  } catch {
    // A reachable-address probe must never break a request.
    return []
  }
}

// ---------------------------------------------------------------------------
// Route health (R6): probe before use, then cool down after a failure.
// ---------------------------------------------------------------------------

/** Default cooldown after a failed probe: the route is not retried for this long. */
export const ROUTE_COOLDOWN_MS = 60_000
/** A healthy route is re-checked at most this often. */
export const ROUTE_RECHECK_MS = 300_000
/** Probe budget: a hanging candidate must not stall `/state`. */
export const ROUTE_PROBE_TIMEOUT_MS = 1_500

/**
 * Per-url route health, keyed by url. Module scope on purpose: the route list is
 * a property of this host process, and `/state` is served by the same process.
 * @type {Map<string, { state: 'unknown'|'ok'|'failed', checkedAt: number, failures: number, cooldownUntil: number }>}
 */
const routeHealth = new Map()
/** urls with a probe in flight, so a 5 s poll cannot stack them up. */
const probing = new Set()

/** Reset all route health (tests and a deliberate re-probe). */
export function resetRouteHealth() {
  routeHealth.clear()
  probing.clear()
}

/**
 * Health snapshot for one url, creating the `unknown` entry on first use.
 * @param {string} url - route base url.
 * @param {number} now - current epoch milliseconds.
 * @returns {{ state: string, checkedAt: number, failures: number, cooldownUntil: number }}
 */
function healthOf(url, now) {
  let entry = routeHealth.get(url)
  if (entry === undefined) {
    entry = { state: 'unknown', checkedAt: 0, failures: 0, cooldownUntil: 0 }
    routeHealth.set(url, entry)
  }
  return entry
}

/**
 * Probe one route by asking its public health endpoint. Never throws.
 * @param {string} url - route base url.
 * @param {{ timeoutMs?: number, fetchImpl?: Function }} [options] - probe knobs.
 * @returns {Promise<{ ok: boolean, status: number, ms: number, error: string|null }>}
 */
export async function probeRoute(url, { timeoutMs = ROUTE_PROBE_TIMEOUT_MS, fetchImpl } = {}) {
  const startedAt = Date.now()
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof fetchFn !== 'function') return { ok: false, status: 0, ms: 0, error: 'no fetch' }
  const target = `${trimTrailing(url)}/api/dsh-computers/health`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetchFn(target, { method: 'GET', signal: controller.signal, redirect: 'manual' })
    return { ok: response.ok === true, status: response.status, ms: Date.now() - startedAt, error: null }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (error?.message ?? 'probe failed')
    return { ok: false, status: 0, ms: Date.now() - startedAt, error: reason }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Refresh health for the candidates that are due a probe: reachable ones that
 * are unknown, past their cooldown, or older than {@link ROUTE_RECHECK_MS}.
 * A route already in cooldown is NOT probed again inside the window.
 * @param {Array<{ url: string, reachable: boolean }>} candidates - route list.
 * @param {{ probe?: Function, now?: () => number, cooldownMs?: number, recheckMs?: number, timeoutMs?: number }} [options] - knobs (tests inject `probe`).
 * @returns {Promise<string[]>} urls that were probed.
 */
export async function refreshRouteHealth(candidates, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const cooldownMs = Number.isSafeInteger(options.cooldownMs) ? options.cooldownMs : ROUTE_COOLDOWN_MS
  const recheckMs = Number.isSafeInteger(options.recheckMs) ? options.recheckMs : ROUTE_RECHECK_MS
  const probe = typeof options.probe === 'function' ? options.probe : probeRoute
  const current = now()
  const due = []
  for (const candidate of candidates) {
    if (candidate.reachable !== true) continue
    const entry = healthOf(candidate.url, current)
    if (entry.cooldownUntil > current) continue
    if (probing.has(candidate.url)) continue
    // Due when never probed, when the recheck window passed, or when a cooldown
    // just expired (that retry is the whole point of cooling down).
    const cooldownExpired = entry.cooldownUntil > 0 && entry.cooldownUntil <= current
    const stale = entry.state === 'unknown' || current - entry.checkedAt >= recheckMs
    if (stale || cooldownExpired) due.push(candidate.url)
  }
  await Promise.all(due.map(async (url) => {
    probing.add(url)
    let outcome
    try {
      outcome = await withTimeout(probe(url, { timeoutMs: options.timeoutMs }), ROUTE_PROBE_TIMEOUT_MS + 250)
    } catch (error) {
      outcome = { ok: false, status: 0, ms: 0, error: error?.message ?? 'probe failed' }
    }
    probing.delete(url)
    const entry = healthOf(url, now())
    entry.checkedAt = now()
    if (outcome !== null && typeof outcome === 'object' && outcome.ok === true) {
      entry.state = 'ok'
      entry.failures = 0
      entry.cooldownUntil = 0
    } else {
      entry.state = 'failed'
      entry.failures += 1
      entry.cooldownUntil = entry.checkedAt + cooldownMs
    }
  }))
  return due
}

/**
 * Attach route health to each candidate WITHOUT reordering: the array order is
 * the documented kind order (public → forwarded → tailscale → lan → mdns →
 * loopback) that the UI renders, and R6 only changes which route is *chosen*.
 * @param {Array<object>} candidates - route list from {@link collectServerUrls}.
 * @param {{ now?: () => number }} [options] - clock override.
 * @returns {Array<object>} new array, same order, entries gain `health`.
 */
export function annotateRouteHealth(candidates, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const current = now()
  return candidates.map((candidate) => {
    const entry = healthOf(candidate.url, current)
    return {
      ...candidate,
      health: {
        state: entry.state,
        checkedAt: entry.checkedAt === 0 ? null : entry.checkedAt,
        failures: entry.failures,
        cooldownUntil: entry.cooldownUntil > current ? entry.cooldownUntil : null,
      },
    }
  })
}

/**
 * Pick the route to advertise: the operator's/collector's recommendation when it
 * is not cooling down, otherwise the first reachable route that is not cooling
 * down. A route whose last probe failed is never chosen while its cooldown runs.
 * @param {Array<object>} candidates - annotated route list.
 * @returns {object|null} the chosen entry.
 */
export function chooseRoute(candidates) {
  const usable = candidates.filter((candidate) => candidate.health.cooldownUntil === null)
  return usable.find((candidate) => candidate.recommended === true && candidate.reachable === true)
    ?? usable.find((candidate) => candidate.reachable === true)
    ?? usable.find((candidate) => candidate.recommended === true)
    ?? null
}

/** Await `value`, rejecting after `ms` so a bad probe cannot stall a request. */
function withTimeout(value, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('address probe timed out')), ms)
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

/** resolveBaseUrl that never throws (it already is total; this is belt-and-braces). */
function safeResolveBaseUrl({ ctx, config, req }) {
  try {
    return resolveBaseUrl({ ctx, config, req })
  } catch {
    return ''
  }
}

/**
 * The address payload routes return alongside `serverUrl`.
 * @param {object} options - same inputs as {@link collectServerUrls}.
 * @returns {{ serverUrl: string, serverUrls: Array<object>, loopbackOnly: boolean }} payload.
 */
export async function resolveAddressPayload(options = {}) {
  const collected = await collectServerUrls(options)
  const listener = listenerOf(options.ctx)
  // R6: never make a browser request wait for a probe. Health recorded by a
  // previous probe decides the order; a background refresh updates it for the
  // next poll (bounded by the cooldown, so a dead route is probed once a minute
  // at most). `options.probe` is the test seam.
  void refreshRouteHealth(collected, {
    ...(typeof options.probe === 'function' ? { probe: options.probe } : {}),
    ...(typeof options.now === 'function' ? { now: options.now } : {}),
    ...(Number.isSafeInteger(options.cooldownMs) ? { cooldownMs: options.cooldownMs } : {}),
    ...(typeof options.recheckMs === 'number' ? { recheckMs: options.recheckMs } : {}),
  })
  const serverUrls = annotateRouteHealth(collected, {
    ...(typeof options.now === 'function' ? { now: options.now } : {}),
  })
  // A route in cooldown is never chosen, even if it was the operator's
  // preference: the last probe proved it does not answer.
  const recommended = chooseRoute(serverUrls)
  for (const candidate of serverUrls) candidate.recommended = recommended !== null && candidate.url === recommended.url
  const reachable = serverUrls.filter((candidate) => candidate.reachable)
  return {
    serverUrl: recommended === null ? '' : recommended.url,
    serverUrls,
    loopbackOnly: reachable.length === 0 || (reachable.length === 1 && reachable[0].kind === 'loopback'),
    // The listener facts the UI needs to explain reachability (v1.4.0).
    listener: { host: listener.host, port: listener.port, loopback: listener.loopback },
  }
}
