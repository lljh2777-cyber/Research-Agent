import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeVaultSnapshot, VAULT_SNAPSHOT_SCHEMA_VERSION } from './vaultStorage.js'

test('rejects unversioned legacy Vault snapshots instead of presenting them as connected', () => {
  assert.equal(normalizeVaultSnapshot({ vaultName: 'knowledge-base', notes: [{ id: 'old' }] }), null)
})

test('normalizes a user-selected versioned Vault snapshot', () => {
  assert.deepEqual(normalizeVaultSnapshot({
    schemaVersion: VAULT_SNAPSHOT_SCHEMA_VERSION,
    vaultName: ' research ',
    notes: [{ id: 'note-1', path: 'notes/paper.md', body: '# Paper\n\nSee [[Methods]].' }],
    source: 'browser-handle',
    revision: 'r1',
    savedAt: '2026-08-09T00:00:00.000Z',
  }), {
    schemaVersion: VAULT_SNAPSHOT_SCHEMA_VERSION,
    vaultName: 'research',
    notes: [{
      id: 'note-1',
      path: 'notes/paper.md',
      name: 'paper.md',
      title: 'paper',
      body: '# Paper\n\nSee [[Methods]].',
      frontmatter: {},
      wikilinks: ['Methods'],
      wordCount: 4,
      type: 'note',
    }],
    source: 'browser-handle',
    revision: 'r1',
    savedAt: '2026-08-09T00:00:00.000Z',
  })
})
