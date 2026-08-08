export const MCP_TRANSPORTS = Object.freeze([
  Object.freeze({ id: 'streamable-http', label: 'Streamable HTTP', detail: 'Remote or local HTTP MCP endpoint' }),
  Object.freeze({ id: 'sse', label: 'SSE (legacy)', detail: 'Legacy HTTP + server-sent events transport' }),
  Object.freeze({ id: 'stdio', label: 'STDIO', detail: 'Desktop-only local process transport' }),
])

export const DEFAULT_TOOL_PERMISSIONS = Object.freeze({
  read: 'allow',
  write: 'ask',
  destructive: 'deny',
})

export const DEFAULT_MCP_CONFIG = Object.freeze({
  schemaVersion: 1,
  permissions: DEFAULT_TOOL_PERMISSIONS,
  servers: Object.freeze([]),
})

const STORAGE_KEY = 'bioresearch-os:mcp-config:v1'
const TRANSPORT_IDS = new Set(MCP_TRANSPORTS.map((transport) => transport.id))

function normalizePermissions(value = {}) {
  return {
    read: value.read === 'deny' ? 'deny' : 'allow',
    write: value.write === 'deny' ? 'deny' : 'ask',
    destructive: 'deny',
  }
}

function normalizeServer(server, index) {
  const transport = TRANSPORT_IDS.has(server?.transport) ? server.transport : 'streamable-http'
  return {
    id: String(server?.id || `mcp-${index + 1}`).slice(0, 80),
    name: String(server?.name || `MCP Server ${index + 1}`).trim().slice(0, 80),
    transport,
    endpoint: typeof server?.endpoint === 'string' ? server.endpoint.trim().slice(0, 2_000) : '',
    command: typeof server?.command === 'string' ? server.command.trim().slice(0, 500) : '',
    enabled: Boolean(server?.enabled),
  }
}

export function normalizeMcpConfig(value) {
  if (!value || typeof value !== 'object') return { schemaVersion: 1, permissions: { ...DEFAULT_TOOL_PERMISSIONS }, servers: [] }
  const seen = new Set()
  const servers = (Array.isArray(value.servers) ? value.servers : []).flatMap((server, index) => {
    const normalized = normalizeServer(server, index)
    if (!normalized.name || seen.has(normalized.id)) return []
    seen.add(normalized.id)
    return [normalized]
  }).slice(0, 32)
  return { schemaVersion: 1, permissions: normalizePermissions(value.permissions), servers }
}

export function loadMcpConfig(storage = globalThis.window?.localStorage) {
  try {
    return normalizeMcpConfig(JSON.parse(storage?.getItem(STORAGE_KEY) || 'null'))
  } catch {
    return normalizeMcpConfig(null)
  }
}

export function saveMcpConfig(config, storage = globalThis.window?.localStorage) {
  const normalized = normalizeMcpConfig(config)
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // MCP configuration persistence is optional in restricted browser contexts.
  }
  return normalized
}

export function createMcpServer(input = {}) {
  return normalizeServer({
    ...input,
    id: input.id || `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    enabled: false,
  }, 0)
}
