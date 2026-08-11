import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { RUNTIME_ANNOTATION_REQUEST_MAX_BYTES } from '../shared/runtime-action-contracts.mjs'
import { createAnnotationApiMiddleware } from './annotation-api.mjs'

async function apiFixture() {
  const calls = []
  const middleware = createAnnotationApiMiddleware({
    store: {
      async write(value) {
        calls.push(value)
        return { ok: true, revision: 'revision-1' }
      },
      async list() { return { annotations: [] } },
      async read() { return { content: '' } },
    },
  })
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}/api/runtime/annotations`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function jsonBodyAt(bytes) {
  const prefix = '{"padding":"'
  const suffix = '"}'
  const body = prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix
  assert.equal(Buffer.byteLength(body), bytes)
  return body
}

test('Annotation HTTP API uses exact raw JSON byte parity at 131,072 bytes', async () => {
  const runtime = await apiFixture()
  try {
    const exact = await fetch(runtime.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBodyAt(RUNTIME_ANNOTATION_REQUEST_MAX_BYTES),
    })
    assert.equal(exact.status, 200)
    assert.equal(runtime.calls.length, 1)

    const over = await fetch(runtime.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBodyAt(RUNTIME_ANNOTATION_REQUEST_MAX_BYTES + 1),
    })
    assert.equal(over.status, 413)
    assert.deepEqual(await over.json(), {
      ok: false,
      code: 'limit_exceeded',
      error: 'Annotation request exceeds the 131,072-byte limit.',
    })
    assert.equal(runtime.calls.length, 1)
  } finally {
    await runtime.close()
  }
})
