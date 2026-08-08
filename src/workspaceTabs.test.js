import assert from 'node:assert/strict'
import test from 'node:test'
import { closeWorkspaceTab, createWorkspaceTab, findReusableTab, titleFromQuestion } from './workspaceTabs.js'

test('creates typed workspace tabs with stable user-facing titles', () => {
  assert.deepEqual(createWorkspaceTab('graph', { id: 'graph-1', vaultName: 'tumor-niche' }), {
    id: 'graph-1',
    kind: 'graph',
    title: 'tumor-niche',
    vaultName: 'tumor-niche',
  })
})

test('closing the active tab selects the adjacent surviving tab', () => {
  const tabs = [
    createWorkspaceTab('research', { id: 'research-1' }),
    createWorkspaceTab('graph', { id: 'graph-1' }),
    createWorkspaceTab('runs', { id: 'runs-1' }),
  ]
  const result = closeWorkspaceTab(tabs, 'graph-1', 'graph-1')
  assert.deepEqual(result.tabs.map((tab) => tab.id), ['research-1', 'runs-1'])
  assert.equal(result.activeTabId, 'runs-1')
})

test('the final workspace tab cannot be closed', () => {
  const tabs = [createWorkspaceTab('research', { id: 'research-1' })]
  assert.deepEqual(closeWorkspaceTab(tabs, 'research-1', 'research-1'), { tabs, activeTabId: 'research-1' })
})

test('conversation titles are compact and reusable tools stay singleton', () => {
  assert.equal(titleFromQuestion('  Compare spatial transcriptomics methods for tumor niche analysis  '), 'Compare spatial transcriptomics…')
  const tabs = [createWorkspaceTab('pipelines', { id: 'pipelines-1' })]
  assert.equal(findReusableTab(tabs, 'pipelines')?.id, 'pipelines-1')
  assert.equal(findReusableTab(tabs, 'research'), null)
  assert.equal(findReusableTab([createWorkspaceTab('launcher', { id: 'launcher-1' })], 'launcher')?.id, 'launcher-1')
})
