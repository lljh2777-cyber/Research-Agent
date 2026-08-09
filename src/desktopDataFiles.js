function dataFilesBridge() {
  return globalThis.window?.researchDesktop?.dataFiles || null
}

export function hasDesktopDataFilesBridge() {
  const bridge = dataFilesBridge()
  return Boolean(bridge?.saveBackup && bridge?.openBackup)
}

export async function saveDesktopDataBackup({ fileName, content }) {
  const bridge = dataFilesBridge()
  if (!bridge?.saveBackup) throw new Error('Desktop backup export is unavailable.')
  const result = await bridge.saveBackup({ fileName, content })
  if (result?.cancelled) return { cancelled: true }
  return {
    cancelled: false,
    fileName: typeof result?.fileName === 'string' ? result.fileName : fileName,
    bytes: Number.isFinite(result?.bytes) ? result.bytes : new TextEncoder().encode(content).length,
  }
}

export async function openDesktopDataBackup() {
  const bridge = dataFilesBridge()
  if (!bridge?.openBackup) throw new Error('Desktop backup import is unavailable.')
  const result = await bridge.openBackup()
  if (result?.cancelled) return { cancelled: true }
  if (typeof result?.content !== 'string') throw new Error('The desktop backup service returned invalid content.')
  return {
    cancelled: false,
    fileName: typeof result.fileName === 'string' ? result.fileName : 'BioResearch OS backup.json',
    content: result.content,
  }
}
