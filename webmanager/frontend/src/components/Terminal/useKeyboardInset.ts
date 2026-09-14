import { useEffect, useState } from 'react'

// Neither iOS Safari nor Android Chrome (Chrome 108+ changed its default to
// match Safari) resize the CSS layout viewport for the on-screen keyboard —
// only the *visual* viewport shrinks, so `dvh` stays constant across
// keyboard open/close on both engines. window.visualViewport is the only
// reliable cross-browser signal for "how much of the bottom is actually
// covered right now" (verified against current engine behavior, not
// assumed) — this hook returns that inset in px so callers can shrink their
// own layout by exactly that much, landing whatever's meant to sit "right
// above the keyboard" at the true bottom edge instead of leaving it hidden
// behind the keyboard while the page silently becomes scrollable underneath.
// Returns 0 (no-op) if the API isn't available.
//
// visualViewport's own resize/scroll events are not enough to *trust* the
// value, though (device report, Samsung Browser, 2026-09-14: the terminal
// kept a size the screen no longer had after the keyboard opened or closed).
// The keyboard animation updates visualViewport and innerHeight at different
// moments, and if the last visualViewport event lands before innerHeight has
// settled, the inset computed from the two stays stale with nothing left to
// re-trigger it. So window resize (innerHeight's own signal) is listened to as
// well, focus moving in or out (which is what opens and closes the keyboard)
// counts as a trigger, and every trigger re-measures again on a short settle
// schedule so the final value is always read after the animation has ended.
//
// Rounded to whole pixels: a desktop reports sub-pixel insets (0.45px) from
// ordinary rounding, and letting those through re-rendered and refitted the
// terminal for changes nobody can see.
const SETTLE_DELAYS_MS = [120, 300, 600]

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const viewport = vv

    function update() {
      setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)))
    }

    let timers: number[] = []
    function settle() {
      update()
      for (const t of timers) window.clearTimeout(t)
      timers = SETTLE_DELAYS_MS.map((ms) => window.setTimeout(update, ms))
    }

    update()
    viewport.addEventListener('resize', settle)
    viewport.addEventListener('scroll', settle)
    window.addEventListener('resize', settle)
    window.addEventListener('focusin', settle)
    window.addEventListener('focusout', settle)
    return () => {
      for (const t of timers) window.clearTimeout(t)
      viewport.removeEventListener('resize', settle)
      viewport.removeEventListener('scroll', settle)
      window.removeEventListener('resize', settle)
      window.removeEventListener('focusin', settle)
      window.removeEventListener('focusout', settle)
    }
  }, [])

  return inset
}
