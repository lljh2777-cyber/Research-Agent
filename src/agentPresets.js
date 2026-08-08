const TOOL_IDS = Object.freeze({
  VAULT_SEARCH: 'vault.search',
  VAULT_WIKILINKS: 'vault.wikilinks',
  WEB_SEARCH: 'web.search',
  MCP: 'mcp',
  CODE_EXECUTE: 'code.execute',
  VAULT_WRITE: 'vault.write',
})

export const SYSTEM_RESEARCH_DEFAULTS = Object.freeze({
  model: Object.freeze({ mode: 'auto', providerId: null, modelId: 'smart-default', endpointType: null }),
  fallbackModels: Object.freeze([]),
  knowledgeScopes: Object.freeze([]),
  outputStyle: 'with-citations',
  loopPolicy: Object.freeze({ maxToolRounds: 6, requireEvidence: true, stopOnInsufficientEvidence: false }),
})

export const SYSTEM_PERMISSION_CEILING = Object.freeze({
  readVault: true,
  writeVault: true,
  executeCode: true,
  networkAccess: 'allow',
})

export const AGENT_PRESETS = Object.freeze([
  {
    id: 'biologist',
    version: 1,
    name: 'Biologist',
    shortName: 'Bio',
    description: 'Biological questions grounded in Vault evidence and literature citations.',
    systemPrompt: 'Act as a careful research biologist. Separate evidence from inference, cite sources, and state uncertainty.',
    model: { mode: 'auto', providerId: null, modelId: 'smart-default', endpointType: null },
    fallbackModels: [],
    tools: {
      allowed: [TOOL_IDS.VAULT_SEARCH, TOOL_IDS.VAULT_WIKILINKS, TOOL_IDS.WEB_SEARCH, TOOL_IDS.MCP],
      defaults: [TOOL_IDS.VAULT_SEARCH, TOOL_IDS.VAULT_WIKILINKS],
    },
    knowledgeScopes: [],
    permissions: { readVault: true, writeVault: false, executeCode: false, networkAccess: 'allow' },
    outputStyle: 'with-citations',
    loopPolicy: { maxToolRounds: 6, requireEvidence: true, stopOnInsufficientEvidence: false },
  },
  {
    id: 'literature-analyst',
    version: 1,
    name: 'Literature Analyst',
    shortName: 'Lit',
    description: 'Paper analysis, figure interpretation, and evidence extraction.',
    systemPrompt: 'Analyze scientific literature with explicit evidence chains. Distinguish reported results from interpretation.',
    model: { mode: 'auto', providerId: null, modelId: 'smart-default', endpointType: null },
    fallbackModels: [],
    tools: {
      allowed: [TOOL_IDS.VAULT_SEARCH, TOOL_IDS.VAULT_WIKILINKS, TOOL_IDS.WEB_SEARCH, TOOL_IDS.MCP],
      defaults: [TOOL_IDS.VAULT_SEARCH, TOOL_IDS.VAULT_WIKILINKS, TOOL_IDS.WEB_SEARCH],
    },
    knowledgeScopes: [],
    permissions: { readVault: true, writeVault: false, executeCode: false, networkAccess: 'allow' },
    outputStyle: 'evidence-report',
    loopPolicy: { maxToolRounds: 8, requireEvidence: true, stopOnInsufficientEvidence: false },
  },
  {
    id: 'bioinformatics-coder',
    version: 1,
    name: 'Bioinformatics Coder',
    shortName: 'BioCode',
    description: 'Bioinformatics code, reproducible pipelines, and local analysis tools.',
    systemPrompt: 'Act as a reproducible bioinformatics engineer. Explain assumptions, validate inputs, and keep destructive actions gated.',
    model: { mode: 'auto', providerId: null, modelId: 'smart-default', endpointType: null },
    fallbackModels: [],
    tools: {
      allowed: [TOOL_IDS.VAULT_SEARCH, TOOL_IDS.VAULT_WIKILINKS, TOOL_IDS.MCP, TOOL_IDS.CODE_EXECUTE],
      defaults: [TOOL_IDS.VAULT_SEARCH, TOOL_IDS.VAULT_WIKILINKS, TOOL_IDS.MCP],
    },
    knowledgeScopes: [],
    permissions: { readVault: true, writeVault: false, executeCode: true, networkAccess: 'ask' },
    outputStyle: 'reproducible-analysis',
    loopPolicy: { maxToolRounds: 10, requireEvidence: false, stopOnInsufficientEvidence: false },
  },
  {
    id: 'research-planner',
    version: 1,
    name: 'Research Planner',
    shortName: 'Plan',
    description: 'Research questions, experimental plans, milestones, and risk analysis.',
    systemPrompt: 'Design feasible research plans with explicit hypotheses, controls, decision points, limitations, and validation criteria.',
    model: { mode: 'auto', providerId: null, modelId: 'smart-default', endpointType: null },
    fallbackModels: [],
    tools: {
      allowed: [TOOL_IDS.VAULT_SEARCH, TOOL_IDS.VAULT_WIKILINKS, TOOL_IDS.WEB_SEARCH],
      defaults: [TOOL_IDS.VAULT_SEARCH, TOOL_IDS.VAULT_WIKILINKS],
    },
    knowledgeScopes: [],
    permissions: { readVault: true, writeVault: false, executeCode: false, networkAccess: 'allow' },
    outputStyle: 'research-plan',
    loopPolicy: { maxToolRounds: 6, requireEvidence: false, stopOnInsufficientEvidence: false },
  },
])

const NETWORK_LEVEL = Object.freeze({ deny: 0, ask: 1, allow: 2 })

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))]
}

