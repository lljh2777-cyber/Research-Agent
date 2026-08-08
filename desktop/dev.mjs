import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import electronPath from 'electron'

const host = '127.0.0.1'
const port = 5174
const vite = await createServer({ server: { host, port, strictPort: true } })
await vite.listen()
vite.printUrls()

const child = spawn(electronPath, ['desktop/main.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, BIORESEARCH_DESKTOP_DEV_URL: `http://${host}:${port}/` },
  stdio: 'inherit',
  windowsHide: true,
})

let closing = false
async function close(exitCode = 0) {
  if (closing) return
  closing = true
  await vite.close()
  process.exitCode = exitCode
}

child.once('exit', (code) => void close(code || 0))
child.once('error', () => void close(1))
process.once('SIGINT', () => child.kill())
process.once('SIGTERM', () => child.kill())
