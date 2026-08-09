import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  ANNOTATION_SCHEMA_VERSION,
  normalizeAnnotation,
  parseAnnotationMarkdown,
  serializeAnnotationMarkdown,
} from './annotations/annotation.js'
import {
  KNOWLEDGE_CONTEXT_MAX_BYTES,
  KNOWLEDGE_CONTEXT_SCHEMA_VERSION,
  knowledgeContextByteLength,
  normalizeKnowledgeContext,
} from './knowledge/context.js'

async function readFixture(name) {
  const url = new URL('../docs/contracts/' + name, import.meta.url)
  return JSON.parse(await readFile(url, 'utf8'))
}

test('authoritative Annotation v1 fixture matches the frozen parser and serializer', async () => {
  const fixture = await readFixture('annotation-v1.fixture.json')
  const annotation = normalizeAnnotation(fixture)

  assert.equal(annotation.schemaVersion, ANNOTATION_SCHEMA_VERSION)
  assert.deepEqual(annotation, fixture)
  assert.deepEqual(parseAnnotationMarkdown(serializeAnnotationMarkdown(annotation)), fixture)
})

test('authoritative Knowledge Context v1 fixture matches the frozen opaque envelope', async () => {
  const fixture = await readFixture('knowledge-context-v1.fixture.json')
  const context = normalizeKnowledgeContext(fixture)

  assert.equal(context.schemaVersion, KNOWLEDGE_CONTEXT_SCHEMA_VERSION)
  assert.deepEqual(context, fixture)
  assert.deepEqual(JSON.parse(JSON.stringify(context)), fixture)
  assert.ok(knowledgeContextByteLength(context) <= KNOWLEDGE_CONTEXT_MAX_BYTES)
})
