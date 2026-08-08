import { createHash, randomUUID } from 'node:crypto'

import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const MAX_TOOLS = 128
const MAX_SCHEMA_BYTES = 24 * 1024
const MAX_ARGUMENT_BYTES = 128 * 1024
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_TICKET_TTL_MS = 60_000

function runtimeError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode })
}

function safeId(value, label) {
  const normalized = String(value || '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(normalized)) throw runtimeError(`${label} is invalid.`)
  return normalized
}

function validateUrl(value) {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw runtimeError('MCP endpoint must be a valid URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw runtimeError('MCP endpoint must use HTTP or HTTPS.')
  return url
}

function normalizeStdio(server) {
  const command = String(server.command || '').trim()
  if (!command || /[\r\n\0]/.test(command)) throw runtimeError('STDIO executable is invalid.')
  const args = Array.isArray(server.args) ? server.args.map((arg) => String(arg)) : []
  if (args.length > 64 || args.some((arg) => arg.length > 2_000 || /[\r\n\0]/.test(arg))) {
    throw runtimeError('STDIO arguments are invalid.')
  }
  return { command, args }
}

export function classifyMcpTool(tool = {}) {
  if (tool.annotations?.destructiveHint === true) return 'destructive'
  if (tool.annotations?.readOnlyHint === true) return 'read'
  return 'write'
}

export function normalizeMcpRuntimeServer(server = {}) {
  const id = safeId(server.id, 'Server id')
  const name = String(server.name || id).trim().slice(0, 80)
  if (!name) throw runtimeError('Server name is required.')
  if (server.transport === 'stdio') return { id, name, transport: 'stdio', ...normalizeStdio(server) }
  if (!['streamable-http', 'sse'].includes(server.transport)) throw runtimeError('Unsupported MCP transport.')
  return { id, name, transport: server.transport, endpoint: validateUrl(server.endpoint).href }
}

function publicTool(tool) {
  let inputSchema = { type: 'object', properties: {} }
  try {
    const serialized = JSON.stringify(tool.inputSchema || inputSchema)
    if (Buffer.byteLength(serialized) <= MAX_SCHEMA_BYTES) inputSchema = JSON.parse(serialized)
  } catch {}
  const sourceAnnotations = tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {}
  const annotations = {
    readOnlyHint: sourceAnnotations.readOnlyHint === true,
    destructiveHint: sourceAnnotations.destructiveHint === true,
    idempotentHint: sourceAnnotations.idempotentHint === true,
    openWorldHint: sourceAnnotations.openWorldHint === true,
  }
  return {
    name: String(tool.name || '').slice(0, 128),
    title: typeof tool.title === 'string' ? tool.title.slice(0, 160) : '',
    description: typeof tool.description === 'string' ? tool.description.slice(0, 2_000) : '',
    inputSchema,
    annotations,
    effect: classifyMcpTool({ annotations }),
  }
}

function hashArguments(args) {
  const serialized = JSON.stringify(args || {})
  if (Buffer.byteLength(serialized) > MAX_ARGUMENT_BYTES) throw runtimeError('MCP tool arguments are too large.', 413)
  return createHash('sha256').update(serialized).digest('hex')
}

async function withTimeout(promise, timeoutMs, label) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(runtimeError(`${label} timed out.`, 504)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

export async function createMcpClientSession(server, { connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  const client = new Client({ name: 'bioresearch-os', version: '0.1.0' })
  let transport
  if (server.transport === 'stdio') {
    transport = new StdioClientTransport({ command: server.command, args: server.args, stderr: 'pipe' })
    transport.stderr?.resume?.()
  } else if (server.transport === 'sse') {
    transport = new SSEClientTransport(new URL(server.endpoint))
  } else {
    transport = new StreamableHTTPClientTransport(new URL(server.endpoint))
  }
  try {
    await withTimeout(client.connect(transport), connectTimeoutMs, `Connection to ${server.name}`)
    return { client, transport }
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
}

export class McpRuntime {
  constructor({ clientFactory = createMcpClientSession, now = () => Date.now(), connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, ticketTtlMs = DEFAULT_TICKET_TTL_MS } = {}) {
    this.clientFactory = clientFactory
    this.now = now
    this.connectTimeoutMs = connectTimeoutMs
    this.ticketTtlMs = ticketTtlMs
    this.sessions = new Map()
    this.tickets = new Map()
  }

  status() {
    return {
      sessions: [...this.sessions.values()].map((session) => ({
        server: session.server,
        state: session.state,
        connectedAt: session.connectedAt,
        instructions: session.instructions,
        tools: session.tools,
        error: session.error || '',
      })),
    }
  }

  async connect(input) {
    const server = normalizeMcpRuntimeServer(input)
    await this.disconnect(server.id)
    const pending = { server, state: 'connecting', connectedAt: null, instructions: '', tools: [], client: null, transport: null, error: '' }
    this.sessions.set(server.id, pending)
    try {
      const session = await this.clientFactory(server, { connectTimeoutMs: this.connectTimeoutMs })
      pending.client = session.client
      pending.transport = session.transport
      const result = await withTimeout(session.client.listTools(), this.connectTimeoutMs, `Tool discovery for ${server.name}`)
      const tools = (Array.isArray(result?.tools) ? result.tools : []).slice(0, MAX_TOOLS).map(publicTool).filter((tool) => tool.name)
      Object.assign(pending, {
        state: 'connected',
        connectedAt: new Date(this.now()).toISOString(),
        instructions: String(session.client.getInstructions?.() || '').slice(0, 8_000),
        tools,
      })
      return this.status()
    } catch (error) {
      pending.state = 'error'
      pending.error = String(error?.message || 'MCP connection failed.').slice(0, 500)
      await pending.client?.close?.().catch(() => {})
      throw Object.assign(new Error(pending.error), { statusCode: Number(error?.statusCode) || 502 })
    }
  }

  async disconnect(serverId) {
    const id = String(serverId || '')
    const session = this.sessions.get(id)
    if (!session) return this.status()
    this.sessions.delete(id)
    for (const [ticketId, ticket] of this.tickets) if (ticket.serverId === id) this.tickets.delete(ticketId)
    if (session.transport?.terminateSession) await session.transport.terminateSession().catch(() => {})
    await session.client?.close?.().catch(() => {})
    return this.status()
  }

  prepareCall({ serverId, toolName, arguments: args }) {
    const session = this.sessions.get(String(serverId || ''))
    if (!session || session.state !== 'connected') throw runtimeError('MCP server is not connected.', 409)
    const tool = session.tools.find((entry) => entry.name === toolName)
    if (!tool) throw runtimeError('MCP tool is unavailable.', 404)
    if (tool.effect === 'destructive') throw runtimeError('Destructive MCP tools are blocked by policy.', 403)
    const ticketId = randomUUID()
    this.tickets.set(ticketId, {
      serverId: session.server.id,
      toolName: tool.name,
      arguments: args && typeof args === 'object' ? args : {},
      argumentsHash: hashArguments(args),
      effect: tool.effect,
      expiresAt: this.now() + this.ticketTtlMs,
    })
    return { ticketId, effect: tool.effect, requiresConfirmation: tool.effect === 'write', expiresInMs: this.ticketTtlMs, server: session.server, tool }
  }

  async executeCall({ ticketId, approved = false }) {
    const ticket = this.tickets.get(String(ticketId || ''))
    this.tickets.delete(String(ticketId || ''))
    if (!ticket || ticket.expiresAt < this.now()) throw runtimeError('MCP call approval expired or was already used.', 409)
    if (ticket.effect === 'write' && approved !== true) throw runtimeError('MCP write tool requires explicit approval.', 403)
    if (ticket.argumentsHash !== hashArguments(ticket.arguments)) throw runtimeError('MCP call arguments changed after review.', 409)
    const session = this.sessions.get(ticket.serverId)
    if (!session || session.state !== 'connected') throw runtimeError('MCP server disconnected before the tool call.', 409)
    const result = await session.client.callTool({ name: ticket.toolName, arguments: ticket.arguments })
    return { serverId: ticket.serverId, toolName: ticket.toolName, effect: ticket.effect, result }
  }

  async shutdown() {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)))
    this.tickets.clear()
  }
}
