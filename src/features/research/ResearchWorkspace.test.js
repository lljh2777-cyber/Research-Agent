import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('ResearchWorkspace keeps readable UI text and exposes EvidencePacket errors accessibly', async () => {
  const source = await readFile(new URL('./ResearchWorkspace.jsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /[闂佸姊洪柍銉嫹]/)
  assert.match(source, /retrievalPacket\?\.error/)
  assert.match(source, /role="alert"/)
  assert.match(source, /aria-live="assertive"/)
  assert.match(source, /models - \$\{modelCatalog/)
  assert.match(source, /Local service offline - restart npm run dev/)
  assert.match(source, / - saved in this conversation snapshot/)
  assert.match(source, /selectedModel\.provider\} - \{selectedModel\.detail/)
  assert.match(source, / - read-only evidence/)
  assert.match(source, / - rerank:/)
})