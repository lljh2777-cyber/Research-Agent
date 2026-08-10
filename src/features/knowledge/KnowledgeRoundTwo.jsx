import {
  Archive,
  Check,
  ChevronRight,
  Highlighter,
  MessageSquare,
  PencilLine,
  Sparkles,
  X,
} from 'lucide-react'

export function SelectionActionBar({ selection, onAction, onClear }) {
  const exact = selection?.anchor?.quote?.exact
  if (!exact) return null
  return <div className="selection-action-bar" role="toolbar" aria-label="Selected text actions">
    <span className="selection-action-context" title={exact}><Highlighter size={13} />{exact}</span>
    <button type="button" onClick={() => onAction('query')}><MessageSquare size={13} />Ask</button>
    <button type="button" onClick={() => onAction('explain')}><Sparkles size={13} />Explain</button>
    <button type="button" className="annotation-action" onClick={() => onAction('annotation')}><PencilLine size={13} />Annotate</button>
    <button type="button" className="selection-action-close" onClick={onClear} aria-label="Clear selected passage"><X size={13} /></button>
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
      <label><span>Your annotation</span><textarea value={draft?.manual || ''} onChange={(event) => onDraftChange({ ...draft, manual: event.target.value })} placeholder="Add your interpretation, caveat, or follow-up..." /></label>
      <label><span>AI contribution</span><textarea value={draft?.ai || ''} onChange={(event) => onDraftChange({ ...draft, ai: event.target.value })} placeholder="Optional curator contribution" /></label>
      <div className="annotation-editor-actions">
        <button type="button" onClick={() => onArchive(annotation)}><Archive size={13} />{annotation.archived ? 'Restore' : 'Archive'}</button>
        <button type="button" className="save" onClick={() => onRequestSave(annotation, draft)} disabled={relocationNeedsAttention || (!draft?.manual?.trim() && !draft?.ai?.trim())}><Check size={13} />Save with approval</button>
      </div>
      <p className="annotation-approval-hint">Saving is a scoped Vault write and always requires explicit approval.</p>
    </section>}
    {annotations.length > 0 && <section className="annotation-history" aria-label="Saved annotations">
      <span>Saved on this note</span>
      {annotations.map((item) => <AnnotationRecord annotation={item} active={item.id === annotation?.id} onReopen={onReopen} key={item.id} />)}
    </section>}
  </aside>
}
