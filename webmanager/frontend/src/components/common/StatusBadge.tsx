import type { ProcessState } from '../../api/types'
import './common.css'

const COLOR_BY_STATE: Record<ProcessState, string> = {
  RUNNING: 'green',
  STOPPED: 'gray',
  STARTING: 'yellow',
  STOPPING: 'yellow',
  BACKOFF: 'yellow',
  EXITED: 'red',
  FATAL: 'red',
  UNKNOWN: 'gray',
}

export function StatusBadge({ state }: { state: ProcessState }) {
  const color = COLOR_BY_STATE[state] ?? 'gray'
  return <span className={`badge badge-${color}`}>{state}</span>
}
