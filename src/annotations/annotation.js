export const ANNOTATION_SCHEMA_VERSION = 1
export const ANNOTATION_V2_SCHEMA_VERSION = 2
export const ANNOTATION_LATEST_SCHEMA_VERSION = ANNOTATION_V2_SCHEMA_VERSION
export const TEXT_ANCHOR_SCHEMA_VERSION = 1
export const RELOCATION_SCHEMA_VERSION = 1
export const ANNOTATION_PATCH_SCHEMA_VERSION = 1
export const ANNOTATION_MARKDOWN_MAX_BYTES = 256 * 1024
export const ANNOTATION_PATCH_CONTENT_MAX_BYTES = 64 * 1024
export const ANNOTATION_SECTION_MAX_BYTES = 64 * 1024
export const ANNOTATION_ID_MAX_BYTES = 256
export const ANNOTATION_REVISION_MAX_BYTES = 256
export const ANNOTATION_RECORD_PATH_MAX_BYTES = 1024
export const ANNOTATION_SOURCE_PATH_MAX_BYTES = 4 * 1024
export const ANNOTATION_ARCHIVE_MAX_TARGETS = 32
export const ANNOTATION_ARCHIVE_TARGET_MAX_BYTES = 1024
export const ANNOTATION_ARCHIVE_TARGETS_MAX_BYTES = 16 * 1024
export const ANNOTATION_PROVENANCE_ID_MAX_BYTES = 256
export const ANNOTATION_ARCHIVE_RUN_ID_MAX_BYTES = 256
export const ANNOTATION_ARCHIVE_ERROR_CODE_MAX_BYTES = 64
export const ANNOTATION_ARCHIVE_ERROR_MESSAGE_MAX_BYTES = 1024

const DEFAULT_CONTEXT_CHARACTERS = 48
const BACKTICK = String.fromCharCode(96)
const RELOCATION_STATUSES = new Set(['anchored', 'relocated', 'stale', 'ambiguous', 'missing'])
const RELOCATION_STRATEGIES = new Set(['position', 'quote_context', 'quote', 'heading_line', 'line', 'none'])
const ARCHIVE_STATES = new Set(['none', 'pending', 'completed', 'failed'])
const ARCHIVE_ERROR_CODES = new Set(['archive_cancelled', 'archive_failed'])
const SECTION_MARKERS = Object.freeze({
  manual: Object.freeze({
    start: '<!-- annotation:manual:start -->',
    end: '<!-- annotation:manual:end -->',
  }),
  ai: Object.freeze({
    start: '<!-- annotation:ai:start -->',
    end: '<!-- annotation:ai:end -->',
  }),
})

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(label + ' must be an object.')
  return value
}

function requireString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new TypeError(label + ' must be a non-empty string.')
  return value
}

function optionalString(value, label) {
  if (value === null || value === undefined) return null
  return requireString(value, label)
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw new TypeError(label + ' must be an integer greater than or equal to ' + minimum + '.')
  return value
}

function requireTimestamp(value, label) {
  const timestamp = requireString(value, label)
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError(label + ' must be an ISO-compatible timestamp.')
  return timestamp
}

function requireExactKeys(value, keys, label) {
  const record = requireRecord(value, label)
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(label + ' must contain exactly: ' + keys.join(', ') + '.')
  }
  return record
}

