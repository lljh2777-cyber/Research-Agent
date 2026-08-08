import { executeResearchTool, RESEARCH_TOOL_DEFINITIONS } from './researchTools.js'

export const TOOL_EFFECTS = Object.freeze({ READ: 'read', WRITE: 'write', DESTRUCTIVE: 'destructive' })

export function toolPermissionDecision(effect, permissions = {}) {
  if (effect === TOOL_EFFECTS.DESTRUCTIVE) return 'deny'
  if (effect === TOOL_EFFECTS.WRITE) return permissions.write === 'deny' ? 'deny' : 'ask'
  return permissions.read === 'deny' ? 'deny' : 'allow'
}

export function createToolRegistry(entries, permissions) {
  const registered = new Map(entries.map((entry) => [entry.definition.name, entry]))
  const available = entries.filter((entry) => toolPermissionDecision(entry.effect, permissions) === 'allow')
  return {
    definitions: available.map((entry) => entry.definition),
    inventory: entries.map((entry) => ({
      name: entry.definition.name,
      source: entry.source,
      effect: entry.effect,
      decision: toolPermissionDecision(entry.effect, permissions),
    })),
    execute(call) {
      const entry = registered.get(call?.name)
      if (!entry) return Promise.resolve({ id: call?.id || '', name: call?.name || 'unknown', isError: true, summary: 'Unknown or unavailable tool.', content: JSON.stringify({ error: 'Unknown or unavailable tool.' }) })
      const decision = toolPermissionDecision(entry.effect, permissions)
      if (decision !== 'allow') {
        const message = decision === 'ask' ? 'This tool requires user confirmation before execution.' : 'This tool is blocked by the current permission policy.'
        return Promise.resolve({ id: call?.id || '', name: call.name, isError: true, summary: message, content: JSON.stringify({ error: message, permission: decision }) })
      }
      return Promise.resolve(entry.execute(call))
    },
  }
}

export function createResearchToolRegistry({ retrievalIndex, permissions }) {
  return createToolRegistry(RESEARCH_TOOL_DEFINITIONS.map((definition) => ({
    definition,
    source: 'builtin:vault',
    effect: TOOL_EFFECTS.READ,
    execute: (call) => executeResearchTool(call, { retrievalIndex }),
  })), permissions)
}
