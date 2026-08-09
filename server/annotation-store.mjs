import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'

import {
  isAnnotationPatchIntent,
  RUNTIME_ANNOTATION_CONTENT_MAX_BYTES,
} from '../shared/runtime-action-contracts.mjs'

const ANNOTATION_DIRECTORY = 'wiki/annotations'
const MAX_ANNOTATION_FILES = 128
const MAX_PATH_LENGTH = 512
const IDEMPOTENCY_LIMIT = 1024

function runtimeError(message, statusCode = 400, code = 'invalid_request', details = {}) {
  return Object.assign(new Error(message), { statusCode, code, ...details })
}

function revisionFor(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 32)
}

function normalizeAnnotationPath(value) {
  let path = String(value || '').split(String.fromCharCode(92)).join('/')
  while (path.startsWith('/')) path = path.slice(1)
  if (!path || path.length > MAX_PATH_LENGTH || path.includes(String.fromCharCode(0))) {
    throw runtimeError('Annotation path is invalid.')
  }
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw runtimeError('Annotation path is invalid.')
  }
  if (!path.startsWith(ANNOTATION_DIRECTORY + '/') || extname(path).toLowerCase() !== '.md') {
    throw runtimeError('Annotation writes are restricted to wiki/annotations Markdown files.', 403, 'scope_denied')
  }
  return path
}

function inside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function readExisting(path) {
  try {
    const content = await readFile(path, 'utf8')
    return { content, revision: revisionFor(content) }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function requireWriteEnvelope(input, vaultId, path) {
  if (!isAnnotationPatchIntent(input.intent)) {
    throw runtimeError('Annotation writes require an Annotation Patch Intent v1 envelope.')
  }
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) {
    throw runtimeError('Annotation writes require a valid idempotencyKey.')
  }
  if (input.intent.target.vaultId !== vaultId || input.intent.target.path !== path) {
    throw runtimeError('Annotation patch target does not match the target Vault and path.', 403, 'scope_denied')
  }
  if (input.approval?.status !== 'approved' && input.approval?.approved !== true) {
    throw runtimeError('Annotation writes require explicit approval.', 403, 'approval_required')
  }
  return idempotencyKey
}

export class AnnotationStore {
  #rootPromise
  #locks = new Map()
  #idempotency = new Map()

  constructor({ root }) {
    if (!root) throw new Error('AnnotationStore requires a Vault root.')
    this.#rootPromise = realpath(resolve(root))
  }

  async vaultId() {
    return basename(await this.#rootPromise)
  }

  async list() {
    const root = await this.#rootPromise
    const directory = resolve(root, ANNOTATION_DIRECTORY)
    const entries = []
    const walk = async (current) => {
      let children
      try {
        children = await readdir(current, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') return
        throw error
      }
      for (const child of children) {
        if (child.isSymbolicLink()) continue
        const absolute = resolve(current, child.name)
        if (!inside(directory, absolute)) continue
        if (child.isDirectory()) {
          await walk(absolute)
          continue
        }
        if (!child.isFile() || extname(child.name).toLowerCase() !== '.md') continue
        if (entries.length >= MAX_ANNOTATION_FILES) {
          throw runtimeError('Annotation file limit exceeded.', 413, 'limit_exceeded')
        }
        const details = await stat(absolute)
        if (details.size > RUNTIME_ANNOTATION_CONTENT_MAX_BYTES) {
          throw runtimeError('Annotation file exceeds the 64 KiB limit.', 413, 'limit_exceeded')
        }
        const content = await readFile(absolute, 'utf8')
        entries.push({
          path: relative(root, absolute).split(String.fromCharCode(92)).join('/'),
          revision: revisionFor(content),
          bytes: Buffer.byteLength(content),
        })
      }
    }
    await walk(directory)
    return { vaultId: basename(root), annotations: entries.sort((a, b) => a.path.localeCompare(b.path)) }
  }

  async read(pathValue) {
    const { root, path, absolute } = await this.#target(pathValue)
    const existing = await readExisting(absolute)
    if (!existing) throw runtimeError('Annotation was not found.', 404, 'not_found')
    if (Buffer.byteLength(existing.content) > RUNTIME_ANNOTATION_CONTENT_MAX_BYTES) {
      throw runtimeError('Annotation file exceeds the 64 KiB limit.', 413, 'limit_exceeded')
    }
    return {
      vaultId: basename(root),
      path,
      content: existing.content,
      revision: existing.revision,
    }
  }

  async write(input = {}) {
    const intent = input.intent || {}
    const { root, path, absolute } = await this.#target(intent.target?.path)
    const vaultId = basename(root)
    const content = typeof intent.content === 'string' ? intent.content : ''
    if (!content || Buffer.byteLength(content) > RUNTIME_ANNOTATION_CONTENT_MAX_BYTES) {
      throw runtimeError('Annotation content must be non-empty and no larger than 64 KiB.', 413, 'limit_exceeded')
    }
    const idempotencyKey = requireWriteEnvelope(input, vaultId, path)
    const requestDigest = revisionFor(JSON.stringify(intent))
    const replay = this.#idempotency.get(idempotencyKey)
    if (replay) {
      if (replay.requestDigest !== requestDigest) {
        throw runtimeError('Idempotency key was already used for different annotation content.', 409, 'idempotency_conflict')
      }
      return { ...replay.result, replayed: true }
    }

    const previous = this.#locks.get(path) || Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      await mkdir(dirname(absolute), { recursive: true })
      const parent = await realpath(dirname(absolute))
      if (!inside(root, parent)) throw runtimeError('Annotation target escapes the Vault root.', 403, 'scope_denied')
      const existing = await readExisting(absolute)
      const currentRevision = existing?.revision || null
      if (currentRevision !== intent.target.expectedRevision) {
        throw runtimeError('Annotation revision conflict.', 409, 'revision_conflict', { currentRevision })
      }
      const temporary = resolve(parent, '.' + basename(path) + '.' + randomUUID() + '.tmp')
      try {
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        const beforeRename = await readExisting(absolute)
        if ((beforeRename?.revision || null) !== currentRevision) {
          throw runtimeError('Annotation changed during the write.', 409, 'revision_conflict', {
            currentRevision: beforeRename?.revision || null,
          })
        }
        await rename(temporary, absolute)
      } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
      }
      const result = {
        ok: true,
        annotationId: intent.annotationId,
        vaultId,
        path,
        revision: revisionFor(content),
        bytes: Buffer.byteLength(content),
        replayed: false,
      }
      this.#remember(idempotencyKey, { requestDigest, result })
      return result
    })
    this.#locks.set(path, task)
    try {
      return await task
    } finally {
      if (this.#locks.get(path) === task) this.#locks.delete(path)
    }
  }

  async #target(pathValue) {
    const root = await this.#rootPromise
    const path = normalizeAnnotationPath(pathValue)
    const absolute = resolve(root, ...path.split('/'))
    if (!inside(root, absolute)) throw runtimeError('Annotation target escapes the Vault root.', 403, 'scope_denied')
    return { root, path, absolute }
  }

  #remember(key, value) {
    this.#idempotency.set(key, value)
    if (this.#idempotency.size > IDEMPOTENCY_LIMIT) this.#idempotency.delete(this.#idempotency.keys().next().value)
  }
}

export const annotationStoreInternals = Object.freeze({
  annotationDirectory: ANNOTATION_DIRECTORY,
  normalizeAnnotationPath,
  revisionFor,
})
