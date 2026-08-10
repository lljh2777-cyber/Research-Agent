import { describe, expect, it, vi } from 'vitest'

import { processVaultFallbackSelection, snapshotSelectedFiles } from '../../src/runtime/VaultFallbackPicker.jsx'

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
})
