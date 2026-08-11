import { useEffect, useRef, useState } from 'react'
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  GripHorizontal,
  Highlighter,
  PencilLine,
  RotateCw,
  Settings2,
  Sparkles,
  Square,
  X,
} from 'lucide-react'

export function SelectionChooser({ selection, position, onAction, onDismiss, aiAvailable = false, aiUnavailableReason = '' }) {
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
  return <div className="selection-chooser" role="menu" aria-label="选中文本操作" ref={chooserRef} style={{ left: position.x, top: position.y }}>
    <button type="button" role="menuitem" autoFocus onClick={() => onAction('manual')}><PencilLine size={14} />手工批注</button>
    <button type="button" role="menuitem" onClick={() => onAction('ai')} disabled={!aiAvailable} title={!aiAvailable ? aiUnavailableReason : undefined}><Sparkles size={14} />AI 解释</button>
  </div>
}

function AnnotationRecord({ annotation, active, onReopen }) {
  const state = annotation.archive?.state || (annotation.archived ? 'completed' : 'none')
  return <button type="button" className={`annotation-record ${active ? 'active' : ''}`} onClick={() => onReopen(annotation)}>
    <span><Highlighter size={13} /><strong>{annotation.anchor?.quote?.exact || 'Detached annotation'}</strong></span>
    <small>{state === 'completed' ? 'Archived' : state === 'pending' ? 'Archive pending' : state === 'failed' ? 'Archive failed' : annotation.sections?.manual || annotation.sections?.ai || 'No annotation text'}</small>
    <ChevronRight size={13} />
  </button>
}

function relocationMessage(relocation) {
  if (relocation.status === 'ambiguous') return `${relocation.candidates} possible matches — choose a new passage before saving.`
  if (relocation.status === 'stale') return 'The original quote changed; the fallback range is shown for review.'
  if (relocation.status === 'missing') return 'The selected passage could not be found in the current note.'
  return `Located with ${relocation.strategy}.`
}

function ArchiveEvidence({ archiveState, evidence = [] }) {
  if (!archiveState || archiveState.state === 'none') return null
  return <section className={`annotation-archive-state ${archiveState.state}`} aria-label="Formal archive status">
    <strong>Formal archive: {archiveState.state}</strong>
    {archiveState.error?.message && <p role="alert">{archiveState.error.message}</p>}
    {evidence.length > 0 && <ul>{evidence.map((entry) => <li key={entry.path}><span>{entry.path}</span><small>{entry.status}{entry.revision ? ` · ${entry.revision}` : ''}</small></li>)}</ul>}
    {archiveState.targets?.length > 0 && evidence.length === 0 && <p>{archiveState.targets.length} requested target{archiveState.targets.length === 1 ? '' : 's'}; requested paths are not commit evidence.</p>}
  </section>
}

