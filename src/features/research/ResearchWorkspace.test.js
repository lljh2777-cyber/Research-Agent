import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('ResearchWorkspace keeps readable UI text and exposes EvidencePacket errors accessibly', async () => {
  const source = await readFile(new URL('./ResearchWorkspace.jsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /[閻闁鈥�]/)
  assert.match(source, /retrievalPacket\?\.error/)
  assert.match(source, /role="alert"/)
  assert.match(source, /aria-live="assertive"/)
})