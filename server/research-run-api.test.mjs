import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { RESEARCH_RUN_EVENT } from '../src/research/runProtocol.js'
import { createResearchRunApiMiddleware } from './research-run-api.mjs'

async function withResearchServer(callback) {
  const middleware = createResearchRunApiMiddleware()
  const server = createServer((request, response) => middleware(request, response, () => {
    response.writeHead(404).end()
  }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  try {
    await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('creates, appends, replays, and streams Research Run events', async () => {
  await withResearchServer(async (origin) => {
    const created = await fetch(`${origin}/api/research/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'run-http', sessionId: 'research-tab' }),
    })
    assert.equal(created.status, 201)

    const appended = await fetch(`${origin}/api/research/runs/run-http/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [
        { type: RESEARCH_RUN_EVENT.RUN_STARTED, clientEventId: 'http-1' },
        { type: RESEARCH_RUN_EVENT.RUN_COMPLETED, iteration: 1, clientEventId: 'http-2' },
      ] }),
    })
    assert.equal(appended.status, 202)
    assert.equal((await appended.json()).lastCursor, 2)

    const replay = await fetch(`${origin}/api/research/runs/run-http/events?after=1`)
    const replayPayload = await replay.json()
    assert.deepEqual(replayPayload.events.map((item) => item.event.type), [RESEARCH_RUN_EVENT.RUN_COMPLETED])

    const stream = await fetch(`${origin}/api/research/runs/run-http/events?after=0&follow=1`, {
      headers: { Accept: 'text/event-stream' },
    })
    const streamText = await stream.text()
    assert.match(streamText, /id: 1/)
    assert.match(streamText, /event: run\.completed/)

    const resumedStream = await fetch(`${origin}/api/research/runs/run-http/events?follow=1`, {
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': '1' },
    })
    const resumedText = await resumedStream.text()
    assert.doesNotMatch(resumedText, /id: 1/)
    assert.match(resumedText, /id: 2/)
    assert.match(resumedText, /event: run\.completed/)
  })
})

test('returns bounded API errors instead of falling through to the app shell', async () => {
  await withResearchServer(async (origin) => {
    const missing = await fetch(`${origin}/api/research/runs/missing`)
    assert.equal(missing.status, 404)
    assert.match((await missing.json()).error, /not found/i)

    const invalid = await fetch(`${origin}/api/research/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '../invalid' }),
    })
    assert.equal(invalid.status, 400)

    const created = await fetch(`${origin}/api/research/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'run-illegal-transition' }),
    })
    assert.equal(created.status, 201)
    const illegalTransition = await fetch(`${origin}/api/research/runs/run-illegal-transition/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [{ type: RESEARCH_RUN_EVENT.RUN_COMPLETED }] }),
    })
    assert.equal(illegalTransition.status, 409)
  })
})

test('routes provider starts, cancellation, and delegated tool results through the executor', async () => {
  const calls = []
  const executor = {
    start: (runId, input) => { calls.push(['start', runId, input]); return { started: true, runId } },
    cancel: (runId) => { calls.push(['cancel', runId]); return { cancelled: true } },
    submitToolResult: (runId, requestId, result) => { calls.push(['tool', runId, requestId, result]); return { accepted: true } },
  }
  const middleware = createResearchRunApiMiddleware({ executor })
  const server = createServer((request, response) => middleware(request, response, () => response.writeHead(404).end()))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  try {
    await fetch(`${origin}/api/research/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'run-routes' }) })
    const started = await fetch(`${origin}/api/research/runs/run-routes/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'provider' }) })
    const tool = await fetch(`${origin}/api/research/runs/run-routes/tool-results`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'request-1', result: { content: '{}' } }) })
    const cancelled = await fetch(`${origin}/api/research/runs/run-routes`, { method: 'DELETE' })

    assert.equal(started.status, 202)
    assert.equal(tool.status, 202)
    assert.equal(cancelled.status, 200)
    assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
      ['start', 'run-routes', { kind: 'provider' }],
      ['tool', 'run-routes', 'request-1'],
      ['cancel', 'run-routes'],
    ])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})


function parseResearchRunSse(text) {
  return String(text).split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    return data ? [JSON.parse(data)] : []
  })
}

async function withKnowledgeReadProvider(callback) {
  const requests = []
  let resolveCancelStarted
  let cancelAborted = false
  const cancelStarted = new Promise((resolve) => { resolveCancelStarted = resolve })
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    requests.push({ url: request.url, authorization: request.headers.authorization, body })
    if (request.url.includes('/failure/')) {
      response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: { message: 'Rejected test credential.' } }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
    if (request.url.includes('/cancel/')) {
      response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }) + '\n\n')
      resolveCancelStarted()
      response.once('close', () => {
        cancelAborted = true
        response.end()
      })
      return
    }
    const text = '\u03b2-catenin \u4fe1\u53f7\u5728\u4e09\u7ec4\u961f\u5217\u4e2d\u4e00\u81f4\u3002'
    response.end([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: text.slice(0, 12) } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { content: text.slice(12) } }], usage: { total_tokens: 21 } }),
      'data: [DONE]',
      '',
    ].join('\n\n'))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  try {
    await callback({
      origin: `http://127.0.0.1:${address.port}`,
      requests,
      waitForCancelStart: () => cancelStarted,
      wasCancelAborted: () => cancelAborted,
    })
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

