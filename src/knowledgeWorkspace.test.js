import assert from 'node:assert/strict'
import test from 'node:test'

import { buildVaultFileTree, collectVaultTags, DEFAULT_DOCK_LAYOUT, extractMarkdownOutline, filterVaultFileTree, moveDockPanel, normalizeDockLayout } from './knowledgeWorkspace.js'

test('normalizes dock layout without duplicates or missing panels', () => {
  const layout = normalizeDockLayout({ left: ['files', 'files', 'web'], right: ['graph', 'unknown'] })
  assert.deepEqual(layout.left, ['files', 'web', 'outline', 'tags'])
  assert.deepEqual(layout.right, ['graph', 'plugins'])
})

test('moves a panel across docks and preserves ordering', () => {
  const moved = moveDockPanel(DEFAULT_DOCK_LAYOUT, 'files', 'right', 'web')
  assert.deepEqual(moved.left, ['outline', 'tags'])
  assert.deepEqual(moved.right, ['graph', 'files', 'web', 'plugins'])
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
