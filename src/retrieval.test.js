import assert from 'node:assert/strict'
import test from 'node:test'

import { buildEvidenceSystemMessage, buildEvidenceUserContext, buildRetrievalIndex, chunkVaultNote, evidenceSources, retrieveEvidence, tokenize } from './retrieval.js'

const notes = [
  {
    id: 'methods/CellChat.md',
    path: 'methods/CellChat.md',
    name: 'CellChat.md',
    title: 'CellChat',
    type: 'method',
    frontmatter: { disease: ['cancer'], assay: 'single-cell RNA-seq' },
    wikilinks: ['Spatial niche'],
    body: '# CellChat\nCellChat infers ligand-receptor communication between cell populations.',
  },
  {
    id: 'concepts/Spatial niche.md',
    path: 'concepts/Spatial niche.md',
    name: 'Spatial niche.md',
    title: 'Spatial niche',
    type: 'concept',
    frontmatter: {},
    wikilinks: [],
    body: '# Spatial niche\nSpatial neighborhoods constrain which cell populations can interact.',
  },
  {
    id: 'methods/Unrelated.md',
    path: 'methods/Unrelated.md',
    name: 'Unrelated.md',
    title: 'Mass spectrometry',
    type: 'method',
    frontmatter: {},
    wikilinks: [],
    body: '# Proteomics\nPeptide abundance is measured by a mass spectrometer.',
  },
]

test('tokenize preserves scientific terms and creates CJK bigrams', () => {
  const tokens = tokenize('CellChat 如何分析肿瘤空间微环境?')
  assert(tokens.includes('cellchat'))
  assert(tokens.includes('肿瘤'))
  assert(tokens.includes('空间'))
})

test('chunkVaultNote preserves the active heading and overlap', () => {
  const chunks = chunkVaultNote({ ...notes[0], body: `# Results\n${'signal '.repeat(90)}` }, { chunkSize: 220, chunkOverlap: 40 })
  assert(chunks.length > 1)
  assert.equal(chunks[0].heading, 'Results')
  assert.equal(chunks[0].path, 'methods/CellChat.md')
})

test('retrieveEvidence ranks lexical evidence and adds one-hop wikilinks', () => {
  const index = buildRetrievalIndex(notes, { chunkSize: 400, chunkOverlap: 40 })
  const packet = retrieveEvidence(index, 'How does CellChat infer ligand receptor communication?', {
    topK: 4,
    similarityThreshold: 0,
  })
  assert.equal(packet.evidence[0].title, 'CellChat')
  assert(packet.evidence.some((item) => item.title === 'Spatial niche' && item.relationship === 'wikilink'))
  assert(!packet.evidence.some((item) => item.title === 'Mass spectrometry'))
})

test('retrieveEvidence prevents one long note from monopolizing Top K', () => {
  const repeatedNotes = [
    { ...notes[0], body: `# CellChat\n${'ligand receptor communication. '.repeat(120)}` },
    { ...notes[1], body: `# Spatial niche\n${'ligand receptor spatial communication. '.repeat(20)}` },
  ]
  const index = buildRetrievalIndex(repeatedNotes, { chunkSize: 220, chunkOverlap: 20 })
  const packet = retrieveEvidence(index, 'ligand receptor communication', { topK: 6, similarityThreshold: 0 })
  const perNote = packet.evidence.reduce((counts, item) => counts.set(item.noteId, (counts.get(item.noteId) || 0) + 1), new Map())
  assert([...perNote.values()].every((count) => count <= 2))
  assert.equal(new Set(packet.evidence.map((item) => item.noteId)).size, 2)
})

test('evidence packet becomes citation-safe model context and unique sources', () => {
  const index = buildRetrievalIndex(notes)
  const packet = retrieveEvidence(index, 'CellChat communication', { topK: 3, similarityThreshold: 0 })
  const prompt = buildEvidenceSystemMessage(packet)
  const context = buildEvidenceUserContext(packet)
  const sources = evidenceSources(packet)
  assert.match(prompt, /untrusted source data/)
  assert.doesNotMatch(prompt, /ligand-receptor communication/)
  assert.match(context, /\[1\] CellChat/)
  assert.match(context, /<vault_evidence>/)
  assert.equal(new Set(sources.map((source) => source.path)).size, sources.length)
})

test('empty retrieval instructs the model to expose the evidence gap', () => {
  const index = buildRetrievalIndex(notes)
  const packet = retrieveEvidence(index, 'zzzz-no-match', { topK: 3 })
  assert.equal(packet.evidence.length, 0)
  assert.match(buildEvidenceSystemMessage(packet), /Vault 中未找到足够依据/)
})
