import { createHash, randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'

const MAX_MARKDOWN_FILES = 20_000
const MAX_NOTE_BYTES = 10 * 1024 * 1024
const MAX_VAULT_BYTES = 200 * 1024 * 1024
const IGNORED_DIRECTORIES = new Set(['.obsidian', '.trash', 'node_modules'])

function isInsideRoot(root, candidate) {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function normalizeRelativePath(value) {
  return value.split('\\').join('/')
}

async function listMarkdownFiles(root) {
  const files = []
  let totalBytes = 0

  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) continue
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const candidate = join(directory, entry.name)
      if (entry.isDirectory()) {
        const canonicalDirectory = await realpath(candidate)
        if (!isInsideRoot(root, canonicalDirectory)) continue
        await walk(canonicalDirectory, relativePath)
        continue
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue

      const canonicalFile = await realpath(candidate)
      if (!isInsideRoot(root, canonicalFile)) continue
      const metadata = await stat(canonicalFile)
      if (!metadata.isFile()) continue
      if (metadata.size > MAX_NOTE_BYTES) throw new Error('A Markdown note exceeds the 10 MB safety limit.')
      totalBytes += metadata.size
      if (totalBytes > MAX_VAULT_BYTES) throw new Error('The Vault exceeds the 200 MB safety limit.')
      files.push({
        path: normalizeRelativePath(relativePath),
        absolutePath: canonicalFile,
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
      })
      if (files.length > MAX_MARKDOWN_FILES) throw new Error('The Vault exceeds the 20,000 Markdown file safety limit.')
    }
  }

  await walk(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function revisionFor(files) {
  const digest = createHash('sha256')
  for (const file of files) digest.update(`${file.path}\u0000${file.mtimeMs}\u0000${file.size}\n`)
  return digest.digest('hex').slice(0, 16)
}

async function scanVault(root, since = '') {
  const files = await listMarkdownFiles(root)
  const revision = revisionFor(files)
  if (since && revision === since) {
    return { unchanged: true, revision, noteCount: files.length }
  }
  const payloadFiles = []
  for (const file of files) {
    payloadFiles.push({ path: file.path, content: await readFile(file.absolutePath, 'utf8') })
  }
  return { unchanged: false, revision, noteCount: files.length, files: payloadFiles }
}

export class DesktopVaultManager {
  #vaults = new Map()

  async connect(ownerId, selectedPath, onChanged = () => {}) {
    if (!Number.isInteger(ownerId) || ownerId < 1) throw new Error('Invalid Vault owner.')
    if (typeof selectedPath !== 'string' || !selectedPath.trim()) throw new Error('A Vault directory must be selected.')
    const root = await realpath(selectedPath)
    const details = await stat(root)
    if (!details.isDirectory()) throw new Error('The selected Vault must be a directory.')

    const snapshot = await scanVault(root)
    this.cancelOwner(ownerId)

    const vaultId = randomUUID()
    const entry = { ownerId, root, onChanged, watcher: null, changeTimer: null }
    this.#vaults.set(vaultId, entry)
    try {
      entry.watcher = watch(root, { recursive: true }, () => {
        clearTimeout(entry.changeTimer)
        entry.changeTimer = setTimeout(() => onChanged({ vaultId }), 350)
      })
      entry.watcher.on('error', () => {})
    } catch {
      entry.watcher = null
    }

    return { vaultId, vaultName: basename(root), watching: Boolean(entry.watcher), ...snapshot }
  }

  async sync(ownerId, vaultId, since = '') {
    const entry = this.#ownedVault(ownerId, vaultId)
    if (typeof since !== 'string' || since.length > 128) throw new Error('Invalid Vault revision.')
    const snapshot = await scanVault(entry.root, since)
    return { vaultId, vaultName: basename(entry.root), watching: Boolean(entry.watcher), ...snapshot }
  }

  disconnect(ownerId, vaultId) {
    const entry = this.#ownedVault(ownerId, vaultId)
    clearTimeout(entry.changeTimer)
    entry.watcher?.close()
    this.#vaults.delete(vaultId)
    return { ok: true }
  }

  cancelOwner(ownerId) {
    for (const [vaultId, entry] of this.#vaults) {
      if (entry.ownerId !== ownerId) continue
      clearTimeout(entry.changeTimer)
      entry.watcher?.close()
      this.#vaults.delete(vaultId)
    }
  }

  close() {
    for (const entry of this.#vaults.values()) {
      clearTimeout(entry.changeTimer)
      entry.watcher?.close()
    }
    this.#vaults.clear()
  }

  #ownedVault(ownerId, vaultId) {
    if (typeof vaultId !== 'string' || vaultId.length > 128) throw new Error('Invalid Vault capability.')
    const entry = this.#vaults.get(vaultId)
    if (!entry || entry.ownerId !== ownerId) throw new Error('Vault access is unavailable. Select the folder again.')
    return entry
  }
}
