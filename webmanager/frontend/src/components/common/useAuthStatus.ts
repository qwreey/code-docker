import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage, onAuthStatusChange } from '../../api/client'
import type { AuthStatus } from '../../api/types'

// Shared GET /auth/status fetch - originally only RequiresUnlock.tsx called
// this; factored out once the sidebar footer's lock-status indicator became
// a second consumer rather than duplicating the fetch a third time.
export function useAuthStatus() {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<AuthStatus>('/auth/status')
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
