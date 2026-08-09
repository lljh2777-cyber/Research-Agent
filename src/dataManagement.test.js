import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDataBackup,
  createLocalDataSummary,
  DATA_BACKUP_KIND,
  parseDataBackup,
  serializeDataBackup,
} from './dataManagement.js'

function portableInput() {
  return {
    workspace: {
      tabs: [{ id: 'research-1', kind: 'research', title: 'Bio - CellChat' }],
      activeTabId: 'research-1',
      sessions: {
        'research-1': {
          phase: 'conversation',
          messages: [{ id: 'message-1', role: 'user', text: 'Compare CellChat methods' }],
          configSnapshot: { source: { agentId: 'biologist' } },
        },
      },
    },
    modelConfig: { chatModelId: 'deepseek-chat', topK: 12 },
    providerConfigs: {
      deepseek: {
        endpoint: 'https://api.deepseek.com',
        apiKey: 'must-not-leave-the-device',
        models: [{ id: 'deepseek-chat' }],
        selectedModelIds: ['deepseek-chat'],
        enabled: true,
      },
    },
    mcpConfig: {
      permissions: { read: 'allow', write: 'ask', destructive: 'deny' },
      servers: [{ id: 'local-r', name: 'Local R', transport: 'stdio', command: 'Rscript', args: ['server.R'], env: { SECRET: 'must-not-export' } }],
    },
    pipelineRuns: [{ id: 'run-1', pipelineId: 'knowledge-inventory', status: 'completed', summary: 'Healthy Vault' }],
  }
}

test('creates a portable backup without credentials, Vault content, or transient runtime state', () => {
  const backup = createDataBackup(portableInput(), { createdAt: '2026-08-09T00:00:00.000Z', appVersion: '0.1.0' })
  const serialized = serializeDataBackup(backup)
  assert.equal(backup.kind, DATA_BACKUP_KIND)
  assert.equal(backup.data.workspace.sessions['research-1'].running, false)
  assert.equal(backup.data.providerConfigs.deepseek.enabled, true)
  assert.equal(backup.data.mcpConfig.servers[0].command, 'Rscript')
  assert.ok(!serialized.includes('must-not-leave-the-device'))
  assert.ok(!serialized.includes('must-not-export'))
  assert.ok(backup.exclusions.includes('vault-content'))
  assert.ok(!Object.hasOwn(backup.data, 'vault'))
  assert.ok(!Object.hasOwn(backup.data, 'credentials'))
})

test('parses and normalizes a supported backup while rejecting unrelated JSON', () => {
  const serialized = serializeDataBackup(createDataBackup(portableInput()))
  const restored = parseDataBackup(serialized)
  assert.equal(restored.data.workspace.sessions['research-1'].messages[0].text, 'Compare CellChat methods')
  assert.equal(restored.data.modelConfig.topK, 12)
  assert.equal(restored.data.pipelineRuns.length, 1)
  assert.throws(() => parseDataBackup('{"hello":"world"}'), /not a supported BioResearch OS backup/)
  assert.throws(() => parseDataBackup('{broken'), /not valid JSON/)
})

test('summarizes local history separately from the connected Vault', () => {
  const summary = createLocalDataSummary({ workspace: portableInput().workspace, pipelineRuns: portableInput().pipelineRuns, vaultNoteCount: 181 })
  assert.equal(summary.conversations, 1)
  assert.equal(summary.messages, 1)
  assert.equal(summary.pipelineRuns, 1)
  assert.equal(summary.vaultNotes, 181)
  assert.ok(summary.estimatedBytes > 0)
})
