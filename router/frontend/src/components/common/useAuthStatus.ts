import { useCallback, useEffect, useState } from 'react'
import { authApi, errorMessage, onAuthStatusChange } from '../../api/client'
import type { AuthStatus } from '../../api/types'

// Shared GET /api/auth/status fetch, hand-kept duplicate of webmanager's own
// useAuthStatus.ts - the sidebar footer's lock-status indicator is the only
// consumer here so far (RouterAuthPanel.tsx does its own separate fetch,
// since it needs the setup/change form fields too, not just this hook's
// read-only status).
export function useAuthStatus() {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await authApi.get<AuthStatus>('/status')
      setStatus(data)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    refresh()
    return onAuthStatusChange(refresh)
  }, [refresh])

  return { status, error, refresh }
}
