import assert from 'node:assert/strict'
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { dataBackupByteLength, MAX_DATA_BACKUP_BYTES } from '../shared/data-backup-policy.mjs'
import { DesktopDataFileManager } from './data-file-manager.mjs'

test('saves and opens a bounded backup through user-owned native dialogs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bioresearch-data-files-'))
  const backupPath = join(directory, 'portable-backup.json')
  const observed = {}
  const manager = new DesktopDataFileManager({
    dialog: {
      showSaveDialog: async (options) => {
        observed.saveOptions = options
        return { canceled: false, filePath: backupPath }
      },
      showOpenDialog: async (options) => {
        observed.openOptions = options
        return { canceled: false, filePaths: [backupPath] }
      },
    },
  })

  try {
    const content = '{"kind":"bioresearch-os-local-backup","schemaVersion":1}'
    const saved = await manager.saveBackup(null, { fileName: 'portable-backup.json', content })
    assert.deepEqual(saved, { cancelled: false, fileName: 'portable-backup.json', bytes: dataBackupByteLength(content) })
    assert.equal(await readFile(backupPath, 'utf8'), content)
    assert.deepEqual(observed.saveOptions.filters, [{ name: 'BioResearch OS backup', extensions: ['json'] }])

    const opened = await manager.openBackup(null)
    assert.deepEqual(opened, { cancelled: false, fileName: 'portable-backup.json', content })
    assert.deepEqual(observed.openOptions.properties, ['openFile'])
    assert.equal(Object.hasOwn(opened, 'filePath'), false)
  } finally {
    await unlink(backupPath).catch(() => {})
    await rmdir(directory).catch(() => {})
  }
})

test('rejects unsafe names and oversized backup files at the desktop boundary', async () => {
  const manager = new DesktopDataFileManager({
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true }),
    },
  })
  const supported = '{"kind":"bioresearch-os-local-backup","schemaVersion":1}'
  await assert.rejects(() => manager.saveBackup(null, { fileName: '..\\private.json', content: supported }), /Invalid backup file name/)
  await assert.rejects(() => manager.saveBackup(null, { fileName: 'backup.json', content: 'x'.repeat(MAX_DATA_BACKUP_BYTES + 1) }), /16 MiB limit/)
  await assert.rejects(() => manager.saveBackup(null, { fileName: 'backup.json', content: '{"kind":"other"}' }), /not a supported BioResearch OS backup/)
})

test('returns cancellation without reading or writing a file', async () => {
  let touched = false
  const manager = new DesktopDataFileManager({
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true }),
    },
    read: async () => { touched = true },
    write: async () => { touched = true },
  })
  assert.deepEqual(await manager.saveBackup(null, { fileName: 'backup.json', content: '{"kind":"bioresearch-os-local-backup","schemaVersion":1}' }), { cancelled: true })
  assert.deepEqual(await manager.openBackup(null), { cancelled: true })
  assert.equal(touched, false)
})
