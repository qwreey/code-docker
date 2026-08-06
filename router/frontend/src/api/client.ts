// router-manager's own admin-API auth (internal/authgate, opt-in via
// ROUTER_MANAGER_AUTH_PASSWORD_HASH - see router/plan.md's "router-manager
// 자체 admin API 인증"): every createApiClient(prefix) instance shares one
// global 401-retry/unlock-prompt handler, since there's only one gate
// regardless of which feature area (dev-proxy/tailscale) issued the
// request - same "prompt on 401, retry once" pattern webmanager's own
// api/client.ts uses, generalized to cover multiple prefixes sharing one
// gate instead of just one.
type UnlockPrompter = () => Promise<void>
let unlockPrompter: UnlockPrompter | null = null

export function setUnlockPrompter(fn: UnlockPrompter | null) {
  unlockPrompter = fn
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function withJsonBody(body?: unknown): RequestInit {
  if (body === undefined) return {}
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

// createApiClient binds an api/apiUrl pair to prefix - a path under
// router's own single `/router/` nginx location (see
// router/config/nginx/nginx.default.conf), which strips just that `/router`
// segment and forwards the rest straight through to router-manager's
// matching route (e.g. `/router/api/dev-proxy/exposes` -> router-manager's
// `POST /api/dev-proxy/exposes`) - one unix-socket-backed location handles
// every feature area now, no more per-feature nginx remapping. Deliberately
// NOT
// import.meta.env.BASE_URL-relative (unlike webmanager's own client.ts) -
// router-manager is a genuinely separate backend service, not part of
// whichever app happens to import these components, so its API routes
// shouldn't be coupled to the consuming app's own base path.
//
// skipUnlockRetry opts a client out of the 401→prompt→retry dance -
// used only by the auth client itself (see below), since a wrong-password
// 401 from the unlock endpoint must surface directly to its own form
// instead of re-triggering the prompter (which would recurse).
export function createApiClient(prefix: string, opts: { skipUnlockRetry?: boolean } = {}) {
  function apiUrl(path: string): string {
    return `/${prefix}${path}`
  }

  async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
    const res = await fetch(apiUrl(path), init)

    if (res.status === 204) {
      return undefined as T
    }

    const raw = await res.text()
    let data: unknown = undefined
    if (raw) {
      try {
        data = JSON.parse(raw)
      } catch {
        data = undefined
      }
    }

    if (!res.ok) {
      if (res.status === 401 && !retried && unlockPrompter && !opts.skipUnlockRetry) {
        let unlocked = false
        try {
          await unlockPrompter()
          unlocked = true
        } catch {
          // User cancelled the prompt — fall through to the original error below.
        }
        if (unlocked) {
          // Re-issue the exact same request once, with retried=true so a
          // second 401 (or any other error) just falls through to its own
          // normal throw instead of prompting again.
          return request<T>(path, init, true)
        }
      }

      const message =
        data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
          ? (data as { error: string }).error
          : raw || `요청에 실패했습니다 (${res.status})`
      throw new ApiError(res.status, message)
    }

    return data as T
  }

  const api = {
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', ...withJsonBody(body) }),
    put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', ...withJsonBody(body) }),
    del: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', ...withJsonBody(body) }),
  }

  return { api, apiUrl }
}

// Dev Proxy's own bound client - the original, pre-generalization call
// site (RouteDialog/DevProxy.tsx import these two directly).
export const { api, apiUrl } = createApiClient('router/api/dev-proxy')

// router-manager's auth endpoints (/api/auth/unlock, /api/auth/status,
// /api/auth/setup, /api/auth/change). Used by UnlockModal.tsx.
export const { api: authApi } = createApiClient('router/api/auth', { skipUnlockRetry: true })
