import type { SupervisorProcess } from '../../api/types'
import { formatDuration } from '../../utils/time'
import { StatusBadge } from '../common/StatusBadge'
import './Supervisor.css'

type Action = 'start' | 'stop' | 'restart'

interface ProcessTableProps {
  processes: SupervisorProcess[]
  busy: Record<string, boolean>
  onAction: (name: string, action: Action) => void
  onShowLogs: (name: string) => void
}

const ACTION_LABEL: Record<Action, string> = {
  start: '시작',
  stop: '정지',
  restart: '재시작',
}

function confirmAction(name: string, action: Action): boolean {
  if (action === 'stop' && (name === 'webmanager' || name === 'sshd')) {
    const extra =
      name === 'webmanager'
        ? '이 화면(webmanager) 자체가 멈춰서 다시 시작하려면 SSH/터미널 접근이 필요합니다.'
        : 'sshd가 멈추면 SSH 접근 경로가 끊깁니다.'
    return window.confirm(`"${name}" 프로세스를 정지하시겠습니까?\n\n주의: ${extra}`)
  }
  return window.confirm(`"${name}" 프로세스를 ${ACTION_LABEL[action]}하시겠습니까?`)
}

export function ProcessTable({ processes, busy, onAction, onShowLogs }: ProcessTableProps) {
  if (processes.length === 0) {
    return <p className="empty-state">등록된 프로세스가 없습니다.</p>
  }

  function handleAction(name: string, action: Action) {
    if (!confirmAction(name, action)) return
    onAction(name, action)
  }

  return (
    <div className="table-wrapper">
      <table className="process-table">
        <thead>
          <tr>
            <th>이름</th>
            <th>그룹</th>
            <th>상태</th>
            <th>PID</th>
            <th>가동 시간</th>
            <th>설명</th>
            <th aria-label="동작" />
          </tr>
        </thead>
        <tbody>
          {processes.map((proc) => {
            const isRunning = proc.statename === 'RUNNING'
            const isTransitioning = proc.statename === 'STARTING' || proc.statename === 'STOPPING'
            const isBusy = Boolean(busy[proc.name])
            const uptime = isRunning ? formatDuration(proc.now - proc.start) : '-'

            return (
              <tr key={proc.name}>
                <td>{proc.name}</td>
                <td>{proc.group}</td>
                <td>
                  <StatusBadge state={proc.statename} />
                </td>
                <td>{proc.pid || '-'}</td>
                <td>{uptime}</td>
                <td className="process-description">{proc.description}</td>
                <td>
                  <div className="process-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={isRunning || isTransitioning || isBusy}
                      onClick={() => handleAction(proc.name, 'start')}
                    >
                      시작
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={!isRunning || isBusy}
                      onClick={() => handleAction(proc.name, 'stop')}
                    >
                      정지
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={isTransitioning || isBusy}
                      onClick={() => handleAction(proc.name, 'restart')}
                    >
                      재시작
                    </button>
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => onShowLogs(proc.name)}>
                      로그
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
