import assert from 'node:assert/strict'
import test from 'node:test'

import { createToolRegistry, TOOL_EFFECTS, toolPermissionDecision } from './toolRegistry.js'

const definition = { name: 'example_tool', description: 'Example', parameters: { type: 'object' } }

test('classifies read, write, and destructive tool effects conservatively', () => {
  assert.equal(toolPermissionDecision(TOOL_EFFECTS.READ, { read: 'allow' }), 'allow')
  assert.equal(toolPermissionDecision(TOOL_EFFECTS.WRITE, { write: 'allow' }), 'ask')
  assert.equal(toolPermissionDecision(TOOL_EFFECTS.DESTRUCTIVE, { destructive: 'allow' }), 'deny')
})

test('advertises only auto-approved tools and blocks execution otherwise', async () => {
  const readRegistry = createToolRegistry([{ definition, source: 'test', effect: TOOL_EFFECTS.READ, execute: () => ({ id: '1', name: definition.name, content: '{}' }) }], { read: 'allow' })
  assert.equal(readRegistry.definitions.length, 1)
  assert.equal((await readRegistry.execute({ id: '1', name: definition.name })).isError, undefined)

  const writeRegistry = createToolRegistry([{ definition, source: 'test', effect: TOOL_EFFECTS.WRITE, execute: () => ({}) }], { write: 'ask' })
  assert.equal(writeRegistry.definitions.length, 1)
  assert.match((await writeRegistry.execute({ id: '2', name: definition.name })).summary, /requires user confirmation/)

  let executed = false
  const approvedRegistry = createToolRegistry([{ definition, source: 'test', effect: TOOL_EFFECTS.WRITE, execute: (_call, options) => { executed = options.approved; return {} } }], { write: 'ask' }, { requestApproval: async () => true })
  await approvedRegistry.execute({ id: '3', name: definition.name })
  assert.equal(executed, true)
})
