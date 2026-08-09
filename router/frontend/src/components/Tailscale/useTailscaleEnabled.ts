import { useEffect, useState } from 'react'
import { api } from './client'

// null = still loading (SidebarContainer just shows the tab until this
// resolves, same as it always has, rather than flashing a false "removed"
// state). A fetch failure also resolves to true - degrading to "enabled"
// (the old, always-shown behavior) is safer than hiding the tab over a
// transient error.
export function useTailscaleEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<{ enabled: boolean }>('/status')
      .then((res) => {
        if (!cancelled) setEnabled(res.enabled)
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
