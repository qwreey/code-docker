import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from './client'
import type { DnsBlocklistSource, DnsBlocklistSourcesResponse, DnsBuiltinBlocklistStatus } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { withViewTransition } from '../../utils/viewTransition'
import { BlocklistSourceDialog } from './BlocklistSourceDialog'

// BuiltinCard is split out from the custom-source list below it since it
// has an entirely different shape: no name/hosts editing, just an
// entryCount and (when the image shipped an updated blocklist since this
// was last seeded/acknowledged) a pull/ignore/compare decision - see
// router/.claude/dns-blocklist-management-plan.md's three-hash algorithm.
// dns.default.sh already silently re-applies the update on its own if the
// live copy was never touched, so by the time this card can show
// updateAvailable=true, it's always the "you customized this, please
// decide" case.
function BuiltinCard({
  entryCount,
  updateAvailable,
  onChanged,
}: {
  entryCount: number
  updateAvailable: boolean
  onChanged: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<DnsBuiltinBlocklistStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'pull' | 'ignore' | null>(null)

  async function loadStatus() {
    try {
      const data = await api.get<DnsBuiltinBlocklistStatus>('/blocklist-sources/builtin/status')
      setStatus(data)
      setStatusError(null)
    } catch (e) {
      setStatusError(errorMessage(e))
    }
  }

  async function handleExpand() {
    const next = !expanded
    setExpanded(next)
    if (next && !status) await loadStatus()
  }

  async function handlePull() {
    setBusy('pull')
    try {
      await api.post('/blocklist-sources/builtin/pull')
      setExpanded(false)
      setStatus(null)
      onChanged()
    } catch (e) {
      setStatusError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function handleIgnore() {
    setBusy('ignore')
    try {
      await api.post('/blocklist-sources/builtin/ignore')
      setExpanded(false)
      setStatus(null)
      onChanged()
    } catch (e) {
      setStatusError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2>
          builtin <span className="dns-source-meta">(이미지 내장, StevenBlack/hosts)</span>
        </h2>
        {updateAvailable && <span className="badge badge-yellow">업데이트 있음</span>}
      </div>
      <p className="section-description">{entryCount.toLocaleString()}개 호스트 차단 중.</p>
      {updateAvailable && (
        <>
          <button type="button" className="btn btn-secondary btn-small" onClick={handleExpand}>
            {expanded ? '접기' : '무엇이 바뀌었는지 보기'}
          </button>
          {expanded && (
            <div className="dns-diff-panel">
              {statusError && <ErrorBanner message={statusError} onDismiss={() => setStatusError(null)} />}
              {!status ? (
                <Skeleton />
              ) : (
                <>
                  <p className="section-description">
                    추가됨 {status.addedCount.toLocaleString()}개, 제거됨 {status.removedCount.toLocaleString()}개
                    {status.liveDiverged ? ' — 현재 목록은 웹 UI 또는 직접 편집으로 수정된 상태입니다.' : ''}
                  </p>
                  {status.addedSample.length > 0 && (
                    <details>
                      <summary>추가될 호스트 예시 ({status.addedSample.length}개 표시)</summary>
                      <ul className="dns-sample-list">
                        {status.addedSample.map((h) => (
                          <li key={h}>{h}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {status.removedSample.length > 0 && (
                    <details>
                      <summary>제거될 호스트 예시 ({status.removedSample.length}개 표시)</summary>
                      <ul className="dns-sample-list">
                        {status.removedSample.map((h) => (
                          <li key={h}>{h}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="dns-diff-actions">
                    <button type="button" className="btn btn-primary btn-small" disabled={busy !== null} onClick={handlePull}>
                      {busy === 'pull' ? '적용하는 중...' : '새 기본값 가져오기'}
                    </button>
                    <button type="button" className="btn btn-secondary btn-small" disabled={busy !== null} onClick={handleIgnore}>
                      {busy === 'ignore' ? '처리하는 중...' : '무시 (지금 목록 유지)'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function Blocklist() {
  const [data, setData] = useState<DnsBlocklistSourcesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ source: DnsBlocklistSource | null } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.get<DnsBlocklistSourcesResponse>('/blocklist-sources')
      setData(result)
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

  async function handleSave(name: string, hosts: string[]) {
    setSubmitting(true)
    setDialogError(null)
    try {
      if (dialog?.source) {
        await api.put(`/blocklist-sources/${encodeURIComponent(name)}`, { hosts })
      } else {
        await api.post('/blocklist-sources', { name, hosts })
      }
      setDialog(null)
      await load()
    } catch (e) {
      setDialogError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(sourceName: string) {
    setDeleting(sourceName)
    try {
      await api.del(`/blocklist-sources/${encodeURIComponent(sourceName)}`)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDeleting(null)
      setConfirmDelete(null)
    }
  }

  if (loading) return <Skeleton />
  if (!data) return error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null

  const builtin = data.sources.find((s) => s.builtin)
  const custom = data.sources.filter((s) => !s.builtin)

  return (
    <div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {data.duplicateHosts.length > 0 && (
        <div className="warning-note">
          <span aria-hidden="true">⚠</span>
          <span>
            {data.duplicateHosts.length}개 호스트 이름이 여러 소스(블록리스트/추가 호스트)에 동시에 등장합니다 —
            dnsmasq가 어느 쪽을 우선할지는 보장되지 않으니 겹치는 항목을 정리하는 걸 권장합니다:{' '}
            <code>{data.duplicateHosts.slice(0, 20).join(', ')}</code>
            {data.duplicateHosts.length > 20 ? ` 외 ${data.duplicateHosts.length - 20}개` : ''}
          </span>
        </div>
      )}

      {builtin && (
        <BuiltinCard entryCount={builtin.entryCount} updateAvailable={data.builtinUpdateAvailable} onChanged={load} />
      )}

      <div className="card">
        <div className="card-header">
          <h2>사용자 블록리스트</h2>
          <button type="button" className="btn btn-primary btn-small" onClick={() => setDialog({ source: null })}>
            블록리스트 추가
          </button>
        </div>
        <p className="section-description">직접 추가한 블록리스트 소스입니다. 여러 개를 만들 수 있습니다.</p>
        {custom.length === 0 ? (
          <p className="empty-state">등록된 사용자 블록리스트가 없습니다.</p>
        ) : (
          <div className="table-wrapper">
            <table className="dns-table">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>호스트 수</th>
                  <th aria-label="동작" className="table-actions-col" />
                </tr>
              </thead>
              <tbody>
                {custom.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td>{s.entryCount.toLocaleString()}</td>
                    <td className="table-actions-col">
                      <button type="button" className="btn btn-small" onClick={() => setDialog({ source: s })}>
                        편집
                      </button>{' '}
                      <button
                        type="button"
                        className="btn btn-danger btn-small"
                        disabled={deleting === s.name}
                        onClick={() => setConfirmDelete(s.name)}
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog && (
        <BlocklistSourceDialog
          source={dialog.source}
          submitting={submitting}
          error={dialogError}
          onCancel={() => setDialog(null)}
          onSave={handleSave}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete !== null && handleDelete(confirmDelete)}
        title="블록리스트 삭제"
        confirmLabel="삭제"
        busy={deleting !== null}
      >
        &quot;{confirmDelete}&quot; 블록리스트를 삭제하시겠습니까?
      </ConfirmDialog>
    </div>
  )
}
