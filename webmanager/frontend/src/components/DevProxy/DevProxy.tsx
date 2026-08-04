import { Fragment, useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { DevProxyInfo } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { ExpandableEditor } from '../common/ExpandableEditor'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'
import './DevProxy.css'

// Editing a fragment that didn't parse back out of Render (info.structured
// is undefined - see internal/devproxy.parseStructured) only offers raw
// text editing; switching it to the structured form would silently
// overwrite whatever custom Caddyfile syntax made it unparseable.
function EditPanel({
  info,
  onSaved,
  onCancel,
}: {
  info: DevProxyInfo
  onSaved: () => void
  onCancel: () => void
}) {
  const [mode, setMode] = useState<'structured' | 'raw'>(info.structured ? 'structured' : 'raw')
  const [target, setTarget] = useState(info.structured?.target ?? '')
  const [apiTarget, setApiTarget] = useState(info.structured?.apiTarget ?? '')
  const [requireAuth, setRequireAuth] = useState(info.structured?.requireAuth ?? false)
  const [raw, setRaw] = useState(info.raw)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setSubmitting(true)
    setError(null)
    try {
      if (mode === 'structured') {
        await api.put(`/dev-proxy/exposes/${encodeURIComponent(info.name)}`, {
          target,
          apiTarget: apiTarget || undefined,
          requireAuth,
        })
      } else {
        await api.put(`/dev-proxy/exposes/${encodeURIComponent(info.name)}`, { raw })
      }
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="dev-proxy-edit-panel">
      {info.structured && (
        <div className="dev-proxy-edit-toggle">
          <button
            type="button"
            className={mode === 'structured' ? 'btn btn-small btn-primary' : 'btn btn-small'}
            onClick={() => setMode('structured')}
          >
            구조화 편집
          </button>
          <button
            type="button"
            className={mode === 'raw' ? 'btn btn-small btn-primary' : 'btn btn-small'}
            onClick={() => setMode('raw')}
          >
            원본 편집
          </button>
        </div>
      )}

      {mode === 'structured' ? (
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor={`dp-edit-target-${info.name}`}>target (host:port)</label>
            <input
              id={`dp-edit-target-${info.name}`}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor={`dp-edit-api-target-${info.name}`}>/api/* target (선택)</label>
            <input
              id={`dp-edit-api-target-${info.name}`}
              value={apiTarget}
              onChange={(e) => setApiTarget(e.target.value)}
            />
          </div>
          <label className="dev-proxy-checkbox-option">
            <input
              type="checkbox"
              checked={requireAuth}
              onChange={(e) => setRequireAuth(e.target.checked)}
            />
            인증 요구 (webmanager 비밀번호)
          </label>
        </div>
      ) : (
        <ExpandableEditor value={raw} onChange={setRaw} language="plain" readOnly={false} triggerLabel="원본 편집" />
      )}

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <div className="dev-proxy-edit-toggle">
        <button type="button" className="btn btn-primary btn-small" disabled={submitting} onClick={handleSave}>
          {submitting ? '저장하는 중...' : '저장'}
        </button>
        <button type="button" className="btn btn-small" disabled={submitting} onClick={onCancel}>
          취소
        </button>
      </div>
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
  const [target, setTarget] = useState('')
  const [apiTarget, setApiTarget] = useState('')
  const [requireAuth, setRequireAuth] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [editingName, setEditingName] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<DevProxyInfo[]>('/dev-proxy/exposes')
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

  function showNotice() {
    setNotice('저장됨 (caddy-adapter에 반영됨)')
    setTimeout(() => setNotice(null), 2500)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    try {
      await api.post('/dev-proxy/exposes', {
        name,
        target,
        apiTarget: apiTarget || undefined,
        requireAuth,
      })
      setName('')
      setTarget('')
      setApiTarget('')
      setRequireAuth(true)
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
      await api.del(`/dev-proxy/exposes/${encodeURIComponent(exposeName)}`)
      await load()
      showNotice()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="card">
      <h2>Dev Proxy</h2>
      <p className="section-description">
        컨테이너 안에서 뜬 dev 서버(예: <code>npm run dev</code>)를 와일드카드 서브도메인으로 노출합니다.
      </p>
      <div className="info-note">
        <span aria-hidden="true">ℹ</span>
        <span>
          바깥 리버스 프록시는 <code>CADDY_ADAPTER_DOMAIN</code>에 설정한 와일드카드 도메인을 이 컨테이너의{' '}
          <code>CADDY_ADAPTER_PORT</code>(기본 8082)로 통째로 넘기면 됩니다. 인증을 쓰려면{' '}
          <code>WEBMANAGER_CODE_SERVER_URL</code>과 <code>WEBMANAGER_AUTH_COOKIE_DOMAIN</code>도 설정해야 합니다 —
          자세한 내용은{' '}
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
                <th>target</th>
                <th>/api/*</th>
                <th>인증</th>
                <th aria-label="동작" />
              </tr>
            </thead>
            <tbody>
              {exposes.map((info) => (
                <Fragment key={info.name}>
                  <tr>
                    <td>{info.name}</td>
                    <td>{info.structured?.target ?? <em>raw</em>}</td>
                    <td>{info.structured?.apiTarget ?? '-'}</td>
                    <td>{info.structured ? (info.structured.requireAuth ? '요구' : '없음') : '-'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => setEditingName(editingName === info.name ? null : info.name)}
                      >
                        {editingName === info.name ? '닫기' : '편집'}
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
                  {editingName === info.name && (
                    <tr className="dev-proxy-edit-row">
                      <td colSpan={5}>
                        <EditPanel
                          info={info}
                          onCancel={() => setEditingName(null)}
                          onSaved={async () => {
                            setEditingName(null)
                            await load()
                            showNotice()
                          }}
                        />
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
            <label htmlFor="dp-name">이름 (서브도메인)</label>
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
            <label htmlFor="dp-target">target (host:port)</label>
            <input
              id="dp-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="127.0.0.1:5173"
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="dp-api-target">/api/* target (선택)</label>
            <input
              id="dp-api-target"
              value={apiTarget}
              onChange={(e) => setApiTarget(e.target.value)}
              placeholder="127.0.0.1:5174"
            />
          </div>
          <label className="dev-proxy-checkbox-option">
            <input type="checkbox" checked={requireAuth} onChange={(e) => setRequireAuth(e.target.checked)} />
            인증 요구 (webmanager 비밀번호)
          </label>
        </div>
        {formError && <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />}
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? '추가하는 중...' : 'expose 추가'}
        </button>
      </form>
    </div>
  )
}
