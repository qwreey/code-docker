import { useCallback, useEffect, useState } from 'react'
import { api, apiUrl, errorMessage } from '../../api/client'
import type { FileEntry, FileOpResult, FileUploadResult } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
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

function summarizeFailures(results: FileOpResult[]): string | null {
  const failed = results.filter((r) => !r.ok)
  if (failed.length === 0) return null
  return `${failed.length}개 실패: ${failed.map((f) => `${f.path} (${f.error ?? '알 수 없는 오류'})`).join(', ')}`
}

export function FileManager() {
  const [pathStack, setPathStack] = useState<Crumb[]>([{ label: '홈', path: null }])
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
  const [bulkBusy, setBulkBusy] = useState(false)

  const currentPath = pathStack[pathStack.length - 1].path
  const currentDirPath = currentPath ?? resolvedRootPath

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

  useEffect(() => {
    setSelected(new Set())
  }, [currentPath])

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

  async function submitRename(entry: FileEntry, newName: string) {
    if (!newName || newName === entry.name) {
      setRenamingPath(null)
      return
    }
    setRenameBusy(true)
    try {
      await api.post<{ ok: true }>('/files/rename', { path: entry.path, newName })
      setRenamingPath(null)
      setError(null)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRenameBusy(false)
    }
  }

  async function handleDelete(paths: string[]) {
    if (paths.length === 0) return
    if (!window.confirm(`${paths.length}개 항목을 삭제하시겠습니까?`)) return
    try {
      const res = await api.post<{ results: FileOpResult[] }>('/files/delete', { items: paths })
      setError(summarizeFailures(res.results))
      setSelected(new Set())
      await load()
    } catch (e) {
      setError(errorMessage(e))
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

  async function handleUpload(files: FileList) {
    if (currentDirPath === null) {
      setError('현재 디렉토리 경로를 확인할 수 없어 업로드할 수 없습니다.')
      return
    }
    setUploading(true)
    setUploadSummary(null)
    try {
      const fd = new FormData()
      fd.append('dir', currentDirPath)
      for (const f of Array.from(files)) fd.append('files', f)
      const res = await fetch(apiUrl('/files/upload'), { method: 'POST', body: fd })
      if (!res.ok) {
        throw new Error(`업로드 요청이 실패했습니다 (${res.status})`)
      }
      const data: { results: FileUploadResult[] } = await res.json()
      const ok = data.results.filter((r) => r.ok).length
      const failed = data.results.filter((r) => !r.ok)
      setUploadSummary(
        failed.length === 0
          ? `${ok}개 성공`
          : `${ok}개 성공, ${failed.length}개 실패: ${failed.map((f) => f.name).join(', ')}`,
      )
      setError(null)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setUploading(false)
    }
  }

  async function submitBulk(destDir: string) {
    if (!bulkMode) return
    setBulkBusy(true)
    try {
      const res = await api.post<{ results: FileOpResult[] }>(`/files/${bulkMode}`, {
        items: Array.from(selected),
        destDir,
      })
      setError(summarizeFailures(res.results))
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
      <div className="section-header">
        <h1>Files</h1>
        <button type="button" className="btn btn-secondary btn-small" onClick={load} disabled={loading}>
          {loading ? '불러오는 중...' : '새로고침'}
        </button>
      </div>
      <p className="section-description">
        컨테이너 파일시스템을 code-server가 열어둔 프로젝트 폴더에 국한되지 않고 탐색합니다.
      </p>

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
              if (files && files.length > 0) handleUpload(files)
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
          onDelete={(entry) => handleDelete([entry.path])}
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
        <button type="button" className="btn btn-danger btn-small" onClick={() => handleDelete(Array.from(selected))}>
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
          onConfirm={submitBulk}
        />
      )}
    </section>
  )
}
