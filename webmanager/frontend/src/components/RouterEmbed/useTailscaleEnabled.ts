import { useEffect, useState } from 'react'

// Plain fetch, same pattern as useRouterTrustedHosts.ts in this folder -
// GET /api/tailscale/status is unauthenticated (reads stay open per
// router-manager's authgate convention), and this is router-manager's own
// backend, not webmanager's (api/client.ts's api.get always targets
// /manager/api/...). null = still loading; the sidebar just shows the tab
// until this resolves rather than flashing a false "removed" state. A fetch
// failure also resolves to true - degrading to "enabled" (the old,
// always-shown behavior) is safer than hiding the tab over a transient
// error.
export function useTailscaleEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/router/api/tailscale/status')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((data: { enabled?: boolean }) => {
        if (!cancelled) setEnabled(data.enabled ?? true)
      })
      .catch(() => {
        if (!cancelled) setEnabled(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return enabled
}