export function utf8ByteLength(value) {
  let bytes = 0
  for (const character of String(value)) {
    const point = character.codePointAt(0)
    if (point <= 0x7f) bytes += 1
    else if (point <= 0x7ff) bytes += 2
    else if (point <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

function requireBoundedString(value, label, maximumBytes, options) {
  const string = requireString(value, label, options)
  const bytes = utf8ByteLength(string)
  if (bytes > maximumBytes) throw new RangeError(label + ' exceeds ' + maximumBytes + ' UTF-8 bytes.')
  return string
}

function optionalBoundedString(value, label, maximumBytes) {
  if (value === null || value === undefined) return null
  return requireBoundedString(value, label, maximumBytes)
}

function lineRecords(markdown) {
  const text = String(markdown || '')
  const records = []
  let start = 0
  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && text[index] !== '\n') continue
    const contentEnd = index > start && text[index - 1] === '\r' ? index - 1 : index
    records.push({
      number: records.length + 1,
      start,
      contentEnd,
      end: index < text.length ? index + 1 : index,
      text: text.slice(start, contentEnd),
    })
    start = index + 1
  }
  return records
}

function lineNumberAt(records, offset) {
  const match = records.find((line, index) => (
    offset >= line.start && (offset < line.end || index === records.length - 1)
  ))
  return match?.number || records.at(-1)?.number || 1
}

function markdownHeadings(markdown) {
  return lineRecords(markdown).flatMap((line) => {
    const match = line.text.match(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/)
    if (!match) return []
    return [{
      text: match[2].trim(),
      level: match[1].length,
      line: line.number,
      start: line.start,
    }]
  })
}

function fenceMarker(line) {
  const value = line.trimStart()
  const character = value[0]
  if (character !== '~' && character !== BACKTICK) return null
  let length = 0
  while (value[length] === character) length += 1
  return length >= 3 ? { character, length, tail: value.slice(length) } : null
}

function protectedMarkdownRanges(markdown) {
  const text = String(markdown || '')
  const records = lineRecords(text)
  const ranges = []
  let firstContentLine = 0

  if (records[0]?.text.trim() === '---') {
    const closingIndex = records.findIndex((line, index) => index > 0 && line.text.trim() === '---')
    if (closingIndex > 0) {
      ranges.push({ start: records[0].start, end: records[closingIndex].end, kind: 'frontmatter' })
      firstContentLine = closingIndex + 1
    }
  }

  let fence = null
  records.forEach((line, index) => {
    if (index < firstContentLine) return
    const marker = fenceMarker(line.text)
    if (!marker) return
    if (!fence) {
      fence = { ...marker, start: line.start }
      return
    }
    if (
      marker.character === fence.character
      && marker.length >= fence.length
      && !marker.tail.trim()
    ) {
      ranges.push({ start: fence.start, end: line.end, kind: 'fenced_code' })
      fence = null
    }
  })
  if (fence) ranges.push({ start: fence.start, end: text.length, kind: 'fenced_code' })

  for (const match of text.matchAll(/<!--[\s\S]*?-->/g)) {
    ranges.push({ start: match.index, end: match.index + match[0].length, kind: 'html_comment' })
  }

  records.forEach((line) => {
    if (ranges.some((range) => line.start >= range.start && line.start < range.end)) return
    const value = line.text
    for (let cursor = 0; cursor < value.length;) {
      if (value[cursor] !== BACKTICK) {
        cursor += 1
        continue
      }
      let runEnd = cursor + 1
      while (value[runEnd] === BACKTICK) runEnd += 1
      const delimiter = value.slice(cursor, runEnd)
      const closing = value.indexOf(delimiter, runEnd)
      if (closing < 0) {
        cursor = runEnd
        continue
      }
      ranges.push({
        start: line.start + cursor,
        end: line.start + closing + delimiter.length,
        kind: 'inline_code',
      })
      cursor = closing + delimiter.length
    }
  })

  return ranges.sort((left, right) => left.start - right.start || left.end - right.end)
}

export function normalizeAnnotationSource(value) {
  const source = requireRecord(value, 'annotation.source')
  return {
    vaultId: requireString(source.vaultId, 'annotation.source.vaultId'),
    noteId: requireString(source.noteId, 'annotation.source.noteId'),
    path: requireBoundedString(source.path, 'annotation.source.path', ANNOTATION_SOURCE_PATH_MAX_BYTES),
    revision: requireString(source.revision, 'annotation.source.revision', { allowEmpty: true }),
  }
}

export function normalizeSourceAnnotationReference(value) {
  const reference = requireExactKeys(value, ['id', 'path', 'revision'], 'source annotation reference')
  return {
    id: requireBoundedString(reference.id, 'source annotation reference.id', ANNOTATION_ID_MAX_BYTES),
    path: normalizeAnnotationRecordPath(reference.path),
    revision: requireBoundedString(reference.revision, 'source annotation reference.revision', ANNOTATION_REVISION_MAX_BYTES),
  }
}

export function normalizeAnnotationRecordPath(value) {
  const label = 'source annotation reference.path'
  const path = requireBoundedString(value, label, ANNOTATION_RECORD_PATH_MAX_BYTES)
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')) {
    throw new TypeError(label + ' must be a relative Vault path using forward slashes.')
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new TypeError(label + ' must not contain control characters.')
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError(label + ' must be a normalized relative Vault path.')
  }
  if (!path.startsWith('wiki/annotations/')) throw new TypeError(label + ' must be under wiki/annotations/.')
  if (!path.endsWith('.md')) throw new TypeError(label + ' must identify a .md file.')
  return path
}

