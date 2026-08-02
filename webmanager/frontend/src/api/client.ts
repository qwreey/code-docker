export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init)

  if (res.status === 204) {
    return undefined as T
  }

  const raw = await res.text()
  let data: unknown = undefined
  if (raw) {
    try {
      data = JSON.parse(raw)
    } catch {
      // 응답이 JSON이 아닌 경우 (프록시 에러 페이지 등) raw 텍스트를 메시지로 사용
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

function withJsonBody(body?: unknown): RequestInit {
  if (body === undefined) return {}
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', ...withJsonBody(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', ...withJsonBody(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
