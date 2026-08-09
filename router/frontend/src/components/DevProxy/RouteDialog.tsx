import { useState, type FormEvent } from 'react'
import { Sheet } from '../common/Sheet'
import { ErrorBanner } from '../common/ErrorBanner'
import type { DevProxyRoute } from '../../api/types'

// Bind-address nudge: router's Caddy (this container) reaches targets over
// code-docker-internal, not code-docker's own loopback - a target bound to
// 127.0.0.1/localhost only accepts connections from inside code-docker
// itself, which router can never reach. Use the compose service hostname
// (e.g. "code-docker:5173") or a specific network alias instead.
function looksUnreachable(target: string) {
  const host = target.split(':')[0]
  return host === '127.0.0.1' || host === 'localhost' || host === ''
}

export function RouteDialog({
  route,
  submitting,
  error,
  onCancel,
  onSave,
}: {
  route: DevProxyRoute | null
  submitting: boolean
  error: string | null
  onCancel: () => void
  onSave: (route: DevProxyRoute) => void
}) {
  const [path, setPath] = useState(route?.path ?? '')
  const [target, setTarget] = useState(route?.target ?? '')
  const [stripPrefix, setStripPrefix] = useState(route?.stripPrefix ?? '')
  const [rewritePrefix, setRewritePrefix] = useState(route?.rewritePrefix ?? '')
  const [mode, setMode] = useState<'route' | 'handle'>(route?.mode ?? 'handle')
  const [requireAuth, setRequireAuth] = useState(route?.requireAuth ?? false)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSave({
      path: path.trim() || undefined,
      target: target.trim(),
      stripPrefix: stripPrefix.trim() || undefined,
      rewritePrefix: rewritePrefix.trim() || undefined,
      mode,
      requireAuth,
    })
  }

  return (
    <Sheet open onClose={onCancel} title={route ? '라우트 편집' : '라우트 추가'}>
      <form onSubmit={handleSubmit} className="dev-proxy-route-form">
        <div className="form-field">
          <label htmlFor="rt-path">라우팅 대상 path</label>
          <input
            id="rt-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/api/* (비우면 전체 매치)"
          />
        </div>
        <div className="form-field">
          <label htmlFor="rt-target">target (host:port)</label>
          <input
            id="rt-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="code-docker:5173"
            required
          />
          {looksUnreachable(target) && (
            <p className="dev-proxy-route-hint">
              <code>{target || '(비어있음)'}</code>은(는) 이 컨테이너(router) 자신을 가리켜, 다른 컨테이너 안의 dev
              서버에는 닿지 않습니다 — <code>code-docker:포트</code>처럼 compose 서비스 호스트네임을 쓰세요.
            </p>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="rt-strip">strip prefix (선택)</label>
          <input
            id="rt-strip"
            value={stripPrefix}
            onChange={(e) => setStripPrefix(e.target.value)}
            placeholder="/api (비우면 자르지 않음)"
          />
        </div>
        <div className="form-field">
          <label htmlFor="rt-rewrite">리버스프록시 path (선택)</label>
          <input
            id="rt-rewrite"
            value={rewritePrefix}
            onChange={(e) => setRewritePrefix(e.target.value)}
            placeholder="/v1/api (비우면 붙이지 않음)"
          />
        </div>
        <div className="form-field">
          <label htmlFor="rt-mode">매칭 방식</label>
          <select id="rt-mode" value={mode} onChange={(e) => setMode(e.target.value as 'route' | 'handle')}>
            <option value="handle">handle (다른 라우트와 배타적, 먼저 매치되는 것만 실행)</option>
            <option value="route">route (매치되면 무조건 실행, 다른 라우트와 독립적)</option>
          </select>
        </div>
        <label className="dev-proxy-checkbox-option">
          <input type="checkbox" checked={requireAuth} onChange={(e) => setRequireAuth(e.target.checked)} />
          인증 요구 (tinyauth 로그인)
        </label>

        {error && <ErrorBanner message={error} />}
        <div className="dev-proxy-edit-toggle">
          <button type="submit" className="btn btn-primary btn-small" disabled={submitting}>
            {submitting ? '저장하는 중...' : '저장'}
          </button>
          <button type="button" className="btn btn-small" disabled={submitting} onClick={onCancel}>
            취소
          </button>
        </div>
      </form>
    </Sheet>
  )
}
