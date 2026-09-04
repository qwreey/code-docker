import type { ReactNode } from 'react'
import type { ProcessInfo } from '../../api/types'
import { buildHighlightSegments, type FuzzyMatchResult } from '../../utils/fuzzyMatch'
import { formatBytes, formatPercent } from '../../utils/format'
import { COLUMN_ORDER, PROCESS_COLUMNS, columnClassName, type ColumnId } from './columns'
import { KillButtons } from './KillButtons'

// HighlightedText renders `text` plainly, or with fuzzy-matched characters
// wrapped in <mark> when `match` is a successful FuzzyMatchResult produced
// against this exact string.
export function HighlightedText({ text, match }: { text: string; match?: FuzzyMatchResult }) {
  if (!match || !match.matched || match.indices.length === 0) return <>{text}</>
  const segments = buildHighlightSegments(text, match.indices)
  return (
    <>
      {segments.map((seg, i) =>
        seg.matched ? (
          <mark key={i} className="process-match-highlight">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  )
}

export interface ProcessRowCellsProps {
  proc: ProcessInfo
  nameMatch?: FuzzyMatchResult
  cmdMatch?: FuzzyMatchResult
  // Tree-view-only: indentation depth and expand/collapse control, rendered
  // inline with the name cell so the flat list and the tree share one cell
  // layout instead of two divergent markups.
  indent?: number
  expandable?: boolean
  expanded?: boolean
  onToggleExpand?: () => void
  onKilled: () => void
  onError: (message: string) => void
}

// ProcessRowCells renders the <td> cells shared by ProcessTable's flat rows
// and ProcessTree's tree rows — kept as one function so a future column
// change (or kill-button change) only needs to happen once.
export function ProcessRowCells({
  proc,
  nameMatch,
  cmdMatch,
  indent = 0,
  expandable = false,
  expanded = false,
  onToggleExpand,
  onKilled,
  onError,
}: ProcessRowCellsProps) {
  // One cell's worth of content per column, keyed by the same ColumnId the
  // header (ProcessTable.tsx) renders from. Typed as `Record<ColumnId,
  // ReactNode>` rather than a loose object literal so this is the other
  // half of columns.ts's anti-drift guarantee: TypeScript won't compile this
  // function if a column present in COLUMN_ORDER has no entry here (or vice
  // versa), so a column can no longer be added to the header and forgotten
  // in the body, or the reverse.
  const cells: Record<ColumnId, ReactNode> = {
    pid: proc.pid,
    name: (
      <span className="process-name-cell" style={indent ? { paddingLeft: `${indent * 1.25}rem` } : undefined}>
        {expandable && (
          <button
            type="button"
            className="process-tree-toggle"
            onClick={onToggleExpand}
            aria-label={expanded ? '자식 프로세스 접기' : '자식 프로세스 펼치기'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        )}
        <HighlightedText text={proc.name} match={nameMatch} />
      </span>
    ),
    username: proc.username || '-',
    status: <span className="badge badge-gray">{proc.status}</span>,
    cpuPercent: formatPercent(proc.cpuPercent),
    memPercent: formatPercent(proc.memPercent),
    rssBytes: formatBytes(proc.rssBytes),
    cmd: <HighlightedText text={proc.cmdline || '-'} match={cmdMatch} />,
    actions: <KillButtons pid={proc.pid} label={proc.name} onKilled={onKilled} onError={onError} />,
  }

  // Per-row cell tooltips (the actual process name/cmdline value, truncated
  // by CSS ellipsis) - distinct from a column's static header tooltip
  // (`PROCESS_COLUMNS[id].title`, e.g. MEM's cgroup explanation), so this
  // stays separate from columns.ts rather than living there.
  const cellTitles: Partial<Record<ColumnId, string | undefined>> = {
    name: proc.name,
    cmd: proc.cmdline,
  }

  return (
    <>
      {COLUMN_ORDER.map((id) => {
        const col = PROCESS_COLUMNS[id]
        const className = columnClassName(col, col.bodyOnlyClassName)
        return (
          <td key={id} className={className} title={cellTitles[id]}>
            {cells[id]}
          </td>
        )
      })}
    </>
  )
}