export function normalizeArchiveAnnotationInput(value) {
  const input = requireExactKeys(value, ['operation', 'sourceAnnotation', 'targets'], 'archive annotation input')
  if (input.operation !== 'archive-annotation') throw new TypeError('archive annotation input.operation must be archive-annotation.')
  const targets = normalizeAnnotationArchiveTargets(input.targets)
  if (!targets.length) throw new TypeError('archive annotation input.targets must not be empty.')
  return {
    operation: 'archive-annotation',
    sourceAnnotation: normalizeSourceAnnotationReference(input.sourceAnnotation),
    targets,
  }
}

export function normalizeAnnotationArchiveTargets(value) {
  if (!Array.isArray(value)) throw new TypeError('annotation.archive.targets must be an array.')
  if (value.length > ANNOTATION_ARCHIVE_MAX_TARGETS) {
    throw new RangeError('annotation.archive.targets exceeds ' + ANNOTATION_ARCHIVE_MAX_TARGETS + ' targets.')
  }
  const seen = new Set()
  const targets = value.map((entry, index) => {
    const path = requireBoundedString(entry, 'annotation.archive.targets[' + index + ']', ANNOTATION_ARCHIVE_TARGET_MAX_BYTES)
    if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')) {
      throw new TypeError('annotation.archive.targets[' + index + '] must be a relative Vault path using forward slashes.')
    }
    if (/[\u0000-\u001f\u007f]/.test(path)) {
      throw new TypeError('annotation.archive.targets[' + index + '] must not contain control characters.')
    }
    const segments = path.split('/')
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new TypeError('annotation.archive.targets[' + index + '] must be a normalized relative Vault path.')
    }
    if (!path.toLowerCase().endsWith('.md')) {
      throw new TypeError('annotation.archive.targets[' + index + '] must identify a Markdown file.')
    }
    if (seen.has(path)) throw new TypeError('annotation.archive.targets must not contain duplicate paths.')
    seen.add(path)
    return path
  })
  if (utf8ByteLength(JSON.stringify(targets)) > ANNOTATION_ARCHIVE_TARGETS_MAX_BYTES) {
    throw new RangeError('annotation.archive.targets exceeds ' + ANNOTATION_ARCHIVE_TARGETS_MAX_BYTES + ' serialized UTF-8 bytes.')
  }
  return targets
}

export function normalizeAnnotationArchiveError(value) {
  if (value === null || value === undefined) return null
  const error = requireRecord(value, 'annotation.archive.error')
  const code = requireBoundedString(error.code, 'annotation.archive.error.code', ANNOTATION_ARCHIVE_ERROR_CODE_MAX_BYTES)
  if (!ARCHIVE_ERROR_CODES.has(code)) throw new TypeError('Unsupported annotation.archive.error.code.')
  return {
    code,
    message: requireBoundedString(error.message, 'annotation.archive.error.message', ANNOTATION_ARCHIVE_ERROR_MESSAGE_MAX_BYTES),
  }
}

export function createArchiveCancellationError(message = 'Archive run was cancelled.') {
  return normalizeAnnotationArchiveError({ code: 'archive_cancelled', message })
}

