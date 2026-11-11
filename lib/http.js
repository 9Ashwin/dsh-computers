/**
 * Small HTTP helpers shared by every dsh-computers host route: JSON/text
 * writers, a bounded JSON body reader, the browser request gate, the origin
 * resolver and the two installer script generators.
 *
 * Node builtins only — this module has to load in any DSH profile.
 *
 * The gate is a compact restatement of `dshmarket/src/http.ts` (sendJson,
 * refuseUnadmitted, sameOrigin, loopbackAuthority, trustedAuthority). The
 * reason it exists is the same: `webServer.register` routes are exact
 * registrations on the bare web server, so they never pass DSH's own `/api`
 * fence and each plugin has to ask the host's fence itself.
 */

import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/**
 * One request failure that maps directly onto an HTTP response.
 * Route handlers throw these; the route wrapper turns them into JSON.
 */
export class HttpError extends Error {
  /**
   * @param {number} status - HTTP status code.
   * @param {string} code - stable machine-readable error code.
   * @param {string} message - human-readable detail.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** Write one JSON payload. `no-store` because every answer here is live state. */
export function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Write one plain-text payload (installer scripts, exit refusals). */
export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = String(text)
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** One protocol-shaped `{ error, message }` failure. */
export function jsonError(res, status, code, message) {
  sendJson(res, status, { error: code, message })
}

/** 405 with the single method the route supports. */
export function methodNotAllowed(res, allow) {
  if (!res.headersSent) res.setHeader('allow', allow)
  sendJson(res, 405, { error: 'method-not-allowed', message: `use ${allow}` })
}

/**
 * Read a JSON request body, refusing anything above `maxBytes`.
 * Reads the stream to its end (or drains it on refusal) so the client sees a
 * response instead of a cut socket.
 * @param {import('node:http').IncomingMessage} req - request to read.
 * @param {number} maxBytes - inclusive size cap.
 * @returns {Promise<unknown>} the parsed JSON value.
 */
export async function readJsonBody(req, maxBytes) {
  const chunks = []
  let size = 0
  let overLimit = false
  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > maxBytes) {
        // Keep consuming (and forgetting) the rest so the client receives a
        // readable 413 instead of a reset socket, without buffering it.
        overLimit = true
        chunks.length = 0
        return
      }
      chunks.push(buffer)
    })
    req.on('end', resolve)
    req.on('error', reject)
    req.on('aborted', () => reject(new HttpError(400, 'bad-request', 'request aborted')))
  })
  if (overLimit) throw new HttpError(413, 'payload-too-large', `request body exceeds ${maxBytes} bytes`)
  if (size === 0) throw new HttpError(400, 'bad-request', 'request body is empty')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad-request', 'request body is not valid JSON')
  }
}

/** Parse a bare `host[:port]` authority, or null when the value is not one. */
function parseAuthority(value) {
  try {
    const url = new URL(`http://${value}`)
    const canonical = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
    return canonical === value.toLowerCase() ? url : null
  } catch {
    return null
  }
}

/**
 * Whether a request authority is one of the deployment's declared ones.
 * Port-less entries match the hostname on any port; entries with a port match
 * that exact authority. Both sides compare through WHATWG normalization.
 * @param {string} host - the request's `Host` header.
 * @param {readonly string[]} trustedHosts - authorities the host declared.
 * @returns {boolean} whether the authority is declared.
 */
