const ELEMENT_NODE = 1
const TEXT_NODE = 3

export function isEditableSelectionTarget(target) {
  if (!target || typeof target.closest !== 'function') return false
  return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
}

function mappedAncestor(node) {
  if (node?.nodeType === ELEMENT_NODE && node.matches?.('[data-source-start][data-source-end]')) return node
  return node?.parentElement?.closest?.('[data-source-start][data-source-end]') || null
}

export function mappedTextPoint(node, offset) {
  if (node?.nodeType !== TEXT_NODE) return null
  const mapped = mappedAncestor(node)
  if (!mapped) return null
  const sourceStart = Number(mapped.dataset.sourceStart)
  const sourceEnd = Number(mapped.dataset.sourceEnd)
  const textLength = String(node.data ?? node.textContent ?? '').length
  if (!Number.isInteger(sourceStart) || !Number.isInteger(sourceEnd) || sourceEnd < sourceStart) return null
  if (sourceEnd - sourceStart !== textLength) return null
  if (!Number.isInteger(offset) || offset < 0 || offset > textLength) return null
  return sourceStart + offset
}

function mappedTextNodes(root) {
  if (!root) return []
  if (root.nodeType === TEXT_NODE) return mappedAncestor(root) ? [root] : []
  const ownerDocument = root.ownerDocument
  if (!ownerDocument?.createTreeWalker) return []
  const walker = ownerDocument.createTreeWalker(root, 4)
  const nodes = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (mappedAncestor(node)) nodes.push(node)
  }
  return nodes
}

function boundaryPoint(container, node, offset, edge) {
  const direct = mappedTextPoint(node, offset)
  if (direct !== null) return direct
  if (node?.nodeType !== ELEMENT_NODE || !container.contains(node)) return null
  const children = [...node.childNodes]
  const candidate = edge === 'start' ? children[offset] : children[offset - 1]
  const candidates = mappedTextNodes(candidate || node)
  const textNode = edge === 'start' ? candidates[0] : candidates.at(-1)
  if (!textNode) return null
  return mappedTextPoint(textNode, edge === 'start' ? 0 : String(textNode.data ?? '').length)
}

export function normalizeMappedRange(markdown, start, end) {
  const source = String(markdown || '')
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  const normalizedStart = Math.min(start, end)
  const normalizedEnd = Math.max(start, end)
  if (normalizedStart < 0 || normalizedEnd > source.length || normalizedEnd <= normalizedStart) return null
  if (!source.slice(normalizedStart, normalizedEnd).trim()) return null
  return { start: normalizedStart, end: normalizedEnd }
}

export function mapDomSelectionToMarkdown(selection, container, markdown) {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || !container) return null
  const range = selection.getRangeAt(0)
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null
  const start = boundaryPoint(container, range.startContainer, range.startOffset, 'start')
  const end = boundaryPoint(container, range.endContainer, range.endOffset, 'end')
  return normalizeMappedRange(markdown, start, end)
}

export function activeAnnotationRanges(annotations = []) {
  return annotations
    .filter((annotation) => !annotation.archived && ['anchored', 'relocated'].includes(annotation.relocation?.status))
    .filter((annotation) => Number.isInteger(annotation.relocation.start) && Number.isInteger(annotation.relocation.end) && annotation.relocation.end > annotation.relocation.start)
    .sort((left, right) => left.relocation.start - right.relocation.start || left.relocation.end - right.relocation.end || left.id.localeCompare(right.id))
}

export function splitSourceText(value, sourceStart, annotations = []) {
  const text = String(value ?? '')
  const sourceEnd = sourceStart + text.length
  const relevant = activeAnnotationRanges(annotations).filter((annotation) => annotation.relocation.start < sourceEnd && annotation.relocation.end > sourceStart)
  const boundaries = new Set([sourceStart, sourceEnd])
  relevant.forEach((annotation) => {
    boundaries.add(Math.max(sourceStart, annotation.relocation.start))
    boundaries.add(Math.min(sourceEnd, annotation.relocation.end))
  })
  const points = [...boundaries].sort((left, right) => left - right)
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1]
    return {
      start,
      end,
      text: text.slice(start - sourceStart, end - sourceStart),
      annotations: relevant.filter((annotation) => annotation.relocation.start < end && annotation.relocation.end > start),
    }
  })
}
