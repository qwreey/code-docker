import { useEffect, useState } from 'react'

const POLL_INTERVAL_MS = 5000

// Plain fetch, same pattern as useRouterTrustedHosts.ts in this folder -
// GET /api/tailscale/status is unauthenticated (reads stay open per
// router-manager's authgate convention), and this is router-manager's own
// backend, not webmanager's (api/client.ts's api.get always targets
// /manager/api/...). null = still loading; the sidebar just shows the tab
// until this resolves rather than flashing a false "removed" state. A fetch
// failure also resolves to true - degrading to "enabled" (the old,
// always-shown behavior) is safer than hiding the tab over a transient
// error.
//
// Re-polls every POLL_INTERVAL_MS (same interval Dind.tsx uses) rather than
// fetching once on mount - a one-shot fetch meant toggling TAILSCALE_ENABLED
// only took effect after a full webmanager page reload, which read as the
// tab taking a very long time to disappear. The backend endpoint itself
// short-circuits instantly when disabled (see handleTailscaleStatus), so
// this poll is cheap.
export function useTailscaleEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false

    const check = () => {
      fetch('/router/api/tailscale/status')
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
        .then((data: { enabled?: boolean }) => {
          if (!cancelled) setEnabled(data.enabled ?? true)
        })
        .catch(() => {
          if (!cancelled) setEnabled(true)
        })
    }

    check()
    const timer = setInterval(check, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return enabled
}
