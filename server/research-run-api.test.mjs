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