export function AnnotationEditor({
  annotation,
  draft,
  annotations = [],
  stage = 'view',
  position,
  onDraftChange,
  onRequestSave,
  onRequestArchive,
  onCancelArchive,
  onDismiss,
  onBack,
  onEdit,
  onRegenerate,
  onCancelAi,
  onReopen,
  focusSection = 'manual',
  persistenceMessage = '',
  aiStatus = null,
  provenance = null,
  provider = null,
  onOpenSettings,
  archiveAvailable = false,
  archiveUnavailableReason = '',
  archiveTargets = '',
  onArchiveTargetsChange,
  archiveEvidence = [],
  closeGuard = false,
  onConfirmDiscard,
  onKeepEditing,
}) {
  const popoverRef = useRef(null)
  const [dragPosition, setDragPosition] = useState(position)
  useEffect(() => setDragPosition(position), [position])
  useEffect(() => {
    const dismissOutside = (event) => {
      if (!popoverRef.current?.contains(event.target)) onDismiss()
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

  if (!annotation && annotations.length === 0) return null
  const relocationNeedsAttention = annotation && ['ambiguous', 'stale', 'missing'].includes(annotation.relocation.status)
  const editable = ['edit', 'generating', 'review'].includes(stage)
  const startDrag = (event) => {
    if (!dragPosition) return
    const start = { x: event.clientX, y: event.clientY, left: dragPosition.x, top: dragPosition.y }
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (next) => setDragPosition({
      x: Math.max(8, Math.min(window.innerWidth - 336, start.left + next.clientX - start.x)),
      y: Math.max(8, Math.min(window.innerHeight - 120, start.top + next.clientY - start.y)),
    })
    const stop = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
  }

  return <aside className="annotation-workbench" aria-label="Annotations" ref={popoverRef} style={dragPosition ? { left: dragPosition.x, top: dragPosition.y } : undefined}>
    <header onPointerDown={startDrag}>
      <span><GripHorizontal size={14} aria-hidden="true" /><Highlighter size={15} /><strong>{stage === 'view' ? 'Annotation' : stage === 'generating' ? 'Generating explanation' : 'Review annotation'}</strong></span>
      <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={onDismiss} aria-label="Close annotations"><X size={14} /></button>
    </header>
    {closeGuard && <section className="annotation-close-guard" role="alertdialog" aria-labelledby="annotation-discard-title">
      <CircleAlert size={17} /><div><strong id="annotation-discard-title">Discard unsaved changes?</strong><p>Your saved annotation will stay unchanged.</p></div>
      <button type="button" onClick={onKeepEditing}>Keep editing</button><button type="button" className="danger" onClick={onConfirmDiscard}>Discard</button>
    </section>}
    {!closeGuard && annotation && <section className="annotation-editor" aria-labelledby="annotation-editor-title">
      <div className={`annotation-relocation ${annotation.relocation.status}`} role={relocationNeedsAttention ? 'alert' : 'status'}>
        <strong>Anchor {annotation.relocation.status}</strong><span>{relocationMessage(annotation.relocation)}</span>
      </div>
      <div className="annotation-source"><span id="annotation-editor-title">Selected passage</span><blockquote>{annotation.anchor?.quote?.exact}</blockquote><small>{annotation.source?.path || 'Current note'}{annotation.anchor?.heading?.text ? ` · ${annotation.anchor.heading.text}` : ''}</small></div>

      {editable ? <>
        <label><span>Your annotation</span><textarea autoFocus={focusSection === 'manual'} value={draft?.manual || ''} onChange={(event) => onDraftChange({ ...draft, manual: event.target.value })} placeholder="Add your interpretation, caveat, or follow-up…" /></label>
        <label><span>AI contribution</span><textarea autoFocus={focusSection === 'ai' && stage !== 'generating'} aria-busy={stage === 'generating'} disabled={stage === 'generating'} value={draft?.ai || ''} onChange={(event) => onDraftChange({ ...draft, ai: event.target.value })} placeholder="Review the generated explanation…" /></label>
        {provider && <div className="annotation-provider"><span><Sparkles size={12} /><strong>{provider.providerName}</strong> · {provider.modelName}</span><button type="button" onClick={onOpenSettings}><Settings2 size={12} />Switch</button></div>}
        {aiStatus?.message && <p className={`annotation-ai-status ${aiStatus.kind}`} role={aiStatus.kind === 'error' ? 'alert' : 'status'}>{aiStatus.message}</p>}
        <div className="annotation-editor-actions">
          {stage === 'generating' ? <button type="button" onClick={onCancelAi}><Square size={12} />Cancel AI</button> : <button type="button" onClick={onBack}><ArrowLeft size={13} />Back</button>}
          <button type="button" className="save" onClick={() => onRequestSave(annotation, draft)} disabled={stage === 'generating' || relocationNeedsAttention || (!draft?.manual?.trim() && !draft?.ai?.trim())}><Check size={13} />Save with approval</button>
        </div>
      </> : <>
        <div className="annotation-rendered"><section><span>Manual</span><p>{annotation.sections?.manual || 'No manual contribution.'}</p></section><section><span>AI</span><p>{annotation.sections?.ai || 'No AI contribution.'}</p>{annotation.aiProvenance && <small>{annotation.aiProvenance.providerId} · {annotation.aiProvenance.modelId} · {new Date(annotation.aiProvenance.generatedAt).toLocaleString()}</small>}</section></div>
        <ArchiveEvidence archiveState={annotation.archive} evidence={archiveEvidence} />
        <div className="annotation-editor-actions"><button type="button" onClick={onEdit}><PencilLine size={13} />Edit</button><button type="button" onClick={onRegenerate} disabled={!provider}><RotateCw size={13} />Regenerate</button></div>
        <label className="annotation-archive-targets"><span>Formal archive targets (one Vault .md path per line)</span><textarea value={archiveTargets} onChange={(event) => onArchiveTargetsChange(event.target.value)} placeholder="synthesis/findings.md" /></label>
        {annotation.archive?.state === 'pending'
          ? <button type="button" className="annotation-archive-button danger" onClick={onCancelArchive}><Square size={12} />Cancel archive run</button>
          : <button type="button" className="annotation-archive-button" onClick={() => onRequestArchive(annotation)} disabled={!archiveAvailable || !archiveTargets.trim()} title={!archiveAvailable ? archiveUnavailableReason : undefined}><Archive size={13} />Archive knowledge with approval</button>}
      </>}
      <p className="annotation-approval-hint">Saving and formal archive are distinct scoped operations. Neither runs without per-call approval.</p>
      {persistenceMessage && <p className="annotation-persistence-message" role="alert">{persistenceMessage}</p>}
    </section>}
    {!closeGuard && annotations.length > 0 && <section className="annotation-history" aria-label="Saved annotations"><span>Saved on this note</span>{annotations.map((item) => <AnnotationRecord annotation={item} active={item.id === annotation?.id} onReopen={onReopen} key={item.id} />)}</section>}
  </aside>
}
