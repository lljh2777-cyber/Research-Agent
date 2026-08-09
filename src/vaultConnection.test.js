import assert from 'node:assert/strict'
import test from 'node:test'

import { describeVaultConnection, VAULT_CONNECTION_STATUS } from './vaultConnection.js'

test('describes a first-run Vault without fabricated workspace data', () => {
  assert.deepEqual(describeVaultConnection(), {
    status: VAULT_CONNECTION_STATUS.DISCONNECTED,
    title: 'Connect a Vault',
    detail: 'Choose a local Obsidian folder',
    actionLabel: 'Connect Obsidian vault',
    syncLabel: '',
  })
})

test('distinguishes cached Vault evidence from a live connection', () => {
  const cached = describeVaultConnection({ vaultName: 'knowledge-base', noteCount: 181, syncState: 'needs-permission' })
  assert.equal(cached.status, VAULT_CONNECTION_STATUS.CACHED)
  assert.equal(cached.title, 'knowledge-base')
  assert.match(cached.detail, /181 cached Markdown notes/)
  assert.match(cached.detail, /reconnect/)

  const connected = describeVaultConnection({ vaultName: 'research', noteCount: 1, syncState: 'ready' })
  assert.equal(connected.status, VAULT_CONNECTION_STATUS.CONNECTED)
  assert.equal(connected.detail, '1 Markdown note')
})
