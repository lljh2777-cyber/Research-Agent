import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

export const VAULT_PICKER_ERROR_CODE = 'selection-not-delivered'

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

export function createVaultFallbackSelectionController({ input, callbacks, schedule, cancelSchedule, startRecovery = () => {}, stopRecovery = () => {} }) {
  let state = 'idle'
  let recoveryTimer = null
  let disposed = false

  const clearRecovery = () => {
    if (recoveryTimer !== null) cancelSchedule(recoveryTimer)
    recoveryTimer = null
  }
  const resetInput = () => { input.value = '' }
  const settlePending = () => {
    if (state !== 'pending' || disposed) return false
    state = 'settled'
    clearRecovery()
    stopRecovery()
    return true
  }
  const processInput = () => {
    if (disposed) return undefined
    if (state === 'settled') {
      resetInput()
      return undefined
    }
    if (state === 'pending' && !settlePending()) return undefined
    const { onSelect, onCancel, onError } = callbacks()
    return processVaultFallbackSelection({ fileList: input.files, onSelect, onCancel, onError, reset: resetInput })
  }

  return {
    open() {
      if (disposed) return
      clearRecovery()
      state = 'pending'
      startRecovery()
      input.click()
    },
    change: processInput,
    cancel() {
      if (disposed) return
      if (state === 'settled') {
        resetInput()
        return
      }
      if (state === 'pending') settlePending()
      callbacks().onCancel?.()
      resetInput()
    },
    resume() {
      if (disposed || state !== 'pending' || recoveryTimer !== null) return
      recoveryTimer = schedule(() => {
        recoveryTimer = null
        if (disposed || state !== 'pending') return
        if (input.files?.length) {
          processInput()
          return
        }
        if (!settlePending()) return
        resetInput()
        const error = new Error('The browser closed the folder picker without delivering the selected files.')
        error.name = 'VaultPickerUnavailableError'
        error.code = VAULT_PICKER_ERROR_CODE
        error.outcome = 'picker-unavailable'
        callbacks().onError?.(error)
      }, 250)
    },
    dispose() {
      disposed = true
      state = 'settled'
      clearRecovery()
      stopRecovery()
    },
    getState: () => state,
  }
}

const VaultFallbackPicker = forwardRef(function VaultFallbackPicker({ enabled, onSelect, onCancel, onError }, forwardedRef) {
  const inputRef = useRef(null)
  const controllerRef = useRef(null)
  const callbacksRef = useRef({ onSelect, onCancel, onError })
  callbacksRef.current = { onSelect, onCancel, onError }

  useImperativeHandle(forwardedRef, () => ({
    open: () => controllerRef.current?.open(),
  }), [])

  useEffect(() => {
    const input = inputRef.current
    if (!enabled || !input) return undefined
    let controller
    let recoveryListening = false
    const handleCancel = () => controller.cancel()
    const recoverMissingPickerEvent = () => controller.resume()
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') controller.resume()
    }
    const startRecovery = () => {
      if (recoveryListening) return
      recoveryListening = true
      window.addEventListener('focus', recoverMissingPickerEvent)
      document.addEventListener('visibilitychange', handleVisibility)
    }
    const stopRecovery = () => {
      if (!recoveryListening) return
      recoveryListening = false
      window.removeEventListener('focus', recoverMissingPickerEvent)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
    controller = createVaultFallbackSelectionController({
      input,
      callbacks: () => callbacksRef.current,
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancelSchedule: (timer) => window.clearTimeout(timer),
      startRecovery,
      stopRecovery,
    })
    controllerRef.current = controller
    input.addEventListener('cancel', handleCancel)
    return () => {
      input.removeEventListener('cancel', handleCancel)
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [enabled])

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
      void controllerRef.current?.change(event.currentTarget)
    }}
  />
})

export default VaultFallbackPicker
