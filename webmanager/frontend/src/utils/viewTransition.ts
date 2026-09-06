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
  // Capturing a View Transition snapshot of a page that currently contains a
  // live <iframe> (the router-frontend embed - see RouterFrame.tsx) crashes
  // the renderer in Chrome, reproduced on both a desktop (AMD/Mesa/Wayland)
  // and an Android device, never on Firefox (which has no View Transition
  // API at all and just falls through to the plain update below anyway) -
  // see git history around 2026-08-09 for the incident. This only catches an
  // iframe present *before* the update (leaving an iframe tab, or any
  // transition triggered while one is already on screen, e.g. the theme
  // toggle); App.tsx's sidebar handler additionally skips this wrapper
  // outright when the *target* tab is iframe-based, since an iframe about to
  // be mounted can't be detected by this presence check.
  // A View Transition can only start on a *visible* document. On a hidden
  // one Chrome rejects `ready` with "Transition was aborted because of
  // invalid state" and — the part that actually matters — defers the update
  // callback instead of running it, so the state change inside flushSync
  // never lands until something else happens to start another transition.
  // The symptom is the app silently not navigating: measured 2026-09-06,
  // the file-browser overlay's "탭으로 열기" closed its dialog but stayed on
  // the Terminal tab, and the pending setActive only applied minutes later
  // when an unrelated transition ran. (This is also the likely explanation
  // for the "sidebar .click() sometimes doesn't route" flakiness recorded in
  // .claude/browser-qa-notes.md, since an automation tab is hidden.)
  // A hidden document has nothing to animate anyway, so take the plain path.
  if (!document.startViewTransition || document.hidden || document.querySelector('iframe')) {
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
