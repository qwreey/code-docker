// Much simpler than webmanager's own api/client.ts - router-manager's
// endpoints aren't password-gated (see router/backend/handlers_devproxy.go's
// own comment: no host-published port yet, private-by-default the same way
// GET /api/tailscale/state is), so there's no 401-retry/unlock-prompt
// machinery to replicate here. If router-manager ever gets its own admin
// auth, this file is where that would need to grow a matching interceptor -
// see router/plan.md's TODO list.
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

// createApiClient binds an api/apiUrl pair to prefix - one router-manager
// feature area's own nginx location (e.g. `/dev-proxy/`, `/tailscale/`, see
// config/nginx.default.conf), each proxied straight to router-manager's
// matching `/api/<prefix>/` route. Deliberately NOT
// import.meta.env.BASE_URL-relative (unlike webmanager's own client.ts) -
// router-manager is a genuinely separate backend service, not part of
// whichever app happens to import these components, so its API routes
// shouldn't be coupled to the consuming app's own base path.
export function createApiClient(prefix: string) {
  function apiUrl(path: string): string {
    return `/${prefix}${path}`
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
export const { api, apiUrl } = createApiClient('dev-proxy')
