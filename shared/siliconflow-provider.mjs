export const SILICONFLOW_DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1'

export const SILICONFLOW_MODEL_KINDS = Object.freeze({
  CHAT: 'chat',
  EMBEDDING: 'embedding',
  RERANK: 'rerank',
})

export const SILICONFLOW_PROVIDER_DESCRIPTOR = Object.freeze({
  id: 'siliconflow',
  name: 'SiliconFlow',
  protocol: 'openai-chat-completions',
  protocolLabel: 'OpenAI-compatible Chat Completions',
  auth: 'api-key',
  modelCatalog: 'remote',
  defaultBaseUrl: SILICONFLOW_DEFAULT_BASE_URL,
  capabilities: Object.freeze({
    chat: true,
    modelDiscovery: true,
    embedding: true,
    rerank: true,
  }),
})

export const SILICONFLOW_PROVIDER = SILICONFLOW_PROVIDER_DESCRIPTOR

function modelText(record) {
  return [
    record?.id,
    record?.name,
    record?.display_name,
    record?.displayName,
    record?.kind,
    record?.type,
    record?.task,
    record?.task_type,
  ].filter((value) => value !== undefined && value !== null).join(' ').toLowerCase()
}

export function classifySiliconFlowModel(record) {
  const text = modelText(record)
  if (/(rerank|reranker|cross[-_ ]?encoder)/i.test(text)) return SILICONFLOW_MODEL_KINDS.RERANK
  if (/(embedding|embed|text[-_.]?embedding|bge[-_.]?m3|gte[-_.]|e5[-_.])/i.test(text)) return SILICONFLOW_MODEL_KINDS.EMBEDDING
  return SILICONFLOW_MODEL_KINDS.CHAT
}

export function siliconFlowModelCapabilities(record, kind = classifySiliconFlowModel(record)) {
  return {
    chat: kind === SILICONFLOW_MODEL_KINDS.CHAT,
    embedding: kind === SILICONFLOW_MODEL_KINDS.EMBEDDING,
    embeddings: kind === SILICONFLOW_MODEL_KINDS.EMBEDDING,
    rerank: kind === SILICONFLOW_MODEL_KINDS.RERANK,
  }
}

export function getSiliconFlowModelProfile(record) {
  const kind = classifySiliconFlowModel(record)
  return { kind, capabilities: siliconFlowModelCapabilities(record, kind) }
}

export function withSiliconFlowModelProfile(model) {
  const profile = getSiliconFlowModelProfile(model)
  return {
    ...model,
    kind: profile.kind,
    capabilities: {
      ...(model?.capabilities || {}),
      ...profile.capabilities,
    },
  }
}
