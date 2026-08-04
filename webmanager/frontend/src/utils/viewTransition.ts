import { flushSync } from 'react-dom'

// Thin wrapper around the browser View Transition API (see
// https://developer.mozilla.org/docs/Web/API/Document/startViewTransition)
// for a default cross-fade when swapping "pages" (e.g. sidebar tab
// switches). flushSync forces the state update's DOM mutation to complete
// synchronously inside startViewTransition's callback — without it, React's
// normal async/batched update wouldn't be done in time for the browser to
// capture the "after" snapshot, and the transition would be a no-op.
// Browsers without support (Firefox, older Safari) just get the plain
// synchronous update — no animation, functionally identical.
export function withViewTransition(update: () => void): void {
  if (!document.startViewTransition) {
    update()
    return
  }
  const transition = document.startViewTransition(() => flushSync(update))
  // The transition can be aborted for reasons outside our control (tab not
  // visible/focused, reduced-motion edge cases, etc.) - flushSync above
  // already applied the real state update regardless, so a rejected
  // transition here just means "no animation this time," not a real
  // error. Without this, the rejection surfaces as an unhandled promise
  // rejection in the console on every such occurrence.
  transition.ready.catch(() => {})
  transition.finished.catch(() => {})
}
