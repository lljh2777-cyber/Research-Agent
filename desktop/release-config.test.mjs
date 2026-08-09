import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const config = packageJson.build

test('desktop release metadata is explicit and local-first', () => {
  assert.equal(packageJson.private, true)
  assert.equal(packageJson.license, 'AGPL-3.0-only')
  assert.equal(config.appId, 'io.bioresearch.os')
  assert.equal(config.productName, 'BioResearch OS')
  assert.equal(config.asar, true)
  assert.equal(config.electronDist, 'node_modules/electron/dist')
  assert.equal(config.publish, undefined)
  assert.match(packageJson.scripts['dist:desktop'], /--publish never$/)
})

test('Windows installer stays per-user and produces deterministic artifacts', () => {
  assert.equal(config.win.requestedExecutionLevel, 'asInvoker')
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }])
  assert.equal(config.nsis.oneClick, false)
  assert.equal(config.nsis.allowToChangeInstallationDirectory, true)
  assert.equal(config.nsis.createDesktopShortcut, 'always')
  assert.equal(config.artifactName, 'BioResearch-OS-${version}-${os}-${arch}.${ext}')
})

test('packaged files exclude tests and local environment files', () => {
  assert.ok(config.files.includes('!**/*.test.*'))
  assert.ok(!config.files.some((entry) => entry.includes('.env')))
  assert.ok(!config.extraResources)
})