async function createAndStartKnowledgeRead(origin, { id, endpoint, apiKey = 'rt3-secret' }) {
  const created = await fetch(`${origin}/api/research/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, sessionId: 'knowledge-session', executionOwner: 'loopback' }),
  })
  assert.equal(created.status, 201)
  const started = await fetch(`${origin}/api/research/runs/${id}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'provider',
      providerId: 'deepseek',
      endpoint,
      model: 'deepseek-chat',
      apiKey,
      messages: [
        { role: 'system', content: 'Explain the supplied Knowledge Context as read-only evidence. Never call tools.' },
        { role: 'user', content: 'Explain the selected \u03b2-catenin finding.' },
      ],
      tools: [],
      policy: { requireEvidence: false },
    }),
  })
  assert.equal(started.status, 202)
}

test('executes knowledge.explain-style Provider HTTP through Research Run terminals without write access', async () => {
  await withKnowledgeReadProvider(async (provider) => {
    await withResearchServer(async (runtime) => {
      await createAndStartKnowledgeRead(runtime, { id: 'knowledge-explain-success', endpoint: provider.origin + '/success/v1' })
      const response = await fetch(`${runtime}/api/research/runs/knowledge-explain-success/events?follow=1`, {
        headers: { Accept: 'text/event-stream' },
      })
      const streamText = await response.text()
      const events = parseResearchRunSse(streamText).map((envelope) => envelope.event)
      const terminal = events.find((event) => event.type === RESEARCH_RUN_EVENT.RUN_COMPLETED)

      assert.equal(response.ok, true)
      assert.equal(terminal.result.text, '\u03b2-catenin \u4fe1\u53f7\u5728\u4e09\u7ec4\u961f\u5217\u4e2d\u4e00\u81f4\u3002')
      assert(events.some((event) => event.type === RESEARCH_RUN_EVENT.MODEL_TEXT_DELTA))
      assert.equal(events.some((event) => event.type.includes('tool.execution')), false)
      assert.equal(provider.requests[0].authorization, 'Bearer rt3-secret')
      assert.equal('tools' in provider.requests[0].body, false)
      assert.match(provider.requests[0].body.messages.at(-1).content, /\u03b2-catenin/)
      assert.doesNotMatch(streamText, /rt3-secret|annotation\.upsert|wiki\/annotations/)
    })
  })
})

test('keeps knowledge.explain-style Provider failures and cancellation terminal and credential-safe', async () => {
  await withKnowledgeReadProvider(async (provider) => {
    await withResearchServer(async (runtime) => {
      await createAndStartKnowledgeRead(runtime, { id: 'knowledge-explain-failure', endpoint: provider.origin + '/failure/v1' })
      const failedResponse = await fetch(`${runtime}/api/research/runs/knowledge-explain-failure/events?follow=1`, {
        headers: { Accept: 'text/event-stream' },
      })
      const failedText = await failedResponse.text()
      const failedEvents = parseResearchRunSse(failedText).map((envelope) => envelope.event)
      assert.equal(failedEvents.at(-1).type, RESEARCH_RUN_EVENT.RUN_FAILED)
      assert.equal(failedEvents.some((event) => event.type === RESEARCH_RUN_EVENT.RUN_COMPLETED), false)
      assert.doesNotMatch(failedText, /rt3-secret/)

      await createAndStartKnowledgeRead(runtime, { id: 'knowledge-explain-cancel', endpoint: provider.origin + '/cancel/v1' })
      await provider.waitForCancelStart()
      const following = await fetch(`${runtime}/api/research/runs/knowledge-explain-cancel/events?follow=1`, {
        headers: { Accept: 'text/event-stream' },
      })
      const cancelled = await fetch(`${runtime}/api/research/runs/knowledge-explain-cancel`, { method: 'DELETE' })
      assert.equal(cancelled.ok, true)
      const cancelledText = await following.text()
      const cancelledEvents = parseResearchRunSse(cancelledText).map((envelope) => envelope.event)
      assert.equal(cancelledEvents.at(-1).type, RESEARCH_RUN_EVENT.RUN_CANCELLED)
      assert.equal(cancelledEvents.some((event) => event.type === RESEARCH_RUN_EVENT.RUN_COMPLETED), false)
      assert.doesNotMatch(cancelledText, /rt3-secret/)
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(provider.wasCancelAborted(), true)
    })
  })
})
