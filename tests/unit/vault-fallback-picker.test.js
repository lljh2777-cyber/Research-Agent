import { describe, expect, it, vi } from 'vitest'

import {
  createVaultFallbackSelectionController,
  processVaultFallbackSelection,
  snapshotSelectedFiles,
  VAULT_PICKER_ERROR_CODE,
} from '../../src/runtime/VaultFallbackPicker.jsx'

describe('browser Vault fallback selection', () => {
  it('snapshots the live FileList before async processing and resets only after it settles', async () => {
    const readme = { name: 'README.md' }
    const liveFiles = [readme]
    let finish
    const processing = processVaultFallbackSelection({
      fileList: liveFiles,
      onSelect: async (files) => {
        await new Promise((resolve) => { finish = resolve })
        return { status: 'selected', files }
      },
      reset: () => { liveFiles.length = 0 },
    })

    expect(liveFiles).toHaveLength(1)
    finish()
    const outcome = await processing

    expect(outcome).toEqual({ status: 'selected', files: [readme] })
    expect(liveFiles).toHaveLength(0)
  })

  it('treats an empty selection as cancellation and never invokes parsing', async () => {
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    const reset = vi.fn()

    await expect(processVaultFallbackSelection({ fileList: [], onSelect, onCancel, reset })).resolves.toEqual({ status: 'cancelled' })

    expect(onSelect).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledOnce()
    expect(reset).toHaveBeenCalledOnce()
  })

  it('surfaces callback rejection without leaving an unhandled promise', async () => {
    const failure = new Error('parser rejected')
    const onError = vi.fn()

    await expect(processVaultFallbackSelection({
      fileList: [{ name: 'README.md' }],
      onSelect: async () => { throw failure },
      onError,
    })).resolves.toEqual({ status: 'failed', error: failure })
    expect(onError).toHaveBeenCalledWith(failure)
  })

  it('allows the same folder selection to be processed again after reset', async () => {
    const selected = [{ name: 'README.md' }]
    const onSelect = vi.fn(async (files) => ({ status: 'selected', files }))
    const reset = vi.fn()

    await processVaultFallbackSelection({ fileList: selected, onSelect, reset })
    await processVaultFallbackSelection({ fileList: selected, onSelect, reset })

    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(reset).toHaveBeenCalledTimes(2)
    expect(snapshotSelectedFiles(selected)).toEqual(selected)
  })

  it('settles a focus-return with no native event as a typed picker-unavailable failure', () => {
    const input = { files: [], value: 'folder', click: vi.fn() }
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    const onError = vi.fn()
    const stopRecovery = vi.fn()
    let recover
    const controller = createVaultFallbackSelectionController({
      input,
      callbacks: () => ({ onSelect, onCancel, onError }),
      schedule: (callback) => { recover = callback; return 1 },
      cancelSchedule: vi.fn(),
      stopRecovery,
    })

    controller.open()
    controller.resume()
    recover()

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0]).toMatchObject({
      name: 'VaultPickerUnavailableError',
      code: VAULT_PICKER_ERROR_CODE,
      outcome: 'picker-unavailable',
    })
    expect(onSelect).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(controller.getState()).toBe('settled')
    expect(input.value).toBe('')
    expect(stopRecovery).toHaveBeenCalledOnce()
  })

  it('ignores late change and cancel events after the no-event outcome settles', async () => {
    const input = { files: [], value: '', click: vi.fn() }
    const onSelect = vi.fn()
    const onCancel = vi.fn()
    const onError = vi.fn()
    let recover
    const controller = createVaultFallbackSelectionController({
      input,
      callbacks: () => ({ onSelect, onCancel, onError }),
      schedule: (callback) => { recover = callback; return 1 },
      cancelSchedule: vi.fn(),
    })

    controller.open()
    controller.resume()
    recover()
    input.files = [{ name: 'late.md' }]
    await controller.change()
    controller.cancel()

    expect(onError).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('starts a fresh pending cycle on retry and accepts a delivered FileList', async () => {
    const readme = { name: 'README.md' }
    const input = { files: [], value: '', click: vi.fn() }
    const onSelect = vi.fn(async (files) => ({ status: 'selected', files }))
    let recover
    const controller = createVaultFallbackSelectionController({
      input,
      callbacks: () => ({ onSelect, onError: vi.fn() }),
      schedule: (callback) => { recover = callback; return 1 },
      cancelSchedule: vi.fn(),
    })

    controller.open()
    controller.resume()
    recover()
    controller.open()
    input.files = [readme]
    await controller.change()

    expect(input.click).toHaveBeenCalledTimes(2)
    expect(onSelect).toHaveBeenCalledWith([readme])
    expect(controller.getState()).toBe('settled')
  })

  it('cancels pending recovery work when disposed', () => {
    const input = { files: [], value: '', click: vi.fn() }
    const onError = vi.fn()
    const cancelSchedule = vi.fn()
    const startRecovery = vi.fn()
    const stopRecovery = vi.fn()
    let recover
    const controller = createVaultFallbackSelectionController({
      input,
      callbacks: () => ({ onError }),
      schedule: (callback) => { recover = callback; return 17 },
      cancelSchedule,
      startRecovery,
      stopRecovery,
    })

    controller.open()
    controller.resume()
    controller.dispose()
    recover()

    expect(cancelSchedule).toHaveBeenCalledWith(17)
    expect(startRecovery).toHaveBeenCalledOnce()
    expect(stopRecovery).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })
})
