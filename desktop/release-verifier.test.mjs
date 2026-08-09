import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyDesktopPackageFiles } from './release-verifier.mjs'

test('accepts minimal Windows, macOS, and Linux packaged layouts', () => {
  assert.equal(verifyDesktopPackageFiles(['BioResearch OS.exe', 'resources/app.asar'], { platform: 'win32' }).ok, true)
  assert.equal(verifyDesktopPackageFiles(['BioResearch OS.app/Contents/MacOS/BioResearch OS', 'BioResearch OS.app/Contents/Resources/app.asar'], { platform: 'darwin' }).ok, true)
  assert.equal(verifyDesktopPackageFiles(['bioresearch-os', 'resources/app.asar'], { platform: 'linux' }).ok, true)
})

test('rejects incomplete packages and accidentally bundled local secrets', () => {
  assert.throws(
    () => verifyDesktopPackageFiles(['BioResearch OS.exe'], {
      platform: 'win32',
      archiveFiles: ['/.env.local', '/desktop/main.test.mjs', '/provider-credentials.json'],
    }),
    /missing resources\/app\.asar.*Sensitive local files.*Test files are present/,
  )
})
