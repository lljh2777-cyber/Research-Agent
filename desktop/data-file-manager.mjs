import { open, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { assertSupportedDataBackupText, dataBackupByteLength, MAX_DATA_BACKUP_BYTES, normalizeDataBackupFileName } from '../shared/data-backup-policy.mjs'

function dialogResult(dialog, method, owner, options) {
  return owner ? dialog[method](owner, options) : dialog[method](options)
}

async function readBoundedUtf8(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > MAX_DATA_BACKUP_BYTES) throw new Error('The selected backup must be a JSON file within the 16 MiB limit.')
    const buffer = Buffer.alloc(MAX_DATA_BACKUP_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_DATA_BACKUP_BYTES) throw new Error('The selected backup exceeds the 16 MiB limit.')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export class DesktopDataFileManager {
  constructor({ dialog, read = readBoundedUtf8, write = writeFile } = {}) {
    if (!dialog?.showSaveDialog || !dialog?.showOpenDialog) throw new Error('Desktop data file dialogs are unavailable.')
    this.dialog = dialog
    this.read = read
    this.write = write
  }

  async saveBackup(owner, input = {}) {
    const content = typeof input.content === 'string' ? input.content : ''
    const bytes = dataBackupByteLength(content)
    if (!content || bytes > MAX_DATA_BACKUP_BYTES) throw new Error('Backup content must be valid JSON text within the 16 MiB limit.')
    assertSupportedDataBackupText(content)
    const fileName = normalizeDataBackupFileName(input.fileName)
    const selection = await dialogResult(this.dialog, 'showSaveDialog', owner, {
      title: 'Export BioResearch OS backup',
      defaultPath: fileName,
      filters: [{ name: 'BioResearch OS backup', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (selection.canceled || !selection.filePath) return { cancelled: true }
    await this.write(selection.filePath, content, 'utf8')
    return { cancelled: false, fileName: basename(selection.filePath), bytes }
  }

  async openBackup(owner) {
    const selection = await dialogResult(this.dialog, 'showOpenDialog', owner, {
      title: 'Import BioResearch OS backup',
      filters: [{ name: 'BioResearch OS backup', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (selection.canceled || selection.filePaths?.length !== 1) return { cancelled: true }
    const filePath = selection.filePaths[0]
    const content = await this.read(filePath)
    if (dataBackupByteLength(content) > MAX_DATA_BACKUP_BYTES) throw new Error('The selected backup exceeds the 16 MiB limit.')
    assertSupportedDataBackupText(content)
    return { cancelled: false, fileName: basename(filePath), content }
  }
}
