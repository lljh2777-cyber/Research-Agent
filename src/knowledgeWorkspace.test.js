import assert from 'node:assert/strict'
import test from 'node:test'

import { buildVaultFileTree, collectVaultTags, DEFAULT_DOCK_LAYOUT, extractMarkdownOutline, filterVaultFileTree, moveDockPanel, normalizeDockLayout, parseWikilinks, resolveWikilink } from './knowledgeWorkspace.js'

test('normalizes dock layout without duplicates or missing panels', () => {
  const layout = normalizeDockLayout({ left: ['files', 'files', 'web'], right: ['graph', 'unknown'] })
  assert.deepEqual(layout.left, ['files', 'web', 'outline', 'tags'])
  assert.deepEqual(layout.right, ['graph', 'agent', 'plugins'])
})

test('moves a panel across docks and preserves ordering', () => {
  const moved = moveDockPanel(DEFAULT_DOCK_LAYOUT, 'files', 'right', 'web')
  assert.deepEqual(moved.left, ['outline', 'tags'])
  assert.deepEqual(moved.right, ['agent', 'graph', 'files', 'web', 'plugins'])
})

test('extracts headings and aggregates frontmatter and inline tags', () => {
  assert.deepEqual(extractMarkdownOutline('# Title\n## Methods\nText\n### Result'), [
    { id: 'heading-0', level: 1, title: 'Title' },
    { id: 'heading-1', level: 2, title: 'Methods' },
    { id: 'heading-3', level: 3, title: 'Result' },
  ])
  assert.deepEqual(collectVaultTags([
    { frontmatter: { tags: ['spatial', 'tumor'] }, body: 'Uses #spatial methods.' },
    { frontmatter: { tag: 'tumor' }, body: '' },
  ]), [{ name: 'spatial', count: 2 }, { name: 'tumor', count: 2 }])
})

test('builds a folder-first Vault tree and excludes hidden paths', () => {
  const notes = [
    { id: 'root', path: 'Research index.md', name: 'Research index.md' },
    { id: 'source', path: 'wiki/sources/Paper 10.md', name: 'Paper 10.md' },
    { id: 'annotation', path: 'wiki/annotations/Paper 2.md', name: 'Paper 2.md' },
    { id: 'hidden', path: '.verysync/Archive/secret.md', name: 'secret.md' },
  ]
  const tree = buildVaultFileTree(notes)

  assert.deepEqual(tree.map(({ type, name }) => ({ type, name })), [
    { type: 'folder', name: 'wiki' },
    { type: 'file', name: 'Research index' },
  ])
  assert.deepEqual(tree[0].children.map(({ type, name }) => ({ type, name })), [
    { type: 'folder', name: 'annotations' },
    { type: 'folder', name: 'sources' },
  ])
  assert.equal(tree[0].children[0].children[0].note.id, 'annotation')
})

test('filters a Vault tree while preserving matching ancestor folders', () => {
  const tree = buildVaultFileTree([
    { id: 'target', path: 'wiki/annotations/qiang_language_2026.md' },
    { id: 'other', path: 'wiki/sources/other.md' },
  ])
  const filtered = filterVaultFileTree(tree, 'qiang_language')

  assert.equal(filtered[0].name, 'wiki')
  assert.equal(filtered[0].children[0].name, 'annotations')
  assert.deepEqual(filtered[0].children[0].children.map((node) => node.name), ['qiang_language_2026'])
})

test('parses Obsidian wikilinks with aliases and heading targets', () => {
  assert.deepEqual(parseWikilinks('Evidence: [[wiki/sources/core_defining_2012|Core et al. 2012]] and [[#Methods]].'), [
    { type: 'text', value: 'Evidence: ' },
    { type: 'wikilink', raw: '[[wiki/sources/core_defining_2012|Core et al. 2012]]', target: 'wiki/sources/core_defining_2012', heading: '', alias: 'Core et al. 2012', label: 'Core et al. 2012' },
    { type: 'text', value: ' and ' },
    { type: 'wikilink', raw: '[[#Methods]]', target: '', heading: 'Methods', alias: '', label: 'Methods' },
    { type: 'text', value: '.' },
  ])
})

test('resolves wikilinks by Vault suffix, basename, and heading', () => {
  const notes = [
    { id: 'method', path: '.verysync/Archive/wiki/methods/gro-seq.md', title: 'GRO-seq', body: '## Methods\nDetails' },
    { id: 'source', path: '.verysync/Archive/wiki/sources/core_defining_2012.md', name: 'core_defining_2012.md', title: 'Defining the Status of RNA Polymerase at Promoters', body: '# Paper' },
  ]

  assert.equal(resolveWikilink(notes, notes[0], { target: 'wiki/sources/core_defining_2012' }).note.id, 'source')
  assert.equal(resolveWikilink(notes, notes[0], { target: 'core_defining_2012' }).note.id, 'source')
  assert.deepEqual(resolveWikilink(notes, notes[0], { target: '', heading: 'Methods' }), {
    note: notes[0],
    anchorId: 'heading-0',
    missing: false,
    missingHeading: false,
  })
  assert.equal(resolveWikilink(notes, notes[0], { target: 'missing-note' }).missing, true)
})

test('resolves relative wikilinks and frontmatter aliases through the Vault resolver', () => {
  const overview = { id: 'research/notes/overview.md', path: 'research/notes/overview.md', title: 'Overview', body: '# Overview' }
  const method = {
    id: 'research/methods/cellchat.md',
    path: 'research/methods/cellchat.md',
    name: 'cellchat.md',
    title: 'CellChat',
    frontmatter: { aliases: ['Cell Chat method'] },
    body: '# CellChat\n## Results\nDetails',
  }
  const notes = [overview, method]

  assert.equal(resolveWikilink(notes, overview, { target: '../methods/cellchat' }).note, method)
  assert.deepEqual(resolveWikilink(notes, overview, { target: 'Cell Chat method', heading: 'Results' }), {
    note: method,
    anchorId: 'heading-1',
    missing: false,
    missingHeading: false,
  })
})
