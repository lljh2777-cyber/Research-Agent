import assert from 'node:assert/strict'
import test from 'node:test'

import { VAULT_INDEX_SCHEMA_VERSION, VAULT_NOTE_SCHEMA_VERSION, buildVaultIndex, parseVaultTextEntries, resolveVaultWikilink } from './vault.js'

test('parses versioned Notes and resolves relative, alias, and heading wikilinks deterministically', async () => {
  const notes = await parseVaultTextEntries([
    {
      path: 'research/notes/overview.md',
      content: '# Overview\n[[../methods/CellChat|Cell Chat]] [[../papers/key-study#Results]] [[Method Alias]] [[Shared]]',
    },
    {
      path: 'research/methods/CellChat.md',
      content: '---\naliases:\n  - Method Alias\n---\n# CellChat\nMethod details',
    },
    {
      path: 'research/papers/key-study.md',
      content: '# Key study\n## Results\nEvidence',
    },
    { path: 'research/a/shared.md', content: '---\nalias: Shared\n---\n# Shared A' },
    { path: 'research/b/shared.md', content: '---\nalias: Shared\n---\n# Shared B' },
  ])
  const overview = notes.find((note) => note.path === 'research/notes/overview.md')
  const cellChat = notes.find((note) => note.path === 'research/methods/CellChat.md')
  const study = notes.find((note) => note.path === 'research/papers/key-study.md')

  assert(notes.every((note) => note.schemaVersion === VAULT_NOTE_SCHEMA_VERSION))
  assert.equal(resolveVaultWikilink(notes, overview, '[[../methods/CellChat|Cell Chat]]').note, cellChat)
  const headingLink = resolveVaultWikilink(notes, overview, '[[../papers/key-study#Results]]')
  assert.equal(headingLink.note, study)
  assert.equal(headingLink.heading, 'Results')
  assert.equal(resolveVaultWikilink(notes, overview, '[[Method Alias]]').note, cellChat)
  assert.equal(resolveVaultWikilink(notes, overview, '[[Shared]]').reason, 'ambiguous')

  const index = buildVaultIndex(notes)
  assert.equal(index.schemaVersion, VAULT_INDEX_SCHEMA_VERSION)
  assert.deepEqual(index.edges.map((edge) => edge.target.id || edge.target.reason), [cellChat.id, study.id, cellChat.id, 'ambiguous'])
})
