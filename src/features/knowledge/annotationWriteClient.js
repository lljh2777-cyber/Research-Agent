export const ANNOTATION_WRITE_STAGES = Object.freeze({
  BODY: 'body',
  ARCHIVE_PENDING: 'archive.pending',
  ARCHIVE_COMPLETED: 'archive.completed',
  ARCHIVE_FAILED: 'archive.failed',
  ARCHIVE_CANCELLED: 'archive.cancelled',
})

const VALID_STAGES = new Set(Object.values(ANNOTATION_WRITE_STAGES))

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function createAnnotationWriteIdempotencyKey(intent, stage) {
  if (!VALID_STAGES.has(stage)) throw new TypeError('Unsupported Annotation write stage.')
  if (!intent || typeof intent !== 'object') throw new TypeError('Annotation write intent is required.')
  const serialized = JSON.stringify({ stage, intent })
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
  return `annotation.write.${stage}.${hex(digest)}`
}
