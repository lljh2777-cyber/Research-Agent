import { spawn, spawnSync } from 'node:child_process'

import {
  MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES,
  RUNTIME_ARCHIVE_PLAN_MAX_BYTES,
} from '../shared/runtime-action-contracts.mjs'

const SKILL_BY_ACTION = Object.freeze({
  'knowledge.lint': 'research-vault-lint',
  'knowledge.paper.ingest': 'research-vault-ingest',
  'knowledge.xray': 'research-vault-xray',
  'knowledge.code.analyze': 'research-vault-code',
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
    if (descriptor.id === 'knowledge.synthesis.write') {
      throw Object.assign(new Error('Formal archive requires the Runtime realization service.'), {
        code: 'runtime_unavailable',
      })
    }
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

function archivePlanPrompt({ request, sourceRecord }) {
  return [
    'Use $research-vault-synthesis in planning-only mode.',
    'The filesystem is read-only. Do not create, modify, rename, or delete any file.',
    'Treat the source Annotation Markdown as opaque reviewed source material; do not rewrite the source record.',
    'Return only strict JSON with exact shape {"targets":[{"path":"<requested path>","content":"<complete Markdown>"}]}.',
    'Return every requested target exactly once and in the requested order. Do not add fields or paths.',
    JSON.stringify({
      schemaVersion: 1,
      operation: request.input.operation,
      sourceAnnotation: request.input.sourceAnnotation,
      requestedTargets: request.input.targets,
      knowledgeContext: request.context,
      sourceMarkdown: sourceRecord.content,
    }),
  ].join(String.fromCharCode(10))
}

export class CodexArchivePlanner {
  #root
  #command
  #spawn
  #executable

  constructor({
    root,
    command = process.env.BIORESEARCH_CODEX_EXECUTABLE || (process.platform === 'win32' ? 'codex.cmd' : 'codex'),
    spawnProcess = spawn,
    probeExecutable = (value) => {
      const result = process.platform === 'win32'
        ? spawnSync('where.exe', [value], { windowsHide: true, stdio: 'ignore', timeout: 5_000 })
        : spawnSync(value, ['--version'], { stdio: 'ignore', timeout: 5_000 })
      return !result.error && result.status === 0
    },
  } = {}) {
    if (!root) throw new Error('CodexArchivePlanner requires a Vault root.')
    this.#root = root
    this.#command = command
    this.#spawn = spawnProcess
    this.#executable = probeExecutable(command) === true
  }

  capabilityEvidence() {
    return { executable: this.#executable, sandbox: 'read-only', output: 'strict-json' }
  }

  plan({ request, sourceRecord, signal, onProgress = () => {} }) {
    if (!this.#executable) {
      return Promise.reject(Object.assign(new Error('Archive planner executable is unavailable.'), {
        code: 'runtime_unavailable',
      }))
    }
    if (signal?.aborted) return Promise.reject(abortError())
    const args = [
      'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', this.#root, '-',
    ]
    return new Promise((resolvePlan, rejectPlan) => {
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
        finish(rejectPlan, abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.once('error', (error) => finish(rejectPlan, error))
      child.stderr.on('data', (chunk) => {
        stderr = boundedText(stderr + chunk.toString(), 8192)
      })
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString()
        if (Buffer.byteLength(buffer) > RUNTIME_ARCHIVE_PLAN_MAX_BYTES) {
          child.kill()
          return finish(rejectPlan, Object.assign(new Error('Archive plan exceeds the 4,194,304-byte limit.'), { code: 'limit_exceeded' }))
        }
        const newline = String.fromCharCode(10)
        let index
        while ((index = buffer.indexOf(newline)) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line) continue
          try {
            const event = JSON.parse(line)
            const text = finalTextFromEvent(event)
            if (text) finalText = boundedText(text, RUNTIME_ARCHIVE_PLAN_MAX_BYTES)
            onProgress({ type: event.type || 'archive.planner.event' })
          } catch {
            onProgress({ type: 'archive.planner.output' })
          }
        }
      })
      child.once('close', (code) => {
        if (settled) return
        if (signal?.aborted) return finish(rejectPlan, abortError())
        if (code !== 0) {
          return finish(rejectPlan, new Error(boundedText(stderr || `Archive planner exited with code ${code}.`, 8192)))
        }
        const output = finalText || buffer.trim()
        try {
          return finish(resolvePlan, JSON.parse(output))
        } catch {
          return finish(rejectPlan, Object.assign(new Error('Archive planner did not return strict JSON.'), { code: 'invalid_archive_plan' }))
        }
      })
      child.stdin.end(archivePlanPrompt({ request, sourceRecord }))
    })
  }
}

export const actionRunnerInternals = Object.freeze({ skillByAction: SKILL_BY_ACTION, buildPrompt, archivePlanPrompt })
