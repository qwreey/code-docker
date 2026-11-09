// Minimal unified-diff renderer - no diff library is installed and this
// app avoids adding new dependencies for what pre-split-lines + CSS covers.
// Only line-prefix classification (+/-/@@/file-header/context), no
// intra-line word diffing.
export function DiffView({ text, truncated = false }: { text: string; truncated?: boolean }) {
  if (!text.trim()) {
    return <p className="empty-state">표시할 변경 사항이 없습니다.</p>
  }

  const lines = text.split('\n')

  return (
    <>
      {truncated && (
        <p className="warning-note">diff가 너무 커서 앞부분만 표시합니다. 전체는 터미널에서 git으로 확인하세요.</p>
      )}
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
    </>
  )
}
