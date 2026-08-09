import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { api, errorMessage } from '../../api/client'
import type { ClaudeMemory } from '../../api/types'
import { withViewTransition } from '../../utils/viewTransition'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import '../common/common.css'
import './ProjectMemoryPanel.css'

// Self-contained widget showing one project's Claude Code CLI auto-memory
// (CLAUDE_CONFIG_DIR/projects/<slug>/memory/ - see internal/claudememory).
// Takes only a filesystem `path`, no Projects-specific state/props, same
// idiom as GitStatusPanel (../common/Git/GitStatusPanel.tsx) so it can be
// dropped anywhere a project root is already known. Collapsed by default and
// fetched lazily on first expand - most projects have never had Claude Code
// run against them, so paying the request cost only when a user actually
// opens the section avoids extra load on every detail-sheet open.
export default function ProjectMemoryPanel({ path }: { path: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [memory, setMemory] = useState<ClaudeMemory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeFile, setActiveFile] = useState<string | null>(null)

  useEffect(() => {
    setOpen(false)
    setLoaded(false)
    setLoading(false)
    setMemory(null)
    setError(null)
    setActiveFile(null)
  }, [path])

  async function toggleOpen() {
    const next = !open
    setOpen(next)
    if (!next || loaded || loading) return

    setLoading(true)
    try {
      const res = await api.get<ClaudeMemory>(`/claude/memory?project=${encodeURIComponent(path)}`)
      setMemory(res)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoaded(true)
      withViewTransition(() => setLoading(false))
    }
  }

  const activeFileData = memory?.files.find((f) => f.filename === activeFile) ?? null

  return (
    <section className="claude-memory-panel-section">
      <button
        type="button"
        className="claude-memory-panel-toggle"
        onClick={toggleOpen}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="claude-memory-panel-title">Claude Code 메모리</span>
      </button>

      {open && (
        <div className="claude-memory-panel-body">
          {loading ? (
            <Skeleton />
          ) : error ? (
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          ) : !memory?.exists ? (
            <p className="empty-state">메모리 없음</p>
          ) : (
            <>
              {memory.index.length > 0 ? (
                <ul className="claude-memory-index-list">
                  {memory.index.map((entry) => (
                    <li key={entry.filename}>
                      <button
                        type="button"
                        className={`claude-memory-index-item ${activeFile === entry.filename ? 'active' : ''}`}
                        onClick={() => setActiveFile(activeFile === entry.filename ? null : entry.filename)}
                      >
                        <span className="claude-memory-index-title">{entry.title}</span>
                        {entry.summary && <span className="claude-memory-index-summary">{entry.summary}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : memory.files.length > 0 ? (
                // MEMORY.md missing/unparseable but individual files exist -
                // fall back to listing the files directly rather than
                // showing nothing.
                <ul className="claude-memory-index-list">
                  {memory.files.map((f) => (
                    <li key={f.filename}>
                      <button
                        type="button"
                        className={`claude-memory-index-item ${activeFile === f.filename ? 'active' : ''}`}
                        onClick={() => setActiveFile(activeFile === f.filename ? null : f.filename)}
                      >
                        <span className="claude-memory-index-title">{f.name || f.filename}</span>
                        {f.description && <span className="claude-memory-index-summary">{f.description}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty-state">메모리 없음</p>
              )}

              {activeFile && !activeFileData && (
                <p className="empty-state">파일을 찾을 수 없습니다.</p>
              )}

              {activeFileData && (
                <div className="claude-memory-file-view">
                  <div className="claude-memory-file-header">
                    <span className="claude-memory-file-name">{activeFileData.name || activeFileData.filename}</span>
                    {activeFileData.type && <span className="badge badge-gray">{activeFileData.type}</span>}
                  </div>
                  {activeFileData.description && (
                    <p className="claude-memory-file-description">{activeFileData.description}</p>
                  )}
                  <pre className="claude-memory-file-body">{activeFileData.body}</pre>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
