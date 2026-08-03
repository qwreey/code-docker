import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, errorMessage } from '../../api/client'
import type { ClaudeLoginStartResponse, ClaudeLoginStatus } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { CopyButton } from '../common/CopyButton'
import '../common/common.css'
import './ClaudeCode.css'

const LOGIN_POLL_INTERVAL_MS = 1000

type LoginPhase = 'idle' | 'running' | 'success' | 'failed' | 'expired'

// In-browser `claude` sign-in flow for the "설치되어 있지만 로그인 안 됨" state -
// starts the CLI login on the backend (POST /claude/login/start), polls its
// stdout/stderr for the sign-in URL (GET /claude/login/:id), and lets the
// user paste back the code the sign-in page shows (the documented fallback
// for browsers that can't reach the CLI's local OAuth callback - normal in a
// container, not an error case).
export function LoginPanel({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState<ClaudeLoginStatus | null>(null)
  const [phase, setPhase] = useState<LoginPhase>('idle')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [submittingCode, setSubmittingCode] = useState(false)

  const handleStart = useCallback(async () => {
    if (starting) return
    setStarting(true)
    setError(null)
    try {
      const res = await api.post<ClaudeLoginStartResponse>('/claude/login/start')
      setStatus(null)
      setCode('')
      setSessionId(res.sessionId)
      setPhase('running')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setStarting(false)
    }
  }, [starting])

  const handleReset = useCallback(() => {
    setSessionId(null)
    setStatus(null)
    setPhase('idle')
    setError(null)
    setCode('')
  }, [])

  // Poll while a session is running.
  useEffect(() => {
    if (phase !== 'running' || !sessionId) return
    let cancelled = false

    const poll = async () => {
      try {
        const res = await api.get<ClaudeLoginStatus>(`/claude/login/${encodeURIComponent(sessionId)}`)
        if (cancelled) return
        setStatus(res)
        if (res.exitCode === 0) {
          setPhase('success')
          onLoggedIn()
        } else if (res.exitCode !== null) {
          setPhase('failed')
        }
      } catch (e) {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 404) {
          // Session id stale/superseded - not retryable, let the user start over.
          setPhase('expired')
        } else {
          setError(errorMessage(e))
        }
      }
    }

    poll()
    const timer = setInterval(poll, LOGIN_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sessionId])

  // Best-effort cancel of the backend session whenever it's replaced (a new
  // login started, or the user reset) or the component unmounts (e.g. tab
  // switch) - not awaited, errors aren't surfaced, it's just tidy-up.
  useEffect(() => {
    if (!sessionId) return
    return () => {
      api.post(`/claude/login/${encodeURIComponent(sessionId)}/cancel`).catch(() => {})
    }
  }, [sessionId])

  async function handleSubmitCode() {
    if (!sessionId || !code.trim() || submittingCode) return
    setSubmittingCode(true)
    setError(null)
    try {
      await api.post<{ ok: true }>(`/claude/login/${encodeURIComponent(sessionId)}/code`, { code: code.trim() })
      setCode('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSubmittingCode(false)
    }
  }

  if (phase === 'idle') {
    return (
      <div className="claude-login-panel">
        <button type="button" className="btn btn-primary btn-small" onClick={handleStart} disabled={starting}>
          {starting ? '시작하는 중...' : '로그인'}
        </button>
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        <div className="claude-card-note">또는 터미널에서 claude 명령을 직접 실행해도 됩니다.</div>
      </div>
    )
  }

  if (phase === 'expired') {
    return (
      <div className="claude-login-panel">
        <div className="claude-login-message claude-login-error">세션이 만료되었습니다. 다시 시도해주세요.</div>
        <button type="button" className="btn btn-secondary btn-small" onClick={handleReset}>
          다시 시도
        </button>
      </div>
    )
  }

  const lines = status?.lines ?? []
  const url = status?.url ?? ''

  return (
    <div className="claude-login-panel">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {!url && phase === 'running' && (
        <div className="claude-login-message">로그인 프로세스를 시작하는 중...</div>
      )}

      {url && (
        <div className="claude-login-url-row">
          <span>아래 링크를 열어 로그인하세요:</span>
          <a href={url} target="_blank" rel="noopener noreferrer" className="claude-login-url">
            {url}
          </a>
          <CopyButton text={url} />
        </div>
      )}

      {url && phase === 'running' && (
        <div className="claude-login-code-row">
          <input
            type="text"
            className="claude-login-code-input"
            placeholder="로그인 코드 붙여넣기"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={submittingCode}
          />
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={handleSubmitCode}
            disabled={submittingCode || !code.trim()}
          >
            제출
          </button>
        </div>
      )}

      <pre className="claude-login-log">{lines.join('\n') || '(출력 대기 중)'}</pre>

      {phase === 'success' && <div className="claude-login-message claude-login-success">로그인에 성공했습니다.</div>}

      {phase === 'failed' && (
        <>
          <div className="claude-login-message claude-login-error">
            로그인에 실패했습니다{status && status.exitCode !== null ? ` (exit ${status.exitCode})` : ''}.
          </div>
          <button type="button" className="btn btn-secondary btn-small" onClick={handleReset}>
            다시 시도
          </button>
        </>
      )}
    </div>
  )
}
