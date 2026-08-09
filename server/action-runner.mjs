import { spawn } from 'node:child_process'

import { MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES } from '../shared/runtime-action-contracts.mjs'

const SKILL_BY_ACTION = Object.freeze({
  'knowledge.lint': 'research-vault-lint',
  'knowledge.paper.ingest': 'research-vault-ingest',
  'knowledge.xray': 'research-vault-xray',
  'knowledge.code.analyze': 'research-vault-code',
  'knowledge.synthesis.write': 'research-vault-synthesis',
})

function abortError() {
  return Object.assign(new Error('Action was cancelled.'), { name: 'AbortError', code: 'cancelled' })
}

function boundedText(value, maximum = MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES) {
  const text = String(value || '')
  if (Buffer.byteLength(text) <= maximum) return text
  return Buffer.from(text).subarray(0, maximum).toString('utf8')
}

function finalTextFromEvent(event) {
  if (!event || typeof event !== 'object') return ''
  if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
    return event.item.text || event.item.content || ''
  }
  if (event.type === 'message' && typeof event.message === 'string') return event.message
  if (typeof event.output === 'string') return event.output
  return ''
}

function buildPrompt({ descriptor, input, context, scope }) {
  const skill = SKILL_BY_ACTION[descriptor.id]
  const payload = JSON.stringify({
    schemaVersion: 1,
    toolId: descriptor.id,
    input: input || {},
    knowledgeContext: context || null,
    scope: scope || null,
  })
  return [
    'Use $' + skill + ' to execute the requested Research Vault action.',
    'Treat knowledgeContext as opaque caller context. Do not broaden the approved scope.',
    descriptor.effect === 'read'
      ? 'This action is read-only. Do not modify any Vault or source file.'
      : 'Write only within the explicitly approved scope and report every changed file.',
    'Return a compact JSON-compatible completion summary no larger than 64 KiB.',
    payload,
  ].join(String.fromCharCode(10))
}

export class CodexActionRunner {
  #root
  #command
  #spawn

  constructor({
    root,
    command = process.env.BIORESEARCH_CODEX_EXECUTABLE || (process.platform === 'win32' ? 'codex.cmd' : 'codex'),
    spawnProcess = spawn,
  } = {}) {
    if (!root) throw new Error('CodexActionRunner requires a Vault root.')
    this.#root = root
    this.#command = command
    this.#spawn = spawnProcess
  }

  run({ descriptor, input, context, scope, signal, onProgress = () => {} }) {
    if (!SKILL_BY_ACTION[descriptor.id]) throw new Error('No Research Vault runner is registered for this action.')
    if (signal?.aborted) return Promise.reject(abortError())
    const sandbox = descriptor.effect === 'read' ? 'read-only' : 'workspace-write'
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      sandbox,
      '-C',
      this.#root,
      '-',
    ]
    return new Promise((resolveRun, rejectRun) => {
      const child = this.#spawn(this.#command, args, {
        cwd: this.#root,
        env: process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let buffer = ''
      let finalText = ''
      let stderr = ''
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        callback(value)
      }
      const onAbort = () => {
        child.kill()
        finish(rejectRun, abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.once('error', (error) => finish(rejectRun, error))
      child.stderr.on('data', (chunk) => {
        stderr = boundedText(stderr + chunk.toString(), 8192)
      })
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString()
        const newline = String.fromCharCode(10)
        let index
        while ((index = buffer.indexOf(newline)) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line) continue
          try {
            const event = JSON.parse(line)
            const text = finalTextFromEvent(event)
            if (text) finalText = boundedText(text)
            onProgress({ type: event.type || 'runner.event' })
          } catch {
            onProgress({ type: 'runner.output' })
          }
        }
      })
      child.once('close', (code) => {
        if (settled) return
        if (signal?.aborted) return finish(rejectRun, abortError())
        if (code !== 0) {
          return finish(rejectRun, new Error(boundedText(stderr || 'Action runner exited with code ' + code + '.', 8192)))
        }
        const output = finalText || boundedText(buffer.trim())
        if (Buffer.byteLength(output) > MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES) {
          return finish(rejectRun, Object.assign(new Error('Action output exceeds the 64 KiB limit.'), { code: 'limit_exceeded' }))
        }
        return finish(resolveRun, { summary: output })
      })
      child.stdin.end(buildPrompt({ descriptor, input, context, scope }))
    })
  }
}

export const actionRunnerInternals = Object.freeze({ skillByAction: SKILL_BY_ACTION, buildPrompt })
