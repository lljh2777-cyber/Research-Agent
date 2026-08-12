import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import config, { quoteShellArgument } from '../playwright.config.js'

test('Playwright starts the repo-local Vite CLI without npm or cmd wrappers', () => {
  const command = config.webServer.command
  const viteCliPath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))

  assert.equal(typeof command, 'string')
  assert.doesNotMatch(command, /(^|\s)(?:npm|npx|cmd(?:\.exe)?)(?=\s|$)/i)
  assert.ok(command.includes(process.execPath))
  assert.ok(command.includes(viteCliPath))
  assert.match(command, /--host 127\.0\.0\.1 --port 4173 --strictPort$/)
  assert.equal(config.webServer.url, 'http://127.0.0.1:4173')
  assert.equal(config.webServer.reuseExistingServer, !process.env.CI)
  assert.equal(config.webServer.timeout, 120_000)
})

test('shell argument quoting is safe for supported host platforms', () => {
  assert.equal(
    quoteShellArgument('C:\\Program Files\\nodejs\\node.exe', 'win32'),
    '"C:\\Program Files\\nodejs\\node.exe"',
  )
  assert.throws(
    () => quoteShellArgument('C:\\invalid"path\\node.exe', 'win32'),
    /cannot contain double quotes/,
  )
  assert.equal(quoteShellArgument("/tmp/research agent's/node", 'linux'), "'/tmp/research agent'\\''s/node'")
  assert.equal(quoteShellArgument('/Applications/Research Agent/node', 'darwin'), "'/Applications/Research Agent/node'")
})
