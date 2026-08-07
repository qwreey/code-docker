import { useEffect, useState } from 'react'

// Plain fetch, not the shared api/client.ts machinery - this is a single
// unauthenticated read (GET /api/auth/status - see router/backend/
// handlers_auth.go's authStatusResponse.trustedHosts) with no gated-retry
// concerns of its own. null = still loading (RouterFrame shows a skeleton
// until this resolves, so it never has to guess).
export function useRouterTrustedHosts(): string[] | null {
  const [trustedHosts, setTrustedHosts] = useState<string[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/router/api/auth/status')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((data: { trustedHosts?: string[] }) => {
        if (!cancelled) setTrustedHosts(data.trustedHosts ?? [])
      })
      .catch(() => {
        // Treat a fetch failure the same as "no dedicated domain configured"
        // - falls back to the direct same-origin embed, which is always at
        // least as functional as leaving the tab stuck on a loading skeleton.
        if (!cancelled) setTrustedHosts([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  return trustedHosts
}
