import assert from 'node:assert/strict'
import test from 'node:test'

import { hasDesktopDataFilesBridge, openDesktopDataBackup, saveDesktopDataBackup } from './desktopDataFiles.js'

test('uses the narrow desktop backup bridge without exposing filesystem paths', async () => {
  const calls = []
  globalThis.window = {
    researchDesktop: {
      dataFiles: {
        saveBackup: async (input) => {
          calls.push(input)
          return { cancelled: false, fileName: 'backup.json', bytes: 18, filePath: 'C:\\private\\backup.json' }
        },
        openBackup: async () => ({ cancelled: false, fileName: 'backup.json', content: '{"kind":"fixture"}', filePath: 'C:\\private\\backup.json' }),
      },
    },
  }

  assert.equal(hasDesktopDataFilesBridge(), true)
  assert.deepEqual(await saveDesktopDataBackup({ fileName: 'backup.json', content: '{"kind":"fixture"}' }), { cancelled: false, fileName: 'backup.json', bytes: 18 })
  assert.deepEqual(calls, [{ fileName: 'backup.json', content: '{"kind":"fixture"}' }])
  assert.deepEqual(await openDesktopDataBackup(), { cancelled: false, fileName: 'backup.json', content: '{"kind":"fixture"}' })
  delete globalThis.window
})

test('preserves desktop dialog cancellation', async () => {
  globalThis.window = { researchDesktop: { dataFiles: { saveBackup: async () => ({ cancelled: true }), openBackup: async () => ({ cancelled: true }) } } }
  assert.deepEqual(await saveDesktopDataBackup({ fileName: 'backup.json', content: '{}' }), { cancelled: true })
  assert.deepEqual(await openDesktopDataBackup(), { cancelled: true })
  delete globalThis.window
})
