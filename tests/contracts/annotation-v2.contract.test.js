import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import {
  ANNOTATION_ARCHIVE_MAX_TARGETS,
  ANNOTATION_ARCHIVE_RUN_ID_MAX_BYTES,
  ANNOTATION_MARKDOWN_MAX_BYTES,
  ANNOTATION_PATCH_CONTENT_MAX_BYTES,
  ANNOTATION_RECORD_PATH_MAX_BYTES,
  ANNOTATION_SECTION_MAX_BYTES,
  ANNOTATION_V2_SCHEMA_VERSION,
  createAnnotationPatchIntent,
  migrateAnnotationToV2,
  normalizeAnnotation,
  normalizeAnnotationArchiveTargets,
  normalizeArchiveAnnotationInput,
  normalizeSourceAnnotationReference,
  parseAnnotationMarkdown,
  serializeAnnotationMarkdown,
  utf8ByteLength,
} from '../../src/annotations/annotation.js'
import {
  RUNTIME_ANNOTATION_CONTENT_MAX_BYTES,
  RUNTIME_ANNOTATION_REQUEST_MAX_BYTES,
} from '../../shared/runtime-action-contracts.mjs'

async function fixture(name) {
  return JSON.parse(await readFile(new URL('../../docs/contracts/' + name, import.meta.url), 'utf8'))
}

