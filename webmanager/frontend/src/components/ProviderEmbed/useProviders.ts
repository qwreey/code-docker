import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { ProviderInfo } from '../../api/types'

// Fetched once: the list is parsed from env at webmanager's startup, so it
// can only change across a container restart, which reloads this page
// anyway. null = still loading. A failure resolves to [] - no provider tabs
// is the same as an install without any attached project, never an error
// banner on every page.
export function useProviders(): ProviderInfo[] | null {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<ProviderInfo[]>('/providers')
      .then((list) => {
        if (!cancelled) setProviders(list ?? [])
      })
      .catch(() => {
        if (!cancelled) setProviders([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  return providers
}
