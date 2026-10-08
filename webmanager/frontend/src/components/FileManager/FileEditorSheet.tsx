import { Suspense, useCallback, useEffect, useState } from 'react'
import { WrapText } from 'lucide-react'
import { ApiError, api, errorMessage } from '../../api/client'
import type { FileContent, FileEntry } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { Sheet } from '../common/Sheet'
import { LazyCodeEditor } from '../common/LazyCodeEditor'
import './FileManager.css'

// Per-device UI preference, same try/catch-wrapped localStorage idiom as the
// rest of the app (see webmanager/CLAUDE.md's ground rules). Wrapping is the
// better default on a phone, which is where reading a long markdown line by
// scrolling sideways is genuinely painful — and where this editor is most
// often opened.
const WRAP_KEY = 'webmanager.files.editorWrap'

function loadWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) !== '0'
  } catch {
    return true
  }
}

function saveWrap(wrap: boolean) {
  try {
    if (wrap) localStorage.removeItem(WRAP_KEY)
    else localStorage.setItem(WRAP_KEY, '0')
  } catch {
    // localStorage unavailable (e.g. private browsing) - just won't persist
  }
}

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
  const [unsupported, setUnsupported] = useState<string | null>(null)
  // What the file was when loaded (or last saved). A save that finds
  // something else on disk - an agent or a terminal wrote it meanwhile - is
  // refused and asks before overwriting that change.
  const [version, setVersion] = useState('')
  const [changedOnDisk, setChangedOnDisk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [wrap, setWrapState] = useState(loadWrap)

  function toggleWrap() {
    setWrapState((prev) => {
      const next = !prev
      saveWrap(next)
      return next
    })
  }

  const load = useCallback(async () => {
    setLoading(true)
    setUnsupported(null)
    setError(null)
    try {
      const data = await api.get<FileContent>(`/files/content?path=${encodeURIComponent(entry.path)}`)
      setContent(data.content)
      setVersion(data.version)
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        setUnsupported(
          e.message.includes('UTF-8')
            ? 'UTF-8이 아닌 텍스트입니다. 여기서 고쳐 저장하면 글자가 깨지니 다운로드해서 여세요.'
            : '이 파일은 미리보기/편집을 지원하지 않습니다 — 다운로드해서 여세요.',
        )
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

  async function handleSave(overwrite = false) {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const res = await api.put<{ ok: true; version: string }>('/files/content', {
        path: entry.path,
        content,
        baseVersion: overwrite ? '' : version,
      })
      setVersion(res.version)
      setChangedOnDisk(false)
      setSaved(true)
      onSaved()
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setChangedOnDisk(true)
      } else {
        setError(`저장 실패 — 변경 사항이 적용되지 않았습니다: ${errorMessage(e)}`)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={`편집 — ${entry.name}`}
      size="full"
      bodyClassName="sheet-body-flush file-editor-body"
      headerActions={
        !loading && !unsupported ? (
          <>
            <button
              type="button"
              className={`btn btn-small ${wrap ? 'btn-primary' : 'btn-secondary'}`}
              onClick={toggleWrap}
              aria-pressed={wrap}
              title={wrap ? '줄바꿈 끄기 (가로 스크롤)' : '줄바꿈 켜기'}
            >
              <WrapText size={14} /> <span className="btn-label">{wrap ? '줄바꿈 켜짐' : '줄바꿈 꺼짐'}</span>
            </button>
            <button type="button" className="btn btn-primary btn-small" disabled={saving} onClick={() => handleSave()}>
              {saving ? '저장하는 중...' : saved ? '저장됨' : '저장'}
            </button>
          </>
        ) : undefined
      }
    >
      {error && (
        <div className="file-editor-notice">
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        </div>
      )}
      {loading ? (
        <p className="empty-state">불러오는 중...</p>
      ) : unsupported ? (
        <p className="empty-state">{unsupported}</p>
      ) : (
        <Suspense fallback={<div className="empty-state">에디터 불러오는 중...</div>}>
          <LazyCodeEditor value={content} onChange={setContent} language="plain" wrap={wrap} height="100%" />
        </Suspense>
      )}
      <ConfirmDialog
        open={changedOnDisk}
        onClose={() => setChangedOnDisk(false)}
        onConfirm={() => handleSave(true)}
        title="파일이 바깥에서 바뀌었습니다"
        confirmLabel="덮어쓰기"
        busy={saving}
      >
        연 뒤에 다른 곳(에이전트, 터미널 등)에서 이 파일을 고쳤습니다. 덮어쓰면 그 변경은 사라집니다. 취소하면 내
        편집은 이 창에 남고 파일은 그대로입니다.
      </ConfirmDialog>
    </Sheet>
  )
}
