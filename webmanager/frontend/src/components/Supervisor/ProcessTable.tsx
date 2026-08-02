import { Fragment, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { ProcessInfo, SupervisorProcess } from '../../api/types'
import { buildProcessTree, type ProcessTreeNode } from '../../utils/processTree'
import { ErrorBanner } from '../common/ErrorBanner'
import { StatusBadge } from '../common/StatusBadge'
import { ProcessTree } from '../Processes/ProcessTree'
import { formatDuration } from '../../utils/time'
import '../Processes/Processes.css'
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

// A subtree is cached for this long before an expand re-fetches — process
// counts here are small and bounded (same reasoning as Processes tab), so a
// short cache just avoids a redundant round-trip when a user toggles a row
// closed and back open quickly, not a real freshness guarantee.
const TREE_CACHE_MS = 3000

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

// collectSubtree flattens a buildProcessTree(..., rootPid) result (root +
// all descendants) back into a flat ProcessInfo[], which is what ProcessTree
// (the Processes-tab tree renderer) expects — it computes its own
// parent/child relationships internally, so feeding it a list pre-scoped to
// just this subtree makes the supervised program's pid the tree's only root.
function collectSubtree(nodes: ProcessTreeNode[]): ProcessInfo[] {
  const out: ProcessInfo[] = []
  function walk(node: ProcessTreeNode) {
    out.push(node.process)
    node.children.forEach(walk)
  }
  nodes.forEach(walk)
  return out
}

export function ProcessTable({ processes, busy, onAction, onShowLogs }: ProcessTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [allProcesses, setAllProcesses] = useState<ProcessInfo[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [lastFetch, setLastFetch] = useState(0)

  async function loadProcesses(force = false) {
    if (!force && allProcesses.length > 0 && Date.now() - lastFetch < TREE_CACHE_MS) return
    setTreeLoading(true)
    try {
      const data = await api.get<ProcessInfo[]>('/processes')
      setAllProcesses(data)
      setLastFetch(Date.now())
      setTreeError(null)
    } catch (e) {
      setTreeError(errorMessage(e))
    } finally {
      setTreeLoading(false)
    }
  }

  function toggleTree(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
        loadProcesses()
      }
      return next
    })
  }

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
            const displayName = proc.label || proc.name
            const isExpanded = expanded.has(proc.name)

            const startDisabled = isRunning || isTransitioning || isBusy || proc.disableStart
            const stopDisabled = !isRunning || isBusy || proc.disableStop
            const restartDisabled = isTransitioning || isBusy || proc.disableRestart
            const logsDisabled = proc.disableLogs

            const startTitle = proc.disableStart && proc.note ? proc.note : undefined
            const stopTitle = proc.disableStop && proc.note ? proc.note : undefined
            const restartTitle = proc.disableRestart && proc.note ? proc.note : undefined
            const logsTitle = proc.disableLogs && proc.note ? proc.note : undefined

            const subtree = isExpanded ? collectSubtree(buildProcessTree(allProcesses, proc.pid)) : []

            return (
              <Fragment key={proc.name}>
                <tr>
                  <td>{displayName}</td>
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
                        disabled={startDisabled}
                        title={startTitle}
                        onClick={() => handleAction(proc.name, 'start')}
                      >
                        시작
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={stopDisabled}
                        title={stopTitle}
                        onClick={() => handleAction(proc.name, 'stop')}
                      >
                        정지
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={restartDisabled}
                        title={restartTitle}
                        onClick={() => handleAction(proc.name, 'restart')}
                      >
                        재시작
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={logsDisabled}
                        title={logsTitle}
                        onClick={() => onShowLogs(proc.name)}
                      >
                        로그
                      </button>
                      <button
                        type="button"
                        className="process-tree-toggle"
                        onClick={() => toggleTree(proc.name)}
                        aria-label={isExpanded ? '하위 프로세스 접기' : '하위 프로세스 펼치기'}
                      >
                        {isExpanded ? '▾' : '▸'}
                      </button>
                    </div>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="supervisor-tree-row">
                    <td colSpan={7}>
                      {treeError && <ErrorBanner message={treeError} onDismiss={() => setTreeError(null)} />}
                      {treeLoading && allProcesses.length === 0 ? (
                        <p className="empty-state">불러오는 중...</p>
                      ) : subtree.length === 0 ? (
                        <p className="empty-state">
                          {proc.pid ? '하위 프로세스가 없습니다.' : '프로세스가 실행 중이 아닙니다.'}
                        </p>
                      ) : (
                        <div className="table-wrapper">
                          <table className="process-info-table">
                            <thead>
                              <tr>
                                <th>PID</th>
                                <th>이름</th>
                                <th>사용자</th>
                                <th>상태</th>
                                <th>CPU</th>
                                <th>MEM</th>
                                <th>RSS</th>
                                <th>커맨드</th>
                                <th aria-label="동작" />
                              </tr>
                            </thead>
                            <ProcessTree
                              processes={subtree}
                              onKilled={() => loadProcesses(true)}
                              onError={setTreeError}
                            />
                          </table>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