function normalizeArchive(value) {
  const archive = requireRecord(value, 'annotation.archive')
  const state = requireString(archive.state, 'annotation.archive.state')
  if (!ARCHIVE_STATES.has(state)) throw new TypeError('Unsupported annotation.archive.state.')
  const targets = normalizeAnnotationArchiveTargets(archive.targets)
  const runId = optionalBoundedString(archive.runId, 'annotation.archive.runId', ANNOTATION_ARCHIVE_RUN_ID_MAX_BYTES)
  const error = normalizeAnnotationArchiveError(archive.error)
  if (state === 'none' && (targets.length || runId || error)) {
    throw new TypeError('annotation.archive none state requires empty targets and null runId/error.')
  }
  if (state === 'pending' && (!targets.length || !runId || error)) {
    throw new TypeError('annotation.archive pending state requires targets and runId with null error.')
  }
  if (state === 'completed' && error) {
    throw new TypeError('annotation.archive completed state requires null error.')
  }
  if (state === 'completed') {
    const legacyMigration = targets.length === 0 && runId === null
    const completedExecution = targets.length > 0 && runId !== null
    if (!legacyMigration && !completedExecution) {
      throw new TypeError('annotation.archive completed state requires paired empty targets/null runId for legacy migration or non-empty targets/non-null runId for execution.')
    }
  }
  if (state === 'failed' && !error) {
    throw new TypeError('annotation.archive failed state requires a typed error.')
  }
  return { state, targets, runId, error }
}

function normalizeAiProvenance(value) {
  if (value === null || value === undefined) return null
  const provenance = requireRecord(value, 'annotation.aiProvenance')
  return {
    providerId: requireBoundedString(provenance.providerId, 'annotation.aiProvenance.providerId', ANNOTATION_PROVENANCE_ID_MAX_BYTES),
    modelId: requireBoundedString(provenance.modelId, 'annotation.aiProvenance.modelId', ANNOTATION_PROVENANCE_ID_MAX_BYTES),
    generatedAt: requireTimestamp(provenance.generatedAt, 'annotation.aiProvenance.generatedAt'),
  }
}

export function normalizeTextAnchor(value) {
  const anchor = requireRecord(value, 'text anchor')
  if (anchor.schemaVersion !== TEXT_ANCHOR_SCHEMA_VERSION) throw new TypeError('Unsupported text anchor schemaVersion.')
  const quote = requireRecord(anchor.quote, 'text anchor.quote')
  const position = requireRecord(anchor.position, 'text anchor.position')
  const line = requireRecord(anchor.line, 'text anchor.line')
  const normalized = {
    schemaVersion: TEXT_ANCHOR_SCHEMA_VERSION,
    quote: {
      exact: requireString(quote.exact, 'text anchor.quote.exact'),
      prefix: requireString(quote.prefix ?? '', 'text anchor.quote.prefix', { allowEmpty: true }),
      suffix: requireString(quote.suffix ?? '', 'text anchor.quote.suffix', { allowEmpty: true }),
    },
    position: {
      start: requireInteger(position.start, 'text anchor.position.start'),
      end: requireInteger(position.end, 'text anchor.position.end'),
    },
    heading: null,
    line: {
      start: requireInteger(line.start, 'text anchor.line.start', 1),
      end: requireInteger(line.end, 'text anchor.line.end', 1),
    },
  }
  if (normalized.position.end <= normalized.position.start) throw new TypeError('text anchor.position.end must be greater than start.')
  if (normalized.position.end - normalized.position.start !== normalized.quote.exact.length) {
    throw new TypeError('text anchor.position span must match quote.exact length.')
  }
  if (normalized.line.end < normalized.line.start) throw new TypeError('text anchor.line.end must not precede start.')
  if (anchor.heading !== null && anchor.heading !== undefined) {
    const heading = requireRecord(anchor.heading, 'text anchor.heading')
    normalized.heading = {
      text: requireString(heading.text, 'text anchor.heading.text'),
      level: requireInteger(heading.level, 'text anchor.heading.level', 1),
      line: requireInteger(heading.line, 'text anchor.heading.line', 1),
      relativeStartLine: requireInteger(heading.relativeStartLine, 'text anchor.heading.relativeStartLine'),
      relativeEndLine: requireInteger(heading.relativeEndLine, 'text anchor.heading.relativeEndLine'),
    }
    if (normalized.heading.level > 6) throw new TypeError('text anchor.heading.level must be from 1 to 6.')
    if (normalized.heading.relativeEndLine < normalized.heading.relativeStartLine) {
      throw new TypeError('text anchor.heading relativeEndLine must not precede relativeStartLine.')
    }
  }
  return normalized
}

