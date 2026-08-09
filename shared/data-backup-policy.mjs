export const DATA_BACKUP_KIND = 'bioresearch-os-local-backup'
export const DATA_BACKUP_SCHEMA_VERSION = 1
export const MAX_DATA_BACKUP_BYTES = 16 * 1024 * 1024

export function dataBackupByteLength(value) {
  return new TextEncoder().encode(String(value || '')).length
}

export function normalizeDataBackupFileName(value) {
  const fileName = String(value || '').trim()
  if (!fileName || fileName.length > 160 || /[\\/\0-\x1f]/.test(fileName)) {
    throw new Error('Invalid backup file name.')
  }
  return fileName.toLowerCase().endsWith('.json') ? fileName : `${fileName}.json`
}

export function assertSupportedDataBackupText(value) {
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Backup content must be valid JSON.')
  }
  if (parsed?.kind !== DATA_BACKUP_KIND || parsed?.schemaVersion !== DATA_BACKUP_SCHEMA_VERSION) {
    throw new Error('This is not a supported BioResearch OS backup.')
  }
  return parsed
}
