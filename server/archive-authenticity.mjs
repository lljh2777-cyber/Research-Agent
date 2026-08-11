import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const KEY_BYTES = 32
const KEY_VERSION = 1
const MAX_ACTIVE_REALIZATIONS = 256
const MAX_AUTHENTICATED_STATE_BYTES = 64 * 1024 * 1024

function defaultStateRoot() {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || process.env.APPDATA || homedir(), 'BioResearch OS', 'runtime-state')
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'bioresearch-os')
}

function json(value) {
  return JSON.stringify(value)
}

function journalExists(root) {
  const directory = resolve(root, '.bioresearch', 'runtime', 'archive-realizations', 'v1')
  try {
    return readdirSync(directory).some((name) => name.endsWith('.json'))
  } catch {
    return false
  }
}

function assertRegularFile(path, label) {
  const details = lstatSync(path)
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${label} must be a regular file.`)
}

function assertDirectory(path, label) {
  const details = lstatSync(path)
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`${label} must be a real directory.`)
}

function loadOrCreateKey({ root, stateRoot, suppliedKey }) {
  if (suppliedKey) {
    const key = Buffer.from(suppliedKey)
    if (key.length !== KEY_BYTES) throw new Error('Archive authenticity key must contain exactly 32 bytes.')
    return key
  }
  const keyDirectory = join(stateRoot, 'keys')
  const keyPath = join(keyDirectory, 'archive-realization-hmac-v1.key')
  mkdirSync(keyDirectory, { recursive: true, mode: 0o700 })
  assertDirectory(stateRoot, 'Archive Runtime state root')
  assertDirectory(keyDirectory, 'Archive Runtime key directory')
  if (existsSync(keyPath)) {
    assertRegularFile(keyPath, 'Archive authenticity key')
    const key = readFileSync(keyPath)
    if (key.length !== KEY_BYTES) throw new Error('Archive authenticity key is invalid.')
    return key
  }
  if (journalExists(root)) {
    throw new Error('Archive authenticity key is missing for an existing realization journal.')
  }
  const key = randomBytes(KEY_BYTES)
  let descriptor
  try {
    descriptor = openSync(keyPath, 'wx', 0o600)
    writeFileSync(descriptor, key)
    fsyncSync(descriptor)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  assertRegularFile(keyPath, 'Archive authenticity key')
  const persisted = readFileSync(keyPath)
  if (persisted.length !== KEY_BYTES) throw new Error('Archive authenticity key is invalid.')
  return persisted
}

export class ArchiveAuthenticityStore {
  #key
  #stateRoot
  #keyId

  constructor({ root, stateRoot = process.env.BIORESEARCH_RUNTIME_STATE_ROOT || defaultStateRoot(), key } = {}) {
    if (!root) throw new Error('ArchiveAuthenticityStore requires a Vault root.')
    this.#stateRoot = resolve(stateRoot)
    const stateRelative = relative(resolve(root), this.#stateRoot)
    if (stateRelative === '' || (!stateRelative.startsWith('..') && !isAbsolute(stateRelative))) {
      throw new Error('Archive authenticity state must be stored outside the user-controlled Vault.')
    }
    this.#key = loadOrCreateKey({ root, stateRoot: this.#stateRoot, suppliedKey: key })
    this.#keyId = createHash('sha256').update(this.#key).digest('hex').slice(0, 32)
    this.#audit(root)
  }

  get keyId() {
    return this.#keyId
  }

  audit(root, validateRecord) {
    this.#audit(root, validateRecord)
    return true
  }

  mac(record) {
    const { mac: _mac, ...payload } = record
    return createHmac('sha256', this.#key).update(json(payload)).digest('hex')
  }

  verify(record) {
    return record?.keyId === this.#keyId && record.mac === this.mac(record)
  }

  async load(key) {
    const path = this.#path(key)
    try {
      assertRegularFile(path, 'Archive authenticity checkpoint')
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async persist(key, record) {
    const path = this.#path(key)
    const directory = dirname(path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    assertDirectory(this.#stateRoot, 'Archive Runtime state root')
    assertDirectory(dirname(directory), 'Archive Runtime checkpoint root')
    assertDirectory(directory, 'Archive Runtime checkpoint directory')
    const temporary = join(directory, `.${key}.${randomUUID()}.tmp`)
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${json(record)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporary, path)
      let directoryHandle
      try {
        directoryHandle = await open(directory, 'r')
        await directoryHandle.sync()
        await directoryHandle.close()
        directoryHandle = null
      } catch {
        // Directory durability is best-effort where the platform does not expose it.
      } finally {
        await directoryHandle?.close().catch(() => {})
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  #path(key) {
    return join(this.#stateRoot, 'archive-realizations', 'v1', `${key}.json`)
  }

  #audit(root, validateRecord) {
    const journalDirectory = resolve(root, '.bioresearch', 'runtime', 'archive-realizations', 'v1')
    const checkpointDirectory = join(this.#stateRoot, 'archive-realizations', 'v1')
    const readDirectory = (directory) => {
      const records = new Map()
      let bytes = 0
      for (const name of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, name.name)
        if (name.isFile() && /^\.[a-f0-9]{64}\..+\.tmp$/.test(name.name)) {
          unlinkSync(path)
          continue
        }
        if (!name.isFile() || !/^[a-f0-9]{64}\.json$/.test(name.name)) {
          throw new Error('Archive Runtime state directory contains an unexpected entry.')
        }
        assertRegularFile(path, 'Archive authenticated state')
        bytes += statSync(path).size
        const record = JSON.parse(readFileSync(path, 'utf8'))
        const terminal = ['completed', 'failed', 'cancelled'].includes(record?.state)
        const expectedKeys = (terminal ? [
          'schemaVersion', 'kind', 'key', 'keyId', 'generation', 'previousMac', 'mac', 'requestDigest', 'approvalDigest', 'binding',
          'state', 'targets', 'result', 'createdAt', 'updatedAt',
        ] : [
          'schemaVersion', 'kind', 'key', 'keyId', 'generation', 'previousMac', 'mac', 'requestDigest', 'approvalDigest', 'request', 'approval',
          'state', 'targets', 'result', 'createdAt', 'updatedAt',
        ]).sort()
        const actualKeys = Object.keys(record || {}).sort()
        if (record?.schemaVersion !== 1
          || record?.kind !== 'runtime-archive-realization'
          || record?.key !== name.name.slice(0, -5)
          || !Number.isSafeInteger(record?.generation)
          || record.generation < 0
          || actualKeys.length !== expectedKeys.length
          || actualKeys.some((key, index) => key !== expectedKeys[index])) {
          throw new Error('Archive authenticated state has an invalid schema or filename binding.')
        }
        if (!this.verify(record)) throw new Error('Archive authenticated state does not match the Runtime-private key.')
        validateRecord?.(record, name.name.slice(0, -5), this)
        records.set(name.name.slice(0, -5), record)
      }
      return { records, bytes }
    }
    const empty = () => ({ records: new Map(), bytes: 0 })
    let journals = empty()
    let checkpoints = empty()
    try { journals = readDirectory(journalDirectory) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    try { checkpoints = readDirectory(checkpointDirectory) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    if (journals.bytes + checkpoints.bytes > MAX_AUTHENTICATED_STATE_BYTES) {
      throw new Error('Archive authenticated state exceeds the 67,108,864-byte quota.')
    }
    const keys = new Set([...journals.records.keys(), ...checkpoints.records.keys()])
    let active = 0
    for (const key of keys) {
      const journal = journals.records.get(key) || null
      const checkpoint = checkpoints.records.get(key) || null
      const newest = checkpoint && (!journal || checkpoint.generation >= journal.generation) ? checkpoint : journal
      if (!['completed', 'failed', 'cancelled'].includes(newest?.state)) active += 1
      if (!journal) continue
      if (!checkpoint) {
        if (journal.generation === 0 && journal.state === 'accepted') continue
        throw new Error('Archive trusted checkpoint is missing for an active realization.')
      }
      const consistent = journal.generation === checkpoint.generation
        ? journal.mac === checkpoint.mac
        : journal.generation === checkpoint.generation + 1 && journal.previousMac === checkpoint.mac
      if (!consistent) throw new Error('Archive journal/checkpoint generation audit failed.')
    }
    if (active > MAX_ACTIVE_REALIZATIONS) throw new Error('Archive active realization quota exceeds 256 records.')
  }
}

export const archiveAuthenticityInternals = Object.freeze({
  keyBytes: KEY_BYTES,
  keyVersion: KEY_VERSION,
  maxActiveRealizations: MAX_ACTIVE_REALIZATIONS,
  maxAuthenticatedStateBytes: MAX_AUTHENTICATED_STATE_BYTES,
  defaultStateRoot,
})
