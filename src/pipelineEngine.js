const RUNS_STORAGE_KEY = 'bioresearch-os:pipeline-runs:v1'
const MAX_STORED_RUNS = 50

export const PIPELINE_TEMPLATES = [
  {
    id: 'vault-integrity-audit',
    title: 'Vault integrity audit',
    category: 'Knowledge quality',
    description: 'Resolve wikilinks, detect orphan notes, and surface broken references before research synthesis.',
    output: 'Link health report',
    icon: 'shield',
    stages: ['Snapshot Vault', 'Resolve wikilinks', 'Detect knowledge gaps', 'Summarize findings'],
  },
  {
    id: 'retrieval-readiness',
    title: 'Retrieval readiness',
    category: 'RAG diagnostics',
    description: 'Inspect chunks, metadata coverage, note content, and graph connectivity used by local retrieval.',
    output: 'Retrieval readiness report',
    icon: 'search',
    stages: ['Inspect Markdown', 'Measure chunk coverage', 'Check metadata', 'Score readiness'],
  },
  {
    id: 'knowledge-inventory',
    title: 'Knowledge inventory',
    category: 'Vault intelligence',
    description: 'Classify note types and identify the most connected concepts, methods, papers, and datasets.',
    output: 'Knowledge inventory',
    icon: 'network',
    stages: ['Classify notes', 'Measure connectivity', 'Rank central nodes', 'Build inventory'],
  },
]

function percent(part, total) {
  return total ? Math.round((part / total) * 100) : 0
}

function relationshipMetrics(notes, edges) {
  const degree = new Map(notes.map((note) => [note.id, 0]))
  const seen = new Set()
  let resolved = 0
  let unresolved = 0
  for (const edge of edges) {
    const targetId = edge.target.missing ? `missing:${edge.target.title.toLocaleLowerCase()}` : edge.target.id
    const relationshipId = `${edge.source.id}->${targetId}`
    if (seen.has(relationshipId)) continue
    seen.add(relationshipId)
    degree.set(edge.source.id, (degree.get(edge.source.id) || 0) + 1)
    if (edge.target.missing) {
      unresolved += 1
    } else {
      resolved += 1
      degree.set(edge.target.id, (degree.get(edge.target.id) || 0) + 1)
    }
  }
  const ranked = notes
    .map((note) => ({ id: note.id, title: note.title, type: note.type || 'note', degree: degree.get(note.id) || 0 }))
    .sort((left, right) => right.degree - left.degree || left.title.localeCompare(right.title))
  return {
    degree,
    ranked,
    resolved,
    unresolved,
    orphans: ranked.filter((note) => note.degree === 0),
    connected: ranked.filter((note) => note.degree > 0),
  }
}

function integrityAudit(context) {
  const notes = context.notes || []
  const relations = relationshipMetrics(notes, context.vaultIndex?.edges || [])
  const missingTypes = notes.filter((note) => !note.frontmatter?.type).length
  const findings = []
  findings.push(relations.unresolved
    ? { level: 'warning', title: `${relations.unresolved} unresolved wikilink${relations.unresolved === 1 ? '' : 's'}`, detail: 'Create matching Markdown notes or repair the link targets.' }
    : { level: 'success', title: 'All wikilinks resolve', detail: 'No broken local note references were detected.' })
  if (relations.orphans.length) findings.push({ level: 'warning', title: `${relations.orphans.length} orphan note${relations.orphans.length === 1 ? '' : 's'}`, detail: relations.orphans.slice(0, 4).map((note) => note.title).join(', ') })
  if (missingTypes) findings.push({ level: 'info', title: `${missingTypes} note${missingTypes === 1 ? '' : 's'} without a type`, detail: 'Add frontmatter type fields to improve filtering and knowledge inventory.' })
  if (!findings.some((finding) => finding.level === 'warning')) findings.push({ level: 'success', title: 'Vault link structure is healthy', detail: `${relations.connected.length} notes participate in the local knowledge graph.` })
  return {
    summary: `Audited ${notes.length} Markdown notes and ${relations.resolved + relations.unresolved} wikilinks in ${context.vaultName}.`,
    metrics: [
      { label: 'Notes', value: notes.length },
      { label: 'Resolved', value: relations.resolved },
      { label: 'Unresolved', value: relations.unresolved, tone: relations.unresolved ? 'warning' : 'success' },
      { label: 'Orphans', value: relations.orphans.length, tone: relations.orphans.length ? 'warning' : 'success' },
    ],
    findings,
    stepDetails: [
      `${notes.length} Markdown notes captured`,
      `${relations.resolved} resolved and ${relations.unresolved} unresolved links`,
      `${relations.orphans.length} orphan notes and ${missingTypes} missing type fields`,
      'Link health report generated locally',
    ],
  }
}

