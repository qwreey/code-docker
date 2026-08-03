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
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    function update() {
      // vv is narrowed non-null by the enclosing `if` above at hook-setup
      // time; TS can't see that inside this nested closure, so re-assert.
      const viewport = vv as VisualViewport
      const next = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      setInset(next)
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  return inset
}
