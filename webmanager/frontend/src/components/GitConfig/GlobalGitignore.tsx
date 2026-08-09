import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ExpandableEditor } from '../common/ExpandableEditor'
import { withViewTransition } from '../../utils/viewTransition'

interface ExcludesFile {
  path: string
  content: string
}

// Manages whatever file core.excludesFile points at (the system-wide
// gitignore — patterns here apply across every repo, unlike a repo's own
// .gitignore). Mirrors RawConfigEditor.tsx's load/save shape, including its
// stale-fetch guard: a fetch that resolves after the user already started
// editing must never silently clobber their in-progress edits, so handleSave
// re-fetches and compares against what was last loaded/saved before writing.
export function GlobalGitignore() {
  const [path, setPath] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const loadedContentRef = useRef('')

  const load = useCallback(async () => {
    try {
      const data = await api.get<ExcludesFile>('/git/config/excludes')
      setPath(data.path)
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
      const latest = await api.get<ExcludesFile>('/git/config/excludes')
      if (latest.content !== loadedContentRef.current) {
        setError('다른 곳에서 이 파일이 이미 바뀌었어요 — 새로고침한 뒤 다시 편집해주세요. 지금 저장하면 그 변경이 사라집니다.')
        return
      }
      await api.put<{ ok: true }>('/git/config/excludes', { content })
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
      <h2>시스템 전역 gitignore</h2>
      <p className="raw-config-note">
        여기에 등록한 패턴(예: <code>*-ignoreme*</code>)은 이 컨테이너 안의 모든 저장소에 공통으로 적용됩니다.
        {!loading && path && (
          <>
            {' '}
            대상 파일: <code>{path}</code>
          </>
        )}
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : (
        <>
          <ExpandableEditor
            value={content}
            onChange={setContent}
            language="plain"
            readOnly={false}
            triggerLabel="전역 gitignore 편집"
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
