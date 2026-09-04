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

// How long a dismissed prompt suppresses the *next* read-triggered one.
// Several tabs poll a gated endpoint on a short timer (the Terminal tab
// every 3s), so without this, cancelling the modal just meant it reopened
// on the very next tick — an unclosable prompt rather than a declined one.
// Writes are never suppressed: those are deliberate user actions, and
// silently failing one would be worse than asking again.
const PROMPT_COOLDOWN_MS = 60_000

let promptDeclinedAt = 0

function promptSuppressed(init?: RequestInit): boolean {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'GET') return false
  return Date.now() - promptDeclinedAt < PROMPT_COOLDOWN_MS
}

// Each useAuthStatus() consumer (SidebarFooter, RequiresUnlock, ...) keeps
// its own independent status copy, refreshed only when its own caller
// triggers it - so a successful unlock in one place (e.g. a 401 popping the
// modal from a gated write elsewhere) left every other consumer's copy
// stale. Notifying here, the one place every unlock path (proactive click
// or 401-triggered) funnels through, lets every mounted consumer self-refresh
// without needing to know about the others.
const authStatusListeners = new Set<() => void>()

export function onAuthStatusChange(cb: () => void): () => void {
  authStatusListeners.add(cb)
  return () => authStatusListeners.delete(cb)
}

function notifyAuthStatusChange() {
  authStatusListeners.forEach((cb) => cb())
}

// import.meta.env.BASE_URL is '/' in dev and '/manager/' in a production
// build (see vite.config.ts) - prefixing every API URL with it is what lets
// the same build work whether nginx strips a /manager prefix in front of it
// or not.
export function apiUrl(path: string): string {
  return `${import.meta.env.BASE_URL}api${path}`
}

// Default per-request timeout. A bare fetch() has no timeout of its own, so
// a request left in flight across e.g. a laptop sleep/resume can otherwise
// hang forever instead of ever rejecting — see ClaudeCode.tsx's load(),
// whose loadingRef guard depends on the request eventually settling one way
// or the other. 15s comfortably covers the slowest "quick" backend call in
// this codebase (mise's own readTimeout, 15s exactly — see
// backend/internal/mise/mise.go) plus the Claude auth check's 5s
// (backend/internal/claudecode/claudecode.go's authTimeout) with margin for
// normal network latency, while still failing a genuinely stuck request in
// a bounded time instead of never. A handful of endpoints have their own
// backend-side timeout well past this default (font/extension install, both
// 60s server-side) — those call sites pass their own longer timeoutMs
// below rather than raising this shared default for everyone else. Pass 0
// to disable the timeout entirely for a call with no natural upper bound.
const DEFAULT_TIMEOUT_MS = 15_000

async function request<T>(
  path: string,
  init?: RequestInit,
  retried = false,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined

  let res: Response
  try {
    res = await fetch(apiUrl(path), { ...init, signal: controller.signal })
  } catch (err) {
    // AbortError from our own timeout (not a caller-supplied signal — none
    // of this codebase's call sites pass one) is surfaced as a distinct,
    // recognizable ApiError rather than a generic "Failed to fetch" so a
    // caller can show "시간 초과" instead of a confusing network-error
    // message. status 0 is otherwise unused by real responses, so it's a
    // safe sentinel for "no HTTP response was ever received".
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(0, '요청 시간이 초과되었습니다')
    }
    throw err
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }

  if (path === UNLOCK_PATH && res.ok) {
    // Any successful unlock — this modal, the inline RequiresUnlock form,
    // the sidebar's proactive button — clears a previous decline, so the
    // 401 interceptor is immediately live again.
    promptDeclinedAt = 0
    notifyAuthStatusChange()
  }

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
    if (res.status === 401 && !retried && unlockPrompter && path !== UNLOCK_PATH && !promptSuppressed(init)) {
      let unlocked = false
      try {
        await unlockPrompter()
        unlocked = true
        promptDeclinedAt = 0
      } catch {
        // User cancelled the prompt — hold off on read-triggered prompts
        // for a while (see PROMPT_COOLDOWN_MS) and fall through to the
        // original error below.
        promptDeclinedAt = Date.now()
      }
      if (unlocked) {
        // Re-issue the exact same request once, with retried=true so a
        // second 401 (or any other error) just falls through to its own
        // normal throw instead of prompting again. timeoutMs is threaded
        // through so a caller's override survives the retry too.
        return request<T>(path, init, true, timeoutMs)
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

// timeoutMs, on every verb below, overrides DEFAULT_TIMEOUT_MS for call
// sites that legitimately need longer (or, with 0, no timeout at all) — see
// that constant's doc comment.
export const api = {
  get: <T>(path: string, timeoutMs?: number) => request<T>(path, undefined, false, timeoutMs),
  post: <T>(path: string, body?: unknown, timeoutMs?: number) =>
    request<T>(path, { method: 'POST', ...withJsonBody(body) }, false, timeoutMs),
  put: <T>(path: string, body?: unknown, timeoutMs?: number) =>
    request<T>(path, { method: 'PUT', ...withJsonBody(body) }, false, timeoutMs),
  patch: <T>(path: string, body?: unknown, timeoutMs?: number) =>
    request<T>(path, { method: 'PATCH', ...withJsonBody(body) }, false, timeoutMs),
  del: <T>(path: string, body?: unknown, timeoutMs?: number) =>
    request<T>(path, { method: 'DELETE', ...withJsonBody(body) }, false, timeoutMs),
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
