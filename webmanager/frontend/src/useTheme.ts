import { useCallback, useState } from 'react'
import { initTheme, persistTheme, type ThemeChoice } from './theme'

// React-facing wrapper around theme.ts's plain functions - a component (the
// sidebar footer toggle) needs to re-render when the choice changes, which
// theme.ts's module-level functions alone don't provide. initTheme() has
// already run once synchronously in main.tsx before this ever mounts, so
// reading it again here just syncs this component's state to the same
// value rather than re-applying anything.
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeChoice>(() => initTheme())

  const setTheme = useCallback((choice: ThemeChoice) => {
    persistTheme(choice)
    setThemeState(choice)
  }, [])

  return { theme, setTheme }
}
