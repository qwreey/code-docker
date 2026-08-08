import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { GitUserConfig } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

export function GitUserForm() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .get<GitUserConfig>('/git/config')
      .then((data) => {
        if (cancelled) return
        setName(data.name)
        setEmail(data.email)
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
      const data = await api.put<GitUserConfig>('/git/config', { name, email })
      setName(data.name)
      setEmail(data.email)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <h2>사용자 정보</h2>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : (
        <form onSubmit={handleSubmit}>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="git-user-name">이름 (user.name)</label>
              <input id="git-user-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="git-user-email">이메일 (user.email)</label>
              <input
                id="git-user-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? '저장하는 중...' : saved ? '저장됨' : '저장'}
          </button>
        </form>
      )}
    </div>
  )
}