describe('Annotation v2 owner contract', () => {
  it('freezes the enriched authoritative shape and exact Markdown idempotence', async () => {
    const value = await fixture('annotation-v2.fixture.json')
    const normalized = normalizeAnnotation(value)
    const serialized = serializeAnnotationMarkdown(normalized)

    expect(normalized).toEqual(value)
    expect(normalized.schemaVersion).toBe(ANNOTATION_V2_SCHEMA_VERSION)
    expect(Object.keys(normalized)).toEqual([
      'schemaVersion',
      'id',
      'source',
      'anchor',
      'sections',
      'aiProvenance',
      'archive',
      'archived',
      'timestamps',
      'relocation',
    ])
    expect(serializeAnnotationMarkdown(parseAnnotationMarkdown(serialized))).toBe(serialized)
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(ANNOTATION_MARKDOWN_MAX_BYTES)
  })

  it('freezes source annotation identity, archive paths, and cancellation fixture', async () => {
    const value = await fixture('annotation-archive-v1.fixture.json')
    expect(normalizeArchiveAnnotationInput(value.archiveInput)).toEqual(value.archiveInput)
    expect(normalizeSourceAnnotationReference(value.archiveInput.sourceAnnotation)).toEqual(value.archiveInput.sourceAnnotation)
    expect(Object.keys(value.archiveInput.sourceAnnotation)).toEqual(['id', 'path', 'revision'])
    expect(JSON.parse(JSON.stringify(normalizeArchiveAnnotationInput(value.archiveInput)))).toEqual(value.archiveInput)
    expect(normalizeAnnotationArchiveTargets(value.archiveInput.targets)).toEqual(value.archiveInput.targets)
    expect(ANNOTATION_ARCHIVE_MAX_TARGETS).toBe(32)
    expect(ANNOTATION_ARCHIVE_RUN_ID_MAX_BYTES).toBe(256)
    expect(ANNOTATION_RECORD_PATH_MAX_BYTES).toBe(1024)
    expect(ANNOTATION_SECTION_MAX_BYTES).toBe(65_536)
    expect(ANNOTATION_PATCH_CONTENT_MAX_BYTES).toBe(RUNTIME_ANNOTATION_CONTENT_MAX_BYTES)
    expect(value.bounds).toEqual({
      parserToleranceBytes: ANNOTATION_MARKDOWN_MAX_BYTES,
      persistenceContentBytes: RUNTIME_ANNOTATION_CONTENT_MAX_BYTES,
      runtimeRequestBytes: RUNTIME_ANNOTATION_REQUEST_MAX_BYTES,
    })

    const completed = normalizeAnnotation(await fixture('annotation-v2.fixture.json'))
    const validMarkdown = serializeAnnotationMarkdown(completed)
    for (const archive of value.invalidCompletedHalfStates) {
      const invalid = { ...completed, archive }
      expect(() => normalizeAnnotation(invalid)).toThrow(/paired empty targets\/null runId/)
      expect(() => serializeAnnotationMarkdown(invalid)).toThrow(/paired empty targets\/null runId/)
      const invalidMarkdown = validMarkdown.replace(
        'archive: ' + JSON.stringify(completed.archive),
        'archive: ' + JSON.stringify(archive),
      )
      expect(() => parseAnnotationMarkdown(invalidMarkdown)).toThrow(/paired empty targets\/null runId/)
    }
  })

  it('keeps v1 migration explicit and AnnotationPatchIntentV1 opaque and unchanged', async () => {
    const v1 = await fixture('annotation-v1.fixture.json')
    const v2 = migrateAnnotationToV2(v1)
    const intent = createAnnotationPatchIntent(v2, { path: '.annotations/annotation-1.md', expectedRevision: 'annotation-rev-1' })

    expect(v1.schemaVersion).toBe(1)
    expect(v2).toMatchObject({
      schemaVersion: 2,
      aiProvenance: null,
      archive: { state: 'none', targets: [], runId: null, error: null },
      archived: false,
    })
    expect(Object.keys(intent)).toEqual(['schemaVersion', 'kind', 'annotationId', 'target', 'contentType', 'content'])
    expect(intent.schemaVersion).toBe(1)
    expect(parseAnnotationMarkdown(intent.content)).toEqual(v2)
  })

  it('freezes exact content saveability and an escaping-heavy Runtime envelope adversary', async () => {
    const recipe = await fixture('annotation-write-boundary-v1.fixture.json')
    const source = normalizeAnnotation(await fixture(recipe.baseAnnotationFixture))
    const prefix = normalizeAnnotation({
      ...source,
      sections: { ...source.sections, manual: recipe.contentBoundary.manualPrefix },
    })
    const prefixBytes = utf8ByteLength(serializeAnnotationMarkdown(prefix))
    const exact = normalizeAnnotation({
      ...source,
      sections: {
        ...source.sections,
        manual: recipe.contentBoundary.manualPrefix
          + recipe.contentBoundary.manualFill.repeat(recipe.contentBoundary.maximumUtf8Bytes - prefixBytes),
      },
    })
    const exactIntent = createAnnotationPatchIntent(exact, { path: '.annotations/exact.md', expectedRevision: null })
    expect(utf8ByteLength(exactIntent.content)).toBe(RUNTIME_ANNOTATION_CONTENT_MAX_BYTES)

    const over = normalizeAnnotation({
      ...exact,
      sections: { ...exact.sections, manual: exact.sections.manual + recipe.contentBoundary.manualFill },
    })
    expect(() => createAnnotationPatchIntent(over, { path: '.annotations/over.md', expectedRevision: null })).toThrow(/65536/)
    expect(parseAnnotationMarkdown(serializeAnnotationMarkdown(over))).toEqual(over)

    const adversarial = normalizeAnnotation({
      ...source,
      sections: {
        ...source.sections,
        manual: recipe.runtimeEnvelopeAdversary.manualCharacter.repeat(recipe.runtimeEnvelopeAdversary.repeat),
      },
    })
    const adversarialIntent = createAnnotationPatchIntent(adversarial, { path: '.annotations/adversarial.md', expectedRevision: null })
    expect(utf8ByteLength(adversarialIntent.content)).toBeLessThanOrEqual(RUNTIME_ANNOTATION_CONTENT_MAX_BYTES)
    const runtimeEnvelope = { intent: adversarialIntent, idempotencyKey: 'fixture-key', approval: { status: 'approved' } }
    expect(utf8ByteLength(JSON.stringify(runtimeEnvelope))).toBeGreaterThan(RUNTIME_ANNOTATION_REQUEST_MAX_BYTES)
    expect(recipe.externalParserBoundary).toEqual({
      maximumUtf8Bytes: ANNOTATION_MARKDOWN_MAX_BYTES,
      runtimeAdapterReadListSupportedAboveContentBoundary: false,
    })
  })
})
