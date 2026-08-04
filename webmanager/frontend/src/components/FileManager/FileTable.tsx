import { useState } from 'react'
import type { FileEntry } from '../../api/types'
import { formatBytes } from '../../utils/format'
import './FileManager.css'

function RenameForm({
  entry,
  busy,
  onSubmit,
  onCancel,
}: {
  entry: FileEntry
  busy: boolean
  onSubmit: (newName: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(entry.name)

  return (
    <form
      className="file-manager-rename-form"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(value.trim())
      }}
    >
      <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus disabled={busy} />
      <button type="submit" className="btn btn-primary btn-small" disabled={busy || !value.trim()}>
        확인
      </button>
      <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={onCancel}>
        취소
      </button>
    </form>
  )
}

export function FileTable({
  entries,
  selected,
  renamingPath,
  renameBusy,
  onToggleSelect,
  onToggleSelectAll,
  onOpenDir,
  onInfo,
  onDownload,
  onEdit,
  onDelete,
  onStartRename,
  onCancelRename,
  onSubmitRename,
}: {
  entries: FileEntry[]
  selected: Set<string>
  renamingPath: string | null
  renameBusy: boolean
  onToggleSelect: (path: string) => void
  onToggleSelectAll: () => void
  onOpenDir: (entry: FileEntry) => void
  onInfo: (entry: FileEntry) => void
  onDownload: (entry: FileEntry) => void
  onEdit: (entry: FileEntry) => void
  onDelete: (entry: FileEntry) => void
  onStartRename: (entry: FileEntry) => void
  onCancelRename: () => void
  onSubmitRename: (entry: FileEntry, newName: string) => void
}) {
  if (entries.length === 0) {
    return <p className="empty-state">이 디렉토리는 비어 있습니다.</p>
  }

  const allSelected = entries.length > 0 && selected.size === entries.length

  return (
    <div className="table-wrapper">
      <table className="process-info-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleSelectAll}
                aria-label="전체 선택"
                title="전체 선택"
              />
            </th>
            <th>이름</th>
            <th>종류</th>
            <th>크기</th>
            <th>수정 시각</th>
            <th aria-label="동작" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.path} className={entry.isDir ? 'file-manager-row file-manager-row-dir' : 'file-manager-row'}>
              <td onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected.has(entry.path)}
                  onChange={() => onToggleSelect(entry.path)}
                  aria-label={`${entry.name} 선택`}
                />
              </td>
              <td className="file-manager-name-cell" onClick={() => entry.isDir && onOpenDir(entry)}>
                {renamingPath === entry.path ? (
                  <RenameForm
                    entry={entry}
                    busy={renameBusy}
                    onSubmit={(newName) => onSubmitRename(entry, newName)}
                    onCancel={onCancelRename}
                  />
                ) : (
                  <>
                    <span className="file-manager-name">{entry.name}</span>
                    {entry.isSymlink && entry.symlinkTarget && (
                      <span className="file-manager-symlink-target">→ {entry.symlinkTarget}</span>
                    )}
                  </>
                )}
              </td>
              <td>
                <span className="file-manager-type">{entry.isDir ? '폴더' : '파일'}</span>
                {entry.isSymlink && (
                  <span className="badge badge-yellow file-manager-symlink-badge">심볼릭 링크</span>
                )}
              </td>
              <td>{entry.isDir ? '-' : formatBytes(entry.size)}</td>
              <td>{new Date(entry.modTime).toLocaleString()}</td>
              <td>
                <div className="file-manager-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={(e) => {
                      e.stopPropagation()
                      onInfo(entry)
                    }}
                  >
                    정보
                  </button>
                  {!entry.isDir && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDownload(entry)
                      }}
                    >
                      다운로드
                    </button>
                  )}
                  {!entry.isDir && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={(e) => {
                        e.stopPropagation()
                        onEdit(entry)
                      }}
                    >
                      편집
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={(e) => {
                      e.stopPropagation()
                      onStartRename(entry)
                    }}
                  >
                    이름변경
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-small"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(entry)
                    }}
                  >
                    삭제
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
