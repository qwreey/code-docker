import type { ReactNode } from 'react'
import './Mise.css'

// Wraps JobPanel as a top-level dialog pinned near the top of the viewport,
// instead of JobPanel rendering inline in the tab's normal scroll flow.
// Mise.tsx uses this for every job-triggering action (recommend install,
// search install, delete, deactivate, reactivate) so they all present the
// same way, consistent with this app's other modals (see ConfirmDialog).
// Deliberately has no backdrop-click-to-close - a running job keeps going
// server-side either way, and an accidental dismiss while watching install
// output would be worse than not being able to dismiss by misclick.
// ClaudeCode.tsx's own JobPanel usage is untouched - it already renders
// inside its own purpose-built full-tab overlay.
export function JobDialog({ children }: { children: ReactNode }) {
  return (
    <div className="mise-job-dialog-backdrop">
      <div className="mise-job-dialog-position">{children}</div>
    </div>
  )
}
