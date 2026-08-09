const WIKILINK_PATTERN = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g

export const VAULT_NOTE_SCHEMA_VERSION = 1
export const VAULT_INDEX_SCHEMA_VERSION = 1

function cleanValue(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return trimmed
}

function parseFrontmatterValue(lines, startIndex, initialValue) {
  if (initialValue.trim()) return { value: cleanValue(initialValue), nextIndex: startIndex - 1 }

  const items = []
  let index = startIndex
  while (index < lines.length) {
    const line = lines[index]
    const match = line.match(/^\s+-\s+(.+)$/)
    if (!match) break
    items.push(cleanValue(match[1]))
    index += 1
  }
  return { value: items, nextIndex: index - 1 }
}

export function parseFrontmatter(markdown) {
  if (!markdown.startsWith('---')) return { data: {}, body: markdown }
  const lines = markdown.split(/\r?\n/)
  if (lines[0].trim() !== '---') return { data: {}, body: markdown }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (closingIndex < 0) return { data: {}, body: markdown }

  const data = {}
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index]
    if (!line.trim() || line.trim().startsWith('#') || /^\s+-\s+/.test(line)) continue
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    const parsed = parseFrontmatterValue(lines, index + 1, line.slice(separator + 1))
    data[key] = parsed.value
    index = parsed.nextIndex
  }

  return { data, body: lines.slice(closingIndex + 1).join('\n') }
}

export function extractWikilinks(markdown) {
  const links = []
  for (const match of markdown.matchAll(WIKILINK_PATTERN)) {
    const target = match[1].trim()
    if (target && !links.includes(target)) links.push(target)
  }
  return links
}

function titleFromMarkdown(path, body, frontmatter) {
  if (typeof frontmatter.title === 'string' && frontmatter.title.trim()) return frontmatter.title.trim()
  const heading = body.match(/^#\s+(.+)$/m)
  if (heading) return heading[1].trim()
  const filename = path.split('/').pop() || path
  return filename.replace(/\.md$/i, '')
}

function isIgnoredPath(path) {
  return path.split('/').some((part) => part === '.obsidian' || part === '.trash' || part === 'node_modules')
}

export function normalizeVaultPath(value) {
  const segments = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.md$/i, '')
    .split('/')
  const normalized = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      normalized.pop()
    } else {
      normalized.push(segment)
    }
  }
  return normalized.join('/').toLocaleLowerCase()
}

export function parseWikilinkTarget(value) {
  const raw = String(value || '').trim().replace(/^\[\[|\]\]$/g, '')
  const destination = raw.split('|', 1)[0].trim()
  const headingIndex = destination.indexOf('#')
  return {
    target: (headingIndex >= 0 ? destination.slice(0, headingIndex) : destination).trim(),
    heading: headingIndex >= 0 ? destination.slice(headingIndex + 1).trim() : '',
  }
}

function noteAliases(note) {
  const rawAliases = note?.frontmatter?.aliases ?? note?.frontmatter?.alias ?? []
  const values = Array.isArray(rawAliases) ? rawAliases : String(rawAliases).split(',')
  return values.map((alias) => normalizeVaultPath(alias)).filter(Boolean)
}

function noteDirectory(note) {
  const path = String(note?.path || note?.id || '').replace(/\\/g, '/')
  const slashIndex = path.lastIndexOf('/')
  return slashIndex >= 0 ? path.slice(0, slashIndex) : ''
}