export function createTextAnchor(markdown, selection, options = {}) {
  const text = String(markdown || '')
  const input = requireRecord(selection, 'selection')
  const start = requireInteger(input.start, 'selection.start')
  const end = requireInteger(input.end, 'selection.end')
  if (end <= start || end > text.length) throw new RangeError('selection must be a non-empty range inside the Markdown source.')
  const exact = text.slice(start, end)
  if (!exact.trim()) throw new RangeError('selection must contain non-whitespace text.')
  const protectedRange = protectedMarkdownRanges(text).find((range) => start < range.end && end > range.start)
  if (protectedRange) throw new RangeError('selection overlaps protected Markdown: ' + protectedRange.kind + '.')

  const contextCharacters = Math.max(0, Number.isFinite(options.contextCharacters)
    ? Math.floor(options.contextCharacters)
    : DEFAULT_CONTEXT_CHARACTERS)
  const records = lineRecords(text)
  const startLine = lineNumberAt(records, start)
  const endLine = lineNumberAt(records, Math.max(start, end - 1))
  const heading = markdownHeadings(text).filter((candidate) => candidate.start <= start).at(-1) || null

  return normalizeTextAnchor({
    schemaVersion: TEXT_ANCHOR_SCHEMA_VERSION,
    quote: {
      exact,
      prefix: text.slice(Math.max(0, start - contextCharacters), start),
      suffix: text.slice(end, Math.min(text.length, end + contextCharacters)),
    },
    position: { start, end },
    heading: heading ? {
      text: heading.text,
      level: heading.level,
      line: heading.line,
      relativeStartLine: startLine - heading.line,
      relativeEndLine: endLine - heading.line,
    } : null,
    line: { start: startLine, end: endLine },
  })
}

function commonSuffixLength(value, suffix) {
  const limit = Math.min(value.length, suffix.length)
  let length = 0
  while (length < limit && value[value.length - 1 - length] === suffix[suffix.length - 1 - length]) length += 1
  return length
}

function commonPrefixLength(value, prefix) {
  const limit = Math.min(value.length, prefix.length)
  let length = 0
  while (length < limit && value[length] === prefix[length]) length += 1
  return length
}

function relocation(status, strategy, start, end, candidates) {
  return {
    schemaVersion: RELOCATION_SCHEMA_VERSION,
    status,
    strategy,
    start,
    end,
    candidates,
  }
}

function rangeForLines(markdown, startLine, endLine) {
  const records = lineRecords(markdown)
  if (startLine < 1 || endLine < startLine || endLine > records.length) return null
  return {
    start: records[startLine - 1].start,
    end: records[endLine - 1].contentEnd,
  }
}

export function relocateTextAnchor(markdown, value) {
  const text = String(markdown || '')
  const anchor = normalizeTextAnchor(value)
  const { exact, prefix, suffix } = anchor.quote
  const protectedRanges = protectedMarkdownRanges(text)
  const overlapsProtectedMarkdown = (start, end) => protectedRanges.some((range) => start < range.end && end > range.start)
  if (
    text.slice(anchor.position.start, anchor.position.end) === exact
    && !overlapsProtectedMarkdown(anchor.position.start, anchor.position.end)
  ) {
    return relocation('anchored', 'position', anchor.position.start, anchor.position.end, 1)
  }

  const occurrences = []
  for (let start = text.indexOf(exact); start >= 0; start = text.indexOf(exact, start + 1)) {
    const end = start + exact.length
    if (overlapsProtectedMarkdown(start, end)) continue
    const prefixLength = commonSuffixLength(text.slice(0, start), prefix)
    const suffixLength = commonPrefixLength(text.slice(end), suffix)
    occurrences.push({ start, end, score: prefixLength + suffixLength })
  }
  if (occurrences.length === 1) {
    const only = occurrences[0]
    return relocation('relocated', only.score ? 'quote_context' : 'quote', only.start, only.end, 1)
  }
  if (occurrences.length > 1) {
    occurrences.sort((left, right) => right.score - left.score || left.start - right.start)
    if (occurrences[0].score > occurrences[1].score) {
      const best = occurrences[0]
      return relocation('relocated', 'quote_context', best.start, best.end, occurrences.length)
    }
    return relocation('ambiguous', 'none', null, null, occurrences.length)
  }

  if (anchor.heading) {
    const matches = markdownHeadings(text).filter((heading) => (
      heading.level === anchor.heading.level
      && heading.text.toLocaleLowerCase() === anchor.heading.text.toLocaleLowerCase()
    ))
    if (matches.length > 1) return relocation('ambiguous', 'none', null, null, matches.length)
    if (matches.length === 1) {
      const startLine = matches[0].line + anchor.heading.relativeStartLine
      const endLine = matches[0].line + anchor.heading.relativeEndLine
      const range = rangeForLines(text, startLine, endLine)
      if (range && !overlapsProtectedMarkdown(range.start, range.end)) {
        return relocation('stale', 'heading_line', range.start, range.end, 1)
      }
    }
  }

  const lineRange = rangeForLines(text, anchor.line.start, anchor.line.end)
  if (lineRange && !overlapsProtectedMarkdown(lineRange.start, lineRange.end)) {
    return relocation('stale', 'line', lineRange.start, lineRange.end, 1)
  }
  return relocation('missing', 'none', null, null, 0)
}