export function trustedAuthority(host, trustedHosts) {
  const hostUrl = parseAuthority(host)
  if (hostUrl === null) return false
  return trustedHosts.some((entry) => {
    if (typeof entry !== 'string') return false
    const entryUrl = parseAuthority(entry)
    if (entryUrl === null) return false
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/**
 * Whether a `Host` header names a loopback authority. DNS rebinding is stopped
 * here: Host is the one header an attacker's page cannot forge.
 * @param {string | undefined} host - the request's `Host` header.
 * @returns {boolean} whether it names loopback.
 */
export function loopbackAuthority(host) {
  if (typeof host !== 'string') return false
  const lower = host.toLowerCase()
  // IPv6 literals keep their brackets; `[::1]:3080` → `[::1]`.
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * Same-origin check used only when the host publishes no request gate.
 *
 * Copied in spirit from `dshmarket/src/http.ts`:
 * - an absent `Host` is allowed (a stripping proxy — the Desktop build's —
 *   removes it, and a page can never omit it);
 * - a present `Host` must name loopback or a declared authority;
 * - `sec-fetch-site: cross-site` is refused;
 * - an absent `Origin` is allowed (non-browser clients can forge any Origin,
 *   and the Desktop proxy strips it);
 * - a present Origin must share the request's Host.
 * @param {import('node:http').IncomingMessage} req - request to judge.
 * @param {readonly string[]} trustedHosts - host-declared authorities.
 * @returns {boolean} whether the request may reach a browser route.
 */
export function sameOrigin(req, trustedHosts = []) {
  const host = req.headers.host
  if (host !== undefined && !loopbackAuthority(host) && !trustedAuthority(host, trustedHosts)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    // `Origin: null` and an empty Origin are present-but-unparseable: refused.
    return false
  }
}

/**
 * The composition's `connection` service, if this host has one.
 * Resolved per request: the host provides it only after its own async init.
 * @param {object} ctx - Cordis context.
 * @returns {object | undefined} the connection service.
 */
export function connectionOf(ctx) {
  try {
    const service = ctx.get('connection')
    if (service !== undefined && service !== null) return service
  } catch {
    // fall through to the reflective read
  }
  try {
    const service = Reflect.get(ctx, 'connection')
    return service ?? undefined
  } catch {
    return undefined
  }
}

/**
 * POST one JSON body to a URL we dial ourselves (the hub's enroll route) and
 * parse its JSON answer. Used only for outbound calls the plugin initiates.
 *
 * Any transport failure — DNS, refused connection, TLS, timeout, abort, an
 * over-cap response — throws `HttpError(502, 'hub-unreachable', ...)`; an HTTP
 * answer (whatever its status) resolves so the caller can map the hub's own
 * error codes.
 *
 * @param {string} urlString - absolute http(s) URL.
 * @param {unknown} body - JSON-serializable request body.
 * @param {object} [options] - call options.
 * @param {number} [options.timeoutMs] - whole-exchange timeout (default 10 s).
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {number} [options.maxBytes] - response body cap (default 64 KiB).
 * @returns {Promise<{ status: number, headers: Record<string, string | string[] | undefined>, text: string, data: unknown }>} the response.
 */
export async function postJson(urlString, body, { timeoutMs = 10_000, signal, maxBytes = 64 * 1024 } = {}) {
  let url
  try {
    url = new URL(String(urlString))
  } catch {
    throw new HttpError(400, 'bad-request', `not a valid URL: ${JSON.stringify(urlString)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'bad-request', 'serverUrl must use http or https')
  }
  let payload
  try {
    payload = Buffer.from(JSON.stringify(body), 'utf8')
  } catch {
    throw new HttpError(400, 'bad-request', 'request body is not JSON-serializable')
  }
  if (signal?.aborted === true) throw new HttpError(502, 'hub-unreachable', 'the request was aborted')

  return await new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const onAbort = () => {
      request.destroy(new Error('aborted'))
    }

    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = transport(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': payload.length,
        accept: 'application/json',
      },
    }, (response) => {
      const chunks = []
      let size = 0
      let overLimit = false
      response.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > maxBytes) {
          overLimit = true
          chunks.length = 0
          response.resume()
          return
        }
        chunks.push(buffer)
      })
      response.on('end', () => {
        if (overLimit) {
          finish(new HttpError(502, 'hub-unreachable', `hub response exceeded ${maxBytes} bytes`))
          return
        }
        const text = Buffer.concat(chunks).toString('utf8')
        let data
        try {
          data = text === '' ? undefined : JSON.parse(text)
        } catch {
          data = undefined
        }
        finish(undefined, { status: response.statusCode ?? 0, headers: response.headers, text, data })
      })
      response.on('error', (error) => finish(new HttpError(502, 'hub-unreachable', `hub response failed: ${error.message}`)))
    })

    request.on('error', (error) => {
      // `request.destroy(new Error('aborted'))` also lands here; report the
      // caller's cancellation rather than a raw socket error.
      const message = signal?.aborted === true
        ? 'the request was aborted'
        : `cannot reach the hub: ${error.message}`
      finish(new HttpError(502, 'hub-unreachable', message))
    })
    timer = setTimeout(() => {
      request.destroy(new Error('timeout'))
      finish(new HttpError(502, 'hub-unreachable', `the hub did not answer within ${timeoutMs}ms`))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    request.end(payload)
  })
}

/**
 * Answer the request with the host's own rejection, if it has one; when the
 * connection service is absent, apply the fallback same-origin rules.
 * @param {object} ctx - Cordis context.
 * @param {import('node:http').IncomingMessage} req - request to judge.
 * @param {import('node:http').ServerResponse} res - response to answer on.
 * @returns {boolean} true when the request was refused and answered here.
 */
export function refuseBrowserRequest(ctx, req, res) {
  const connection = connectionOf(ctx)
  const gate = connection?.requestRejection
  if (typeof gate === 'function') {
    let status
    try {
      status = gate.call(connection, req)
    } catch {
      // A gate that throws has not admitted anything: fail closed.
      status = 403
    }
    if (typeof status === 'number') {
      // Drain an unread request body so the refusal is not a socket reset.
      try {
        req.resume()
      } catch {
        // Nothing to drain.
      }
      jsonError(res, status, 'unadmitted', status === 401
        ? 'DSH login required: reopen the URL printed by dsh web at startup.'
        : 'This request came from an untrusted origin and was refused.')
      return true
    }
    return false
  }
  const trustedHosts = Array.isArray(connection?.trustedHosts)
    ? connection.trustedHosts.filter((entry) => typeof entry === 'string')
    : []
  if (!sameOrigin(req, trustedHosts)) {
    try {
      req.resume()
    } catch {
      // Nothing to drain.
    }
    jsonError(res, 403, 'unadmitted', 'This request came from an untrusted origin and was refused.')
    return true
  }
  return false
}

/** First value of `x-forwarded-proto`, when a proxy supplied one. */
function forwardedProto(req) {
  const raw = req?.headers?.['x-forwarded-proto']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return undefined
  const first = value.split(',')[0]?.trim().toLowerCase()
  return first === 'http' || first === 'https' ? first : undefined
}

/**
 * The URL a joining machine (and the settings page) should use to reach this
 * host. `config.publicUrl` wins; otherwise the live bound origin; a proxy
 * deployment that hides the bind address still gets a usable one-liner from
 * the request's own Host.
 * @param {object} ctx - Cordis context.
 * @param {{ publicUrl?: string }} config - resolved plugin config.
 * @param {import('node:http').IncomingMessage} [req] - the request being served.
 * @returns {string} origin without a trailing slash.
 */
export function resolveServerUrl(ctx, config, req) {
  const configured = typeof config?.publicUrl === 'string' ? config.publicUrl.trim() : ''
  if (configured !== '') return configured.replace(/\/+$/, '')
  try {
    const origin = ctx.webServer.getOrigin()
    if (typeof origin === 'string' && origin !== '') return origin.replace(/\/+$/, '')
  } catch {
    // The origin is unreadable before the listener binds — fall through.
  }
  const host = req?.headers?.host
  if (typeof host === 'string' && host !== '') {
    return `${forwardedProto(req) ?? 'http'}://${host}`.replace(/\/+$/, '')
  }
  return 'http://127.0.0.1'
}

/** POSIX single-quote escaping for a value embedded in a shell script. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** PowerShell single-quote escaping. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * The macOS/Linux one-liner installer behind `GET /join.sh` (PROTOCOL §4.6).
 * Generated from the same server URL and key the settings page shows, so the
 * script can never drift from the routes.
 * @param {string} serverUrl - host origin.
 * @param {string} key - enrollment key.
 * @returns {string} a POSIX shell script.
 */
export function joinSh(serverUrl, key) {
  const server = shellQuote(serverUrl)
  const token = shellQuote(key)
  // Kept as a line array instead of one template literal so every `$` below
  // stays a shell variable and only `server`/`token` interpolate at build time.
  return [
    '#!/bin/sh',
    '# dsh-computers: connect this machine to a DSH Web deployment.',
    'set -eu',
    '',
    `SERVER=${server}`,
    `KEY=${token}`,
    'DIR="$HOME/.dsh-computers"',
    'AGENT="$DIR/agent.mjs"',
    '',
    'say() { printf \'%s\\n\' "$*"; }',
    'die() { printf \'error: %s\\n\' "$*" >&2; exit 1; }',
    '',
    'command -v curl >/dev/null 2>&1 || die "curl is required to download the agent."',
    'command -v node >/dev/null 2>&1 || die "Node.js 22 or newer is required: https://nodejs.org"',
    'NODE_VERSION="$(node -v 2>/dev/null || true)"',
    'NODE_MAJOR="$(printf \'%s\' "$NODE_VERSION" | sed \'s/^v//\' | cut -d. -f1)"',
    'case "$NODE_MAJOR" in',
    '  \'\'|*[!0-9]*) die "cannot determine the Node.js version (node -v printed \'$NODE_VERSION\')." ;;',
    'esac',
    'if [ "$NODE_MAJOR" -lt 22 ]; then',
    '  die "Node.js 22 or newer is required, found $NODE_VERSION."',
    'fi',
    '',
    'mkdir -p "$DIR"',
    'say "→ downloading the dsh-computers agent"',
    'curl -fsSL "$SERVER/api/dsh-computers/agent.mjs" -o "$AGENT" || die "could not download $SERVER/api/dsh-computers/agent.mjs"',
    'chmod 700 "$AGENT"',
    '',
    'say "→ enrolling this computer with $SERVER"',
    'node "$AGENT" enroll --server "$SERVER" --key "$KEY"',
    '',
    'STARTED=0',
    'case "$(uname -s 2>/dev/null || echo unknown)" in',
    '  Darwin|Linux)',
    '    if node "$AGENT" service install >/dev/null 2>&1 && node "$AGENT" service start >/dev/null 2>&1; then',
    '      STARTED=1',
    '    fi',
    '    ;;',
    'esac',
    '',
    'if [ "$STARTED" -eq 1 ]; then',
    '  say "✓ dsh-computers is connected and will reconnect automatically after a reboot."',
    'else',
    '  say "ℹ automatic startup is not available on this machine."',
    '  say "  keep this computer connected with:"',
    '  say "    node \\"$AGENT\\" run"',
    'fi',
    '',
  ].join('\n')
}

/**
 * The Windows installer behind `GET /join.ps1` (PROTOCOL §4.6, best effort).
 * @param {string} serverUrl - host origin.
 * @param {string} key - enrollment key.
 * @returns {string} a PowerShell script.
 */
export function joinPs1(serverUrl, key) {
  const server = psQuote(serverUrl)
  const token = psQuote(key)
  return [
    '# dsh-computers: connect this machine to a DSH Web deployment.',
    "$ErrorActionPreference = 'Stop'",
    `$Server = ${server}`,
    `$Key = ${token}`,
    "$Dir = Join-Path $HOME '.dsh-computers'",
    "$Agent = Join-Path $Dir 'agent.mjs'",
    '',
    '$node = Get-Command node -ErrorAction SilentlyContinue',
    "if ($null -eq $node) { throw 'Node.js 22 or newer is required: https://nodejs.org' }",
    "$version = (& node -v).TrimStart('v')",
    'if ([int]($version.Split(\'.\')[0]) -lt 22) { throw "Node.js 22 or newer is required, found v$version" }',
    '',
    'New-Item -ItemType Directory -Force -Path $Dir | Out-Null',
    'Write-Host "-> downloading the dsh-computers agent"',
    "Invoke-WebRequest -UseBasicParsing -Uri \"$Server/api/dsh-computers/agent.mjs\" -OutFile $Agent",
    '',
    'Write-Host "-> enrolling this computer with $Server"',
    '& node $Agent enroll --server $Server --key $Key',
    'if ($LASTEXITCODE -ne 0) { throw "enroll failed with exit code $LASTEXITCODE" }',
    '',
    'Write-Host "OK dsh-computers is connected."',
    'Write-Host "   Keep this computer connected with: node `"$Agent`" run"',
    '',
  ].join('\n')
}

/**
 * Serve the machine agent bundle as bytes. Read per request (never imported):
 * the file belongs to the agent surface and may be replaced between requests.
 * @param {import('node:http').ServerResponse} res - response to write.
 * @param {URL} agentUrl - `new URL('./agent/dsh-computers-agent.mjs', import.meta.url)`.
 * @returns {Promise<void>} resolves once the response is written.
 */
export async function serveAgentScript(res, agentUrl) {
  let bytes
  try {
    bytes = await readFile(agentUrl)
  } catch (error) {
    const missing = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    jsonError(res, missing ? 404 : 500, missing ? 'agent-unavailable' : 'internal',
      missing
        ? `the machine agent bundle is missing from this deployment (${agentUrl.pathname})`
        : 'the machine agent bundle could not be read')
    return
  }
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': bytes.length,
  })
  res.end(bytes)
}