function restrictNetwork(current = 'deny', requested) {
  if (!requested || !(requested in NETWORK_LEVEL)) return current
  return NETWORK_LEVEL[requested] < NETWORK_LEVEL[current] ? requested : current
}

function restrictPermissions(current, requested = {}) {
  return {
    readVault: current.readVault && requested.readVault !== false,
    writeVault: current.writeVault && requested.writeVault !== false,
    executeCode: current.executeCode && requested.executeCode !== false,
    networkAccess: restrictNetwork(current.networkAccess, requested.networkAccess),
  }
}

function intersectTools(current, requested) {
  if (!Array.isArray(requested)) return current
  const requestedSet = new Set(requested)
  return current.filter((toolId) => requestedSet.has(toolId))
}

export function getAgentPreset(id = 'biologist') {
  return AGENT_PRESETS.find((preset) => preset.id === id) || AGENT_PRESETS[0]
}

export function resolveConversationConfig({
  agentId = 'biologist',
  systemDefaults = SYSTEM_RESEARCH_DEFAULTS,
  systemPermissions = SYSTEM_PERMISSION_CEILING,
  projectConfig = {},
  conversationOverrides = {},
} = {}) {
  const preset = getAgentPreset(agentId)
  const allowedByAgent = unique(preset.tools?.allowed)
  const allowedTools = intersectTools(allowedByAgent, projectConfig.allowedTools)
  const requestedTools = conversationOverrides.enabledTools
    ?? projectConfig.enabledTools
    ?? preset.tools?.defaults
    ?? []
  const permissions = [preset.permissions, projectConfig.permissions, conversationOverrides.permissions]
    .reduce(restrictPermissions, { ...systemPermissions })
  const enabledTools = intersectTools(allowedTools, unique(requestedTools)).filter((toolId) => {
    if (toolId === TOOL_IDS.WEB_SEARCH) return permissions.networkAccess !== 'deny'
    if (toolId === TOOL_IDS.CODE_EXECUTE) return permissions.executeCode
    if (toolId === TOOL_IDS.VAULT_WRITE) return permissions.writeVault
    if (toolId.startsWith('vault.')) return permissions.readVault
    return true
  })

  return {
    source: {
      agentId: preset.id,
      agentVersion: preset.version,
      projectId: projectConfig.id || null,
    },
    identity: clone({
      name: preset.name,
      shortName: preset.shortName || preset.name,
      ...(projectConfig.identity || {}),
      ...(conversationOverrides.identity || {}),
    }),
    systemPrompt: conversationOverrides.systemPrompt ?? projectConfig.systemPrompt ?? preset.systemPrompt,
    model: clone(conversationOverrides.model ?? projectConfig.model ?? preset.model ?? systemDefaults.model),
    fallbackModels: clone(conversationOverrides.fallbackModels ?? projectConfig.fallbackModels ?? preset.fallbackModels ?? systemDefaults.fallbackModels),
    allowedTools,
    enabledTools,
    knowledgeScopes: clone(conversationOverrides.knowledgeScopes ?? projectConfig.knowledgeScopes ?? preset.knowledgeScopes ?? systemDefaults.knowledgeScopes),
    permissions,
    outputStyle: conversationOverrides.outputStyle ?? projectConfig.outputStyle ?? preset.outputStyle ?? systemDefaults.outputStyle,
    loopPolicy: {
      ...systemDefaults.loopPolicy,
      ...preset.loopPolicy,
      ...projectConfig.loopPolicy,
      ...conversationOverrides.loopPolicy,
    },
  }
}

export function createConversationConfigSnapshot(options = {}) {
  return clone(resolveConversationConfig(options))
}

export function updateConversationModel(snapshot, model) {
  return {
    ...clone(snapshot),
    model: { ...clone(snapshot?.model || SYSTEM_RESEARCH_DEFAULTS.model), ...clone(model) },
  }
}

export function updateConversationIdentity(snapshot, identity) {
  const config = clone(snapshot || createConversationConfigSnapshot())
  return {
    ...config,
    identity: {
      ...clone(config.identity || {}),
      ...clone(identity || {}),
    },
  }
}

export function updateConversationSystemPrompt(snapshot, systemPrompt) {
  return {
    ...clone(snapshot || createConversationConfigSnapshot()),
    systemPrompt: String(systemPrompt ?? ''),
  }
}

export function updateConversationKnowledgeScopes(snapshot, knowledgeScopes) {
  return {
    ...clone(snapshot),
    knowledgeScopes: clone(knowledgeScopes || []),
  }
}

export function updateConversationTools(snapshot, enabledTools) {
  const config = clone(snapshot || createConversationConfigSnapshot())
  return {
    ...config,
    enabledTools: intersectTools(config.allowedTools || [], unique(enabledTools)),
  }
}

export function createRunSnapshot(conversationConfig, {
  id = `run-${Date.now()}`,
  createdAt = new Date().toISOString(),
  resolvedModel = null,
  enabledTools,
} = {}) {
  const config = clone(conversationConfig || createConversationConfigSnapshot())
  const requestedTools = enabledTools === undefined ? config.enabledTools : enabledTools
  return {
    id,
    createdAt,
    source: clone(config.source),
    identity: clone(config.identity),
    systemPrompt: config.systemPrompt,
    model: { ...clone(config.model), ...(resolvedModel ? clone(resolvedModel) : {}) },
    enabledTools: intersectTools(config.allowedTools || [], unique(requestedTools)),
    knowledgeScopes: clone(config.knowledgeScopes),
    permissions: clone(config.permissions),
    outputStyle: config.outputStyle,
    loopPolicy: clone(config.loopPolicy),
  }
}

export { TOOL_IDS }