function normalizeRelocation(value) {
  const result = requireRecord(value, 'annotation.relocation')
  if (result.schemaVersion !== RELOCATION_SCHEMA_VERSION) throw new TypeError('Unsupported relocation schemaVersion.')
  if (!RELOCATION_STATUSES.has(result.status)) throw new TypeError('Unsupported relocation status.')
  if (!RELOCATION_STRATEGIES.has(result.strategy)) throw new TypeError('Unsupported relocation strategy.')
  const start = result.start === null ? null : requireInteger(result.start, 'annotation.relocation.start')
  const end = result.end === null ? null : requireInteger(result.end, 'annotation.relocation.end')
  if ((start === null) !== (end === null)) throw new TypeError('annotation.relocation start and end must both be null or numbers.')
  if (start !== null && end < start) throw new TypeError('annotation.relocation.end must not precede start.')
  const candidates = requireInteger(result.candidates, 'annotation.relocation.candidates')
  const hasRange = start !== null
  if (['anchored', 'relocated', 'stale'].includes(result.status) && (!hasRange || result.strategy === 'none' || candidates < 1)) {
    throw new TypeError('Successful or stale relocation results require a range, strategy, and candidate.')
  }
  if (['ambiguous', 'missing'].includes(result.status) && (hasRange || result.strategy !== 'none')) {
    throw new TypeError('Ambiguous or missing relocation results must not select a range or strategy.')
  }
  if (result.status === 'ambiguous' && candidates < 2) throw new TypeError('Ambiguous relocation requires multiple candidates.')
  if (result.status === 'missing' && candidates !== 0) throw new TypeError('Missing relocation requires zero candidates.')
  return relocation(
    result.status,
    result.strategy,
    start,
    end,
    candidates,
  )
}

function normalizeAnnotationBase(annotation) {
  const sections = requireRecord(annotation.sections, 'annotation.sections')
  const timestamps = requireRecord(annotation.timestamps, 'annotation.timestamps')
  const archivedAt = optionalString(timestamps.archivedAt, 'annotation.timestamps.archivedAt')
  const createdAt = requireTimestamp(timestamps.createdAt, 'annotation.timestamps.createdAt')
  const updatedAt = requireTimestamp(timestamps.updatedAt, 'annotation.timestamps.updatedAt')
  const normalizedArchivedAt = archivedAt ? requireTimestamp(archivedAt, 'annotation.timestamps.archivedAt') : null
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new TypeError('annotation.timestamps.updatedAt must not precede createdAt.')
  if (normalizedArchivedAt && Date.parse(normalizedArchivedAt) < Date.parse(createdAt)) {
    throw new TypeError('annotation.timestamps.archivedAt must not precede createdAt.')
  }
  const normalizedSections = {
    manual: requireBoundedString(sections.manual ?? '', 'annotation.sections.manual', ANNOTATION_SECTION_MAX_BYTES, { allowEmpty: true }),
    ai: requireBoundedString(sections.ai ?? '', 'annotation.sections.ai', ANNOTATION_SECTION_MAX_BYTES, { allowEmpty: true }),
  }
  return {
    id: requireBoundedString(annotation.id, 'annotation.id', ANNOTATION_ID_MAX_BYTES),
    source: normalizeAnnotationSource(annotation.source),
    anchor: normalizeTextAnchor(annotation.anchor),
    sections: normalizedSections,
    timestamps: {
      createdAt,
      updatedAt,
      archivedAt: normalizedArchivedAt,
    },
    relocation: normalizeRelocation(annotation.relocation),
  }
}

