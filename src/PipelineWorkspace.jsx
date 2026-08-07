import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Clock3, Database, Network, Play, Search, ShieldCheck } from 'lucide-react'

import { PIPELINE_TEMPLATES } from './pipelineEngine.js'

const PIPELINE_ICONS = { shield: ShieldCheck, search: Search, network: Network }

function formatTimestamp(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—'
  if (milliseconds < 1000) return `${milliseconds} ms`
  return `${(milliseconds / 1000).toFixed(1)} s`
}

function MetricGrid({ metrics }) {
  return <div className="pipeline-metrics">{metrics.map((metric) => <div className={metric.tone || ''} key={metric.label}><strong>{metric.value}</strong><span>{metric.label}</span></div>)}</div>
}

function Findings({ findings }) {
  return <div className="run-findings">{findings.map((finding, index) => <div className={`run-finding ${finding.level}`} key={`${finding.title}-${index}`}>{finding.level === 'warning' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}<span><strong>{finding.title}</strong><small>{finding.detail}</small></span></div>)}</div>
}

export function PipelinesSection({ vaultName, noteCount, runs, runningPipelineId, onRun, onViewRun, onConnectVault }) {
  const [selectedId, setSelectedId] = useState(PIPELINE_TEMPLATES[0].id)
  const selected = PIPELINE_TEMPLATES.find((pipeline) => pipeline.id === selectedId) || PIPELINE_TEMPLATES[0]
  const latestRun = runs.find((run) => run.pipelineId === selected.id)
  const SelectedIcon = PIPELINE_ICONS[selected.icon]
  const canRun = noteCount > 0 && !runningPipelineId

  return (
    <div className="pipeline-section">
      <header className="pipeline-page-header">
        <div><h2>Pipelines</h2><p>Run deterministic local workflows against the connected research Vault.</p></div>
        <button className="pipeline-vault-status" onClick={onConnectVault}><Database size={15} /><span><strong>{vaultName || 'Connect a Vault'}</strong><small>{noteCount ? `${noteCount} Markdown notes · local only` : 'Choose an Obsidian folder'}</small></span><ArrowRight size={14} /></button>
      </header>
      <section className="pipeline-picker" aria-labelledby="pipeline-picker-title">
        <div className="pipeline-list-heading"><span id="pipeline-picker-title">Choose a workflow</span><small>{PIPELINE_TEMPLATES.length} local workflows</small></div>
        <div className="pipeline-list" role="group" aria-label="Available pipelines">
          {PIPELINE_TEMPLATES.map((pipeline) => {
            const Icon = PIPELINE_ICONS[pipeline.icon]
            const lastRun = runs.find((run) => run.pipelineId === pipeline.id)
            return <button aria-pressed={pipeline.id === selected.id} className={pipeline.id === selected.id ? 'selected' : ''} key={pipeline.id} onClick={() => setSelectedId(pipeline.id)}><span className="pipeline-icon"><Icon size={18} /></span><span><small>{pipeline.category}</small><strong>{pipeline.title}</strong><em>{pipeline.description}</em></span>{lastRun && <span className="pipeline-ran"><CheckCircle2 size={13} /> Run ready</span>}</button>
          })}
        </div>
      </section>
      <section className="pipeline-detail" aria-label={`${selected.title} details`}>
        <div className="pipeline-detail-header"><span className="pipeline-large-icon"><SelectedIcon size={23} /></span><div><span>{selected.category}</span><h3>{selected.title}</h3><p>{selected.description}</p></div><div className="pipeline-primary-action"><small>Produces {selected.output}</small><button onClick={() => noteCount ? onRun(selected.id) : onConnectVault()} disabled={noteCount > 0 && !canRun}>{runningPipelineId === selected.id ? <Clock3 className="spin" size={16} /> : noteCount ? <Play size={16} /> : <Database size={16} />}{runningPipelineId === selected.id ? 'Running…' : noteCount ? 'Run workflow' : 'Connect Vault'}</button></div></div>
        <div className="pipeline-capability"><ShieldCheck size={15} /><span><strong>Runs locally on the current Vault snapshot.</strong> No model login or external API required.</span></div>
        <section className="pipeline-stages"><div className="pipeline-section-heading"><span>How it runs</span><small>{selected.stages.length} read-only stages</small></div><div className="pipeline-stage-flow">{selected.stages.map((stage, index) => <div className="pipeline-stage-row" key={stage}><span>{index + 1}</span><div><strong>{stage}</strong><small>{index === selected.stages.length - 1 ? selected.output : 'Local analysis'}</small></div>{runningPipelineId === selected.id ? <Clock3 className="spin" size={15} /> : <Check size={14} />}</div>)}</div></section>
        {latestRun && <section className="pipeline-latest"><div className="pipeline-section-heading"><span>Latest result</span><small>{formatTimestamp(latestRun.completedAt)}</small></div><div className="pipeline-latest-summary"><p>{latestRun.summary}</p><button onClick={() => onViewRun(latestRun.id)}>Open full run <ArrowRight size={14} /></button></div><MetricGrid metrics={latestRun.metrics} /></section>}
      </section>
    </div>
  )
}

export function RunsSection({ runs, selectedRunId, onSelectRun }) {
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) || runs[0] || null, [runs, selectedRunId])
  if (!runs.length) return <div className="runs-empty"><span><Clock3 size={25} /></span><h2>No pipeline runs yet</h2><p>Run a local workflow from Pipelines to create an inspectable execution trace.</p></div>
  return (
    <div className="runs-section">
      <header className="runs-page-header"><div><h2>Runs</h2><p>Inspect local workflow inputs, stages, findings, and verification output.</p></div><span><CheckCircle2 size={15} />{runs.length} completed</span></header>
      <section className="runs-history" aria-labelledby="run-history-title">
        <div className="pipeline-list-heading"><span id="run-history-title">Recent runs</span><small>latest first</small></div>
        <div className="runs-list" role="group" aria-label="Pipeline run history">
          {runs.map((run) => <button aria-pressed={run.id === selectedRun.id} className={run.id === selectedRun.id ? 'selected' : ''} key={run.id} onClick={() => onSelectRun(run.id)}><span className="run-state"><Check size={13} /></span><span><strong>{run.title}</strong><small>{run.vaultName} · {formatTimestamp(run.completedAt)}</small></span></button>)}
        </div>
      </section>
      <section className="run-detail" aria-label={`${selectedRun.title} run details`}>
        <div className="run-detail-header"><span className="run-complete-icon"><CheckCircle2 size={22} /></span><div><span>Completed local run</span><h3>{selectedRun.title}</h3><p>{selectedRun.summary}</p></div></div>
        <MetricGrid metrics={selectedRun.metrics} />
        <div className="run-metadata"><span><small>Vault</small>{selectedRun.vaultName}</span><span><small>Started</small>{formatTimestamp(selectedRun.startedAt)}</span><span><small>Duration</small>{formatDuration(selectedRun.durationMs)}</span><span><small>Output</small>{selectedRun.output}</span></div>
        <div className="run-detail-grid"><section className="run-trace"><div className="pipeline-section-heading"><span>Execution trace</span><small>verified locally</small></div>{selectedRun.steps.map((step, index) => <div className="run-trace-row" key={step.label}><span><Check size={12} /></span><div><strong>{index + 1}. {step.label}</strong><small>{step.detail}</small></div></div>)}</section><section className="run-results"><div className="pipeline-section-heading"><span>Findings</span><small>{selectedRun.findings.length} observations</small></div><Findings findings={selectedRun.findings} /></section></div>
      </section>
    </div>
  )
}
