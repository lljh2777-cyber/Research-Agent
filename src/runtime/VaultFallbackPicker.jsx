import { forwardRef, useImperativeHandle, useRef } from 'react'

const VaultFallbackPicker = forwardRef(function VaultFallbackPicker({ enabled, onSelect }, forwardedRef) {
  const inputRef = useRef(null)

  useImperativeHandle(forwardedRef, () => ({
    open: () => inputRef.current?.click(),
  }), [])

  if (!enabled) return null
  return <input
    ref={inputRef}
    className="visually-hidden"
    type="file"
    webkitdirectory="true"
    directory="true"
    multiple
    aria-label="Select Obsidian Vault folder"
    onChange={async (event) => {
      try {
        await onSelect(event.target.files || [])
      } finally {
        event.target.value = ''
      }
    }}
  />
})

export default VaultFallbackPicker
