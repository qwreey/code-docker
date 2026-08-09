import { Fragment, useCallback, useEffect, useState } from 'react'
import { appRoutesApi as api, errorMessage } from '../../api/client'
import type { AppRouteInfo } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { withViewTransition } from '../../utils/viewTransition'
import './AppRoutes.css'

// Bind-address nudge, same reasoning as Dev Proxy's RouteDialog.tsx: router's
// Caddy (this container) reaches targets over code-docker-internal, not
// code-docker's own loopback - a target bound to 127.0.0.1/localhost only
// accepts connections from inside code-docker itself, which router can
// never reach.
function looksUnreachable(target: string) {
  const host = target.split(':')[0]
  return host === '127.0.0.1' || host === 'localhost' || host === ''
}

// Raw-fragment fallback editor - the whole *.caddy file as text, same shape
// as Dev Proxy's own RawPanel (see that component for the rationale on why
// a plain <textarea> rather than a CodeMirror-backed editor).
function RawPanel({ info, onSaved }: { info: AppRouteInfo; onSaved: () => void }) {
  const [raw, setRaw] = useState(info.raw)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setSubmitting(true)
    setError(null)
    try {
      await api.put(`/apps/${encodeURIComponent(info.name)}`, { raw })
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="app-routes-edit-panel">
      <textarea
        className="app-routes-raw-textarea"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        spellCheck={false}
        rows={8}
      />
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="app-routes-edit-toggle">
        <button type="button" className="btn btn-primary btn-small" disabled={submitting} onClick={handleSave}>
          {submitting ? '저장하는 중...' : '저장'}
        </button>
      </div>
    </div>
  )
}

