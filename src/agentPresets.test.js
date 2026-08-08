import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_PRESETS,
  createConversationConfigSnapshot,
  createRunSnapshot,
  getAgentPreset,
  resolveConversationConfig,
  TOOL_IDS,
  updateConversationKnowledgeScopes,
  updateConversationIdentity,
  updateConversationModel,
  updateConversationSystemPrompt,
  updateConversationTools,
} from './agentPresets.js'

test('ships focused, versioned research agent presets', () => {
  assert.deepEqual(AGENT_PRESETS.map(({ id }) => id), [
    'biologist',
    'literature-analyst',
    'bioinformatics-coder',
    'research-planner',
  ])
  assert(AGENT_PRESETS.every((preset) => preset.version === 1 && preset.shortName && preset.systemPrompt))
})

test('conversation overrides win for ordinary settings without expanding agent permissions', () => {
  const config = resolveConversationConfig({
    agentId: 'biologist',
    projectConfig: {
      id: 'cancer-atlas',
      model: { mode: 'fixed', providerId: 'bailian', modelId: 'qwen3.5-plus' },
      allowedTools: [TOOL_IDS.VAULT_SEARCH, TOOL_IDS.WEB_SEARCH],
      permissions: { networkAccess: 'ask' },
    },
    conversationOverrides: {
      model: { mode: 'fixed', providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
      enabledTools: [TOOL_IDS.VAULT_SEARCH, TOOL_IDS.WEB_SEARCH, TOOL_IDS.CODE_EXECUTE],
      permissions: { writeVault: true, executeCode: true, networkAccess: 'allow' },
    },
  })

  assert.equal(config.source.projectId, 'cancer-atlas')
  assert.equal(config.model.modelId, 'deepseek-v4-flash')
  assert.deepEqual(config.enabledTools, [TOOL_IDS.VAULT_SEARCH, TOOL_IDS.WEB_SEARCH])
  assert.deepEqual(config.permissions, {
    readVault: true,
    writeVault: false,
    executeCode: false,
    networkAccess: 'ask',
  })
})

test('denied permissions remove tools that require those permissions', () => {
  const config = resolveConversationConfig({
    agentId: 'bioinformatics-coder',
    conversationOverrides: {
      enabledTools: [TOOL_IDS.VAULT_SEARCH, TOOL_IDS.CODE_EXECUTE],
      permissions: { readVault: false, executeCode: false },
    },
  })

  assert.deepEqual(config.enabledTools, [])
})

test('conversation and run snapshots are detached from later changes', () => {
  const conversation = createConversationConfigSnapshot({
    conversationOverrides: { knowledgeScopes: [{ vaultId: 'knowledge-base', paths: ['wiki'] }] },
  })
  const updated = updateConversationModel(conversation, {
    mode: 'fixed',
    providerId: 'deepseek',
    modelId: 'deepseek-v4-flash',
    endpointType: 'openai-responses',
  })
  const run = createRunSnapshot(updated, {
    id: 'run-1',
    createdAt: '2026-08-08T00:00:00.000Z',
    resolvedModel: { modelId: 'deepseek-v4-flash-202608' },
  })

  updated.knowledgeScopes[0].paths.push('sources')
  assert.deepEqual(conversation.model, { mode: 'auto', providerId: null, modelId: 'smart-default', endpointType: null })
  assert.deepEqual(run.knowledgeScopes[0].paths, ['wiki'])
  assert.equal(run.model.modelId, 'deepseek-v4-flash-202608')
  assert.equal(run.source.agentId, 'biologist')
})

test('conversation editors preserve the permission-filtered configuration boundary', () => {
  const initial = createConversationConfigSnapshot({ agentId: 'biologist' })
  const withTools = updateConversationTools(initial, [TOOL_IDS.WEB_SEARCH, TOOL_IDS.CODE_EXECUTE])
  const withVault = updateConversationKnowledgeScopes(withTools, [{ vaultId: 'knowledge-base', paths: [], tags: [] }])

  assert.deepEqual(withTools.enabledTools, [TOOL_IDS.WEB_SEARCH])
  assert.deepEqual(withVault.knowledgeScopes, [{ vaultId: 'knowledge-base', paths: [], tags: [] }])
  assert.deepEqual(initial.knowledgeScopes, [])
})

test('conversation identity and system prompt are editable without mutating the preset', () => {
  const initial = createConversationConfigSnapshot({ agentId: 'biologist' })
  const identified = updateConversationIdentity(initial, { name: 'Tumor Biologist', shortName: 'T-Bio' })
  const prompted = updateConversationSystemPrompt(identified, 'Focus on tumor microenvironment evidence.')

  assert.deepEqual(prompted.identity, { name: 'Tumor Biologist', shortName: 'T-Bio' })
  assert.equal(prompted.systemPrompt, 'Focus on tumor microenvironment evidence.')
  assert.deepEqual(initial.identity, { name: 'Biologist', shortName: 'Bio' })
  assert.equal(getAgentPreset('biologist').name, 'Biologist')
})
