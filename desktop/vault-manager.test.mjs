import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DesktopVaultManager } from './vault-manager.mjs'

async function removeFixture({ ignoredFile, ignoredDirectory, noteFile, vaultDirectory, outsideFile, outsideDirectory, linkPath }) {
  if (linkPath) await unlink(linkPath).catch(() => {})
  await unlink(ignoredFile).catch(() => {})
  await rmdir(ignoredDirectory).catch(() => {})
  await unlink(noteFile).catch(() => {})
  await rmdir(vaultDirectory).catch(() => {})
  await unlink(outsideFile).catch(() => {})
  await rmdir(outsideDirectory).catch(() => {})
}

test('grants an owner-scoped opaque capability and scans bounded Markdown content', async () => {
  const vaultDirectory = await mkdtemp(join(tmpdir(), 'bioresearch-vault-'))
  const outsideDirectory = await mkdtemp(join(tmpdir(), 'bioresearch-outside-'))
  const noteFile = join(vaultDirectory, 'note.md')
  const ignoredDirectory = join(vaultDirectory, '.obsidian')
  const ignoredFile = join(ignoredDirectory, 'private.md')
  const outsideFile = join(outsideDirectory, 'outside.md')
  const linkPath = join(vaultDirectory, 'outside-link.md')
  const manager = new DesktopVaultManager()
  let linkCreated = false

  try {
    await mkdir(ignoredDirectory)
    await writeFile(noteFile, '# Safe note\n[[Related]]', 'utf8')
    await writeFile(ignoredFile, '# Plugin data', 'utf8')
    await writeFile(outsideFile, '# Outside', 'utf8')
    try {
      await symlink(outsideFile, linkPath, 'file')
      linkCreated = true
    } catch {}

    const connected = await manager.connect(7, vaultDirectory)
    assert.match(connected.vaultId, /^[0-9a-f-]{36}$/)
    assert.equal(connected.vaultName, vaultDirectory.split(/[\\/]/).pop())
    assert.deepEqual(connected.files, [{ path: 'note.md', content: '# Safe note\n[[Related]]' }])
    assert.equal(JSON.stringify(connected).includes(vaultDirectory), false)

    const unchanged = await manager.sync(7, connected.vaultId, connected.revision)
    assert.equal(unchanged.unchanged, true)
    await assert.rejects(() => manager.sync(8, connected.vaultId), /Select the folder again/)
    manager.disconnect(7, connected.vaultId)
    await assert.rejects(() => manager.sync(7, connected.vaultId), /Select the folder again/)
  } finally {
    manager.close()
    await removeFixture({ ignoredFile, ignoredDirectory, noteFile, vaultDirectory, outsideFile, outsideDirectory, linkPath: linkCreated ? linkPath : '' })
  }
})
