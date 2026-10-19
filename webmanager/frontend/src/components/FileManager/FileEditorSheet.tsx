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
  // content as last loaded or saved; anything else is unsaved, and closing
  // asks before dropping it.
  const [savedContent, setSavedContent] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // A failed load leaves no file to edit: showing an empty editor with a
  // save button would let one click replace the file with nothing.
  const [loadFailed, setLoadFailed] = useState(false)
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
    setLoadFailed(false)
    setError(null)
    try {
      const data = await api.get<FileContent>(`/files/content?path=${encodeURIComponent(entry.path)}`)
      setContent(data.content)
      setSavedContent(data.content)
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
        setLoadFailed(true)
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
    const body = content
    try {
      const res = await api.put<{ ok: true; version: string }>('/files/content', {
        path: entry.path,
        content: body,
        baseVersion: overwrite ? '' : version,
      })
      setVersion(res.version)
      setSavedContent(body)
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

  function requestClose() {
    if (content !== savedContent) setConfirmDiscard(true)
    else onClose()
  }

  return (
    <Sheet
      open
      onClose={requestClose}
      title={`편집 — ${entry.name}`}
      size="full"
      bodyClassName="sheet-body-flush file-editor-body"
      headerActions={
        !loading && !unsupported && !loadFailed ? (
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
      ) : loadFailed ? (
        <div className="empty-state">
          <p>파일을 불러오지 못했습니다.</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={load}>
            다시 시도
          </button>
        </div>
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
      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={onClose}
        title="저장하지 않은 편집이 있습니다"
        confirmLabel="버리고 닫기"
      >
        닫으면 저장하지 않은 편집은 사라집니다. 취소하면 편집기로 돌아갑니다.
      </ConfirmDialog>
    </Sheet>
  )
}
