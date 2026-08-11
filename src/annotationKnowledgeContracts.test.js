import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  ANNOTATION_SCHEMA_VERSION,
  ANNOTATION_V2_SCHEMA_VERSION,
  createArchiveCancellationError,
  normalizeAnnotation,
  normalizeAnnotationArchiveTargets,
  normalizeArchiveAnnotationInput,
  normalizeSourceAnnotationReference,
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

test('authoritative Annotation v2 fixture is exact, enriched, UTF-8 safe, and idempotent', async () => {
  const fixture = await readFixture('annotation-v2.fixture.json')
  const annotation = normalizeAnnotation(fixture)
  const serialized = serializeAnnotationMarkdown(annotation)

  assert.equal(annotation.schemaVersion, ANNOTATION_V2_SCHEMA_VERSION)
  assert.deepEqual(annotation, fixture)
  assert.deepEqual(parseAnnotationMarkdown(serialized), fixture)
  assert.equal(serializeAnnotationMarkdown(parseAnnotationMarkdown(serialized)), serialized)
  assert.match(serialized, /研究者复核/)
  assert.match(serialized, /ai_provenance: /)
  assert.match(serialized, /archive: /)
})

test('authoritative source annotation and archive target fixture matches Core consumer semantics', async () => {
  const fixture = await readFixture('annotation-archive-v1.fixture.json')
  assert.equal(fixture.schemaVersion, 1)
  assert.deepEqual(normalizeArchiveAnnotationInput(fixture.archiveInput), fixture.archiveInput)
  assert.deepEqual(normalizeSourceAnnotationReference(fixture.archiveInput.sourceAnnotation), fixture.archiveInput.sourceAnnotation)
  assert.deepEqual(Object.keys(fixture.archiveInput.sourceAnnotation), ['id', 'path', 'revision'])
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeArchiveAnnotationInput(fixture.archiveInput))), fixture.archiveInput)
  assert.deepEqual(normalizeAnnotationArchiveTargets(fixture.archiveInput.targets), fixture.archiveInput.targets)
  const pathSemantics = fixture.runtimeReadablePathSemantics
  for (const path of pathSemantics.acceptedPreservedPaths) {
    assert.equal(normalizeSourceAnnotationReference({ ...fixture.archiveInput.sourceAnnotation, path }).path, path)
    assert.equal(normalizeArchiveAnnotationInput({
      ...fixture.archiveInput,
      sourceAnnotation: { ...fixture.archiveInput.sourceAnnotation, path },
    }).sourceAnnotation.path, path)
  }
  const recipe = pathSemantics.boundaryRecipe
  const cjkBoundaryPath = recipe.prefix + recipe.cjkCodeUnit.repeat(recipe.cjkCountAtLimit) + recipe.suffix
  const surrogateBoundaryPath = recipe.prefix + recipe.surrogatePair.repeat(recipe.surrogatePairCountAtLimit) + recipe.suffix
  assert.equal(cjkBoundaryPath.length, pathSemantics.maxJavaScriptUtf16CodeUnits)
  assert.equal(surrogateBoundaryPath.length, pathSemantics.maxJavaScriptUtf16CodeUnits)
  assert.equal(normalizeSourceAnnotationReference({ ...fixture.archiveInput.sourceAnnotation, path: cjkBoundaryPath }).path, cjkBoundaryPath)
  assert.equal(normalizeSourceAnnotationReference({ ...fixture.archiveInput.sourceAnnotation, path: surrogateBoundaryPath }).path, surrogateBoundaryPath)
  assert.equal(normalizeArchiveAnnotationInput({
    ...fixture.archiveInput,
    sourceAnnotation: { ...fixture.archiveInput.sourceAnnotation, path: cjkBoundaryPath },
  }).sourceAnnotation.path, cjkBoundaryPath)
  assert.equal(normalizeArchiveAnnotationInput({
    ...fixture.archiveInput,
    sourceAnnotation: { ...fixture.archiveInput.sourceAnnotation, path: surrogateBoundaryPath },
  }).sourceAnnotation.path, surrogateBoundaryPath)
  assert.throws(
    () => normalizeSourceAnnotationReference({ ...fixture.archiveInput.sourceAnnotation, path: recipe.prefix + 'a'.repeat(493) + recipe.suffix }),
    /512 JavaScript UTF-16 code units/,
  )
  assert.deepEqual(createArchiveCancellationError(), fixture.cancellationError)
  assert.deepEqual(fixture.bounds, {
    parserToleranceBytes: 262_144,
    persistenceContentBytes: 65_536,
    runtimeRequestBytes: 131_072,
  })
})

test('authoritative Knowledge Context v1 fixture matches the frozen opaque envelope', async () => {
  const fixture = await readFixture('knowledge-context-v1.fixture.json')
  const context = normalizeKnowledgeContext(fixture)

  assert.equal(context.schemaVersion, KNOWLEDGE_CONTEXT_SCHEMA_VERSION)
  assert.deepEqual(context, fixture)
  assert.deepEqual(JSON.parse(JSON.stringify(context)), fixture)
  assert.ok(knowledgeContextByteLength(context) <= KNOWLEDGE_CONTEXT_MAX_BYTES)
})
