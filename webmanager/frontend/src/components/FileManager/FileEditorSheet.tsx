import { Suspense, useCallback, useEffect, useState } from 'react'
import { ApiError, api, errorMessage } from '../../api/client'
import type { FileContent, FileEntry } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Sheet } from '../common/Sheet'
import { LazyCodeEditor } from '../common/LazyCodeEditor'
import './FileManager.css'

export function FileEditorSheet({
  entry,
  onClose,
  onSaved,
}: {
  entry: FileEntry
  onClose: () => void
  onSaved: () => void
}) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [unsupported, setUnsupported] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setUnsupported(false)
    setError(null)
    try {
      const data = await api.get<FileContent>(`/files/content?path=${encodeURIComponent(entry.path)}`)
      setContent(data.content)
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        setUnsupported(true)
      } else {
        setError(errorMessage(e))
      }
    } finally {
      setLoading(false)
    }
  }, [entry.path])

  useEffect(() => {
    load()
  }, [load])

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await api.put<{ ok: true }>('/files/content', { path: entry.path, content })
      setSaved(true)
      onSaved()
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(`저장 실패 — 변경 사항이 적용되지 않았습니다: ${errorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={`편집 — ${entry.name}`}
      headerActions={
        !loading && !unsupported ? (
          <button type="button" className="btn btn-primary btn-small" disabled={saving} onClick={handleSave}>
            {saving ? '저장하는 중...' : saved ? '저장됨' : '저장'}
          </button>
        ) : undefined
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <p className="empty-state">불러오는 중...</p>
      ) : unsupported ? (
        <p className="empty-state">이 파일은 미리보기/편집을 지원하지 않습니다 — 다운로드해서 여세요.</p>
      ) : (
        <Suspense fallback={<div className="empty-state">에디터 불러오는 중...</div>}>
          <LazyCodeEditor value={content} onChange={setContent} language="plain" height="60vh" />
        </Suspense>
      )}
    </Sheet>
  )
}
