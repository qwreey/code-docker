import { requestUnlock } from '../../api/client'
import type { AuthStatus } from '../../api/types'

// Shared "unlock once, before opening" gate for any action that opens a
// dialog whose own content makes password-gated requests further down (e.g.
// the Projects detail sheet: ProjectTerminalSessions' unconditional fetch
// and SessionLog's <RequiresUnlock> card each prompt independently on their
// own). Call this from the *action that opens the dialog*, not from inside
// it, so the prompt fires exactly once, before anything gated underneath
// gets a chance to ask again - the gated children then just see an already-
// unlocked cookie and render straight through.
//
// Takes a status snapshot (from the caller's own useAuthStatus()) rather
// than fetching one itself, so a component that already renders off that
// hook's state doesn't pay for a second round trip. Resolves true when it's
// safe to proceed (gate unconfigured, already unlocked, or just unlocked
// now), false if the user cancelled the prompt.
export async function ensureUnlocked(status: AuthStatus | null): Promise<boolean> {
  if (!status?.required || status.unlocked) return true
  try {
    await requestUnlock()
    return true
  } catch {
    // User dismissed/cancelled the prompt - caller should not open.
    return false
  }
}