function retrievalReadiness(context) {
  const notes = context.notes || []
  const chunks = context.retrievalIndex?.chunks || []
  const metadataNotes = notes.filter((note) => Object.keys(note.frontmatter || {}).length > 0).length
  const nonEmptyNotes = notes.filter((note) => note.body?.trim()).length
  const graph = context.retrievalIndex?.graph || new Map()
  const connectedNotes = notes.filter((note) => (graph.get(note.id)?.size || 0) > 0).length
  const metadataCoverage = percent(metadataNotes, notes.length)
  const connectedCoverage = percent(connectedNotes, notes.length)
  const contentCoverage = percent(nonEmptyNotes, notes.length)
  const readiness = Math.round((metadataCoverage * 0.25) + (connectedCoverage * 0.35) + (contentCoverage * 0.4))
  const findings = [
    { level: readiness >= 75 ? 'success' : 'warning', title: `${readiness}% retrieval readiness`, detail: 'Heuristic based on content, metadata, and graph connectivity coverage.' },
    { level: metadataCoverage >= 70 ? 'success' : 'info', title: `${metadataCoverage}% metadata coverage`, detail: `${metadataNotes} of ${notes.length} notes include parsed frontmatter.` },
    { level: connectedCoverage >= 70 ? 'success' : 'info', title: `${connectedCoverage}% graph-connected notes`, detail: `${connectedNotes} notes can participate in one-hop wikilink expansion.` },
  ]
  if (nonEmptyNotes < notes.length) findings.push({ level: 'warning', title: `${notes.length - nonEmptyNotes} empty note${notes.length - nonEmptyNotes === 1 ? '' : 's'}`, detail: 'Empty notes produce retrieval chunks without evidence text.' })
  return {
    summary: `Inspected the current Markdown and BM25 index for ${context.vaultName}.`,
    metrics: [
      { label: 'Chunks', value: chunks.length },
      { label: 'Avg tokens', value: Math.round(context.retrievalIndex?.averageLength || 0) },
      { label: 'Metadata', value: `${metadataCoverage}%` },
      { label: 'Readiness', value: `${readiness}%`, tone: readiness >= 75 ? 'success' : 'warning' },
    ],
    findings,
    stepDetails: [
      `${nonEmptyNotes} of ${notes.length} notes contain evidence text`,
      `${chunks.length} retrieval chunks at ${context.chunkSize || 1200} characters`,
      `${metadataCoverage}% metadata and ${connectedCoverage}% link coverage`,
      `${readiness}% local retrieval readiness score`,
    ],
  }
}

function knowledgeInventory(context) {
  const notes = context.notes || []
  const relations = relationshipMetrics(notes, context.vaultIndex?.edges || [])
  const typeCounts = new Map()
  for (const note of notes) {
    const type = typeof note.type === 'string' && note.type ? note.type : 'note'
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1)
  }
  const sortedTypes = [...typeCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  const central = relations.ranked.filter((note) => note.degree > 0).slice(0, 5)
  const connectedCoverage = percent(relations.connected.length, notes.length)
  const findings = sortedTypes.map(([type, count]) => ({ level: 'info', title: `${count} ${type} note${count === 1 ? '' : 's'}`, detail: `${percent(count, notes.length)}% of the current Vault.` }))
  if (central.length) findings.unshift({ level: 'success', title: `Most connected: ${central[0].title}`, detail: `${central[0].degree} incoming or outgoing wikilink relationships.` })
  if (!central.length) findings.unshift({ level: 'warning', title: 'No connected knowledge nodes', detail: 'Add wikilinks between notes to create navigable research context.' })
  return {
    summary: `Classified ${notes.length} notes into ${sortedTypes.length} knowledge types and ranked their local connectivity.`,
    metrics: [
      { label: 'Note types', value: sortedTypes.length },
      { label: 'Connected', value: `${connectedCoverage}%`, tone: connectedCoverage >= 70 ? 'success' : 'warning' },
      { label: 'Central node', value: central[0]?.degree || 0 },
      { label: 'Unresolved', value: relations.unresolved, tone: relations.unresolved ? 'warning' : 'success' },
    ],
    findings,
    stepDetails: [
      `${sortedTypes.length} note types classified`,
      `${relations.connected.length} connected and ${relations.orphans.length} isolated notes`,
      central.length ? `${central[0].title} ranked first with ${central[0].degree} links` : 'No central node could be ranked',
      `${sortedTypes.map(([type, count]) => `${type}: ${count}`).join(' · ') || 'Empty inventory'}`,
    ],
  }
}

const EXECUTORS = {
  'vault-integrity-audit': integrityAudit,
  'retrieval-readiness': retrievalReadiness,
  'knowledge-inventory': knowledgeInventory,
}

export function executePipeline(pipelineId, context, options = {}) {
  const template = PIPELINE_TEMPLATES.find((pipeline) => pipeline.id === pipelineId)
  const executor = EXECUTORS[pipelineId]
  if (!template || !executor) throw new Error('Unknown local pipeline')
  if (!context?.notes?.length) throw new Error('Connect a Vault before running this pipeline')
  const startedAt = options.startedAt || new Date().toISOString()
  const completedAt = options.completedAt || new Date().toISOString()
  const analysis = executor(context)
  return {
    id: options.id || `run-${Date.now()}-${pipelineId}`,
    pipelineId,
    title: template.title,
    output: template.output,
    vaultName: context.vaultName || 'local-vault',
    status: 'completed',
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    summary: analysis.summary,
    metrics: analysis.metrics,
    findings: analysis.findings,
    steps: template.stages.map((label, index) => ({ label, status: 'completed', detail: analysis.stepDetails[index] || 'Completed locally' })),
  }
}

export function loadPipelineRuns() {
  try {
    const runs = JSON.parse(window.localStorage.getItem(RUNS_STORAGE_KEY) || '[]')
    return Array.isArray(runs) ? runs.filter((run) => run?.id && run?.pipelineId).slice(0, MAX_STORED_RUNS) : []
  } catch {
    return []
  }
}

export function savePipelineRuns(runs) {
  try {
    window.localStorage.setItem(RUNS_STORAGE_KEY, JSON.stringify(runs.slice(0, MAX_STORED_RUNS)))
  } catch {
    // Run persistence is optional when browser storage is unavailable.
  }
}
