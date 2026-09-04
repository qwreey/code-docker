import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { GitAITrailerConfig, GitUserConfig } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

// The trailer an agent harness actually writes, used as the preview's input.
const SAMPLE_TRAILER = 'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>'
const SAMPLE_MODEL = 'Opus 5'

// Mirrors config/git/hooks/ai-trailer.sh. Kept here rather than asked of the
// backend because it has to update as the user types, with no round trip —
// it is one line of string building, and the hook stays the only thing that
// touches a real commit.
function buildPreview(
  name: string,
  email: string,
  keepModel: boolean,
): string | null {
  if (!name || !email) return null
  const model = keepModel && SAMPLE_MODEL ? ` (${SAMPLE_MODEL})` : ''
  return `Co-Authored-By: ${name}${model} <${email}>`
}

export function AiTrailer() {
  const [enabled, setEnabled] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [keepModel, setKeepModel] = useState(true)
  const [stripSession, setStripSession] = useState(true)
  const [hookActive, setHookActive] = useState(true)

  // For an honest preview of the empty-field fallback.
  const [gitUser, setGitUser] = useState<GitUserConfig>({ name: '', email: '' })

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.get<GitAITrailerConfig>('/git/ai-trailer'),
      api.get<GitUserConfig>('/git/config').catch(() => ({ name: '', email: '' })),
    ])
      .then(([data, user]) => {
        if (cancelled) return
        setEnabled(data.enabled)
        setName(data.name)
        setEmail(data.email)
        setKeepModel(data.keepModel)
        setStripSession(data.stripSession)
        setHookActive(data.hookActive)
        setGitUser(user)
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e))
      })
      .finally(() => {
        if (!cancelled) withViewTransition(() => setLoading(false))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const data = await api.put<GitAITrailerConfig>('/git/ai-trailer', {
        enabled,
        name,
        email,
        keepModel,
        stripSession,
      })
      setEnabled(data.enabled)
      setName(data.name)
      setEmail(data.email)
      setKeepModel(data.keepModel)
      setStripSession(data.stripSession)
      setHookActive(data.hookActive)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const effectiveName = name || gitUser.name
  const effectiveEmail = email || gitUser.email
  const preview = buildPreview(effectiveName, effectiveEmail, keepModel)

  return (
    <div className="card">
      <h2>AI 커밋 trailer</h2>
      <p className="section-description">
        에이전트가 붙이는 <code>Co-Authored-By</code> trailer를 지정한 이름/이메일로 바꿉니다.
        이메일 도메인이 <code>@anthropic.com</code>인 줄만 대상으로 하므로, 모델 이름이 바뀌어도
        계속 동작합니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : (
        <>
          {!hookActive && (
            <div className="warning-note">
              <span>
                <code>core.hooksPath</code>가 이 이미지의 훅 디렉터리를 가리키고 있지 않아, 여기서
                무엇을 켜도 실제 커밋에는 적용되지 않습니다. 직접 설정한 값이 있으면 그쪽에서{' '}
                <code>/etc/code-docker/git/hooks/hook-dispatch</code>로 체이닝하거나,
                <code>core.hooksPath</code>를 지우고 컨테이너를 다시 시작하세요.
              </span>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <label className="checkbox-option">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              trailer 치환 사용
            </label>

            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="aitrailer-name">이름</label>
                <input
                  id="aitrailer-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!enabled}
                  placeholder={gitUser.name ? `비우면 user.name (${gitUser.name})` : 'qwreey-bot'}
                />
              </div>
              <div className="form-field">
                <label htmlFor="aitrailer-email">이메일</label>
                <input
                  id="aitrailer-email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={!enabled}
                  placeholder={gitUser.email ? `비우면 user.email (${gitUser.email})` : 'bot@example.com'}
                />
              </div>
            </div>

            <label className="checkbox-option">
              <input
                type="checkbox"
                checked={keepModel}
                onChange={(e) => setKeepModel(e.target.checked)}
                disabled={!enabled}
              />
              모델 이름을 괄호로 남기기
            </label>

            <label className="checkbox-option">
              <input
                type="checkbox"
                checked={stripSession}
                onChange={(e) => setStripSession(e.target.checked)}
                disabled={!enabled}
              />
              <span>
                <code>Claude-Session:</code> 줄 제거 — 세션 URL이 커밋에 그대로 남지 않게 합니다
              </span>
            </label>

            <div className="aitrailer-preview">
              <div className="aitrailer-preview-label">미리보기</div>
              <div className="copyable-block">
                <code>
                  {SAMPLE_TRAILER}
                  {'\n'}
                  {'↓'}
                  {'\n'}
                  {!enabled
                    ? SAMPLE_TRAILER + '  (사용 안 함)'
                    : preview ?? SAMPLE_TRAILER + '  (이름/이메일이 모두 있어야 치환됩니다)'}
                </code>
              </div>
            </div>

            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? '저장하는 중...' : saved ? '저장됨' : '저장'}
            </button>
          </form>
        </>
      )}
    </div>
  )
}
