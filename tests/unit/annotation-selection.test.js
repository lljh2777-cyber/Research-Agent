import { describe, expect, it } from 'vitest'

import {
  activeAnnotationRanges,
  mappedTextPoint,
  normalizeMappedRange,
  splitSourceText,
} from '../../src/features/knowledge/annotationSelection.js'

function mappedText(data, sourceStart) {
  const mapped = { dataset: { sourceStart: String(sourceStart), sourceEnd: String(sourceStart + data.length) } }
  return {
    nodeType: 3,
    data,
    parentElement: { closest: () => mapped },
  }
}

describe('DOM selection to Markdown source mapping', () => {
  const markdown = '# Findings\nA phrase spans [[Paper|inline link]] and\ncontinues on another line.\n\nSecond paragraph.\n'

  it('maps word and phrase offsets exactly inside a rendered text node', () => {
    const start = markdown.indexOf('phrase')
    const node = mappedText('A phrase spans ', markdown.indexOf('A phrase'))
    expect(normalizeMappedRange(markdown, mappedTextPoint(node, 2), mappedTextPoint(node, 8))).toEqual({ start, end: start + 6 })
    expect(markdown.slice(mappedTextPoint(node, 2), mappedTextPoint(node, 14))).toBe('phrase spans')
  })

  it('maps a rendered inline-node-spanning and multi-line range without block expansion', () => {
    const first = mappedText('spans ', markdown.indexOf('spans'))
    const inline = mappedText('inline link', markdown.indexOf('inline link'))
    const last = mappedText('continues', markdown.indexOf('continues'))
    const start = mappedTextPoint(first, 0)
    const inlineEnd = mappedTextPoint(inline, inline.data.length)
    const end = mappedTextPoint(last, last.data.length)
    expect(markdown.slice(start, inlineEnd)).toBe('spans [[Paper|inline link')
    expect(markdown.slice(start, end)).toBe('spans [[Paper|inline link]] and\ncontinues')
  })

  it('preserves paragraph ranges and rejects empty, whitespace, outside, and reversed-invalid points', () => {
    const start = markdown.indexOf('Second paragraph.')
    expect(normalizeMappedRange(markdown, start, start + 'Second paragraph.'.length)).toEqual({ start, end: start + 17 })
    expect(normalizeMappedRange(markdown, 0, 0)).toBeNull()
    expect(normalizeMappedRange(markdown, markdown.indexOf('\n\n'), markdown.indexOf('\n\n') + 2)).toBeNull()
    expect(normalizeMappedRange(markdown, -1, 2)).toBeNull()
    expect(mappedTextPoint(mappedText('shown', 10), 6)).toBeNull()
  })
})

describe('annotation highlight segmentation', () => {
  it('orders overlaps deterministically and excludes stale or archived records', () => {
    const annotations = [
      { id: 'b', archived: false, relocation: { status: 'relocated', start: 4, end: 10 } },
      { id: 'a', archived: false, relocation: { status: 'anchored', start: 1, end: 7 } },
      { id: 'stale', archived: false, relocation: { status: 'stale', start: 0, end: 3 } },
      { id: 'archived', archived: true, relocation: { status: 'anchored', start: 0, end: 3 } },
    ]
    expect(activeAnnotationRanges(annotations).map(({ id }) => id)).toEqual(['a', 'b'])
    expect(splitSourceText('0123456789', 0, annotations).map((part) => [part.text, part.annotations.map(({ id }) => id)])).toEqual([
      ['0', []],
      ['123', ['a']],
      ['456', ['a', 'b']],
      ['789', ['b']],
    ])
  })
})
