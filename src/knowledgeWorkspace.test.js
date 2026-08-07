import assert from 'node:assert/strict'
import test from 'node:test'

import { collectVaultTags, DEFAULT_DOCK_LAYOUT, extractMarkdownOutline, moveDockPanel, normalizeDockLayout } from './knowledgeWorkspace.js'

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
