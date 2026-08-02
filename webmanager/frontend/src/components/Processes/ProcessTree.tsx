import { useMemo, useState } from 'react'
import type { ProcessInfo } from '../../api/types'
import type { FuzzyMatchResult } from '../../utils/fuzzyMatch'
import { buildProcessTree, type ProcessTreeNode } from '../../utils/processTree'
import { ProcessRowCells } from './ProcessRow'

interface FlatEntry {
  node: ProcessTreeNode
  depth: number
}

function flatten(nodes: ProcessTreeNode[], depth: number, collapsed: Set<number>, out: FlatEntry[]) {
  for (const node of nodes) {
    out.push({ node, depth })
    if (node.children.length > 0 && !collapsed.has(node.process.pid)) {
      flatten(node.children, depth + 1, collapsed, out)
    }
  }
}

interface ProcessTreeProps {
  processes: ProcessInfo[]
  matches?: Map<number, { nameMatch?: FuzzyMatchResult; cmdMatch?: FuzzyMatchResult }>
  onKilled: () => void
  onError: (message: string) => void
}

// ProcessTree renders buildProcessTree(processes) as an indented,
// expandable/collapsible tree of <tr> rows sharing ProcessRowCells with the
// flat table. Natural process hierarchy order (children sorted by pid) is
// used rather than the flat view's column sort — a process tree ordered by
// e.g. CPU% would scramble the parent/child relationships it exists to show.
export function ProcessTree({ processes, matches, onKilled, onError }: ProcessTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())

  // Rebuilding the tree only needs to happen when `processes` itself
  // changes (a new poll) - without this it also reran (allocating a whole
  // new node tree) on every collapse/expand click, since that's a state
  // update on this same component.
  const tree = useMemo(() => buildProcessTree(processes), [processes])
  const rows: FlatEntry[] = useMemo(() => {
    const out: FlatEntry[] = []
    flatten(tree, 0, collapsed, out)
    return out
  }, [tree, collapsed])

  function toggle(pid: number) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      return next
    })
  }

  if (rows.length === 0) {
    return <p className="empty-state">표시할 프로세스가 없습니다.</p>
  }

  return (
    <tbody>
      {rows.map(({ node, depth }) => {
        const m = matches?.get(node.process.pid)
        return (
          <tr key={node.process.pid}>
            <ProcessRowCells
              proc={node.process}
              nameMatch={m?.nameMatch}
              cmdMatch={m?.cmdMatch}
              indent={depth}
              expandable={node.children.length > 0}
              expanded={!collapsed.has(node.process.pid)}
              onToggleExpand={() => toggle(node.process.pid)}
              onKilled={onKilled}
              onError={onError}
            />
          </tr>
        )
      })}
    </tbody>
  )
}
