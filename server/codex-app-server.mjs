import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'

const REQUEST_TIMEOUT_MS = 30_000
const START_TIMEOUT_MS = 15_000

export class CodexRpcError extends Error {
  constructor(message, code, data) {
    super(message)
    this.name = 'CodexRpcError'
    this.code = code
    this.data = data
  }
}

export class CodexAppServer extends EventEmitter {
  constructor({ command = process.env.BIORESEARCH_CODEX_BIN || 'codex', spawnProcess = spawn } = {}) {
    super()
    this.command = command
    this.spawnProcess = spawnProcess
    this.nextId = 1
    this.pending = new Map()
    this.process = null
    this.startPromise = null
  }

  async start() {
    if (this.startPromise) return this.startPromise
    if (this.process && !this.process.killed) return
    this.startPromise = this.#startProcess().finally(() => { this.startPromise = null })
    return this.startPromise
  }

  async #startProcess() {
    const child = this.spawnProcess(this.command, [
      'app-server',
      '--stdio',
      '-c',
      'cli_auth_credentials_store="keyring"',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.process = child
    child.once('error', (error) => this.#handleExit(error))
    child.once('exit', (code) => this.#handleExit(new Error(`Codex app-server stopped (${code ?? 'unknown'})`)))
    child.stderr?.resume()

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.#handleLine(line))

    await this.#sendRequest('initialize', {
      clientInfo: { name: 'research_agent', title: 'Research Agent', version: '0.1.0' },
      capabilities: {},
    }, START_TIMEOUT_MS)
    this.notify('initialized', {})
  }

  #handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) {
        pending.reject(new CodexRpcError(message.error.message || 'Codex request failed', message.error.code, message.error.data))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.method && Object.hasOwn(message, 'id')) {
      this.#write({ id: message.id, error: { code: -32601, message: 'Research Agent does not expose interactive Codex tools.' } })
      return
    }

    if (message.method) this.emit('notification', message)
  }

  #handleExit(error) {
    if (!this.process) return
    this.process = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
    this.emit('unavailable', error)
  }

  #write(message) {
    if (!this.process?.stdin?.writable) throw new Error('Codex app-server is unavailable')
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #sendRequest(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      try {
        this.#write({ method, id, params })
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async request(method, params = {}, timeoutMs) {
    await this.start()
    return this.#sendRequest(method, params, timeoutMs)
  }

  notify(method, params = {}) {
    this.#write({ method, params })
  }

  close() {
    const child = this.process
    this.process = null
    child?.stdin?.end()
  }
}
