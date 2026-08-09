import { getRuntimeAdapter } from './runtime/adapter.js'

export function hasDesktopDataFilesBridge() {
  return getRuntimeAdapter().dataFiles.native
}

export async function saveDesktopDataBackup({ fileName, content }) {
  const adapter = getRuntimeAdapter().dataFiles
  if (!adapter.native) throw new Error('Desktop backup export is unavailable.')
  const result = await adapter.saveBackup({ fileName, content })
  if (result?.cancelled) return { cancelled: true }
  return {
    cancelled: false,
    fileName: typeof result?.fileName === 'string' ? result.fileName : fileName,
    bytes: Number.isFinite(result?.bytes) ? result.bytes : new TextEncoder().encode(content).length,
  }
}

export async function openDesktopDataBackup() {
  const adapter = getRuntimeAdapter().dataFiles
  if (!adapter.native) throw new Error('Desktop backup import is unavailable.')
  const result = await adapter.openBackup()
  if (result?.cancelled) return { cancelled: true }
  if (typeof result?.content !== 'string') throw new Error('The desktop backup service returned invalid content.')
  return {
    cancelled: false,
    fileName: typeof result.fileName === 'string' ? result.fileName : 'BioResearch OS backup.json',
    content: result.content,
  }
}
