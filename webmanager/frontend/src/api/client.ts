export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Resolves once the user has unlocked (e.g. via a password prompt modal),
// rejects if they cancel. Registered by a UI component mounted near the app
// root (see UnlockModalHost) so that any api.get/post/put/del call gets
// transparent "prompt on 401, retry once, then continue" behavior without
// every write call-site needing to know about the password gate.
type UnlockPrompter = () => Promise<void>
let unlockPrompter: UnlockPrompter | null = null

export function setUnlockPrompter(fn: UnlockPrompter | null) {
  unlockPrompter = fn
}

// Proactive "just open the unlock modal" entry point - unlike the 401
// interceptor below, this isn't triggered by a failed request; it's for a
// UI affordance (the sidebar lock-status indicator) that lets the user
// unlock ahead of time instead of waiting to hit a gated action. Reuses the
// exact same modal/queue (UnlockModalHost), so a concurrent 401-triggered
// prompt and a manual click share one prompt rather than stacking two.
export function requestUnlock(): Promise<void> {
  if (!unlockPrompter) return Promise.reject(new Error('unlock prompter not mounted'))
  return unlockPrompter()
}

// The unlock endpoint itself is excluded from the retry dance below — a
// wrong-password 401 from it must surface directly to its own form instead
// of re-triggering the prompter (which could otherwise recurse).
const UNLOCK_PATH = '/auth/unlock'

async function request<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
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
    if (res.status === 401 && !retried && unlockPrompter && path !== UNLOCK_PATH) {
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
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', ...withJsonBody(body) }),
  del: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', ...withJsonBody(body) }),
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
