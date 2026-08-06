import { flushSync } from 'react-dom'

// Ported verbatim from webmanager/frontend/src/utils/viewTransition.ts - see
// that file for the full rationale.
export function withViewTransition(update: () => void): void {
  if (!document.startViewTransition) {
    update()
    return
  }
  const transition = document.startViewTransition(() => flushSync(update))
  transition.ready.catch(() => {})
  transition.finished.catch(() => {})
}