// The name field edited inline with its own save/cancel - not a dialog,
// since it's one field at a time. Same pattern as Dev Proxy's own
// InlineFieldEditor.
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
      <p className="app-routes-field-line">
        {label}: <code>{initialValue}</code>{' '}
        <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
          편집
        </button>
      </p>
    )
  }

  return (
    <div className="app-routes-field-line">
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

// target + requireAuth editor for one expanded app - a whole-fragment
// overwrite PUT, same contract UpdateStructured has on the backend. No
// nested route list (unlike Dev Proxy's RoutesPanel) - one app has exactly
// one target, full stop.
function TargetPanel({ info, onSaved }: { info: AppRouteInfo; onSaved: (newName?: string) => void }) {
  const app = info.structured
  const [target, setTarget] = useState(app?.target ?? '')
  const [requireAuth, setRequireAuth] = useState(app?.requireAuth ?? false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)

  if (showRaw) {
    return <RawPanel info={info} onSaved={onSaved} />
  }

  async function handleSave() {
    setSubmitting(true)
    setError(null)
    try {
      await api.put(`/apps/${encodeURIComponent(info.name)}`, { target, requireAuth })
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="app-routes-edit-panel">
      <InlineFieldEditor
        label="이름"
        value={info.name}
        onSave={async (newName) => {
          await api.put(`/apps/${encodeURIComponent(info.name)}`, { name: newName, target, requireAuth })
          onSaved(newName)
        }}
      />
      <div className="app-routes-field-line">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={submitting}
          placeholder="code-docker:80"
        />
      </div>
      {looksUnreachable(target) && (
        <p className="app-routes-hint">
          <code>{target || '(비어있음)'}</code>은(는) router 컨테이너 안에서 접근 불가능한 주소일 수 있습니다 -
          대상 컨테이너 자신의 loopback이 아니라 compose 서비스 호스트네임(예: <code>code-docker:80</code>)을 쓰세요.
        </p>
      )}
      <label className="app-routes-checkbox-option">
        <input
          type="checkbox"
          checked={requireAuth}
          onChange={(e) => setRequireAuth(e.target.checked)}
          disabled={submitting}
        />
        인증 요구 (tinyauth)
      </label>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="app-routes-edit-toggle">
        <button type="button" className="btn btn-primary btn-small" disabled={submitting} onClick={handleSave}>
          {submitting ? '저장하는 중...' : '저장'}
        </button>
        <button type="button" className="btn btn-small" onClick={() => setShowRaw(true)}>
          원본 편집
        </button>
      </div>
    </div>
  )
}

export function AppRoutes() {
  const [apps, setApps] = useState<AppRouteInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [expandedName, setExpandedName] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<AppRouteInfo[]>('/apps')
      setApps(data)
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

  async function handleAppSaved(newName?: string) {
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
      await api.post('/apps', { name, target, requireAuth: false })
      setExpandedName(name)
      setName('')
      setTarget('')
      await load()
      showNotice()
    } catch (e) {
      setFormError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(appName: string) {
    setDeleting(appName)
    try {
      await api.del(`/apps/${encodeURIComponent(appName)}`)
      if (expandedName === appName) setExpandedName(null)
      await load()
      showNotice()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDeleting(null)
      setConfirmDelete(null)
    }
  }

  return (
    <section>
      <div className="section-header">
        <h1>App Routes</h1>
      </div>
      <p className="section-description">
        호스트 포트를 여러 개 열지 않고 80번 하나로 여러 앱을 노출하기 위한 기능입니다 — 바깥 리버스 프록시가
        요청 경로 앞에 <code>/app/&lt;이름&gt;</code>을 붙여(rewrite) router의 80번 포트로 넘기면, 이 컨테이너
        안 Caddy가 그 접두사를 자동으로 벗기고 지정한 대상으로 다시 리버스 프록시합니다. 도메인(Host) 기반인
        Dev Proxy와 달리 Host 헤더를 전혀 보지 않고 경로만으로 라우팅합니다 — 바깥 프록시 없이 router에 직접
        접근해도 동일하게 동작하지만, 그건 보너스일 뿐 원래 의도된 사용 경로는 아닙니다.
      </p>
      <div className="card">
        <div className="info-note">
          <span aria-hidden="true">ℹ</span>
          <span>
            바깥 리버스 프록시가 원하는 요청의 경로 앞에 <code>/app/&lt;이름&gt;</code>을 붙여 이 컨테이너(router)의
            80번 포트로 그대로 넘기면 됩니다. 최초 부팅 시 <code>code → code-docker:80</code> 앱이 자동으로
            생성되며, 지우거나 바꾸면 다시 생성되지 않습니다. 자세한 내용은{' '}
            <a href="https://github.com/qwreey/code-docker/blob/master/docs/app-routes.md" target="_blank" rel="noreferrer">
              docs/app-routes.md
            </a>
            를 확인하세요.
          </span>
        </div>

        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        {notice && <p className="success-note">{notice}</p>}

        {loading ? (
          <Skeleton />
        ) : apps.length === 0 ? (
          <p className="empty-state">등록된 앱이 없습니다.</p>
        ) : (
          <div className="table-wrapper">
            <table className="app-routes-table">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>target</th>
                  <th>인증</th>
                  <th aria-label="동작" className="table-actions-col" />
                </tr>
              </thead>
              <tbody>
                {apps.map((info) => (
                  <Fragment key={info.name}>
                    <tr>
                      <td>{info.name}</td>
                      <td>{info.structured?.target ?? <em>raw</em>}</td>
                      <td>{info.structured ? (info.structured.requireAuth ? '요구' : '없음') : '-'}</td>
                      <td className="table-actions-col">
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
                          onClick={() => setConfirmDelete(info.name)}
                        >
                          삭제
                        </button>
                      </td>
                    </tr>
                    {expandedName === info.name && (
                      <tr className="app-routes-edit-row">
                        <td colSpan={4}>
                          {info.structured ? (
                            <TargetPanel info={info} onSaved={handleAppSaved} />
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
              <label htmlFor="ar-name">이름 (경로 세그먼트)</label>
              <input
                id="ar-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="myapp"
                pattern="[a-z0-9][a-z0-9-]{0,61}[a-z0-9]|[a-z0-9]"
                required
              />
            </div>
            <div className="form-field">
              <label htmlFor="ar-target">target</label>
              <input
                id="ar-target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="code-docker:3000"
                required
              />
            </div>
          </div>
          {formError && <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? '추가하는 중...' : '앱 추가'}
          </button>
        </form>
        </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete !== null && handleDelete(confirmDelete)}
        title="앱 삭제"
        confirmLabel="삭제"
        busy={deleting !== null}
      >
        &quot;{confirmDelete}&quot; 앱을 삭제하시겠습니까?
      </ConfirmDialog>
    </section>
  )
}
