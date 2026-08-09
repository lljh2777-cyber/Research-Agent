import { createServer as createViteServer } from 'vite'

import { startAuthServer } from './auth-server.mjs'

const AUTH_HEALTH_URL = 'http://127.0.0.1:4318/api/health'

async function hasRunningAuthService() {
  try {
    const response = await fetch(AUTH_HEALTH_URL, { signal: AbortSignal.timeout(750) })
    const payload = await response.json().catch(() => ({}))
    return response.ok && payload.service === 'bioresearch-auth'
  } catch {
    return false
  }
}

let ownedAuthServer
let viteServer
let closing = false

async function shutdown(exitCode = 0) {
  if (closing) return
  closing = true
  await viteServer?.close().catch(() => {})
  if (ownedAuthServer?.listening) {
    await new Promise((resolve) => ownedAuthServer.close(resolve))
  }
  process.exitCode = exitCode
}

try {
  if (await hasRunningAuthService()) {
    console.log(`[dev-server] reusing ChatGPT auth service at ${AUTH_HEALTH_URL}`)
  } else {
    ownedAuthServer = startAuthServer()
    ownedAuthServer.on('error', (error) => {
      console.error(`[dev-server] ChatGPT auth service failed: ${error.message}`)
      void shutdown(1)
    })
  }

  // Provider API middleware is registered by vite.config.js so both
  // local-runtime identifies the launcher that owns the ChatGPT auth service.
  // Bare npm run dev:web remains fail-closed.
  const vitePort = Number(process.env.BIORESEARCH_VITE_PORT)
  const server = Number.isInteger(vitePort) && vitePort > 0 ? { port: vitePort, strictPort: true } : undefined
  viteServer = await createViteServer({ mode: 'local-runtime', ...(server ? { server } : {}) })
  await viteServer.listen()
  viteServer.printUrls()
} catch (error) {
  console.error(`[dev-server] startup failed: ${error.message}`)
  await shutdown(1)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
