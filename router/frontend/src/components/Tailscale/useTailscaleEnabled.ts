import { useEffect, useState } from 'react'
import { api } from './client'

const POLL_INTERVAL_MS = 5000

// null = still loading (SidebarContainer just shows the tab until this
// resolves, same as it always has, rather than flashing a false "removed"
// state). A fetch failure also resolves to true - degrading to "enabled"
// (the old, always-shown behavior) is safer than hiding the tab over a
// transient error.
//
// Re-polls every POLL_INTERVAL_MS instead of fetching once on mount - see
// the near-identical webmanager copy of this hook
// (webmanager/frontend/src/components/RouterEmbed/useTailscaleEnabled.ts)
// for why a one-shot fetch made the tab feel very slow to disappear after
// TAILSCALE_ENABLED was flipped off.
export function useTailscaleEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false

    const check = () => {
      api
        .get<{ enabled: boolean }>('/status')
        .then((res) => {
          if (!cancelled) setEnabled(res.enabled)
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
