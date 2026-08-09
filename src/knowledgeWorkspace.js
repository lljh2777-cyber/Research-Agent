import { resolveVaultWikilink } from './vault.js'

export const DEFAULT_DOCK_LAYOUT = Object.freeze({
  left: ['files', 'outline', 'tags'],
  right: ['agent', 'graph', 'web', 'plugins'],
})

export const PANEL_IDS = Object.freeze([...DEFAULT_DOCK_LAYOUT.left, ...DEFAULT_DOCK_LAYOUT.right])

export function normalizeDockLayout(layout) {
  const seen = new Set()
  const normalizeSide = (side) => (Array.isArray(layout?.[side]) ? layout[side] : [])
    .filter((panelId) => PANEL_IDS.includes(panelId) && !seen.has(panelId) && seen.add(panelId))

  const left = normalizeSide('left')
  const right = normalizeSide('right')
  for (const panelId of PANEL_IDS) {
    if (!seen.has(panelId)) DEFAULT_DOCK_LAYOUT.right.includes(panelId) ? right.push(panelId) : left.push(panelId)
  }
  return { left, right }
}

export function moveDockPanel(layout, panelId, side, beforePanelId = null) {
  if (!PANEL_IDS.includes(panelId) || !['left', 'right'].includes(side)) return normalizeDockLayout(layout)
  const next = normalizeDockLayout(layout)
  next.left = next.left.filter((id) => id !== panelId)
  next.right = next.right.filter((id) => id !== panelId)
  const target = next[side]
  const beforeIndex = beforePanelId ? target.indexOf(beforePanelId) : -1
  target.splice(beforeIndex >= 0 ? beforeIndex : target.length, 0, panelId)
  return next
}

export function extractMarkdownOutline(markdown = '') {
  return String(markdown).split(/\r?\n/).flatMap((line, lineIndex) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (!match) return []
    return [{ id: `heading-${lineIndex}`, level: match[1].length, title: match[2].replace(/[*_`]/g, '').trim() }]
  })
}

export function parseWikilinks(value = '') {
  const text = String(value)
  const segments = []
  const pattern = /\[\[([^\]]+)\]\]/g
  let cursor = 0
  let match

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) segments.push({ type: 'text', value: text.slice(cursor, match.index) })
    const pipeIndex = match[1].indexOf('|')
    const destination = (pipeIndex >= 0 ? match[1].slice(0, pipeIndex) : match[1]).trim()
    const alias = pipeIndex >= 0 ? match[1].slice(pipeIndex + 1).trim() : ''
    const headingIndex = destination.indexOf('#')
    const target = (headingIndex >= 0 ? destination.slice(0, headingIndex) : destination).trim()
    const heading = headingIndex >= 0 ? destination.slice(headingIndex + 1).trim() : ''
    const label = alias || (target ? target.split(/[\\/]/).at(-1).replace(/\.md$/i, '') : heading) || destination
    segments.push({ type: 'wikilink', raw: match[0], target, heading, alias, label })
    cursor = pattern.lastIndex
  }

  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) })
  return segments.length ? segments : [{ type: 'text', value: text }]
}

export function resolveWikilink(notes = [], currentNote = null, link = {}) {
  const raw = link.raw || `[[${String(link.target || '')}${link.heading ? `#${link.heading}` : ''}]]`
  const resolved = resolveVaultWikilink(notes, currentNote, raw)
  const note = resolved.note
  const heading = resolved.heading || String(link.heading || '').trim()
  const outlineHeading = note && heading
    ? extractMarkdownOutline(note.body).find((item) => item.title.toLocaleLowerCase() === heading.toLocaleLowerCase())
    : null

  return {
    note,
    anchorId: outlineHeading?.id || null,
    missing: !note,
    missingHeading: Boolean(note && heading && !outlineHeading),
  }
}

export function collectVaultTags(notes = []) {
  const counts = new Map()
  for (const note of notes) {
    const frontmatterTags = note.frontmatter?.tags ?? note.frontmatter?.tag ?? []
    const values = Array.isArray(frontmatterTags) ? frontmatterTags : String(frontmatterTags || '').split(',')
    const bodyTags = [...String(note.body || '').matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((match) => match[1])
    for (const rawTag of [...values, ...bodyTags]) {
      const tag = String(rawTag).trim().replace(/^#/, '')
      if (tag) counts.set(tag, (counts.get(tag) || 0) + 1)
    }
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

const compareTreeNodes = (a, b) => {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

export function buildVaultFileTree(notes = []) {
  const root = { type: 'folder', id: '', name: '', path: '', children: [], folders: new Map() }

  for (const note of notes) {
    const segments = String(note.path || note.name || '').split('/').filter(Boolean)
    if (!segments.length || segments.some((segment) => segment.startsWith('.'))) continue

    let parent = root
    for (const segment of segments.slice(0, -1)) {
      const folderPath = parent.path ? `${parent.path}/${segment}` : segment
      if (!parent.folders.has(segment)) {
        const folder = { type: 'folder', id: folderPath, name: segment, path: folderPath, children: [], folders: new Map() }
        parent.folders.set(segment, folder)
        parent.children.push(folder)
      }
      parent = parent.folders.get(segment)
    }

    const filename = segments.at(-1)
    parent.children.push({
      type: 'file',
      id: note.id,
      name: filename.replace(/\.md$/i, ''),
      path: note.path,
      note,
    })
  }

  const finalize = (folder) => {
    folder.children.forEach((node) => {
      if (node.type === 'folder') finalize(node)
    })
    folder.children.sort(compareTreeNodes)
    delete folder.folders
    return folder
  }

  return finalize(root).children
}

export function filterVaultFileTree(nodes = [], query = '') {
  const normalized = String(query).trim().toLocaleLowerCase()
  if (!normalized) return nodes

  return nodes.flatMap((node) => {
    const matches = `${node.name} ${node.path}`.toLocaleLowerCase().includes(normalized)
    if (node.type === 'file') return matches ? [node] : []
    const children = matches ? node.children : filterVaultFileTree(node.children, normalized)
    return children.length ? [{ ...node, children }] : []
  })
}
