import { Fragment, useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { DevProxyInfo, DevProxyRoute } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { RouteDialog } from './RouteDialog'
import { withViewTransition } from '../../utils/viewTransition'
import './DevProxy.css'

function authSummary(routes: DevProxyRoute[]): string {
  if (routes.length === 0) return '-'
  const required = routes.filter((r) => r.requireAuth).length
  if (required === 0) return '없음'
  if (required === routes.length) return '요구'
  return '부분'
}

// Raw-fragment fallback editor — the whole *.caddy file as text, for
// exposes whose content doesn't round-trip through Render (hand-edited, or
// written under an older schema) and as an escape hatch when the structured
// route form can't express something. A plain <textarea>, not webmanager's
// CodeMirror-backed ExpandableEditor — kept this package's dependency
// footprint small rather than pulling in the whole CodeMirror toolchain for
// one rarely-used fallback path.
function RawPanel({ info, onSaved }: { info: DevProxyInfo; onSaved: () => void }) {
  const [raw, setRaw] = useState(info.raw)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setSubmitting(true)
    setError(null)
    try {
      await api.put(`/exposes/${encodeURIComponent(info.name)}`, { raw })
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="dev-proxy-edit-panel">
      <textarea
        className="dev-proxy-raw-textarea"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        spellCheck={false}
        rows={12}
      />
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="dev-proxy-edit-toggle">
        <button type="button" className="btn btn-primary btn-small" disabled={submitting} onClick={handleSave}>
          {submitting ? '저장하는 중...' : '저장'}
        </button>
      </div>
    </div>
  )
}

// A single identity field (name or host) edited inline with its own
// save/cancel — not a dialog, since it's one field at a time. onSave does
// the actual PUT (name-rename and host-edit send different bodies, see
// RoutesPanel below) and throws on failure; value only reverts on cancel.
function InlineFieldEditor({
  label,
  value: initialValue,
  onSave,
}: {
  label: string
  value: string
  onSave: (value: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(initialValue)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (value === initialValue) {
      setEditing(false)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSave(value)
      setEditing(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (!editing) {
    return (
      <p className="dev-proxy-host-line">
        {label}: <code>{initialValue}</code>{' '}
        <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
          편집
        </button>
      </p>
    )
  }

  return (
    <div className="dev-proxy-host-line">
      <input value={value} onChange={(e) => setValue(e.target.value)} disabled={submitting} />{' '}
      <button type="button" className="btn btn-primary btn-small" disabled={submitting} onClick={handleSave}>
        {submitting ? '저장하는 중...' : '저장'}
      </button>{' '}
      <button
        type="button"
        className="btn btn-small"
        disabled={submitting}
        onClick={() => {
          setValue(initialValue)
          setEditing(false)
        }}
      >
        취소
      </button>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
    </div>
  )
}

// Routes belonging to one expanded expose — small list + add/edit/delete,
// each change PUTs the whole route array back (same whole-fragment-overwrite
// contract UpdateStructured already had). host/name are carried along
// unchanged on every route-only save, since the backend re-renders the whole
// fragment. onSaved is called with the expose's new name when it was
// renamed, so the parent can keep it expanded under its new identity.
function RoutesPanel({ info, onSaved }: { info: DevProxyInfo; onSaved: (newName?: string) => void }) {
  const host = info.structured?.host ?? ''
  const routes = info.structured?.routes ?? []
  const [dialog, setDialog] = useState<{ index: number | null } | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null)
  const [showRaw, setShowRaw] = useState(false)

  async function putRoutes(next: DevProxyRoute[]) {
    await api.put(`/exposes/${encodeURIComponent(info.name)}`, { host, routes: next })
  }

  async function handleSaveRoute(route: DevProxyRoute) {
    setSubmitting(true)
    setDialogError(null)
    try {
      const next = [...routes]
      if (dialog?.index != null) {
        next[dialog.index] = route
      } else {
        next.push(route)
      }
      await putRoutes(next)
      setDialog(null)
      onSaved()
    } catch (e) {
      setDialogError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDeleteRoute(index: number) {
    if (!window.confirm('이 라우트를 삭제하시겠습니까?')) return
    setDeletingIndex(index)
    try {
      await putRoutes(routes.filter((_, i) => i !== index))
      onSaved()
    } finally {
      setDeletingIndex(null)
    }
  }

  if (showRaw) {
    return <RawPanel info={info} onSaved={onSaved} />
  }

  return (
    <div className="dev-proxy-routes-panel">
      <InlineFieldEditor
        label="이름"
        value={info.name}
        onSave={async (newName) => {
          await api.put(`/exposes/${encodeURIComponent(info.name)}`, { name: newName, host, routes })
          onSaved(newName)
        }}
      />
      <InlineFieldEditor
        label="host"
        value={host}
        onSave={async (newHost) => {
          await api.put(`/exposes/${encodeURIComponent(info.name)}`, { host: newHost, routes })
          onSaved()
        }}
      />
      {routes.length === 0 ? (
        <p className="empty-state">라우트가 없습니다. 아래에서 추가하세요.</p>
      ) : (
        <div className="table-wrapper">
          <table className="dev-proxy-table">
            <thead>
              <tr>
                <th>path</th>
                <th>target</th>
                <th>strip</th>
                <th>rewrite</th>
                <th>방식</th>
                <th>인증</th>
                <th aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {routes.map((rt, i) => (
                <tr key={i}>
                  <td>{rt.path || <em>전체</em>}</td>
                  <td>{rt.target}</td>
                  <td>{rt.stripPrefix || '-'}</td>
                  <td>{rt.rewritePrefix || '-'}</td>
                  <td>{rt.mode}</td>
                  <td>{rt.requireAuth ? '요구' : '없음'}</td>
                  <td>
                    <button type="button" className="btn btn-small" onClick={() => setDialog({ index: i })}>
                      편집
                    </button>{' '}
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      disabled={deletingIndex === i}
                      onClick={() => handleDeleteRoute(i)}
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
      <div className="dev-proxy-edit-toggle">
        <button type="button" className="btn btn-primary btn-small" onClick={() => setDialog({ index: null })}>
          라우트 추가
        </button>
        <button type="button" className="btn btn-small" onClick={() => setShowRaw(true)}>
          원본 편집
        </button>
      </div>

      {dialog && (
        <RouteDialog
          route={dialog.index != null ? routes[dialog.index] : null}
          submitting={submitting}
          error={dialogError}
          onCancel={() => setDialog(null)}
          onSave={handleSaveRoute}
        />
      )}
    </div>
  )
}

export function DevProxy() {
  const [exposes, setExposes] = useState<DevProxyInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [expandedName, setExpandedName] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<DevProxyInfo[]>('/exposes')
      setExposes(data)
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

  async function handleExposeSaved(newName?: string) {
    if (newName) setExpandedName(newName)
    await load()
  }

  function showNotice() {
    setNotice('저장됨 (caddy-adapter에 반영됨)')
    setTimeout(() => setNotice(null), 2500)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    try {
      await api.post('/exposes', { name, host, routes: [] })
      setExpandedName(name)
      setName('')
      setHost('')
      await load()
      showNotice()
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(exposeName: string) {
    if (!window.confirm(`"${exposeName}" expose를 삭제하시겠습니까?`)) return
    setDeleting(exposeName)
    try {
      await api.del(`/exposes/${encodeURIComponent(exposeName)}`)
      if (expandedName === exposeName) setExpandedName(null)
      await load()
      showNotice()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <section>
      <div className="section-header">
        <h1>Dev Proxy</h1>
      </div>
      <p className="section-description">
        컨테이너 안에서 뜬 dev 서버(예: <code>npm run dev</code>)를 도메인으로 노출합니다. expose마다 완전히 다른
        도메인을 써도 됩니다 — 공유 base 도메인 같은 건 없습니다.
      </p>
      <div className="card">
        <div className="info-note">
          <span aria-hidden="true">ℹ</span>
          <span>
            바깥 리버스 프록시가 원하는 요청의 path 앞에 <code>/exports</code>를 붙이고(Host는 그대로 두고) 이
            컨테이너(router)의 80번 포트로 그대로 넘기면 됩니다 — 안에서는 각 expose의 host 값과 실제 Host 헤더가
            일치하는지로 분배합니다. 인증(라우트별 "인증 요구")을 쓰려면{' '}
            <code>TINYAUTH_APPURL</code>/<code>TINYAUTH_AUTH_USERS</code>도 설정해야 합니다.
          </span>
        </div>
        <div className="info-note">
          <span aria-hidden="true">ℹ</span>
          <span>
            포트 80 하나만 열어두고 싶다면 위 방식으로 충분합니다. router가 포트를 하나 더 열어도 괜찮고 대신
            바깥 프록시의 rewrite를 아예 안 쓰고 싶다면, <code>CADDY_ADAPTER_PORT</code>(기본값 없음 — 설정
            필요)를 지정하고 퍼블리시하는 대안도 있습니다. 자세한 내용은{' '}
            <a href="https://github.com/qwreey/code-docker/blob/master/docs/dev-proxy.md" target="_blank" rel="noreferrer">
              docs/dev-proxy.md
            </a>
            를 확인하세요.
          </span>
        </div>

        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        {notice && <p className="success-note">{notice}</p>}

        {loading ? (
          <Skeleton />
        ) : exposes.length === 0 ? (
          <p className="empty-state">등록된 expose가 없습니다.</p>
        ) : (
          <div className="table-wrapper">
            <table className="dev-proxy-table">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>host</th>
                  <th>라우트</th>
                  <th>인증</th>
                  <th aria-label="동작" />
                </tr>
              </thead>
              <tbody>
                {exposes.map((info) => (
                  <Fragment key={info.name}>
                    <tr>
                      <td>{info.name}</td>
                      <td>{info.structured?.host ?? <em>raw</em>}</td>
                      <td>{info.structured ? `${(info.structured.routes ?? []).length}개` : <em>raw</em>}</td>
                      <td>{info.structured ? authSummary(info.structured.routes ?? []) : '-'}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => setExpandedName(expandedName === info.name ? null : info.name)}
                        >
                          {expandedName === info.name ? '닫기' : '펼치기'}
                        </button>{' '}
                        <button
                          type="button"
                          className="btn btn-danger btn-small"
                          disabled={deleting === info.name}
                          onClick={() => handleDelete(info.name)}
                        >
                          삭제
                        </button>
                      </td>
                    </tr>
                    {expandedName === info.name && (
                      <tr className="dev-proxy-edit-row">
                        <td colSpan={5}>
                          {info.structured ? (
                            <RoutesPanel info={info} onSaved={handleExposeSaved} />
                          ) : (
                            <RawPanel info={info} onSaved={load} />
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form onSubmit={handleSubmit} className="form-grid-inline">
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="dp-name">이름 (내부 식별자)</label>
              <input
                id="dp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="myapp"
                pattern="[a-z0-9][a-z0-9-]{0,61}[a-z0-9]|[a-z0-9]"
                required
              />
            </div>
            <div className="form-field">
              <label htmlFor="dp-host">host (노출할 도메인)</label>
              <input
                id="dp-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="dev.example.com"
                required
              />
            </div>
          </div>
          {formError && <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? '추가하는 중...' : 'expose 추가'}
          </button>
        </form>
      </div>
    </section>
  )
}
