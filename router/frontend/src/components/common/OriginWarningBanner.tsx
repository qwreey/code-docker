import { useEffect, useState } from 'react'
import { authApi } from '../../api/client'
import { ErrorBanner } from './ErrorBanner'

interface AuthStatus {
  trustedHosts: string[]
  requestHost: string
}

const IGNORE_KEY = 'router-origin-warning-ignored'

function isIgnored(): boolean {
  try {
    return sessionStorage.getItem(IGNORE_KEY) === '1'
  } catch {
    return false
  }
}
function setIgnored() {
  try {
    sessionStorage.setItem(IGNORE_KEY, '1')
  } catch {
    // Private browsing / storage disabled - banner just reappears next load.
  }
}

function isLocalhostLike(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

/**
 * Warns when router-manager is being reached in a way that isn't safe for
 * production: over localhost (fine for local dev, but the same access
 * pattern over a real network has no origin isolation at all), over the
 * shared hostname's /router/ path with no ROUTER_MANAGER_HOSTS domain
 * configured at all, or over that shared path while a dedicated domain is
 * already configured but not being used. See router/example-env.router's
 * ROUTER_MANAGER_HOSTS entry and docs/router.md for the underlying
 * reasoning: router_manager_unlock is a host-only cookie, so reaching this
 * page on the same origin as code-server/webmanager/exposed apps means a
 * compromise anywhere on that shared origin can ride the cookie into
 * router-manager's admin API via a same-origin fetch() -
 * HttpOnly/SameSite=Strict don't stop same-origin script. The
 * no-domain-configured case is the actual worst case (a real network
 * request, zero origin isolation, and nothing has ever been set up) - it
 * used to fall through this component's early-return entirely and show no
 * warning at all, silently treating "never configured" the same as "already
 * on the dedicated domain". sessionStorage (not localStorage, unlike
 * RouterAuthSetupBanner) so dismissing it doesn't silently hide a real prod
 * misconfiguration across future visits/tabs.
 */
export function OriginWarningBanner() {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [dismissed, setDismissed] = useState(isIgnored)

  useEffect(() => {
    let cancelled = false
    authApi
      .get<AuthStatus>('/status')
      .then((data) => {
        if (!cancelled) setStatus(data)
      })
      .catch(() => {
        // Transient fetch failure - stay silent rather than show a false positive.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!status || dismissed) return null

  const hostname = window.location.hostname
  const onLocalhost = isLocalhostLike(hostname)
  const hasDedicatedDomain = status.trustedHosts.length > 0
  const onDedicatedDomain = status.trustedHosts.includes(hostname)

  // Only genuinely safe case: a real network hostname that IS the
  // configured dedicated domain. Every other combination gets one of the
  // three warnings below.
  if (!onLocalhost && onDedicatedDomain) return null

  const dismiss = () => {
    setIgnored()
    setDismissed(true)
  }

  if (onLocalhost) {
    return (
      <ErrorBanner
        variant="warning"
        message={
          <>
            localhost로 접근 중입니다 - 개발/테스트에서는 괜찮지만, 실제 운영 환경에서는 이 접근 방식이 그대로
            보안 경계 역할을 하지 못합니다. ROUTER_MANAGER_HOSTS를 설정해 router-manager 전용 도메인을 쓰는 걸
            권장합니다 (docs/router.md 참고).
          </>
        }
        onDismiss={dismiss}
      />
    )
  }

  if (!hasDedicatedDomain) {
    return (
      <ErrorBanner
        variant="warning"
        message={
          <>
            ROUTER_MANAGER_HOSTS 전용 도메인이 설정되어 있지 않은 채로, localhost가 아닌 실제 네트워크 경로로
            접근하고 있습니다 - 지금 이 세션 쿠키는 code-server/webmanager/노출된 앱과 origin을 공유하고 있어서,
            그중 어느 하나라도 뚫리면 이 관리 세션도 함께 위험해집니다. ROUTER_MANAGER_HOSTS를 설정해
            router-manager 전용 도메인을 쓰는 걸 강력히 권장합니다 (docs/router.md 참고).
          </>
        }
        onDismiss={dismiss}
      />
    )
  }

  return (
    <ErrorBanner
      variant="warning"
      message={
        <>
          전용 도메인({status.trustedHosts.join(', ')})이 설정되어 있지만 지금은 공유 도메인의 /router/ 경로로
          접근하고 있습니다 - 이 경로는 code-server/webmanager/노출된 앱과 같은 origin을 공유해서, 어느 한쪽이
          뚫리면 이 세션 쿠키도 함께 노출될 수 있습니다. 보안이 중요한 작업은 전용 도메인에서 하는 걸
          권장합니다.
        </>
      }
      onDismiss={dismiss}
    />
  )
}