function normalizeAnnotationV1(annotation) {
  const normalized = normalizeAnnotationBase(annotation)
  const archived = annotation.archived === true
  if (archived && !normalized.timestamps.archivedAt) throw new TypeError('Archived annotations require timestamps.archivedAt.')
  if (!archived && normalized.timestamps.archivedAt) throw new TypeError('Active annotations require timestamps.archivedAt to be null.')
  return {
    schemaVersion: ANNOTATION_SCHEMA_VERSION,
    id: normalized.id,
    source: normalized.source,
    anchor: normalized.anchor,
    sections: normalized.sections,
    archived,
    timestamps: normalized.timestamps,
    relocation: normalized.relocation,
  }
}

function normalizeAnnotationV2(annotation) {
  const normalized = normalizeAnnotationBase(annotation)
  const aiProvenance = normalizeAiProvenance(annotation.aiProvenance)
  const archive = normalizeArchive(annotation.archive)
  const archived = archive.state === 'completed'
  if (archived && !normalized.timestamps.archivedAt) throw new TypeError('Completed annotation archives require timestamps.archivedAt.')
  if (!archived && normalized.timestamps.archivedAt) {
    throw new TypeError('Non-completed annotation archives require timestamps.archivedAt to be null.')
  }
  if (aiProvenance && !normalized.sections.ai.trim()) {
    throw new TypeError('annotation.aiProvenance requires non-empty annotation.sections.ai.')
  }
  if (aiProvenance && Date.parse(aiProvenance.generatedAt) > Date.parse(normalized.timestamps.updatedAt)) {
    throw new TypeError('annotation.aiProvenance.generatedAt must not follow timestamps.updatedAt.')
  }
  if (aiProvenance && Date.parse(aiProvenance.generatedAt) < Date.parse(normalized.timestamps.createdAt)) {
    throw new TypeError('annotation.aiProvenance.generatedAt must not precede timestamps.createdAt.')
  }
  return {
    schemaVersion: ANNOTATION_V2_SCHEMA_VERSION,
    id: normalized.id,
    source: normalized.source,
    anchor: normalized.anchor,
    sections: normalized.sections,
    aiProvenance,
    archive,
    archived,
    timestamps: normalized.timestamps,
    relocation: normalized.relocation,
  }
}

export function normalizeAnnotation(value) {
  const annotation = requireRecord(value, 'annotation')
  if (annotation.schemaVersion === ANNOTATION_SCHEMA_VERSION) return normalizeAnnotationV1(annotation)
  if (annotation.schemaVersion === ANNOTATION_V2_SCHEMA_VERSION) return normalizeAnnotationV2(annotation)
  throw new TypeError('Unsupported annotation schemaVersion.')
}

export function migrateAnnotationToV2(value) {
  const annotation = normalizeAnnotation(value)
  if (annotation.schemaVersion === ANNOTATION_V2_SCHEMA_VERSION) return annotation
  return normalizeAnnotationV2({
    ...annotation,
    schemaVersion: ANNOTATION_V2_SCHEMA_VERSION,
    aiProvenance: null,
    archive: annotation.archived
      ? { state: 'completed', targets: [], runId: null, error: null }
      : { state: 'none', targets: [], runId: null, error: null },
  })
}

function sectionBody(markdown, name) {
  const marker = SECTION_MARKERS[name]
  const startToken = marker.start + '\n'
  const endToken = '\n' + marker.end
  const start = markdown.indexOf(startToken)
  if (start < 0) throw new Error('Missing ' + name + ' annotation section.')
  const contentStart = start + startToken.length
  const end = markdown.indexOf(endToken, contentStart)
  if (end < 0) throw new Error('Missing closing marker for ' + name + ' annotation section.')
  return markdown.slice(contentStart, end)
}

