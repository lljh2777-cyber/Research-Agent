const TERMINAL_RUN_STATUS = new Set(['completed', 'failed', 'cancelled'])

function progressFor(activeStage, stageCount) {
  const safeStageCount = Math.max(1, Number(stageCount) || 1)
  return Math.min(91, Math.round(((Math.max(0, Number(activeStage) || 0) + 0.7) / safeStageCount) * 100))
}

export function getResearchRunPresentation({
  runStatus,
  running = false,
  hasActivity = false,
  activeStage = 0,
  stageCount = 6,
  packet = null,
  answerMode,
} = {}) {
  const terminalStatus = TERMINAL_RUN_STATUS.has(runStatus) ? runStatus : null
  const isRunning = Boolean(running) || runStatus === 'running' || runStatus === 'waiting-approval'
  const inProgress = progressFor(activeStage, stageCount)

  if (terminalStatus === 'cancelled') {
    return {
      terminalStatus,
      agentLabel: 'Run cancelled',
      runDetail: 'Generation was cancelled. Any partial response is kept in the conversation.',
      progress: hasActivity ? inProgress : 0,
      progressLabel: 'Cancelled',
      answerDetail: 'Generation cancelled before answer completion',
      answerStatus: 'cancelled',
    }
  }

  if (terminalStatus === 'failed') {
    return {
      terminalStatus,
      agentLabel: 'Agent failed',
      runDetail: 'The answer model could not complete this run. Review the error and retry.',
      progress: hasActivity ? inProgress : 0,
      progressLabel: 'Failed',
      answerDetail: 'Answer generation failed',
      answerStatus: 'failed',
    }
  }

  if (terminalStatus === 'completed') {
    const citedAnswer = Boolean(packet) && answerMode === 'chatgpt'
    return {
      terminalStatus,
      agentLabel: 'Agent ready',
      runDetail: 'Run complete',
      progress: hasActivity ? 100 : 0,
      progressLabel: hasActivity ? '100%' : '',
      answerDetail: citedAnswer ? 'Cited answer generated' : packet ? 'Retrieval preview only' : 'Answer generated without Vault evidence',
      answerStatus: 'done',
    }
  }

  if (isRunning) {
    return {
      terminalStatus: null,
      agentLabel: 'Agent running',
      runDetail: 'Synthesizing answer and citing sources...',
      progress: hasActivity ? inProgress : 0,
      progressLabel: hasActivity ? `${inProgress}%` : '',
      answerDetail: packet ? 'Agent working...' : 'waiting for evidence',
      answerStatus: 'current',
    }
  }

  return {
    terminalStatus: null,
    agentLabel: 'Agent ready',
    runDetail: hasActivity ? 'Waiting for Research Run status' : 'Ready for your first question',
    progress: 0,
    progressLabel: '',
    answerDetail: packet ? 'waiting for Research Run status' : 'waiting for evidence',
    answerStatus: 'current',
  }
}