import { executeResearchTool, RESEARCH_TOOL_DEFINITIONS } from './researchTools.js'
import {
  createKnowledgeActionOutput,
  KNOWLEDGE_ACTION_STATUS,
  KNOWLEDGE_ACTION_TOOL_DESCRIPTORS,
  KNOWLEDGE_TOOL_IDS,
  parseKnowledgeActionCall,
} from './research/knowledgeAgent.js'
import { consumeKnowledgeArchiveExecutionResult } from './research/knowledgeArchive.js'

export const TOOL_EFFECTS = Object.freeze({ READ: 'read', WRITE: 'write', DESTRUCTIVE: 'destructive' })

export function toolPermissionDecision(effect, permissions = {}) {
  if (effect === TOOL_EFFECTS.DESTRUCTIVE) return 'deny'
  if (effect === TOOL_EFFECTS.WRITE) return permissions.write === 'deny' ? 'deny' : 'ask'
  return permissions.read === 'deny' ? 'deny' : 'allow'
}

function toolError(call, message, details = {}) {
  return {
    id: call?.id || '',
    name: call?.name || 'unknown',
    isError: true,
    summary: message,
    content: JSON.stringify({ error: message, ...details }),
  }
}

function entryAvailability(entry) {
  return {
    available: entry.available !== false,
    reason: entry.available === false
      ? entry.unavailableReason || 'This tool is unavailable in the current runtime.'
      : null,
  }
}

export function createToolRegistry(entries, permissions, { requestApproval } = {}) {
  const registered = new Map(entries.map((entry) => [entry.definition.name, entry]))
  const available = entries.filter((entry) => (
    entryAvailability(entry).available && toolPermissionDecision(entry.effect, permissions) !== 'deny'
  ))
  return {
    definitions: available.map((entry) => entry.definition),
    inventory: entries.map((entry) => ({
      name: entry.definition.name,
      source: entry.source,
      effect: entry.effect,
      id: entry.descriptor?.id || entry.definition.name,
      title: entry.descriptor?.title || entry.definition.name,
      riskClass: entry.descriptor?.riskClass || entry.effect,
      approvalPolicy: entry.descriptor?.approvalPolicy || (entry.effect === TOOL_EFFECTS.WRITE ? 'explicit' : 'none'),
      capability: entry.descriptor?.capability || null,
      available: entryAvailability(entry).available,
      unavailableReason: entryAvailability(entry).reason,
      decision: toolPermissionDecision(entry.effect, permissions),
    })),
    async execute(call) {
      const entry = registered.get(call?.name)
      if (!entry) return toolError(call, 'Unknown or unavailable tool.')
      const availability = entryAvailability(entry)
      if (!availability.available) return toolError(call, availability.reason, { unavailable: true })
      const decision = toolPermissionDecision(entry.effect, permissions)
      if (decision === 'deny') {
        const message = 'This tool is blocked by the current permission policy.'
        return toolError(call, message, { permission: decision })
      }
      try {
        const prepared = entry.validateCall?.(call)
        const requiresExplicitApproval = entry.descriptor?.approvalPolicy === 'explicit'
        let approved = decision === 'allow' && !requiresExplicitApproval
        if (decision === 'ask' || requiresExplicitApproval) {
          approved = Boolean(await requestApproval?.({
            call,
            entry,
            descriptor: entry.descriptor || null,
            action: prepared || null,
          }))
        }
        if (!approved) {
          const message = 'This tool requires user confirmation before execution.'
          return toolError(call, message, { permission: decision })
        }
        return await Promise.resolve(entry.execute(call, { approved, prepared }))
      } catch (error) {
        if (error?.name === 'AbortError' || error?.terminalResult !== undefined) throw error
        return toolError(call, error?.message || 'Tool execution failed.')
      }
    },
  }
}

function capabilityState(capabilities, capability) {
  if (capabilities instanceof Set) return { available: capabilities.has(capability), reason: null }
  if (Array.isArray(capabilities)) return { available: capabilities.includes(capability), reason: null }
  const value = capabilities?.[capability]
  if (value === true) return { available: true, reason: null }
  if (value && typeof value === 'object') {
    return { available: value.available === true, reason: value.reason || null }
  }
  return { available: false, reason: null }
}

function knowledgeActionResult(call, descriptor, request, value = {}) {
  const output = descriptor.id === KNOWLEDGE_TOOL_IDS.SYNTHESIS
    ? consumeKnowledgeArchiveExecutionResult(request, value)
    : createKnowledgeActionOutput(descriptor.id, {
      requestId: request.requestId,
      runId: request.runId,
      status: value.status,
      summary: value.summary,
      data: value.data,
      artifacts: value.artifacts,
      error: value.error,
      effect: value.effect,
  })
  if (
    output.status === KNOWLEDGE_ACTION_STATUS.CANCELLED
    || (descriptor.id === KNOWLEDGE_TOOL_IDS.SYNTHESIS && output.status === KNOWLEDGE_ACTION_STATUS.FAILED)
  ) {
    throw Object.assign(new Error(output.summary || 'Knowledge action cancelled.'), {
      ...(output.status === KNOWLEDGE_ACTION_STATUS.CANCELLED ? { name: 'AbortError' } : {}),
      terminalResult: output,
    })
  }
  return {
    id: call.id,
    name: call.name,
    isError: output.status === KNOWLEDGE_ACTION_STATUS.FAILED,
    summary: output.summary,
    content: JSON.stringify(output),
  }
}

export function createKnowledgeActionToolEntries({
  capabilities = {},
  context,
  sessionId,
  runId,
  executeAction,
} = {}) {
  return KNOWLEDGE_ACTION_TOOL_DESCRIPTORS.map((descriptor) => {
    const capability = capabilityState(capabilities, descriptor.capability)
    const prepare = (call) => parseKnowledgeActionCall(descriptor.id, call, { context, sessionId, runId })
    return {
      definition: {
        name: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.inputSchema,
      },
      descriptor,
      source: 'builtin:knowledge-agent',
      effect: descriptor.effect,
      available: capability.available,
      unavailableReason: capability.reason || `Runtime capability ${descriptor.capability} is unavailable.`,
      validateCall: prepare,
      async execute(call, { prepared }) {
        if (typeof executeAction !== 'function') throw new Error('Knowledge Action execution is unavailable in this runtime.')
        const request = prepared || prepare(call)
        return knowledgeActionResult(call, descriptor, request, await executeAction(request, { descriptor }))
      },
    }
    })
}

export function createKnowledgeActionToolRegistry(options = {}) {
  return createToolRegistry(
    createKnowledgeActionToolEntries(options),
    options.permissions,
    { requestApproval: options.requestApproval },
  )
}

export function createResearchToolEntries(retrievalIndex) {
  return RESEARCH_TOOL_DEFINITIONS.map((definition) => ({
    definition,
    source: 'builtin:vault',
    effect: TOOL_EFFECTS.READ,
    execute: (call) => executeResearchTool(call, { retrievalIndex }),
  }))
}

export function createResearchToolRegistry({ retrievalIndex, permissions, requestApproval }) {
  return createToolRegistry(createResearchToolEntries(retrievalIndex), permissions, { requestApproval })
}
