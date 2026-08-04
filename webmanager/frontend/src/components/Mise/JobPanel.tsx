import { useState } from 'react'
import type { MiseJobStatus } from '../../api/types'
import { confirmAndRestartCodeServer, type RestartOutcome } from '../../utils/restartCodeServer'
import './Mise.css'

// Shared by Mise.tsx and ClaudeCode.tsx - both poll the same
// GET /api/mise/jobs/:id shape (mise install/uninstall is the mechanism
// behind both a mise-tab tool install and a Claude Code install/update).
export interface JobPanelProps {
  kind: 'install' | 'uninstall'
  toolLabel: string
  status: MiseJobStatus | null
  onClose: () => void
  // Omit to hide the restart prompt entirely (e.g. a caller that doesn't
  // consider its job PATH-affecting).
  offerRestart?: boolean
  // Overrides the header verb text (defaults to kind's "설치"/"삭제") - used
  // by Mise.tsx's deactivate/reactivate actions, which run the same
  // install/uninstall job machinery under a different user-facing label.
  actionLabel?: string
}

const RESTART_OUTCOME_TEXT: Record<RestartOutcome, string> = {
  restarted: '재시작을 요청했습니다.',
  declined: '',
  error: '재시작 요청에 실패했습니다. Supervisor 탭에서 직접 재시작해 주세요.',
}

export function JobPanel({ kind, toolLabel, status, onClose, offerRestart = true, actionLabel }: JobPanelProps) {
  const [restartOutcome, setRestartOutcome] = useState<RestartOutcome | null>(null)

  const jobDone = status !== null && !status.running
  const jobFailed = jobDone && status!.exitCode !== 0

  async function handleRestartClick() {
    const outcome = await confirmAndRestartCodeServer()
    setRestartOutcome(outcome)
  }

  return (
    <div className={`mise-job-panel${jobDone ? (jobFailed ? ' mise-job-error' : ' mise-job-success') : ''}`}>
      <div className="mise-job-header">
        <strong>
          {actionLabel ?? (kind === 'install' ? '설치' : '삭제')}: {toolLabel}
        </strong>
        <span className="mise-job-status">
          {!status
            ? '시작하는 중...'
            : status.running
              ? '진행 중...'
              : jobFailed
                ? `실패 (exit ${status.exitCode})`
                : '완료'}
        </span>
      </div>
      <pre className="mise-job-log">{(status?.lines ?? []).join('\n') || '(출력 대기 중)'}</pre>
      {jobDone && !jobFailed && offerRestart && (
        <div className="mise-restart-note">
          <span>code-server에 반영하려면 재시작이 필요합니다.</span>
          <button type="button" className="btn btn-secondary btn-small" onClick={handleRestartClick}>
            지금 재시작
          </button>
          {restartOutcome && restartOutcome !== 'declined' && (
            <span className={restartOutcome === 'error' ? 'mise-restart-result-error' : 'mise-restart-result'}>
              {RESTART_OUTCOME_TEXT[restartOutcome]}
            </span>
          )}
        </div>
      )}
      <button type="button" className="btn btn-secondary btn-small" onClick={onClose}>
        닫기
      </button>
    </div>
  )
}
