function parseEventBlock(block) {
  const event = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message'
  const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
  if (!data) return null
  try {
    return { event, payload: JSON.parse(data) }
  } catch {
    return null
  }
}

export async function streamProviderResponse({ providerId, endpoint, endpointType, apiKey, model, messages, signal, onDelta, onEvent }) {
  const response = await fetch('/api/providers/responses/stream', {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, endpoint, endpointType, apiKey, model, messages }),
    signal,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error || `Provider request failed (${response.status}).`)
  }
  if (!response.body) throw new Error('The local provider runtime returned an empty stream.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed
  const handle = (parsed) => {
    if (!parsed) return
    onEvent?.(parsed.event, parsed.payload)
    if (parsed.event === 'message.delta' && typeof parsed.payload.delta === 'string') onDelta?.(parsed.payload.delta)
    if (parsed.event === 'run.completed') completed = parsed.payload
    if (parsed.event === 'run.failed') throw new Error(parsed.payload.error || 'Provider stream failed.')
  }
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() || ''
    for (const block of blocks) handle(parseEventBlock(block))
    if (done) break
  }
  handle(parseEventBlock(buffer))
  if (!completed) throw new Error('Provider stream ended before completion.')
  return completed
}
