import { ChevronRight } from 'lucide-react'
import './CollapseChevron.css'

/**
 * The one collapse/expand handle used by every foldable section.
 *
 * Before this existed each section hand-rolled its own: a literal "▶" text
 * glyph in Projects' session history, a lucide ChevronDown/ChevronRight
 * pair in the memory and terminal-sessions panels right below it, and more
 * "▶" variants in Extensions/Fonts/mise/session list. The Projects detail
 * sheet stacked three different-looking handles in one scroll.
 *
 * Rotates a single chevron rather than swapping two icons: the rotation
 * animates, and there's no frame where two glyphs' differing metrics nudge
 * the label beside them.
 */
export function CollapseChevron({ open, size = 14 }: { open: boolean; size?: number }) {
  return (
    <span className={`collapse-chevron${open ? ' collapse-chevron-open' : ''}`} aria-hidden="true">
      <ChevronRight size={size} />
    </span>
  )
}
