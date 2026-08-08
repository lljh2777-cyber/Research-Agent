import { executeResearchTool, RESEARCH_TOOL_DEFINITIONS } from './researchTools.js'

export const TOOL_EFFECTS = Object.freeze({ READ: 'read', WRITE: 'write', DESTRUCTIVE: 'destructive' })

export function toolPermissionDecision(effect, permissions = {}) {
  if (effect === TOOL_EFFECTS.DESTRUCTIVE) return 'deny'
  if (effect === TOOL_EFFECTS.WRITE) return permissions.write === 'deny' ? 'deny' : 'ask'
  return permissions.read === 'deny' ? 'deny' : 'allow'
}

export function createToolRegistry(entries, permissions, { requestApproval } = {}) {
  const registered = new Map(entries.map((entry) => [entry.definition.name, entry]))
  const available = entries.filter((entry) => toolPermissionDecision(entry.effect, permissions) !== 'deny')
  return {
    definitions: available.map((entry) => entry.definition),
    inventory: entries.map((entry) => ({
      name: entry.definition.name,
      source: entry.source,
      effect: entry.effect,
      decision: toolPermissionDecision(entry.effect, permissions),
    })),
    async execute(call) {
      const entry = registered.get(call?.name)
      if (!entry) return { id: call?.id || '', name: call?.name || 'unknown', isError: true, summary: 'Unknown or unavailable tool.', content: JSON.stringify({ error: 'Unknown or unavailable tool.' }) }
      const decision = toolPermissionDecision(entry.effect, permissions)
      if (decision === 'deny') {
        const message = 'This tool is blocked by the current permission policy.'
        return { id: call?.id || '', name: call.name, isError: true, summary: message, content: JSON.stringify({ error: message, permission: decision }) }
      }
      let approved = decision === 'allow'
      if (decision === 'ask') approved = Boolean(await requestApproval?.({ call, entry }))
      if (!approved) {
        const message = 'This tool requires user confirmation before execution.'
        return { id: call?.id || '', name: call.name, isError: true, summary: message, content: JSON.stringify({ error: message, permission: decision }) }
      }
      return Promise.resolve(entry.execute(call, { approved }))
    },
  }
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
