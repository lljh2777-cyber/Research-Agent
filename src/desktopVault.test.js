import assert from 'node:assert/strict'
import test from 'node:test'

import { hasDesktopVaultBridge, onDesktopVaultChanged, selectDesktopVault, syncDesktopVault } from './desktopVault.js'

test('desktop Vault bridge parses snapshots and keeps paths out of renderer requests', async () => {
  const calls = []
  let eventListener
  globalThis.window = {
    researchDesktop: {
      vaults: {
        select: async () => ({ vaultId: 'vault-1', vaultName: 'research', revision: 'r1', files: [{ path: 'wiki/note.md', content: '# Note' }] }),
        sync: async (...args) => {
          calls.push(args)
          return { vaultId: 'vault-1', vaultName: 'research', revision: 'r1', unchanged: true }
        },
        onChanged: (listener) => {
          eventListener = listener
          return () => { eventListener = null }
        },
      },
    },
  }

  try {
    assert.equal(hasDesktopVaultBridge(), true)
    const selected = await selectDesktopVault()
    assert.equal(selected.notes[0].title, 'Note')
    assert.equal(selected.notes[0].path, 'wiki/note.md')
    assert.equal('root' in selected, false)

    const synced = await syncDesktopVault({ vaultId: 'vault-1', revision: 'r1' })
    assert.equal(synced.unchanged, true)
    assert.deepEqual(calls, [['vault-1', 'r1']])

    let changed = ''
    const unsubscribe = onDesktopVaultChanged((event) => { changed = event.vaultId })
    eventListener({ vaultId: 'vault-1' })
    assert.equal(changed, 'vault-1')
    unsubscribe()
    assert.equal(eventListener, null)
  } finally {
    delete globalThis.window
  }
})
