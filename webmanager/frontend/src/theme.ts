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
export function initTheme(): ThemeChoice {
  const choice = readStoredTheme()
  applyTheme(choice)
  return choice
}

export function persistTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // best-effort - the choice still applies for this page load either way
  }
  applyTheme(choice)
}