function parseMetadata(markdown) {
  const match = String(markdown || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) throw new Error('Annotation Markdown requires JSON-valued frontmatter.')
  const metadata = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    metadata[key] = JSON.parse(value)
  }
  return metadata
}

export function serializeAnnotationMarkdown(value) {
  const annotation = normalizeAnnotation(value)
  for (const [name, marker] of Object.entries(SECTION_MARKERS)) {
    const content = annotation.sections[name]
    if (content.includes(marker.start) || content.includes(marker.end)) {
      throw new Error('Annotation section contains a reserved marker.')
    }
  }
  const metadata = [
    ['annotation_schema', annotation.schemaVersion],
    ['id', annotation.id],
    ['source', annotation.source],
    ['anchor', annotation.anchor],
    ...(annotation.schemaVersion === ANNOTATION_V2_SCHEMA_VERSION ? [
      ['ai_provenance', annotation.aiProvenance],
      ['archive', annotation.archive],
    ] : []),
    ['archived', annotation.archived],
    ['created_at', annotation.timestamps.createdAt],
    ['updated_at', annotation.timestamps.updatedAt],
    ['archived_at', annotation.timestamps.archivedAt],
    ['relocation', annotation.relocation],
  ].map(([key, value]) => key + ': ' + JSON.stringify(value))

  const markdown = [
    '---',
    ...metadata,
    '---',
    '# Annotation',
    '',
    '## Manual',
    SECTION_MARKERS.manual.start,
    annotation.sections.manual,
    SECTION_MARKERS.manual.end,
    '',
    '## AI',
    SECTION_MARKERS.ai.start,
    annotation.sections.ai,
    SECTION_MARKERS.ai.end,
    '',
  ].join('\n')
  const bytes = utf8ByteLength(markdown)
  if (bytes > ANNOTATION_MARKDOWN_MAX_BYTES) {
    throw new RangeError('Serialized Annotation Markdown exceeds ' + ANNOTATION_MARKDOWN_MAX_BYTES + ' UTF-8 bytes.')
  }
  return markdown
}

export function parseAnnotationMarkdown(markdown) {
  const raw = String(markdown || '')
  const bytes = utf8ByteLength(raw)
  if (bytes > ANNOTATION_MARKDOWN_MAX_BYTES) {
    throw new RangeError('Annotation Markdown exceeds ' + ANNOTATION_MARKDOWN_MAX_BYTES + ' UTF-8 bytes.')
  }
  const text = raw.replace(/\r\n/g, '\n')
  const metadata = parseMetadata(text)
  return normalizeAnnotation({
    schemaVersion: metadata.annotation_schema,
    id: metadata.id,
    source: metadata.source,
    anchor: metadata.anchor,
    sections: {
      manual: sectionBody(text, 'manual'),
      ai: sectionBody(text, 'ai'),
    },
    ...(metadata.annotation_schema === ANNOTATION_V2_SCHEMA_VERSION ? {
      aiProvenance: metadata.ai_provenance,
      archive: metadata.archive,
    } : {}),
    archived: metadata.archived,
    timestamps: {
      createdAt: metadata.created_at,
      updatedAt: metadata.updated_at,
      archivedAt: metadata.archived_at,
    },
    relocation: metadata.relocation,
  })
}

export function createAnnotationPatchIntent(value, options = {}) {
  const annotation = normalizeAnnotation(value)
  const input = requireRecord(options, 'annotation patch options')
  const content = serializeAnnotationMarkdown(annotation)
  const contentBytes = utf8ByteLength(content)
  if (contentBytes > ANNOTATION_PATCH_CONTENT_MAX_BYTES) {
    throw new RangeError('AnnotationPatchIntentV1 content exceeds the 65536-byte Runtime write ceiling: ' + contentBytes + ' bytes.')
  }
  return {
    schemaVersion: ANNOTATION_PATCH_SCHEMA_VERSION,
    kind: 'annotation.upsert',
    annotationId: annotation.id,
    target: {
      vaultId: annotation.source.vaultId,
      path: requireString(input.path, 'annotation patch options.path'),
      expectedRevision: optionalString(input.expectedRevision, 'annotation patch options.expectedRevision'),
    },
    contentType: 'text/markdown',
    content,
  }
}
