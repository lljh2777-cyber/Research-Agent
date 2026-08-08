import assert from 'node:assert/strict'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BUILD_MODES, createRuntimeManifest, RUNTIME_TARGETS } from '../shared/runtime-capabilities.mjs'
import { createDesktopAppServer } from './app-server.mjs'

test('serves the desktop bundle, resolves credentials server-side, and rejects cross-origin requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bioresearch-desktop-'))
  const indexPath = join(directory, 'index.html')
  await writeFile(indexPath, '<!doctype html><title>Desktop fixture</title>', 'utf8')
  const manifest = createRuntimeManifest({ buildMode: BUILD_MODES.TEST, target: RUNTIME_TARGETS.DESKTOP })
  let upstreamAuthorization = ''
  const host = createDesktopAppServer({
    rootDir: directory,
    runtimeManifest: manifest,
    credentialResolver: async (providerId) => providerId === 'deepseek' ? 'desktop-secret' : '',
    fetchImpl: async (_url, options) => {
      upstreamAuthorization = options.headers.Authorization
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  try {
    const origin = await host.listen()
    const page = await fetch(`${origin}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Desktop fixture/)
    assert.match(page.headers.get('content-security-policy'), /object-src 'none'/)

    const runtime = await fetch(`${origin}/api/runtime`)
    assert.equal(runtime.status, 200)
    assert.equal((await runtime.json()).target, RUNTIME_TARGETS.DESKTOP)

    const models = await fetch(`${origin}/api/providers/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ providerId: 'deepseek', endpoint: 'https://api.deepseek.com', apiKey: '' }),
    })
    assert.equal(models.status, 200)
    assert.equal(upstreamAuthorization, 'Bearer desktop-secret')

    const rejected = await fetch(`${origin}/api/runtime`, { headers: { Origin: 'https://attacker.example' } })
    assert.equal(rejected.status, 403)
  } finally {
    await host.close()
    await unlink(indexPath).catch(() => {})
    await rmdir(directory).catch(() => {})
  }
})
