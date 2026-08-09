import { useEffect, useState } from 'react'
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

// Hand-ported from router/frontend/src/components/common/RouterAuthSetupBanner.tsx
// (same reasoning as ErrorBanner/Sheet/Skeleton - see that component's own
// doc comment) rather than re-adding the @code-docker/router-frontend
// dependency the 2026-08-08 decoupling removed. This nag used to be mounted
// here via that dependency; the decoupling pass dropped the import along
// with every other router-specific component but nobody hand-duplicated a
// replacement, so webmanager silently lost the warning while code-server's
// own banner (config/code/code-patch/router-auth-notify.default.js) kept
// working. Plain fetch against /router/api/auth/status, same as
// RouterEmbed/useRouterTrustedHosts.ts - router-manager's own backend, not
// webmanager's (api/client.ts's api.get always targets /manager/api/...).
export function RouterAuthSetupBanner() {
  const [required, setRequired] = useState<boolean | null>(null)
  const [dismissed, setDismissed] = useState(isIgnored)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await fetch('/router/api/auth/status')
        if (!res.ok) throw new Error(`status ${res.status}`)
        const status: { required: boolean } = await res.json()
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
