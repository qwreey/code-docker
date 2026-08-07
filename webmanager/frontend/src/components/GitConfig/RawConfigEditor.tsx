import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import { ErrorBanner, Skeleton } from '@code-docker/router-frontend'
import { ExpandableEditor } from '../common/ExpandableEditor'
import { withViewTransition } from '../../utils/viewTransition'

export function RawConfigEditor() {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ content: string }>('/git/config/raw')
      setContent(data.content)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      withViewTransition(() => setLoading(false))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await api.put<{ ok: true }>('/git/config/raw', { content })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(`저장 실패 — 변경 사항이 적용되지 않았습니다: ${errorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <h2>원본 .gitconfig 편집</h2>
      <p className="raw-config-note">
        구조화된 설정 탭들이 최신 상태가 아닐 수 있으니 저장 후 새로고침하세요.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : (
        <>
          <ExpandableEditor
            value={content}
            onChange={setContent}
            language="ini"
            readOnly={false}
            triggerLabel="원본 편집 (.gitconfig)"
          />
          <div className="raw-config-actions">
            <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
              {saving ? '저장하는 중...' : saved ? '저장됨' : '저장'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
