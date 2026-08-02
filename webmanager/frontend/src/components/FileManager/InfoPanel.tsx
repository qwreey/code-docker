import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { FileEntry, FileStat } from '../../api/types'
import { formatBytes } from '../../utils/format'
import { ErrorBanner } from '../common/ErrorBanner'
import { Sheet } from '../common/Sheet'
import './FileManager.css'

export function InfoPanel({ entry, onClose }: { entry: FileEntry; onClose: () => void }) {
  const [stat, setStat] = useState<FileStat | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setStat(null)
    setError(null)
    api
      .get<FileStat>(`/files/stat?path=${encodeURIComponent(entry.path)}`)
      .then((data) => {
        if (!cancelled) setStat(data)
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [entry.path])

  return (
    <Sheet open onClose={onClose} title={`정보 — ${entry.name}`}>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <p className="empty-state">불러오는 중...</p>
      ) : stat ? (
        <dl className="file-manager-info-list">
          <div>
            <dt>경로</dt>
            <dd className="mono-cell">{stat.path}</dd>
          </div>
          <div>
            <dt>종류</dt>
            <dd>
              {stat.isDir ? '폴더' : '파일'}
              {stat.isSymlink ? ' (심볼릭 링크)' : ''}
            </dd>
          </div>
          {stat.isSymlink && stat.symlinkTarget && (
            <div>
              <dt>링크 대상</dt>
              <dd className="mono-cell">{stat.symlinkTarget}</dd>
            </div>
          )}
          {!stat.isDir && (
            <div>
              <dt>크기</dt>
              <dd>{formatBytes(stat.size)}</dd>
            </div>
          )}
          <div>
            <dt>권한</dt>
            <dd className="mono-cell">
              {stat.mode} ({stat.modeOctal})
            </dd>
          </div>
          <div>
            <dt>소유자 / 그룹</dt>
            <dd>
              {stat.owner ?? stat.uid} / {stat.group ?? stat.gid}
            </dd>
          </div>
          <div>
            <dt>수정 시각</dt>
            <dd>{new Date(stat.modTime).toLocaleString()}</dd>
          </div>
          <div>
            <dt>메타데이터 변경 시각</dt>
            <dd>{new Date(stat.changeTime).toLocaleString()}</dd>
          </div>
          <div>
            <dt>생성 시각</dt>
            <dd>
              {stat.createdTimeAvailable && stat.createdTime ? (
                new Date(stat.createdTime).toLocaleString()
              ) : (
                <>
                  {new Date(stat.changeTime).toLocaleString()}
                  <div className="file-manager-info-note">정확한 생성 시각 아님 (메타데이터 변경 시각)</div>
                </>
              )}
            </dd>
          </div>
        </dl>
      ) : null}
    </Sheet>
  )
}
