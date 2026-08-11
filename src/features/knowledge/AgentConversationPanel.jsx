import { useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  Code2,
  FilePlus2,
  FileSearch,
  FileText,
  Highlighter,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react'
import './knowledgeRoundTwo.css'

const TOOL_ICONS = Object.freeze({
  query: Search,
  explain: MessageSquare,
  lint: ListChecks,
  annotation: Highlighter,
  'paper-ingest': FilePlus2,
  xray: FileSearch,
  'code-analysis': Code2,
  synthesis: Sparkles,
})

const TERMINAL_PRESENTATION = Object.freeze({
  completed: { label: 'Run complete', tone: 'completed', icon: CheckCircle2 },
  failed: { label: 'Run failed', tone: 'failed', icon: XCircle },
  cancelled: { label: 'Run cancelled', tone: 'cancelled', icon: CircleStop },
  running: { label: 'Agent running', tone: 'running', icon: LoaderCircle },
  'waiting-approval': { label: 'Waiting for approval', tone: 'approval', icon: ShieldCheck },
})

export function getKnowledgeAgentRunPresentation(runStatus) {
  return TERMINAL_PRESENTATION[runStatus] || null
}

function ContextSummary({ contextSummary }) {
  const note = contextSummary?.activeNote
  const selection = contextSummary?.selection?.anchor?.quote?.exact
  return <section className="knowledge-agent-context" aria-label="Knowledge context">
    <div className="knowledge-agent-section-heading"><span>Context</span><small>{contextSummary?.surface === 'research' ? 'Research' : 'Knowledge sidebar'}</small></div>
    {note ? <div className="knowledge-context-chips">
      <span title={note.path || note.title}><FileText size={12} /><strong>Current note</strong>{note.title}</span>
      {selection && <span title={selection}><Highlighter size={12} /><strong>Selection</strong>{selection}</span>}
    </div> : <div className="knowledge-agent-empty compact"><FileText size={17} /><span>No current note or selection context.</span></div>}
  </section>
}

function ToolMenu({ descriptors, onAction }) {
  const [expanded, setExpanded] = useState(true)
  return <section className="knowledge-tool-menu" aria-label="Knowledge actions">
    <button type="button" className="knowledge-agent-section-heading menu-toggle" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
      <span>Actions</span><ChevronDown size={13} />
    </button>
    {expanded && <div className="knowledge-tool-list">
      {descriptors.map((descriptor) => {
        const Icon = TOOL_ICONS[descriptor.id] || Sparkles
        return <button
          type="button"
          className={`knowledge-tool-row ${descriptor.effect === 'write' ? 'write' : 'read'}`}
          disabled={!descriptor.available}
          onClick={() => onAction(descriptor)}
          aria-describedby={!descriptor.available ? `tool-reason-${descriptor.id}` : undefined}
          data-tool-id={descriptor.toolId}
          key={descriptor.id}
        >
          <Icon size={14} />
          <span><strong>{descriptor.title}</strong><small id={`tool-reason-${descriptor.id}`}>{descriptor.available ? descriptor.effect === 'write' ? 'Target scope and approval required' : 'Read-only - no approval' : descriptor.unavailableReason}</small></span>
          {descriptor.effect === 'write' ? <ShieldCheck size={12} /> : <ArrowRight size={12} />}
        </button>
      })}
    </div>}
  </section>
}

function ApprovalCard({ approval, onResolveApproval }) {
  if (!approval) return null
  return <section className="knowledge-approval-card" role="dialog" aria-modal="false" aria-labelledby="knowledge-approval-title">
    <div><LockKeyhole size={16} /><span><strong id="knowledge-approval-title">Approval required</strong><small>{approval.actionTitle}</small></span></div>
    <dl>
      <div><dt>Target scope</dt><dd>{approval.targetScope}</dd></div>
      {approval.approvalDetails?.scope && <div><dt>Authorization root</dt><dd>{approval.approvalDetails.scope.vaultId} · {approval.approvalDetails.scope.target.kind}:{approval.approvalDetails.scope.target.id}</dd></div>}
      {approval.approvalDetails?.sourceAnnotation && <div><dt>Source Annotation</dt><dd>{approval.approvalDetails.sourceAnnotation.id}<br />{approval.approvalDetails.sourceAnnotation.path}<br />Revision {approval.approvalDetails.sourceAnnotation.revision}</dd></div>}
      {approval.approvalDetails?.targets?.length > 0 && <div><dt>Requested targets</dt><dd><ol>{approval.approvalDetails.targets.map((target) => <li key={target}>{target}</li>)}</ol></dd></div>}
      <div><dt>Idempotency</dt><dd>{approval.idempotencyKey}</dd></div>
    </dl>
    <p>This write action runs only once for the displayed target scope.</p>
    <div><button type="button" onClick={() => onResolveApproval(false)}>Cancel</button><button type="button" className="approve" onClick={() => onResolveApproval(true)}><ShieldCheck size={13} />Approve once</button></div>
  </section>
}

function ConversationMessages({ messages, runStatus }) {
  return <div className="knowledge-agent-messages" aria-live="polite">
    {messages.length === 0 ? <div className="knowledge-agent-empty"><Bot size={22} /><strong>Knowledge curator</strong><span>Ask about the current note or selected passage.</span></div> : messages.map((message) => <article className={`knowledge-agent-message ${message.role}`} key={message.id}>
      <span>{message.role === 'assistant' ? <Bot size={13} /> : 'You'}</span>
      <p>{message.text}</p>
    </article>)}
    {getKnowledgeAgentRunPresentation(runStatus) && (() => {
      const state = getKnowledgeAgentRunPresentation(runStatus)
      const Icon = state.icon
      return <div className={`knowledge-run-state ${state.tone}`}><Icon className={state.tone === 'running' ? 'spin' : ''} size={13} /><span>{state.label}</span></div>
    })()}
  </div>
}

export function AgentConversationPanel({
  variant = 'compact',
  session,
  contextSummary,
  descriptors = [],
  input = '',
  onInput,
  onSubmit,
  onAction,
  onContinueInResearch,
  approval,
  onResolveApproval,
  disabled = false,
}) {
  const hasContext = Boolean(contextSummary?.activeNote)
  const handleSubmit = (event) => {
    event.preventDefault()
    if (!disabled && hasContext && input.trim()) onSubmit(input.trim())
  }
  return <section className={`agent-conversation-panel ${variant}`} aria-label="Knowledge curator conversation" data-agent-id={session?.agentId} data-session-id={session?.sessionId} data-run-id={session?.runId || ''} data-cursor={session?.cursor || 0}>
    <header className="knowledge-agent-header"><span><Bot size={17} /><strong>Knowledge curator</strong></span><small>{variant === 'compact' ? 'Knowledge sidebar' : 'Research workspace'}</small></header>
    <ContextSummary contextSummary={contextSummary} />
    <ToolMenu descriptors={descriptors} onAction={onAction} />
    <ConversationMessages messages={session?.messages || []} runStatus={session?.runStatus} />
    <ApprovalCard approval={approval} onResolveApproval={onResolveApproval} />
    <form className="knowledge-agent-composer" onSubmit={handleSubmit}>
      <label htmlFor={`knowledge-agent-input-${variant}`}>Ask knowledge curator</label>
      <div><textarea id={`knowledge-agent-input-${variant}`} value={input} onChange={(event) => onInput(event.target.value)} placeholder={hasContext ? 'Ask about the current note or selection...' : 'Open a note to enable the curator'} disabled={disabled || !hasContext} /><button type="submit" disabled={disabled || !hasContext || !input.trim()} aria-label="Send to knowledge curator"><Send size={14} /></button></div>
    </form>
    {variant === 'compact' && <button type="button" className="continue-research" onClick={onContinueInResearch} disabled={!hasContext}><MessageSquare size={14} />Continue in Research <ArrowRight size={13} /></button>}
    {!hasContext && <div className="knowledge-agent-boundary"><AlertCircle size={12} />Connect a Vault and open a note before starting note-aware actions.</div>}
  </section>
}
