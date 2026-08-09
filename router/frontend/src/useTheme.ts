import { useCallback, useSyncExternalStore } from 'react'
import { getTheme, persistTheme, subscribeTheme, type ThemeChoice } from './theme'

// React-facing wrapper around theme.ts's plain functions - hand-kept
// duplicate of webmanager's own useTheme.ts. useSyncExternalStore ties every
// call site to the same module-level value (theme.ts's `listeners` set), so
// a change made through one instance re-renders every other instance too -
// initTheme() has already run once synchronously in main.tsx before any of
// this ever mounts, so getTheme() here just reads that same value.
export function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme)

  const setTheme = useCallback((choice: ThemeChoice) => {
    persistTheme(choice)
  }, [])

  return { theme, setTheme }
}
