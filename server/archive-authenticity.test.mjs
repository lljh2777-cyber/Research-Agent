import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ArchiveAuthenticityStore } from './archive-authenticity.mjs'

async function cleanup(root, stateRoot) {
  await unlink(join(stateRoot, 'keys', 'archive-realization-hmac-v1.key')).catch(() => {})
  await rmdir(join(stateRoot, 'keys')).catch(() => {})
  await rmdir(stateRoot).catch(() => {})
  await rmdir(root).catch(() => {})
}

test('Runtime-private archive key creation is exclusive, stable, and never exposed by the store surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bioresearch-auth-vault-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'bioresearch-auth-state-'))
  try {
    const first = new ArchiveAuthenticityStore({ root, stateRoot })
    const second = new ArchiveAuthenticityStore({ root, stateRoot })
    assert.equal(first.keyId, second.keyId)
    assert.deepEqual(Object.keys(first), [])
    const record = { keyId: first.keyId, generation: 0, previousMac: null, mac: '' }
    record.mac = first.mac(record)
    assert.equal(first.verify(record), true)
    assert.equal(second.verify(record), true)
    assert.equal(JSON.stringify(record).includes(first.keyId), true)
    assert.equal(JSON.stringify(record).includes('archive-realization-hmac-v1.key'), false)
  } finally {
    await cleanup(root, stateRoot)
  }
})

test('Runtime-private authenticity state cannot be placed inside the Vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bioresearch-auth-containment-'))
  const stateRoot = join(root, '.runtime-state')
  await mkdir(stateRoot)
  try {
    assert.throws(() => new ArchiveAuthenticityStore({ root, stateRoot }), /outside the user-controlled Vault/)
  } finally {
    await rmdir(stateRoot).catch(() => {})
    await rmdir(root).catch(() => {})
  }
})
