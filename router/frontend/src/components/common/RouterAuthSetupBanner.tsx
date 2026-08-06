import { useEffect, useState } from 'react'
import { authApi } from '../../api/client'
import { ErrorBanner } from './ErrorBanner'

const IGNORE_KEY = 'router-auth-setup-ignored'

function isIgnored(): boolean {
  try {
    return localStorage.getItem(IGNORE_KEY) === '1'
  } catch {
    return false
  }
}
function setIgnored() {
  try {
    localStorage.setItem(IGNORE_KEY, '1')
  } catch {
    // Private browsing / storage disabled - the banner just reappears next
    // page load, no worse than before this existed.
  }
}

/**
 * Nags inside webmanager too, alongside code-server's own banner
 * (config/code-patch/router-auth-notify.default.js - see
 * router/.claude/router-nginx-hardening-plan.md Phase 6) - two independent
 * surfaces for the same "router-manager has no admin password configured"
 * state, since an agent driven from either code-server or webmanager
 * should see it before touching anything. Mount once near the consuming
 * app's root (webmanager's App.tsx mounts this next to
 * RouterUnlockModalHost) - polls GET /router/api/auth/status directly
 * rather than waiting for a 401 from some other action, since the point is
 * to warn proactively, not just react to a gated request.
 */
export function RouterAuthSetupBanner() {
  const [required, setRequired] = useState<boolean | null>(null)
  const [dismissed, setDismissed] = useState(isIgnored)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const status = await authApi.get<{ required: boolean }>('/status')
        if (!cancelled) setRequired(status.required)
      } catch {
        // Transient fetch failure - keep whatever we last knew, retry next tick.
      }
    }
    poll()
    const id = setInterval(poll, 30000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // required === null: haven't heard back yet, stay silent rather than
  // flash a false positive. required === true: already configured.
  if (required !== false || dismissed) return null

  return (
    <ErrorBanner
      variant="warning"
      message={
        <>
          router 관리자 비밀번호가 설정되지 않았습니다 - Dev Proxy/Tailscale 설정을 아무나(같은 네트워크의
          다른 컨테이너 포함) 바꿀 수 있는 상태입니다.{' '}
          <a href="/router/" target="_blank" rel="noopener noreferrer">
            지금 설정하기
          </a>
        </>
      }
      onDismiss={() => {
        setIgnored()
        setDismissed(true)
      }}
    />
  )
}
