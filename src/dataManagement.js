import { DEFAULT_MODEL_CONFIG } from './modelConfig.js'
import { normalizeMcpConfig } from './mcpConfig.js'
import { normalizeProviderConfigs } from './providerConfig.js'
import { createWorkspaceSnapshot, normalizeWorkspaceSnapshot } from './workspacePersistence.js'

export const DATA_BACKUP_KIND = 'bioresearch-os-local-backup'
export const DATA_BACKUP_SCHEMA_VERSION = 1
export const MAX_DATA_BACKUP_BYTES = 16 * 1024 * 1024

function boundedString(value, limit = 2_000) {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function boundedClone(value, maxBytes, fallback) {
  try {
    const serialized = JSON.stringify(value)
    if (serialized.length > maxBytes) return fallback
    return JSON.parse(serialized)
  } catch {
    return fallback
  }
}

function finiteNumber(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

export function normalizePortableModelConfig(value) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    chatModelId: boundedString(input.chatModelId, 200) || DEFAULT_MODEL_CONFIG.chatModelId,
    embeddingModelId: boundedString(input.embeddingModelId, 200) || DEFAULT_MODEL_CONFIG.embeddingModelId,
    rerankModelId: boundedString(input.rerankModelId, 200) || DEFAULT_MODEL_CONFIG.rerankModelId,
    parserId: boundedString(input.parserId, 100) || DEFAULT_MODEL_CONFIG.parserId,
    topK: finiteNumber(input.topK, DEFAULT_MODEL_CONFIG.topK, 1, 50),
    similarityThreshold: finiteNumber(input.similarityThreshold, DEFAULT_MODEL_CONFIG.similarityThreshold, 0, 1),
    chunkSize: finiteNumber(input.chunkSize, DEFAULT_MODEL_CONFIG.chunkSize, 200, 8_000),
    chunkOverlap: finiteNumber(input.chunkOverlap, DEFAULT_MODEL_CONFIG.chunkOverlap, 0, 2_000),
    hybridSearch: typeof input.hybridSearch === 'boolean' ? input.hybridSearch : DEFAULT_MODEL_CONFIG.hybridSearch,
    citations: typeof input.citations === 'boolean' ? input.citations : DEFAULT_MODEL_CONFIG.citations,
  }
}

function normalizePipelineRun(run) {
  if (!run || typeof run !== 'object' || typeof run.id !== 'string' || typeof run.pipelineId !== 'string') return null
  return {
    id: boundedString(run.id, 160),
    pipelineId: boundedString(run.pipelineId, 160),
    title: boundedString(run.title, 240),
    output: boundedString(run.output, 240),
    vaultName: boundedString(run.vaultName, 240),
    status: run.status === 'completed' ? 'completed' : 'unknown',
    startedAt: boundedString(run.startedAt, 40),
    completedAt: boundedString(run.completedAt, 40),
    durationMs: finiteNumber(run.durationMs, 0, 0, 86_400_000),
    summary: boundedString(run.summary, 100_000),
    metrics: boundedClone(run.metrics || [], 250_000, []),
    findings: boundedClone(run.findings || [], 500_000, []),
    steps: boundedClone(run.steps || [], 500_000, []),
  }
}

export function normalizePortablePipelineRuns(value) {
  return (Array.isArray(value) ? value : []).map(normalizePipelineRun).filter(Boolean).slice(0, 50)
}

export function createDataBackup({ workspace, modelConfig, providerConfigs, mcpConfig, pipelineRuns }, { createdAt = new Date().toISOString(), appVersion = '0.1.0' } = {}) {
  const normalizedWorkspace = createWorkspaceSnapshot(workspace || { tabs: [], activeTabId: null, sessions: {} })
  if (!normalizedWorkspace) throw new Error('The current workspace could not be normalized for export.')
  return {
    kind: DATA_BACKUP_KIND,
    schemaVersion: DATA_BACKUP_SCHEMA_VERSION,
    createdAt: boundedString(createdAt, 40),
    appVersion: boundedString(appVersion, 40),
    exclusions: ['provider-credentials', 'oauth-tokens', 'vault-content', 'filesystem-handles'],
    data: {
      workspace: normalizedWorkspace,
      modelConfig: normalizePortableModelConfig(modelConfig),
      providerConfigs: normalizeProviderConfigs(providerConfigs),
      mcpConfig: normalizeMcpConfig(mcpConfig),
      pipelineRuns: normalizePortablePipelineRuns(pipelineRuns),
    },
  }
}

export function serializeDataBackup(backup) {
  const serialized = JSON.stringify(backup, null, 2)
  if (new TextEncoder().encode(serialized).length > MAX_DATA_BACKUP_BYTES) {
    throw new Error('The local backup exceeds the 16 MiB portable backup limit.')
  }
  return serialized
}

export function parseDataBackup(serialized) {
  if (typeof serialized !== 'string') throw new Error('Backup content must be JSON text.')
  if (new TextEncoder().encode(serialized).length > MAX_DATA_BACKUP_BYTES) throw new Error('The selected backup exceeds the 16 MiB import limit.')
  let parsed
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error('The selected file is not valid JSON.')
  }
  if (parsed?.kind !== DATA_BACKUP_KIND || parsed?.schemaVersion !== DATA_BACKUP_SCHEMA_VERSION) {
    throw new Error('This is not a supported BioResearch OS backup.')
  }
  const workspace = normalizeWorkspaceSnapshot(parsed.data?.workspace)
  if (!workspace) throw new Error('The backup does not contain a valid workspace snapshot.')
  return {
    kind: DATA_BACKUP_KIND,
    schemaVersion: DATA_BACKUP_SCHEMA_VERSION,
    createdAt: boundedString(parsed.createdAt, 40),
    appVersion: boundedString(parsed.appVersion, 40),
    exclusions: ['provider-credentials', 'oauth-tokens', 'vault-content', 'filesystem-handles'],
    data: {
      workspace,
      modelConfig: normalizePortableModelConfig(parsed.data?.modelConfig),
      providerConfigs: normalizeProviderConfigs(parsed.data?.providerConfigs),
      mcpConfig: normalizeMcpConfig(parsed.data?.mcpConfig),
      pipelineRuns: normalizePortablePipelineRuns(parsed.data?.pipelineRuns),
    },
  }
}

export function createLocalDataSummary({ workspace, pipelineRuns, vaultNoteCount = 0 }) {
  const snapshot = createWorkspaceSnapshot(workspace || { tabs: [], activeTabId: null, sessions: {} })
  const sessions = Object.values(snapshot?.sessions || {})
  const serialized = snapshot ? JSON.stringify(snapshot) : ''
  return {
    estimatedBytes: new TextEncoder().encode(serialized).length,
    conversations: sessions.length,
    messages: sessions.reduce((total, session) => total + (session.messages?.length || 0), 0),
    pipelineRuns: normalizePortablePipelineRuns(pipelineRuns).length,
    vaultNotes: Math.max(0, Number(vaultNoteCount) || 0),
  }
}
