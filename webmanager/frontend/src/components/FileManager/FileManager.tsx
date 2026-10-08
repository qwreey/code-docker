import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Terminal as TerminalIcon } from 'lucide-react'
import { api, apiUrl, ApiError, errorMessage } from '../../api/client'
import type { FileEntry, FileOpResult, FileUploadResult } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { FileTable } from './FileTable'
import { InfoPanel } from './InfoPanel'
import { FileEditorSheet } from './FileEditorSheet'
import { DestinationDialog } from './DestinationDialog'
import '../common/common.css'
import './FileManager.css'
import { withViewTransition } from '../../utils/viewTransition'

interface Crumb {
  label: string
  path: string | null
}

function dirnamePosix(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return '/'
  return p.slice(0, idx)
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

function basenamePosix(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(idx + 1) || p : p
}

// "Already exists" is not reported as a failure: those items go to the
// overwrite question instead (see the *Conflict state below).
function summarizeFailures(results: FileOpResult[]): string | null {
  const failed = results.filter((r) => !r.ok && !r.exists)
  if (failed.length === 0) return null
  return `${failed.length}개 실패: ${failed.map((f) => `${f.path} (${f.error ?? '알 수 없는 오류'})`).join(', ')}`
}

export function FileManager({
  initialPath,
  onInitialPathConsumed,
  onOpenTerminal,
  onPathChange,
  embedded,
}: {
  initialPath?: string | null
  onInitialPathConsumed?: () => void
  onOpenTerminal?: (cwd: string) => void
  // Reports the folder currently being browsed so App.tsx can keep it in the
  // URL (?path=...), which makes a reload land back where you were and a
  // folder bookmarkable.
  onPathChange?: (path: string | null) => void
  // Set when rendered inside FileManagerDialog rather than as its own tab:
  // the dialog's own header already says what this is, so the page heading
  // and description would just be a second title stealing vertical space.
  embedded?: boolean
} = {}) {
  const [pathStack, setPathStack] = useState<Crumb[]>(() =>
    initialPath ? [{ label: '홈', path: null }, { label: basenamePosix(initialPath), path: initialPath }] : [{ label: '홈', path: null }],
  )
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [resolvedRootPath, setResolvedRootPath] = useState<string | null>(null)

  const [infoTarget, setInfoTarget] = useState<FileEntry | null>(null)
  const [editingEntry, setEditingEntry] = useState<FileEntry | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)

  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  const [mkdirBusy, setMkdirBusy] = useState(false)

  const [uploading, setUploading] = useState(false)
  const [uploadSummary, setUploadSummary] = useState<string | null>(null)

  const [bulkMode, setBulkMode] = useState<'move' | 'copy' | null>(null)
  // Nothing is replaced without asking. The backend refuses an existing
  // destination (409 / exists: true); these hold what to re-send with
  // overwrite set if the user says so.
  const [renameConflict, setRenameConflict] = useState<{ entry: FileEntry; newName: string } | null>(null)
  const [uploadConflict, setUploadConflict] = useState<File[] | null>(null)
  const [bulkConflict, setBulkConflict] = useState<{ mode: 'move' | 'copy'; destDir: string; items: string[] } | null>(null)
  const [confirmDeletePaths, setConfirmDeletePaths] = useState<string[] | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)

  const currentPath = pathStack[pathStack.length - 1].path
  const currentDirPath = currentPath ?? resolvedRootPath

  useEffect(() => {
    onPathChange?.(currentPath)
  }, [currentPath, onPathChange])

  // Same-origin fallback: nginx serves code-server (/) and webmanager (/manager)
  // from the same origin/port, so the page webmanager is loaded from is also
  // code-server's origin in the common case (see ProjectTable.tsx, which does
  // the same thing for the Projects tab). FileManager isn't handed
  // WEBMANAGER_CODE_SERVER_URL from the backend at all - it's only plumbed
  // through the Projects scan API response - so this always falls back to
  // window.location.origin rather than adding a new prop/API for it.
  function codeServerHref(path: string): string {
    return `${window.location.origin}/?folder=${encodeURIComponent(path)}`
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = currentPath ? `?path=${encodeURIComponent(currentPath)}` : ''
      const data = await api.get<FileEntry[]>(`/files/list${qs}`)
      setEntries(data)
      setError(null)
      if (currentPath === null && data.length > 0) {
        setResolvedRootPath(dirnamePosix(data[0].path))
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      withViewTransition(() => setLoading(false))
    }
  }, [currentPath])

  useEffect(() => {
    load()
  }, [load])

  // Consumes an "open in file manager" request handed down from another tab
  // (Projects/Terminal, see App.tsx's openInFileManager) - runs once on
  // mount only, since FileManager fully unmounts whenever its tab isn't
  // active (see App.tsx), so a fresh mount is exactly the one moment a
  // still-pending request should apply; pathStack's own initializer above
  // already consumed initialPath itself, this just lets App.tsx clear it.
  useEffect(() => {
    if (initialPath) onInitialPathConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setSelected(new Set())
  }, [currentPath])

  // "홈" (path null) is where the backend opens, WEBMANAGER_FILES_HOME; the
  // root it may browse up to is usually above it (the whole container), so
  // that one gets a crumb of its own in front.
  useEffect(() => {
    let cancelled = false
    api
      .get<{ root: string; home: string }>('/files/home')
      .then(({ root, home }) => {
        if (cancelled || root === home) return
        setPathStack((prev) => (prev[0]?.path === null ? [{ label: '루트', path: root }, ...prev] : prev))
      })
      .catch(() => {
        // no way up then - the listing itself still works
      })
    return () => {
      cancelled = true
    }
  }, [])

  function openDir(entry: FileEntry) {
    setPathStack((prev) => [...prev, { label: entry.name, path: entry.path }])
  }

  function navigateToCrumb(index: number) {
    setPathStack((prev) => prev.slice(0, index + 1))
  }

  function toggleSelect(path: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected((prev) => (prev.size === entries.length ? new Set() : new Set(entries.map((e) => e.path))))
  }

  function handleDownload(entry: FileEntry) {
    window.location.href = apiUrl(`/files/download?path=${encodeURIComponent(entry.path)}`)
  }

  async function submitRename(entry: FileEntry, newName: string, overwrite = false) {
    if (!newName || newName === entry.name) {
      setRenamingPath(null)
      return
    }
    setRenameBusy(true)
    try {
      await api.post<{ ok: true }>('/files/rename', { path: entry.path, newName, overwrite })
      setRenamingPath(null)
      setRenameConflict(null)
      setError(null)
      await load()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && !overwrite) {
        setRenameConflict({ entry, newName })
      } else {
        setRenameConflict(null)
        setError(errorMessage(e))
      }
    } finally {
      setRenameBusy(false)
    }
  }

  async function handleDelete(paths: string[]) {
    if (paths.length === 0) return
    setDeleteBusy(true)
    try {
      const res = await api.post<{ results: FileOpResult[] }>('/files/delete', { items: paths })
      setError(summarizeFailures(res.results))
      setSelected(new Set())
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDeleteBusy(false)
      setConfirmDeletePaths(null)
    }
  }

  async function submitMkdir() {
    const name = mkdirName.trim()
    if (!name || currentDirPath === null) return
    setMkdirBusy(true)
    try {
      await api.post<{ ok: true }>('/files/mkdir', { path: joinPath(currentDirPath, name) })
      setMkdirOpen(false)
      setMkdirName('')
      setError(null)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setMkdirBusy(false)
    }
  }

  async function handleUpload(files: File[], overwrite = false) {
    if (currentDirPath === null) {
      setError('현재 디렉토리 경로를 확인할 수 없어 업로드할 수 없습니다.')
      return
    }
    setUploading(true)
    setUploadSummary(null)
    try {
      const fd = new FormData()
      // Both fields must come before the file parts (handleFilesUpload).
      fd.append('dir', currentDirPath)
      if (overwrite) fd.append('overwrite', 'true')
      for (const f of files) fd.append('files', f)
      const res = await fetch(apiUrl('/files/upload'), { method: 'POST', body: fd })
      if (!res.ok) {
        throw new Error(`업로드 요청이 실패했습니다 (${res.status})`)
      }
      const data: { results: FileUploadResult[] } = await res.json()
      const ok = data.results.filter((r) => r.ok).length
      const failed = data.results.filter((r) => !r.ok && !r.exists)
      const existing = new Set(data.results.filter((r) => r.exists).map((r) => r.name))
      setUploadSummary(
        failed.length === 0
          ? `${ok}개 성공`
          : `${ok}개 성공, ${failed.length}개 실패: ${failed.map((f) => `${f.name} (${f.error ?? '알 수 없는 오류'})`).join(', ')}`,
      )
      setUploadConflict(existing.size > 0 ? files.filter((f) => existing.has(f.name)) : null)
      setError(null)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setUploading(false)
    }
  }

  async function submitBulk(
    destDir: string,
    mode = bulkMode,
    items = Array.from(selected),
    overwrite = false,
  ) {
    if (!mode) return
    setBulkBusy(true)
    try {
      const res = await api.post<{ results: FileOpResult[] }>(`/files/${mode}`, {
        items,
        destDir,
        overwrite,
      })
      setError(summarizeFailures(res.results))
      const existing = res.results.filter((r) => r.exists).map((r) => r.path)
      setBulkConflict(existing.length > 0 ? { mode, destDir, items: existing } : null)
      setBulkMode(null)
      setSelected(new Set())
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <section>
      {!embedded && (
        <>
          <div className="section-header">
            <h1>Files</h1>
            <button type="button" className="btn btn-secondary btn-small" onClick={load} disabled={loading}>
              {loading ? '불러오는 중...' : '새로고침'}
            </button>
          </div>
          <p className="section-description">
            컨테이너 파일시스템을 code-server가 열어둔 프로젝트 폴더에 국한되지 않고 탐색합니다.
          </p>
        </>
      )}

      <nav className="file-manager-breadcrumb" aria-label="현재 위치">
        {pathStack.map((crumb, i) => (
          <span key={i} className="file-manager-breadcrumb-item">
            {i > 0 && <span className="file-manager-breadcrumb-sep">/</span>}
            <button type="button" disabled={i === pathStack.length - 1} onClick={() => navigateToCrumb(i)}>
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="file-manager-toolbar">
        {onOpenTerminal && (
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={currentDirPath === null}
            onClick={() => currentDirPath !== null && onOpenTerminal(currentDirPath)}
            title="현재 디렉토리를 터미널에서 열기"
          >
            <TerminalIcon size={14} /> 터미널에서 열기
          </button>
        )}
        {/* Must be a real <a href>, not a JS window.open handler: that's what lets
            middle-click/ctrl-click open a new tab natively, and target="_top" is
            what breaks out of the surrounding iframe when webmanager is embedded
            (e.g. from code-server's own launcher). Don't "clean this up" into an
            onClick. */}
        <a
          href={currentDirPath !== null ? codeServerHref(currentDirPath) : undefined}
          target="_top"
          rel="noopener"
          className={`btn btn-secondary btn-small${currentDirPath === null ? ' btn-disabled-link' : ''}`}
          aria-disabled={currentDirPath === null}
          title="현재 디렉토리를 code-server에서 열기"
          onClick={(e) => {
            if (currentDirPath === null) e.preventDefault()
          }}
        >
          <ExternalLink size={14} /> code-server에서 열기
        </a>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={currentDirPath === null}
          onClick={() => setMkdirOpen((v) => !v)}
        >
          새 폴더
        </button>
        {mkdirOpen && (
          <form
            className="file-manager-inline-form"
            onSubmit={(e) => {
              e.preventDefault()
              submitMkdir()
            }}
          >
            <input
              value={mkdirName}
              onChange={(e) => setMkdirName(e.target.value)}
              placeholder="폴더 이름"
              autoFocus
              disabled={mkdirBusy}
            />
            <button type="submit" className="btn btn-primary btn-small" disabled={mkdirBusy || !mkdirName.trim()}>
              {mkdirBusy ? '생성 중...' : '생성'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              disabled={mkdirBusy}
              onClick={() => {
                setMkdirOpen(false)
                setMkdirName('')
              }}
            >
              취소
            </button>
          </form>
        )}
        <label className="btn btn-secondary btn-small file-manager-upload-label">
          {uploading ? '업로드 중...' : '업로드'}
          <input
            type="file"
            multiple
            hidden
            disabled={uploading || currentDirPath === null}
            onChange={(e) => {
              const files = e.target.files
              if (files && files.length > 0) handleUpload(Array.from(files))
              e.target.value = ''
            }}
          />
        </label>
      </div>
      {currentDirPath === null && (
        <div className="info-note">
          현재 디렉토리의 전체 경로를 확인할 수 없어 새 폴더/업로드를 사용할 수 없습니다 (빈 최상위 폴더).
        </div>
      )}
      {uploadSummary && <div className="info-note">{uploadSummary}</div>}

      {loading ? (
        <Skeleton />
      ) : (
        <FileTable
          entries={entries}
          selected={selected}
          renamingPath={renamingPath}
          renameBusy={renameBusy}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
          onOpenDir={openDir}
          onInfo={setInfoTarget}
          onDownload={handleDownload}
          onEdit={setEditingEntry}
          onDelete={(entry) => setConfirmDeletePaths([entry.path])}
          onStartRename={(entry) => setRenamingPath(entry.path)}
          onCancelRename={() => setRenamingPath(null)}
          onSubmitRename={submitRename}
        />
      )}

      {/* Always rendered (not conditionally mounted) and pinned via sticky
          bottom - reserves its own height at the bottom of .app-content's
          scroll area at all times so the first selection doesn't shift the
          table above it. Hidden via visibility (keeps its box, drops it from
          the a11y tree/tab order) rather than unmounting when empty. */}
      <div
        className={`file-manager-selection-toolbar${selected.size === 0 ? ' file-manager-selection-toolbar-empty' : ''}`}
      >
        <span className="file-manager-selection-count">{selected.size}개 선택됨</span>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setBulkMode('move')}>
          이동
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setBulkMode('copy')}>
          복사
        </button>
        <button type="button" className="btn btn-danger btn-small" onClick={() => setConfirmDeletePaths(Array.from(selected))}>
          삭제
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setSelected(new Set())}>
          선택 해제
        </button>
      </div>

      {infoTarget && <InfoPanel entry={infoTarget} onClose={() => setInfoTarget(null)} />}
      {editingEntry && (
        <FileEditorSheet entry={editingEntry} onClose={() => setEditingEntry(null)} onSaved={load} />
      )}
      {bulkMode && (
        <DestinationDialog
          mode={bulkMode}
          count={selected.size}
          initialDir={currentDirPath ?? ''}
          busy={bulkBusy}
          onCancel={() => setBulkMode(null)}
          onConfirm={(destDir) => submitBulk(destDir)}
        />
      )}

      <ConfirmDialog
        open={renameConflict !== null}
        onClose={() => setRenameConflict(null)}
        onConfirm={() => renameConflict && submitRename(renameConflict.entry, renameConflict.newName, true)}
        title="이미 있는 이름"
        confirmLabel="덮어쓰기"
        busy={renameBusy}
      >
        '{renameConflict?.newName}'이(가) 이미 있습니다. 바꾸면 기존 항목은 사라집니다.
      </ConfirmDialog>

      <ConfirmDialog
        open={uploadConflict !== null}
        onClose={() => setUploadConflict(null)}
        onConfirm={() => {
          const files = uploadConflict
          setUploadConflict(null)
          if (files) handleUpload(files, true)
        }}
        title="이미 있는 파일"
        confirmLabel="덮어쓰기"
        cancelLabel="건너뛰기"
        busy={uploading}
      >
        이 폴더에 이미 있어 올리지 않은 파일: {uploadConflict?.map((f) => f.name).join(', ')}. 덮어쓸까요?
      </ConfirmDialog>

      <ConfirmDialog
        open={bulkConflict !== null}
        onClose={() => setBulkConflict(null)}
        onConfirm={() => {
          const c = bulkConflict
          setBulkConflict(null)
          if (c) submitBulk(c.destDir, c.mode, c.items, true)
        }}
        title="이미 있는 항목"
        confirmLabel="덮어쓰기"
        cancelLabel="건너뛰기"
        busy={bulkBusy}
      >
        {bulkConflict?.destDir}에 같은 이름이 이미 있어 {bulkConflict?.mode === 'move' ? '이동' : '복사'}하지 않은 항목:{' '}
        {bulkConflict?.items.map(basenamePosix).join(', ')}. 덮어쓸까요? 폴더는 기존 폴더에 합쳐집니다.
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmDeletePaths !== null}
        onClose={() => setConfirmDeletePaths(null)}
        onConfirm={() => confirmDeletePaths && handleDelete(confirmDeletePaths)}
        title="삭제"
        confirmLabel="삭제"
        busy={deleteBusy}
      >
        {confirmDeletePaths?.length}개 항목을 삭제하시겠습니까?
      </ConfirmDialog>
    </section>
  )
}
