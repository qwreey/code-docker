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

export function ContainerTable({
  containers,
  onShowLogs,
}: {
  containers: DindContainer[]
  onShowLogs: (container: DindContainer) => void
}) {
  if (containers.length === 0) {
    return <p className="empty-state">dind에 컨테이너가 없습니다.</p>
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
          {containers.map((c) => (
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
                <button type="button" className="btn btn-secondary btn-small" onClick={() => onShowLogs(c)}>
                  로그
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
