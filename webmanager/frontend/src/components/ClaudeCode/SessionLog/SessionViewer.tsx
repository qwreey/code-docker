import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../../api/client'
import type { ClaudeSessionInfo, ClaudeSessionLinesResponse } from '../../../api/types'
import { ErrorBanner } from '../../common/ErrorBanner'
import { AssistantContent, UserContent } from './ContentBlocks'
import { isNoiseUserEntry, parseConversationLine, type AssistantEntry, type UserEntry } from './entryTypes'

const PAGE_SIZE = 500
// Hard cap on lines fetched for one session — a runaway "더 보기" clicking
// spree on a multi-megabyte transcript shouldn't be able to balloon the
// tab's memory unbounded (mirrors Logs.tsx's MAX_ENTRIES cap).
const MAX_LINES = 10000

export function SessionViewer({ session, onBack }: { session: ClaudeSessionInfo; onBack: () => void }) {
  const [rawLines, setRawLines] = useState<string[]>([])
  const [cursor, setCursor] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadPage = useCallback(
    async (from: number, append: boolean) => {
      try {
        const res = await api.get<ClaudeSessionLinesResponse>(
          `/claude/sessions/${encodeURIComponent(session.project)}/${encodeURIComponent(session.sessionId)}?cursor=${from}&limit=${PAGE_SIZE}`,
        )
        setRawLines((prev) => (append ? [...prev, ...res.lines] : res.lines))
        setCursor(res.cursor)
        setHasMore(res.hasMore)
        setError(null)
      } catch (e) {
        setError(errorMessage(e))
      }
    },
    [session.project, session.sessionId],
  )

  useEffect(() => {
    setLoading(true)
    loadPage(0, false).finally(() => setLoading(false))
  }, [loadPage])

  async function handleLoadMore() {
    setLoadingMore(true)
    await loadPage(cursor, true)
    setLoadingMore(false)
  }

  const entries = rawLines
    .map(parseConversationLine)
    .filter((e): e is UserEntry | AssistantEntry => e !== null && (e.type === 'user' || e.type === 'assistant'))
    .filter((e) => !e.isMeta)
    .filter((e) => e.type !== 'user' || !isNoiseUserEntry(e))

  const atCap = rawLines.length >= MAX_LINES

  return (
    <div className="session-log-viewer">
      <div className="session-log-viewer-header">
        <button type="button" className="btn btn-secondary btn-small" onClick={onBack}>
          ← 목록으로
        </button>
        <div className="session-log-viewer-title">
          <div>{session.cwd || session.project}</div>
          <div className="session-log-viewer-subtitle">{session.sessionId}</div>
        </div>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <p className="empty-state">불러오는 중...</p>
      ) : entries.length === 0 ? (
        <p className="empty-state">표시할 대화 내용이 없습니다.</p>
      ) : (
        <div className="session-log-messages">
          {entries.map((entry) => (
            <div key={entry.uuid} className={`session-log-message session-log-message-${entry.type}`}>
              <div className="session-log-message-role">{entry.type === 'user' ? '사용자' : 'Claude'}</div>
              <div className="session-log-message-body">
                {entry.type === 'user' ? (
                  <UserContent content={entry.message.content} />
                ) : (
                  <AssistantContent content={entry.message.content} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && hasMore && !atCap && (
        <button type="button" className="btn btn-secondary" onClick={handleLoadMore} disabled={loadingMore}>
          {loadingMore ? '불러오는 중...' : '더 보기'}
        </button>
      )}
      {atCap && <p className="session-log-note">최대 {MAX_LINES.toLocaleString()}줄까지만 불러옵니다.</p>}
    </div>
  )
}
