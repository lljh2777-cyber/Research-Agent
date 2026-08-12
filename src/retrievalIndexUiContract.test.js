import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('UI lifecycle is Runtime-only, generation-guarded, and wires Core ready-vector inputs', async () => {
  const mainSource = await readFile(new URL('./main.jsx', import.meta.url), 'utf8')
  const settingsSource = await readFile(new URL('./SettingsWorkspace.jsx', import.meta.url), 'utf8')
  const researchSource = await readFile(new URL('./features/research/ResearchWorkspace.jsx', import.meta.url), 'utf8')
  const providerSource = await readFile(new URL('./providerConfig.js', import.meta.url), 'utf8')
  assert.match(mainSource, /runtimeAdapter\.retrievalIndexes\.(status|progress|build|rebuild|cancel|read)/)
  assert.match(mainSource, /retrievalIndexOperationRef\.current\.generation !== generation/)
  assert.match(mainSource, /validateReadyRetrievalIndex\(readResult, identity\)/)
  assert.equal((mainSource.match(/setReadyRetrievalIndex\(\{/g) || []).length, 1)
  assert.ok(mainSource.indexOf('setReadyRetrievalIndex({') > mainSource.indexOf('if (validated.ok)'))
  assert.match(mainSource, /vectorIndex:/)
  assert.match(mainSource, /requestedIndexIdentity:/)
  assert.match(providerSource, /embeddingDimensions/)
  assert.doesNotMatch(mainSource, /window\.localStorage.*retrieval|localStorage.*vector|fetch\(/)
  assert.match(settingsSource, /Cancel build/)
  assert.match(settingsSource, /Rebuild index/)
  assert.match(settingsSource, /remoteEmbeddingConsent/)
  assert.match(researchSource, /retrievalFocus/)
  assert.match(researchSource, /safeRetrievalErrorMessage/)
  assert.match(researchSource, /citation source/)
})
