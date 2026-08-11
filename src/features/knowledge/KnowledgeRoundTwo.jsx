import { useEffect, useRef } from 'react'
import {
  Archive,
  Check,
  ChevronRight,
  Highlighter,
  PencilLine,
  Sparkles,
  X,
} from 'lucide-react'

export function SelectionChooser({ selection, position, onAction, onDismiss }) {
  const chooserRef = useRef(null)
  useEffect(() => {
    const dismissOutside = (event) => {
      if (!chooserRef.current?.contains(event.target)) onDismiss()
    }
    const dismissEscape = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onDismiss()
      }
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissEscape)
    }
  }, [onDismiss])

  if (!selection?.anchor?.quote?.exact || !position) return null
  return <div
    className="selection-chooser"
    role="menu"
    aria-label="选中文本操作"
    ref={chooserRef}
    style={{ left: position.x, top: position.y }}
  >
    <button type="button" role="menuitem" autoFocus onClick={() => onAction('manual')}><PencilLine size={14} />手工批注</button>
    <button type="button" role="menuitem" onClick={() => onAction('ai')}><Sparkles size={14} />AI 解释</button>
  </div>
}

function AnnotationRecord({ annotation, active, onReopen }) {
  return <button type="button" className={`annotation-record ${active ? 'active' : ''}`} onClick={() => onReopen(annotation)}>
    <span><Highlighter size={13} /><strong>{annotation.anchor?.quote?.exact || 'Detached annotation'}</strong></span>
    <small>{annotation.archived ? 'Archived' : annotation.sections?.manual || annotation.sections?.ai || 'No annotation text'}</small>
    <ChevronRight size={13} />
  </button>
}

function relocationMessage(relocation) {
  if (relocation.status === 'ambiguous') return `${relocation.candidates} possible matches - choose a new passage before saving.`
  if (relocation.status === 'stale') return 'The original quote changed; the fallback range is shown for review.'
  if (relocation.status === 'missing') return 'The selected passage could not be found in the current note.'
  return `Located with ${relocation.strategy}.`
}

export function AnnotationEditor({
  annotation,
  draft,
  annotations = [],
  onDraftChange,
  onRequestSave,
  onArchive,
  onDismiss,
  onReopen,
  focusSection = 'manual',
  persistenceMessage = '',
}) {
  if (!annotation && annotations.length === 0) return null
  const relocationNeedsAttention = annotation && ['ambiguous', 'stale', 'missing'].includes(annotation.relocation.status)
  return <aside className="annotation-workbench" aria-label="Annotations">
    <header>
      <span><Highlighter size={15} /><strong>Annotations</strong></span>
      <button type="button" onClick={onDismiss} aria-label="Close annotations workbench"><X size={14} /></button>
    </header>
    {annotation && <section className="annotation-editor" aria-labelledby="annotation-editor-title">
      <div className={`annotation-relocation ${annotation.relocation.status}`} role={relocationNeedsAttention ? 'alert' : 'status'}>
        <strong>Anchor {annotation.relocation.status}</strong>
        <span>{relocationMessage(annotation.relocation)}</span>
      </div>
      <div className="annotation-source">
        <span id="annotation-editor-title">Selected passage</span>
        <blockquote>{annotation.anchor?.quote?.exact}</blockquote>
        <small>{annotation.source?.path || 'Current note'}{annotation.anchor?.heading?.text ? ` - ${annotation.anchor.heading.text}` : ''}</small>
      </div>
      <label><span>Your annotation</span><textarea autoFocus={focusSection === 'manual'} value={draft?.manual || ''} onChange={(event) => onDraftChange({ ...draft, manual: event.target.value })} placeholder="Add your interpretation, caveat, or follow-up..." /></label>
      <label><span>AI contribution</span><textarea autoFocus={focusSection === 'ai'} value={draft?.ai || ''} onChange={(event) => onDraftChange({ ...draft, ai: event.target.value })} placeholder="Add or review the AI explanation..." /></label>
      <div className="annotation-editor-actions">
        <button type="button" onClick={() => onArchive(annotation)}><Archive size={13} />{annotation.archived ? 'Restore' : 'Archive'}</button>
        <button type="button" className="save" onClick={() => onRequestSave(annotation, draft)} disabled={relocationNeedsAttention || (!draft?.manual?.trim() && !draft?.ai?.trim())}><Check size={13} />Save with approval</button>
      </div>
      <p className="annotation-approval-hint">Saving is a scoped Vault write and always requires explicit approval.</p>
      {persistenceMessage && <p className="annotation-persistence-message" role="alert">{persistenceMessage}</p>}
    </section>}
    {annotations.length > 0 && <section className="annotation-history" aria-label="Saved annotations">
      <span>Saved on this note</span>
      {annotations.map((item) => <AnnotationRecord annotation={item} active={item.id === annotation?.id} onReopen={onReopen} key={item.id} />)}
    </section>}
  </aside>
}
