// Manual light/dark override on top of the existing prefers-color-scheme
// support (see index.css's doc comment for the three-tier CSS pattern this
// drives). Persisted per-device in localStorage rather than synced to the
// backend — "phone stays light, laptop stays dark" is the actual use case,
// so a server-side/account-level setting would be the wrong shape for this.
export type ThemeChoice = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'webmanager-theme'

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
// footer toggle) never re-renders another instance (e.g. RouterFrame's
// postMessage-to-iframe effect), which is why the iframe used to only pick
// up a new theme on full reload.
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
