export const MODEL_REGISTRY = [
  {
    id: 'smart-default',
    name: 'Smart (Default)',
    provider: 'Auto route',
    role: 'chat',
    detail: 'Balanced research responses',
    ready: true,
  },
  {
    id: 'deep-research',
    name: 'Deep Research',
    provider: 'Model profile',
    role: 'chat',
    detail: 'Long-context source synthesis',
    ready: false,
  },
  {
    id: 'local-qwen',
    name: 'Qwen3 · Ollama',
    provider: 'Ollama',
    role: 'chat',
    detail: 'Local/private research model',
    ready: false,
  },
  {
    id: 'bge-m3',
    name: 'BAAI/bge-m3',
    provider: 'Embedding',
    role: 'embedding',
    detail: 'Multilingual paper retrieval',
    ready: false,
  },
  {
    id: 'jina-reranker',
    name: 'jina-reranker-v2',
    provider: 'Reranker',
    role: 'rerank',
    detail: 'Cross-encoder candidate ranking',
    ready: false,
  },
]

export const DEFAULT_MODEL_CONFIG = {
  chatModelId: 'smart-default',
  embeddingModelId: 'none',
  rerankModelId: 'none',
  parserId: 'markdown',
  topK: 6,
  similarityThreshold: 0.35,
  chunkSize: 900,
  chunkOverlap: 120,
  hybridSearch: true,
  citations: true,
}

const STORAGE_KEY = 'bioresearch-os:model-config'

export function getModelsByRole(role) {
  return MODEL_REGISTRY.filter((model) => model.role === role)
}

export function getModelById(id) {
  return MODEL_REGISTRY.find((model) => model.id === id) || MODEL_REGISTRY[0]
}

export function loadModelConfig() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored ? { ...DEFAULT_MODEL_CONFIG, ...JSON.parse(stored) } : DEFAULT_MODEL_CONFIG
  } catch {
    return DEFAULT_MODEL_CONFIG
  }
}

export function saveModelConfig(config) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // Configuration persistence is optional in restricted browser contexts.
  }
}
