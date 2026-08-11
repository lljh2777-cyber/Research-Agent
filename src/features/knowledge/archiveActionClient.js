import { consumeKnowledgeArchiveTerminalEvent } from '../../research/knowledgeArchive.js'

function parseEventBlock(block) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

function abortError() {
  return Object.assign(new Error('Archive run was cancelled.'), { name: 'AbortError' })
}

export async function executeKnowledgeArchiveAction({ actionRuntime, request, approval, signal, onEvent }) {
  if (!actionRuntime?.available) throw new Error(actionRuntime?.reason || 'Formal archive is unavailable in this Runtime.')
  const started = await actionRuntime.start({ ...request, approval, signal })
  if (!started?.ok && started?.ok !== undefined) throw new Error(started.error || started.reason || 'Formal archive could not start.')
  if (started?.terminalEvent) return consumeKnowledgeArchiveTerminalEvent(request, started.terminalEvent)

  signal?.addEventListener('abort', () => void actionRuntime.cancel(request.runId).catch(() => {}), { once: true })
  let cursor = 0
  while (true) {
    if (signal?.aborted) throw abortError()
    const followed = await actionRuntime.follow(request.runId, { after: cursor, signal })
    if (!followed?.ok || !followed.response?.body) throw new Error(followed?.error || 'Formal archive event stream is unavailable.')
    const reader = followed.response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() || ''
      for (const block of blocks) {
        const envelope = parseEventBlock(block)
        cursor = Math.max(cursor, Number(envelope?.cursor) || 0)
        if (envelope?.event) onEvent?.(envelope.event)
        const result = envelope ? consumeKnowledgeArchiveTerminalEvent(request, envelope) : null
        if (result) return result
      }
      if (done) break
    }
    const envelope = parseEventBlock(buffer)
    if (envelope?.event) onEvent?.(envelope.event)
    const result = envelope ? consumeKnowledgeArchiveTerminalEvent(request, envelope) : null
    if (result) return result
  }
}
