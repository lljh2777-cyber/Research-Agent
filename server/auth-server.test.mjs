import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { buildResearchPrompt, isTrustedLoopbackRequest, normalizeCodexAccount, normalizeCodexModels } from './auth-server.mjs'
import { CodexAppServer } from './codex-app-server.mjs'

test('normalizeCodexModels keeps picker-visible account models in backend order', () => {
  const catalog = normalizeCodexModels({
    models: [
      {
        slug: 'gpt-5.6-sol',
        display_name: 'GPT-5.6-Sol',
        description: 'Frontier model',
        visibility: 'list',
        priority: 1,
        default_reasoning_level: 'high',
        supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }],
      },
      { slug: 'codex-auto-review', display_name: 'Auto review', visibility: 'hide', priority: 2 },
      { slug: 'GPT-5.6-TERRA', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 3 },
      { slug: '../invalid', display_name: 'Invalid', visibility: 'list', priority: 4 },
    ],
  })

  assert.equal(catalog.defaultModelId, 'gpt-5.6-sol')
  assert.deepEqual(catalog.models.map((model) => model.id), ['gpt-5.6-sol', 'gpt-5.6-terra'])
  assert.deepEqual(catalog.models[0].reasoningLevels, ['medium', 'high'])
})

test('normalizeCodexModels accepts the official app-server model/list shape', () => {
  const catalog = normalizeCodexModels({
    data: [
      { id: 'gpt-5.6', displayName: 'GPT-5.6', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
      { id: 'internal-model', displayName: 'Internal', hidden: true },
    ],
  })
  assert.equal(catalog.defaultModelId, 'gpt-5.6')
  assert.deepEqual(catalog.models.map((model) => model.id), ['gpt-5.6'])
  assert.deepEqual(catalog.models[0].reasoningLevels, ['medium', 'high'])
})

test('normalizeCodexAccount exposes metadata but never credentials', () => {
  const status = normalizeCodexAccount({ account: { type: 'chatgpt', email: 'researcher@example.com', planType: 'plus', accessToken: 'secret' } })
  assert.deepEqual(status, {
    provider: 'chatgpt',
    connected: true,
    type: 'oauth',
    email: 'researcher@example.com',
    planType: 'plus',
    requiresOpenaiAuth: true,
  })
  assert.equal('accessToken' in status, false)
})

test('research prompt confines synthesis to supplied conversation evidence', () => {
  const prompt = buildResearchPrompt([{ role: 'user', content: 'Evidence packet' }])
  assert.match(prompt, /Do not use tools, browse, or read local files/)
  assert.match(prompt, /USER:\nEvidence packet/)
})

test('loopback service rejects cross-site and DNS-rebinding requests', () => {
  assert.equal(isTrustedLoopbackRequest({ headers: { host: '127.0.0.1:4318', origin: 'http://localhost:5173' } }), true)
  assert.equal(isTrustedLoopbackRequest({ headers: { host: '127.0.0.1:4318', origin: 'https://attacker.example' } }), false)
  assert.equal(isTrustedLoopbackRequest({ headers: { host: 'attacker.example:4318' } }), false)
})

test('Codex app-server bridge initializes with OS keyring storage', async () => {
  let spawnArgs
  let initialized = false
  const child = new EventEmitter()
  child.killed = false
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', (line) => {
    const request = JSON.parse(line.trim())
    if (request.method === 'initialize') child.stdout.write(`${JSON.stringify({ id: request.id, result: { codexHome: 'test' } })}\n`)
    if (request.method === 'initialized') initialized = true
    if (request.method === 'account/read') {
      const response = initialized
        ? { id: request.id, result: { account: null, requiresOpenaiAuth: true } }
        : { id: request.id, error: { code: -32000, message: 'Not initialized' } }
      child.stdout.write(`${JSON.stringify(response)}\n`)
    }
  })
  const bridge = new CodexAppServer({
    command: 'codex-test',
    spawnProcess: (command, args) => {
      assert.equal(command, 'codex-test')
      spawnArgs = args
      return child
    },
  })
  const [account, concurrentAccount] = await Promise.all([
    bridge.request('account/read', { refreshToken: false }),
    bridge.request('account/read', { refreshToken: false }),
  ])
  assert.equal(account.requiresOpenaiAuth, true)
  assert.equal(concurrentAccount.requiresOpenaiAuth, true)
  assert.deepEqual(spawnArgs, ['app-server', '--stdio', '-c', 'cli_auth_credentials_store="keyring"'])
  bridge.close()
})
