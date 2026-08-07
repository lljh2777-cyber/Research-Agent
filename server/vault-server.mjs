import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { realpath } from 'node:fs/promises'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4317
const MAX_MARKDOWN_FILES = 20000
const MAX_NOTE_BYTES = 10 * 1024 * 1024
const MAX_VAULT_BYTES = 200 * 1024 * 1024
const ignoredDirectories = new Set(['.obsidian', '.trash', 'node_modules'])

function usage() {
  console.error('Usage: npm run vault-server -- "D:\\path\\to\\knowledge-base"')
}

async function getRoot() {
  const input = process.argv[2] || process.env.BIORESEARCH_VAULT_ROOT
  if (!input) {
    usage()
    process.exitCode = 1
    return null
  }
  const root = await realpath(resolve(input))
  const details = await stat(root)
  if (!details.isDirectory()) throw new Error('Vault root must be a directory')
  return root
}

async function listMarkdownFiles(root) {
  const files = []
  let totalBytes = 0
  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (ignoredDirectories.has(entry.name)) continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath, path)
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        const metadata = await stat(absolutePath)
        if (metadata.size > MAX_NOTE_BYTES) throw new Error(`Markdown note exceeds ${MAX_NOTE_BYTES} byte limit`)
        totalBytes += metadata.size
        if (totalBytes > MAX_VAULT_BYTES) throw new Error(`Vault exceeds ${MAX_VAULT_BYTES} byte limit`)
        files.push({ path, absolutePath, mtimeMs: metadata.mtimeMs, size: metadata.size })
        if (files.length > MAX_MARKDOWN_FILES) throw new Error(`Vault exceeds ${MAX_MARKDOWN_FILES} Markdown file limit`)
      }
    }
  }
  await walk(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function revisionFor(files) {
  const digest = createHash('sha256')
  for (const file of files) digest.update(`${file.path}\u0000${file.mtimeMs}\u0000${file.size}\n`)
  return digest.digest('hex').slice(0, 16)
}

async function scanVault(root, since = '') {
  const files = await listMarkdownFiles(root)
  const revision = revisionFor(files)
  if (since && since === revision) {
    return { unchanged: true, revision, vaultName: basename(root), noteCount: files.length }
  }

  const payloadFiles = await Promise.all(files.map(async (file) => ({
    path: file.path,
    content: await readFile(file.absolutePath, 'utf8'),
  })))
  return { unchanged: false, revision, vaultName: basename(root), files: payloadFiles }
}

function setCorsHeaders(request, response) {
  const origin = request.headers.origin
  let allowedOrigin = ''
  if (!origin || origin === 'null') {
    allowedOrigin = origin || ''
  } else {
    try {
      const url = new URL(origin)
      if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
        allowedOrigin = origin
      }
    } catch {
      allowedOrigin = ''
    }
  }
  if (allowedOrigin) response.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')
}

function sendJson(request, response, status, payload) {
  setCorsHeaders(request, response)
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
  response.end(body)
}

const root = await getRoot()
if (root) {
  const server = createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      setCorsHeaders(request, response)
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method !== 'GET') {
      sendJson(request, response, 405, { error: 'read-only adapter' })
      return
    }

    try {
      const url = new URL(request.url || '/', `http://${DEFAULT_HOST}`)
      if (url.pathname === '/api/health') {
        sendJson(request, response, 200, { ok: true, adapter: 'local-vault', readOnly: true, vaultName: basename(root) })
        return
      }
      if (url.pathname === '/api/vault') {
        const payload = await scanVault(root, url.searchParams.get('since') || '')
        sendJson(request, response, 200, payload)
        return
      }
      sendJson(request, response, 404, { error: 'not found' })
    } catch (error) {
      console.error(`[vault-server] ${error.message}`)
      sendJson(request, response, 500, { error: 'Vault scan failed' })
    }
  })

  const port = Number(process.env.BIORESEARCH_VAULT_PORT || DEFAULT_PORT)
  server.listen(port, DEFAULT_HOST, () => {
    console.log(`[vault-server] read-only adapter listening at http://${DEFAULT_HOST}:${port}`)
    console.log(`[vault-server] vault: ${root}`)
  })
}
