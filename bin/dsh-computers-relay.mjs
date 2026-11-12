#!/usr/bin/env node
/**
 * `dsh-computers-relay` — run the standalone relay (docs/relay-design.md §6.2).
 *
 * Usage:
 *   dsh-computers-relay --port 8787 --host 0.0.0.0
 *
 * Zero dependencies, no build step. The process only owns argv parsing, the
 * listening log and graceful shutdown; the server itself lives in
 * `relay/main.mjs` and is also importable from tests.
 */

import { createRelay } from '../relay/main.mjs'

const HELP = `dsh-computers-relay — standalone relay for dsh-computers

Usage:
  dsh-computers-relay [options]

Options:
  -p, --port <port>   TCP port to listen on (default: 8787; 0 = ephemeral)
  -H, --host <host>   interface to bind (default: 0.0.0.0)
  -h, --help          show this help and exit

Routes:
  GET  /health                    relay liveness + connected hub ids
  GET  /ws?hub=<id>&role=hub      hub dial-in (WebSocket upgrade)
  GET  /r/<hubId>/<path>          generic HTTP tunnel to that hub

Environment:
  DSH_RELAY_PORT / DSH_RELAY_HOST are used when the flags are absent.

The relay keeps no state on disk. Put TLS in front of it (nginx/Caddy) or
terminate TLS in the reverse proxy; hub links should use wss:// in production.
`

/** Parse the small, fixed CLI surface. */
function parseArgs(argv) {
  const args = {
    port: Number(process.env.DSH_RELAY_PORT ?? 8787),
    host: process.env.DSH_RELAY_HOST ?? '0.0.0.0',
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') {
      args.help = true
      continue
    }
    if (arg === '-p' || arg === '--port') {
      const value = argv[index + 1]
      index += 1
      if (value === undefined) throw new Error(`${arg} requires a value`)
      const port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid port '${value}' (expected 0-65535)`)
      }
      args.port = port
      continue
    }
    if (arg.startsWith('--port=')) {
      const port = Number(arg.slice('--port='.length))
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid port '${arg.slice('--port='.length)}' (expected 0-65535)`)
      }
      args.port = port
      continue
    }
    if (arg === '-H' || arg === '--host') {
      const value = argv[index + 1]
      index += 1
      if (value === undefined || value === '') throw new Error(`${arg} requires a value`)
      args.host = value
      continue
    }
    if (arg.startsWith('--host=')) {
      const value = arg.slice('--host='.length)
      if (value === '') throw new Error('--host requires a value')
      args.host = value
      continue
    }
    throw new Error(`unknown option '${arg}' (try --help)`)
  }
  return args
}

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`dsh-computers-relay: ${error.message}`)
  console.error('')
  console.error(HELP)
  process.exitCode = 1
  args = null
}

if (args !== null && args.help) {
  console.log(HELP)
} else if (args !== null) {
  const relay = createRelay({
    host: args.host,
    port: args.port,
    log(level, message) {
      // Keep the operational surface small: warnings/errors to stderr, info to stdout.
      if (level === 'warn' || level === 'error') console.error(message)
      else console.log(message)
    },
  })

  try {
    const address = await relay.listen()
    console.log(`dsh-computers-relay listening on ${address.url} (bound ${address.host}:${address.port})`)
    console.log(`  hub dial-in: ws://<this-host>:${address.port}/ws?hub=<hubId>&role=hub`)
    console.log(`  tunnel:      ${address.url}/r/<hubId>/…`)
  } catch (error) {
    console.error(`dsh-computers-relay: cannot listen on ${args.host}:${args.port}: ${error?.message ?? error}`)
    process.exitCode = 1
  }

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`dsh-computers-relay: ${signal} received, closing…`)
    try {
      await relay.close()
      process.exitCode = 0
    } catch (error) {
      console.error(`dsh-computers-relay: shutdown failed: ${error?.message ?? error}`)
      process.exitCode = 1
    }
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}
