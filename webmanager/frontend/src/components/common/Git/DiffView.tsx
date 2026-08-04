// Minimal unified-diff renderer - no diff library is installed and this
// app avoids adding new dependencies for what pre-split-lines + CSS covers.
// Only line-prefix classification (+/-/@@/file-header/context), no
// intra-line word diffing.
export function DiffView({ text }: { text: string }) {
  if (!text.trim()) {
    return <p className="empty-state">표시할 변경 사항이 없습니다.</p>
  }

  const lines = text.split('\n')

  return (
    <pre className="git-diff-view">
      {lines.map((line, i) => {
        let cls = 'git-diff-line-context'
        if (line.startsWith('+++') || line.startsWith('---')) {
          cls = 'git-diff-line-file'
        } else if (line.startsWith('@@')) {
          cls = 'git-diff-line-hunk'
        } else if (line.startsWith('+')) {
          cls = 'git-diff-line-add'
        } else if (line.startsWith('-')) {
          cls = 'git-diff-line-del'
        }
        return (
          <div key={i} className={`git-diff-line ${cls}`}>
            {line.length === 0 ? ' ' : line}
          </div>
        )
      })}
    </pre>
  )
}
