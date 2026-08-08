export const MAX_WORKSPACE_TABS = 12

export const WORKSPACE_TAB_KINDS = Object.freeze({
  research: { label: 'Research', title: 'New research' },
  graph: { label: 'Knowledge Graph', title: 'Knowledge graph' },
  pipelines: { label: 'Pipelines', title: 'Pipelines' },
  runs: { label: 'Runs', title: 'Runs' },
  settings: { label: 'Settings', title: 'Settings' },
  launcher: { label: 'Launcher', title: 'Launcher' },
})

let tabSequence = 0

export function createWorkspaceTab(kind, { id, title, vaultName = '' } = {}) {
  const metadata = WORKSPACE_TAB_KINDS[kind] || WORKSPACE_TAB_KINDS.research
  tabSequence += 1
  return {
    id: id || `${kind}-${Date.now()}-${tabSequence}`,
    kind,
    title: title || (kind === 'graph' && vaultName ? vaultName : metadata.title),
    vaultName,
  }
}

export function titleFromQuestion(question, fallback = 'New research') {
  const normalized = String(question || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  if (normalized.length <= 34) return normalized
  const candidate = normalized.slice(0, 33).trimEnd()
  const wordBoundary = candidate.lastIndexOf(' ')
  return `${(wordBoundary > 18 ? candidate.slice(0, wordBoundary) : candidate).trimEnd()}…`
}

export function researchTabTitle(agentShortName, conversationTitle = 'New research') {
  const agent = String(agentShortName || '').replace(/\s+/g, ' ').trim() || 'Agent'
  const conversation = String(conversationTitle || '').replace(/\s+/g, ' ').trim() || 'New research'
  return `${agent} - ${conversation}`
}

export function closeWorkspaceTab(tabs, activeTabId, closingTabId) {
  const closingIndex = tabs.findIndex((tab) => tab.id === closingTabId)
  if (closingIndex < 0) return { tabs, activeTabId }
  const nextTabs = tabs.filter((tab) => tab.id !== closingTabId)
  if (activeTabId !== closingTabId) return { tabs: nextTabs, activeTabId }
  if (nextTabs.length === 0) return { tabs: nextTabs, activeTabId: null }
  const nextActive = nextTabs[Math.min(closingIndex, nextTabs.length - 1)]
  return { tabs: nextTabs, activeTabId: nextActive.id }
}

export function findReusableTab(tabs, kind) {
  if (kind === 'research' || kind === 'graph') return null
  return tabs.find((tab) => tab.kind === kind) || null
}
