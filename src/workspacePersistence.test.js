import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkspaceSnapshot, loadWorkspaceSnapshot, normalizeWorkspaceSnapshot, saveWorkspaceSnapshot, WORKSPACE_PERSISTENCE_LIMITS } from './workspacePersistence.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

test('persists restorable workspace tabs and conversations without transient runtime state', async () => {
  const storage = memoryStorage()
  const snapshot = {
    tabs: [
      { id: 'research-1', kind: 'research', title: 'Bio - CellChat', vaultName: '' },
      { id: 'graph-1', kind: 'graph', title: 'knowledge-base', vaultName: 'knowledge-base' },
    ],
    activeTabId: 'research-1',
    sessions: {
      'research-1': {
        phase: 'conversation',
        conversationTitle: 'CellChat',
        input: 'draft question',
        running: true,
        pendingQuestion: 'must not resume',
        retrievalPacket: { evidence: ['transient'] },
        messages: [{ id: 'user-1', role: 'user', text: 'Compare CellChat methods', evidenceContext: 'local evidence' }],
        configSnapshot: {
          source: { agentId: 'biologist' },
          identity: { name: 'My Biologist', shortName: 'Bio' },
          systemPrompt: 'Use evidence.',
          model: { mode: 'fixed', providerId: 'deepseek', modelId: 'deepseek-chat' },
          enabledTools: ['vault.search', 'vault.write', 'unknown.tool'],
          permissions: { writeVault: true, executeCode: true, networkAccess: 'allow' },
        },
        runSnapshots: [{ id: 'run-1', model: { modelId: 'deepseek-chat' } }],
      },
    },
  }

  assert.equal(await saveWorkspaceSnapshot(snapshot, { indexedDb: null, storage }), true)
  const restored = await loadWorkspaceSnapshot({ indexedDb: null, storage })
  const session = restored.sessions['research-1']
  assert.equal(restored.tabs.length, 2)
  assert.equal(restored.activeTabId, 'research-1')
  assert.equal(session.running, false)
  assert.equal(session.pendingQuestion, '')
  assert.equal(session.retrievalPacket, null)
  assert.equal(session.input, 'draft question')
  assert.equal(session.configSnapshot.identity.name, 'My Biologist')
  assert.deepEqual(session.configSnapshot.enabledTools, ['vault.search'])
  assert.equal(session.configSnapshot.permissions.writeVault, false)
})

test('rejects malformed tabs, duplicate ids, orphan sessions, and unknown schema versions', () => {
  assert.equal(normalizeWorkspaceSnapshot({ schemaVersion: 2, tabs: [] }), null)
  const normalized = normalizeWorkspaceSnapshot({
    schemaVersion: 1,
    tabs: [
      { id: 'same', kind: 'research', title: 'First' },
      { id: 'same', kind: 'settings', title: 'Duplicate' },
      { id: 'bad', kind: 'unknown', title: 'Unknown' },
    ],
    activeTabId: 'missing',
    sessions: { same: { messages: [] }, orphan: { messages: [] } },
  })
  assert.deepEqual(normalized.tabs.map((tab) => tab.id), ['same'])
  assert.equal(normalized.activeTabId, 'same')
  assert.deepEqual(Object.keys(normalized.sessions), ['same'])
  assert.equal(normalized.sessions.same.configSnapshot.model.modelId, 'smart-default')
})

test('bounds retained message history and keeps empty workspaces valid', () => {
  const messages = Array.from({ length: WORKSPACE_PERSISTENCE_LIMITS.maxMessagesPerSession + 5 }, (_, index) => ({ id: `message-${index}`, role: 'user', text: String(index) }))
  const normalized = createWorkspaceSnapshot({
    tabs: [{ id: 'research-1', kind: 'research', title: 'Research' }],
    activeTabId: 'research-1',
    sessions: { 'research-1': { messages } },
  })
  assert.equal(normalized.sessions['research-1'].messages.length, WORKSPACE_PERSISTENCE_LIMITS.maxMessagesPerSession)
  assert.equal(normalized.sessions['research-1'].messages[0].text, '5')
  assert.deepEqual(createWorkspaceSnapshot({ tabs: [], activeTabId: null, sessions: {} }).tabs, [])
})
