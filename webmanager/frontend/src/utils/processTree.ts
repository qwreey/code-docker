import type { ProcessInfo } from '../api/types'

export interface ProcessTreeNode {
  process: ProcessInfo
  children: ProcessTreeNode[]
}

// buildProcessTree turns the flat list GET /api/processes already returns
// into a parent/child tree, purely client-side (no backend change needed —
// process counts in a devcontainer are small and bounded, so server-side
// tree-building would be over-engineering).
//
// With no rootPid, every process whose ppid doesn't resolve to another
// process in the same list (orphans, or kernel threads reparented to pid 1)
// becomes a top-level root. With rootPid given, only the subtree rooted at
// that pid is returned (empty array if the pid isn't present) — this is
// what a future Supervisor per-program tree view needs, so the signature
// supports it now even though nothing calls it that way yet.
export function buildProcessTree(processes: ProcessInfo[], rootPid?: number): ProcessTreeNode[] {
  const byPid = new Map<number, ProcessInfo>()
  for (const p of processes) byPid.set(p.pid, p)

  const childrenByPpid = new Map<number, ProcessInfo[]>()
  for (const p of processes) {
    if (p.pid === p.ppid) continue // defensive: a process is never its own parent
    const siblings = childrenByPpid.get(p.ppid)
    if (siblings) siblings.push(p)
    else childrenByPpid.set(p.ppid, [p])
  }

  function buildNode(p: ProcessInfo): ProcessTreeNode {
    const children = (childrenByPpid.get(p.pid) ?? [])
      .slice()
      .sort((a, b) => a.pid - b.pid)
      .map(buildNode)
    return { process: p, children }
  }

  if (rootPid != null) {
    const root = byPid.get(rootPid)
    return root ? [buildNode(root)] : []
  }

  const roots = processes.filter((p) => p.pid !== p.ppid && !byPid.has(p.ppid))
  return roots
    .slice()
    .sort((a, b) => a.pid - b.pid)
    .map(buildNode)
}
