import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

export function snapshotSelectedFiles(fileList) {
  return Array.from(fileList || [])
}

export async function processVaultFallbackSelection({ fileList, onSelect, onCancel, onError, reset }) {
  const files = snapshotSelectedFiles(fileList)
  try {
    if (!files.length) {
      onCancel?.()
      return { status: 'cancelled' }
    }
    return await onSelect(files)
  } catch (error) {
    onError?.(error)
    return { status: 'failed', error }
  } finally {
    reset?.()
  }
}

const VaultFallbackPicker = forwardRef(function VaultFallbackPicker({ enabled, onSelect, onCancel, onError }, forwardedRef) {
  const inputRef = useRef(null)

  useImperativeHandle(forwardedRef, () => ({
    open: () => inputRef.current?.click(),
  }), [])

  useEffect(() => {
    const input = inputRef.current
    if (!enabled || !input) return undefined
    const handleCancel = () => {
      onCancel?.()
      input.value = ''
    }
    input.addEventListener('cancel', handleCancel)
    return () => input.removeEventListener('cancel', handleCancel)
  }, [enabled, onCancel])

  if (!enabled) return null
  return <input
    ref={inputRef}
    className="visually-hidden"
    type="file"
    webkitdirectory="true"
    directory="true"
    multiple
    aria-label="Select Obsidian Vault folder"
    onChange={(event) => {
      const input = event.currentTarget
      void processVaultFallbackSelection({
        fileList: input.files,
        onSelect,
        onCancel,
        onError,
        reset: () => { input.value = '' },
      })
    }}
  />
})

export default VaultFallbackPicker
