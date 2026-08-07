import assert from 'node:assert/strict'
import test from 'node:test'

import { coerceCodexRequestBody, extractResponseText, parseSseBlock } from './auth-server.mjs'

test('coerceCodexRequestBody creates the Codex Responses shape', () => {
  const body = coerceCodexRequestBody({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: 'Use the linked evidence.' },
      { role: 'user', content: 'Summarize the result.' },
    ],
  })

  assert.equal(body.model, 'gpt-5.4')
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.deepEqual(body.include, ['reasoning.encrypted_content'])
  assert.match(body.instructions, /Use the linked evidence/)
  assert.deepEqual(body.input, [{ role: 'user', content: 'Summarize the result.' }])
})

test('parseSseBlock reads a Responses API delta', () => {
  const event = parseSseBlock('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}')
  assert.deepEqual(event, { type: 'response.output_text.delta', delta: 'hello' })
  assert.equal(parseSseBlock('data: [DONE]'), null)
})

test('extractResponseText joins output message parts', () => {
  const text = extractResponseText({
    output: [{ content: [{ type: 'output_text', text: 'first' }, { type: 'output_text', text: 'second' }] }],
  })
  assert.equal(text, 'first\nsecond')
})
