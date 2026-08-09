// Manual light/dark override on top of the existing prefers-color-scheme
// support, for standalone (non-embedded) visits to this SPA - hand-kept
// duplicate of webmanager's own theme.ts (same reasoning: two separate Vite
// apps, not worth a shared package for this little logic - see root
// CLAUDE.md's "사이드바 공유" note). Persisted per-device in localStorage
// under its own key so it never collides with webmanager's 'webmanager-theme'
// even when both are visited from the same browser.
//
// Only used outside embed mode (?embed=1) - an embedded visit is driven
// entirely by embedTheme.ts instead (the parent frame tells this page what
// theme to use, live, via postMessage), since a cross-origin parent can't
// read this page's own localStorage/theme choice. main.tsx picks exactly one
// of the two initializers based on ?embed=1, so they never run in the same
// page load.
export type ThemeChoice = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'router-theme'

function readStoredTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    // localStorage unavailable (private browsing, disabled storage, ...) -
    // fall back to system, same as "never set a preference"
  }
  return 'system'
}

function applyTheme(choice: ThemeChoice) {
  if (choice === 'system') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = choice
  }
}

// Call once, synchronously, before React renders anything (see main.tsx) -
// applying the stored choice only from inside a component's useEffect would
// run after first paint and flash the wrong theme for a frame.
let currentTheme: ThemeChoice = readStoredTheme()

export function initTheme(): ThemeChoice {
  applyTheme(currentTheme)
  return currentTheme
}

// Every useTheme() call site gets its own useState - without a shared
// listener set here, a change made through one instance (e.g. the sidebar
// footer toggle) never re-renders another instance.
const listeners = new Set<(choice: ThemeChoice) => void>()

export function subscribeTheme(listener: (choice: ThemeChoice) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getTheme(): ThemeChoice {
  return currentTheme
}

export function persistTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // best-effort - the choice still applies for this page load either way
  }
  applyTheme(choice)
  currentTheme = choice
  listeners.forEach((listener) => listener(choice))
}
