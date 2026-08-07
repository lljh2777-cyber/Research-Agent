export const DEFAULT_DOCK_LAYOUT = Object.freeze({
  left: ['files', 'outline', 'tags'],
  right: ['graph', 'web', 'plugins'],
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
