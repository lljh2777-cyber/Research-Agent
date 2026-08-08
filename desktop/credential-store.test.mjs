import assert from 'node:assert/strict'
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EncryptedCredentialStore, normalizeCredentialOrigins, normalizeProviderCredentialId } from './credential-store.mjs'

test('stores only encrypted provider credentials and supports removal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bioresearch-credentials-'))
  const filePath = join(directory, 'credentials.json')
  const store = new EncryptedCredentialStore({
    filePath,
    encrypt: async (value) => Buffer.from(`sealed:${value}`).toString('base64'),
    decrypt: async (value) => Buffer.from(value, 'base64').toString('utf8').replace(/^sealed:/, ''),
  })

  try {
    await store.set('deepseek', 'secret-test-key', ['https://api.deepseek.com/v1'])
    assert.equal(await store.get('deepseek', 'https://api.deepseek.com/chat/completions'), 'secret-test-key')
    assert.equal(await store.get('deepseek', 'https://attacker.example/collect'), '')
    assert.equal(await store.has('deepseek'), true)
    assert.doesNotMatch(await readFile(filePath, 'utf8'), /secret-test-key/)

    await store.delete('deepseek')
    assert.equal(await store.get('deepseek', 'https://api.deepseek.com'), '')
  } finally {
    await unlink(filePath).catch(() => {})
    await rmdir(directory).catch(() => {})
  }
})

test('normalizes credential scopes and rejects insecure remote endpoints', () => {
  assert.deepEqual(normalizeCredentialOrigins(['https://api.deepseek.com/v1', 'https://api.deepseek.com/models']), ['https://api.deepseek.com'])
  assert.deepEqual(normalizeCredentialOrigins(['http://127.0.0.1:1234/v1']), ['http://127.0.0.1:1234'])
  assert.throws(() => normalizeCredentialOrigins(['http://provider.example/v1']), /HTTPS or a loopback/)
})

test('rejects credential identifiers outside the narrow provider namespace', () => {
  assert.equal(normalizeProviderCredentialId('Bailian'), 'bailian')
  assert.throws(() => normalizeProviderCredentialId('../tokens'), /Invalid provider credential identifier/)
  assert.throws(() => normalizeProviderCredentialId(''), /Invalid provider credential identifier/)
})

test('does not silently replace a corrupt credential envelope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bioresearch-credentials-corrupt-'))
  const filePath = join(directory, 'credentials.json')
  await writeFile(filePath, '{not-json', 'utf8')
  const store = new EncryptedCredentialStore({ filePath, encrypt: async (value) => value, decrypt: async (value) => value })
  try {
    await assert.rejects(store.get('deepseek', 'https://api.deepseek.com'), SyntaxError)
  } finally {
    await unlink(filePath).catch(() => {})
    await rmdir(directory).catch(() => {})
  }
})
