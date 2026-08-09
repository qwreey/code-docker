import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ExpandableEditor } from '../common/ExpandableEditor'
import { withViewTransition } from '../../utils/viewTransition'

export function RawConfigEditor() {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // Snapshot of what the editor last loaded/saved, so handleSave can detect
  // whether .gitconfig changed elsewhere (e.g. user info saved via the
  // structured form) while this editor sat open with stale content, instead
  // of silently clobbering it (previously could wipe the file to 0 bytes).
  const loadedContentRef = useRef('')

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ content: string }>('/git/config/raw')
      setContent(data.content)
      loadedContentRef.current = data.content
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
      const latest = await api.get<{ content: string }>('/git/config/raw')
      if (latest.content !== loadedContentRef.current) {
        setError('다른 곳에서 이 설정이 이미 바뀌었어요 — 새로고침한 뒤 다시 편집해주세요. 지금 저장하면 그 변경이 사라집니다.')
        return
      }
      await api.put<{ ok: true }>('/git/config/raw', { content })
      loadedContentRef.current = content
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
