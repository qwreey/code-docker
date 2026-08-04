import type { ProcessInfo } from '../../api/types'
import { buildHighlightSegments, type FuzzyMatchResult } from '../../utils/fuzzyMatch'
import { formatBytes, formatPercent } from '../../utils/format'
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
  return (
    <>
      <td className="pf-col-pid">{proc.pid}</td>
      <td className="pf-col-name" title={proc.name}>
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
      </td>
      <td className="pf-col-user">{proc.username || '-'}</td>
      <td className="pf-col-status">
        <span className="badge badge-gray">{proc.status}</span>
      </td>
      <td className="pf-col-cpu">{formatPercent(proc.cpuPercent)}</td>
      <td className="pf-col-mem">{formatPercent(proc.memPercent)}</td>
      <td className="pf-col-rss">{formatBytes(proc.rssBytes)}</td>
      <td className="pf-col-cmd process-cmdline" title={proc.cmdline}>
        <HighlightedText text={proc.cmdline || '-'} match={cmdMatch} />
      </td>
      <td className="pf-col-actions">
        <KillButtons pid={proc.pid} label={proc.name} onKilled={onKilled} onError={onError} />
      </td>
    </>
  )
}