export function resolveVaultWikilink(notes = [], sourceNote = null, value = '') {
  const { target, heading } = parseWikilinkTarget(value)
  if (!target) return { note: sourceNote || null, target, heading, reason: sourceNote ? null : 'missing' }

  const targetPath = normalizeVaultPath(target)
  const isRelative = /^(?:\.\/|\.\.\/)/.test(target.replace(/\\/g, '/'))
  const relativePath = isRelative ? normalizeVaultPath(`${noteDirectory(sourceNote)}/${target}`) : ''
  const notesByPath = new Map()
  for (const note of notes) {
    const path = normalizeVaultPath(note.path || note.id)
    if (!notesByPath.has(path)) notesByPath.set(path, [])
    notesByPath.get(path).push(note)
  }
  for (const path of [relativePath, targetPath].filter(Boolean)) {
    const matches = notesByPath.get(path) || []
    if (matches.length === 1) return { note: matches[0], target, heading, reason: null }
    if (matches.length > 1) return { note: null, target, heading, reason: 'ambiguous' }
  }

  const targetBasename = targetPath.split('/').at(-1)
  const candidates = notes.filter((note) => {
    const aliases = [
      normalizeVaultPath(note.title),
      normalizeVaultPath(note.name || String(note.path || '').split('/').pop()),
      normalizeVaultPath(note.path || note.id).split('/').at(-1),
      ...noteAliases(note),
    ]
    return aliases.includes(targetPath) || aliases.includes(targetBasename)
  })
  if (candidates.length === 1) return { note: candidates[0], target, heading, reason: null }
  return { note: null, target, heading, reason: candidates.length ? 'ambiguous' : 'missing' }
}

async function parseVaultEntries(entries) {
  const files = entries.filter((file) => /\.md$/i.test(file.name) && !isIgnoredPath(file.webkitRelativePath || file.name))
  const notes = await Promise.all(files.map(async (file) => {
    const path = file.webkitRelativePath || file.name
    const markdown = await file.text()
    const { data: frontmatter, body } = parseFrontmatter(markdown)
    const wikilinks = extractWikilinks(markdown)
    const title = titleFromMarkdown(path, body, frontmatter)
    return {
      schemaVersion: VAULT_NOTE_SCHEMA_VERSION,
      id: path,
      path,
      name: path.split('/').pop() || path,
      title,
      body,
      frontmatter,
      wikilinks,
      wordCount: body.trim() ? body.trim().split(/\s+/).length : 0,
      type: typeof frontmatter.type === 'string' ? frontmatter.type : 'note',
    }
  }))
  return notes.sort((a, b) => a.path.localeCompare(b.path))
}

export async function parseVaultFiles(fileList) {
  return parseVaultEntries(Array.from(fileList))
}

export async function parseVaultTextEntries(entries) {
  return parseVaultEntries(entries.map(({ path, content }) => ({
    name: path.split('/').pop() || path,
    webkitRelativePath: path,
    text: () => Promise.resolve(content),
  })))
}

export async function parseVaultDirectory(directoryHandle) {
  const entries = []

  async function walk(directory, prefix = '') {
    for await (const [name, entry] of directory.entries()) {
      const path = prefix ? `${prefix}/${name}` : name
      if (isIgnoredPath(path)) continue
      if (entry.kind === 'directory') {
        await walk(entry, path)
      } else if (entry.kind === 'file' && /\.md$/i.test(name)) {
        const file = await entry.getFile()
        entries.push({ name: file.name, webkitRelativePath: path, text: () => file.text() })
      }
    }
  }

  await walk(directoryHandle)
  return parseVaultEntries(entries)
}

export function buildVaultIndex(notes) {
  const edges = []
  notes.forEach((note) => {
    note.wikilinks.forEach((target) => {
      const resolved = resolveVaultWikilink(notes, note, target)
      edges.push({ source: note, target: resolved.note || { title: target, path: target, missing: true, reason: resolved.reason } })
    })
  })

  return {
    schemaVersion: VAULT_INDEX_SCHEMA_VERSION,
    notes,
    edges,
    linkedNotes: notes.map((note) => ({
      id: note.id,
      title: note.title,
      type: note.type,
      path: note.path,
      body: note.body,
      frontmatter: note.frontmatter,
      wikilinks: note.wikilinks,
      wordCount: note.wordCount,
    })),
    sources: notes.slice(0, 12).map((note) => ({
      id: note.id,
      name: note.name,
      title: note.title,
      path: note.path,
      kind: note.type === 'paper' ? 'paper' : 'note',
    })),
  }
}

export function getVaultName(notes) {
  const firstPath = notes[0]?.path || ''
  return firstPath.split('/')[0] || 'local-vault'
}
