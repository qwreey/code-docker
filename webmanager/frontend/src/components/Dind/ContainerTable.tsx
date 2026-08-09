import { useState } from 'react'
import type { DindContainer } from '../../api/types'
import { ConfirmDialog } from '../common/ConfirmDialog'
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

type PendingAction = { container: DindContainer; action: Action; force: boolean }

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
  const [pending, setPending] = useState<PendingAction | null>(null)

  if (containers.length === 0) {
    return <p className="empty-state">dind에 컨테이너가 없습니다.</p>
  }

  function handleConfirm() {
    if (!pending) return
    onAction(pending.container.id, pending.action, pending.force)
    setPending(null)
  }

  return (
    <>
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
                      onClick={() => setPending({ container: c, action: 'start', force: false })}
                    >
                      시작
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={!isRunning || isBusy}
                      onClick={() => setPending({ container: c, action: 'stop', force: false })}
                    >
                      정지
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={isBusy}
                      onClick={() => setPending({ container: c, action: 'remove', force: isRunning })}
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

    <ConfirmDialog
      open={pending !== null}
      onClose={() => setPending(null)}
      onConfirm={handleConfirm}
      title={
        pending?.action === 'start'
          ? '컨테이너 시작'
          : pending?.action === 'stop'
            ? '컨테이너 정지'
            : pending?.force
              ? '컨테이너 강제 삭제'
              : '컨테이너 삭제'
      }
      confirmLabel={pending?.action === 'start' ? '시작' : pending?.action === 'stop' ? '정지' : '삭제'}
      danger={pending?.action === 'remove'}
    >
      {pending?.action === 'start' && <p>&quot;{pending.container.names}&quot; 컨테이너를 시작하시겠습니까?</p>}
      {pending?.action === 'stop' && <p>&quot;{pending.container.names}&quot; 컨테이너를 정지하시겠습니까?</p>}
      {pending?.action === 'remove' && pending.force && (
        <>
          <p>&quot;{pending.container.names}&quot; 컨테이너가 실행 중입니다.</p>
          <p>
            강제 삭제를 진행하면 컨테이너를 즉시 종료(kill)한 뒤 삭제합니다. 안전하게 종료하려면 먼저 &quot;정지&quot;
            버튼으로 정지한 후 삭제하세요.
          </p>
          <p>그래도 강제로 삭제하시겠습니까?</p>
        </>
      )}
      {pending?.action === 'remove' && !pending.force && (
        <>
          <p>&quot;{pending.container.names}&quot; 컨테이너를 삭제하시겠습니까?</p>
          <p>이 작업은 되돌릴 수 없습니다.</p>
        </>
      )}
    </ConfirmDialog>
    </>
  )
}
