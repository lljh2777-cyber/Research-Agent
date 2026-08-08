import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const STORE_VERSION = 1
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_ALLOWED_ORIGINS = 16

export function normalizeProviderCredentialId(value) {
  const id = String(value || '').trim().toLowerCase()
  if (!PROVIDER_ID_PATTERN.test(id)) throw new Error('Invalid provider credential identifier.')
  return id
}

export function normalizeCredentialOrigins(values) {
  if (!Array.isArray(values)) throw new Error('Provider credentials require an endpoint scope.')
  const origins = new Set()
  for (const value of values) {
    let url
    try {
      url = new URL(String(value || '').trim())
    } catch {
      throw new Error('Provider credential endpoint scope is invalid.')
    }
    const loopbackHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !loopbackHttp) throw new Error('Provider credentials require HTTPS or a loopback HTTP endpoint.')
    if (url.username || url.password) throw new Error('Provider credential endpoint scopes cannot contain embedded credentials.')
    origins.add(url.origin)
    if (origins.size > MAX_ALLOWED_ORIGINS) throw new Error('Too many provider credential endpoint scopes.')
  }
  if (!origins.size) throw new Error('Provider credentials require at least one endpoint scope.')
  return [...origins].sort()
}

export class EncryptedCredentialStore {
  constructor({ filePath, encrypt, decrypt }) {
    if (!filePath || typeof encrypt !== 'function' || typeof decrypt !== 'function') {
      throw new Error('Encrypted credential storage requires a file path and encryption adapter.')
    }
    this.filePath = filePath
    this.encrypt = encrypt
    this.decrypt = decrypt
    this.writeQueue = Promise.resolve()
  }

  async readEnvelope() {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (value?.version !== STORE_VERSION || !value.credentials || typeof value.credentials !== 'object' || Array.isArray(value.credentials)) return { version: STORE_VERSION, credentials: {} }
      return { version: STORE_VERSION, credentials: value.credentials }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return { version: STORE_VERSION, credentials: {} }
    }
  }

  async writeEnvelope(envelope) {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 })
    try {
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error
      await unlink(this.filePath).catch(() => {})
      await rename(temporaryPath, this.filePath)
    }
  }

  async get(providerId, endpoint) {
    const id = normalizeProviderCredentialId(providerId)
    await this.writeQueue
    const record = (await this.readEnvelope()).credentials[id]
    if (!record || typeof record !== 'object' || typeof record.encrypted !== 'string' || !record.encrypted || !Array.isArray(record.allowedOrigins)) return ''
    let requestedOrigin
    try {
      requestedOrigin = new URL(String(endpoint || '')).origin
    } catch {
      return ''
    }
    if (!record.allowedOrigins.includes(requestedOrigin)) return ''
    try {
      return await this.decrypt(record.encrypted)
    } catch {
      return ''
    }
  }

  async has(providerId) {
    const id = normalizeProviderCredentialId(providerId)
    await this.writeQueue
    const record = (await this.readEnvelope()).credentials[id]
    if (!record || typeof record !== 'object' || typeof record.encrypted !== 'string' || !record.encrypted || !Array.isArray(record.allowedOrigins)) return false
    try {
      return Boolean(await this.decrypt(record.encrypted))
    } catch {
      return false
    }
  }

  async set(providerId, secret, allowedEndpoints) {
    const id = normalizeProviderCredentialId(providerId)
    const value = String(secret || '')
    if (!value) return this.delete(id)
    const allowedOrigins = normalizeCredentialOrigins(allowedEndpoints)
    this.writeQueue = this.writeQueue.then(async () => {
      const envelope = await this.readEnvelope()
      envelope.credentials[id] = { encrypted: await this.encrypt(value), allowedOrigins }
      await this.writeEnvelope(envelope)
    })
    await this.writeQueue
  }

  async delete(providerId) {
    const id = normalizeProviderCredentialId(providerId)
    this.writeQueue = this.writeQueue.then(async () => {
      const envelope = await this.readEnvelope()
      if (!(id in envelope.credentials)) return
      delete envelope.credentials[id]
      await this.writeEnvelope(envelope)
    })
    await this.writeQueue
  }
}
