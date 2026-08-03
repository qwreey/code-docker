import type { DindContainer } from '../../api/types'
import './Dind.css'

const COLOR_BY_STATE: Record<string, string> = {
  running: 'green',
  paused: 'yellow',
  restarting: 'yellow',
  created: 'gray',
  exited: 'red',
  dead: 'red',
}

function StateBadge({ state }: { state: string }) {
  const color = COLOR_BY_STATE[state] ?? 'gray'
  return <span className={`badge badge-${color}`}>{state || 'unknown'}</span>
}

type Action = 'start' | 'stop' | 'remove'

// Remove of a running container needs `docker rm -f`, which kills it without
// the graceful stop `docker stop` gives — the confirm copy must say so
// explicitly rather than silently forcing (dind-plan.md's M2 requirement).
function confirmRemove(container: DindContainer): { ok: boolean; force: boolean } {
  if (container.state === 'running') {
    const ok = window.confirm(
      `"${container.names}" 컨테이너가 실행 중입니다.\n\n강제 삭제를 진행하면 컨테이너를 즉시 종료(kill)한 뒤 삭제합니다. 안전하게 종료하려면 먼저 "정지" 버튼으로 정지한 후 삭제하세요.\n\n그래도 강제로 삭제하시겠습니까?`,
    )
    return { ok, force: true }
  }
  const ok = window.confirm(`"${container.names}" 컨테이너를 삭제하시겠습니까?\n\n이 작업은 되돌릴 수 없습니다.`)
  return { ok, force: false }
}

export function ContainerTable({
  containers,
  busy,
  onShowLogs,
  onInspect,
  onAction,
}: {
  containers: DindContainer[]
  busy: Record<string, boolean>
  onShowLogs: (container: DindContainer) => void
  onInspect: (container: DindContainer) => void
  onAction: (id: string, action: Action, force?: boolean) => void
}) {
  if (containers.length === 0) {
    return <p className="empty-state">dind에 컨테이너가 없습니다.</p>
  }

  function handleStart(c: DindContainer) {
    if (!window.confirm(`"${c.names}" 컨테이너를 시작하시겠습니까?`)) return
    onAction(c.id, 'start')
  }

  function handleStop(c: DindContainer) {
    if (!window.confirm(`"${c.names}" 컨테이너를 정지하시겠습니까?`)) return
    onAction(c.id, 'stop')
  }

  function handleRemove(c: DindContainer) {
    const { ok, force } = confirmRemove(c)
    if (!ok) return
    onAction(c.id, 'remove', force)
  }

  return (
    <div className="table-wrapper">
      <table className="process-info-table">
        <thead>
          <tr>
            <th>상태</th>
            <th>이름</th>
            <th>이미지</th>
            <th>명령어</th>
            <th>포트</th>
            <th>생성</th>
            <th>상태 메시지</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {containers.map((c) => {
            const isRunning = c.state === 'running'
            const isBusy = Boolean(busy[c.id])
            return (
              <tr key={c.id}>
                <td>
                  <StateBadge state={c.state} />
                </td>
                <td>{c.names}</td>
                <td>{c.image}</td>
                <td className="dind-command-cell">{c.command}</td>
                <td>{c.ports || '-'}</td>
                <td>{c.created}</td>
                <td>{c.status}</td>
                <td>
                  <div className="process-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={isRunning || isBusy}
                      onClick={() => handleStart(c)}
                    >
                      시작
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={!isRunning || isBusy}
                      onClick={() => handleStop(c)}
                    >
                      정지
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={isBusy}
                      onClick={() => handleRemove(c)}
                    >
                      삭제
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => onShowLogs(c)}
                    >
                      로그
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={() => onInspect(c)}
                    >
                      Inspect
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
