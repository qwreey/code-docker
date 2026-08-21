import type { MouseEvent } from 'react'
import { ZoomIn, ZoomOut } from 'lucide-react'
import type { KeyBinding } from '../../api/types'
import { isModifierBinding, type ModifierId } from './keybindings'

// Stops the browser's default "shift focus to the element that was just
// pressed" behavior. A plain touch-drag (scrolling the row) never
// synthesizes a mousedown at all, so this only ever fires for an actual tap
// — it doesn't interfere with scrolling the bar.
function preventFocusSteal(event: MouseEvent) {
  event.preventDefault()
}

/**
 * Always-visible mobile control bar. Renders from the same KeyBinding list
 * the settings panel edits (see Terminal.tsx), so editing one changes the
 * other. Ctrl/Alt/Shift are recognized by id and rendered as sticky
 * modifiers (armModifier) instead of literal byte-senders (sendBytes) --
 * their `bytes` field is unused.
 *
 * Zoom in/out is a fixed pair appended after the customizable keybinding
 * row, not part of it -- unlike a key, it never sends a byte and its state
 * (font size) is per-device localStorage, not the backend-persisted
 * TerminalSettings blob (see Terminal.tsx's FONT_SIZE_STORAGE_KEY), so it
 * doesn't belong in a user-reorderable/removable list the same way. Icons
 * instead of a text label, and terminal-key-action's own slightly different
 * color, mark it as this different category of control at a glance.
 *
 * Mobile focus/keyboard fix: tapping this bar used to steal focus away from
 * xterm's hidden input textarea, which both dropped xterm's own focus state
 * and dismissed the on-screen keyboard. `onMouseDown={preventFocusSteal}` on
 * every button stops a tap from moving DOM focus to the button in the first
 * place; each button's own action (sendBytes/armModifier/zoom) then calls
 * Terminal.tsx's own `focusTerminal()` when it needs to re-focus, which
 * knows to target the mobile-input-workaround's own hidden input directly
 * rather than xterm's real textarea (see that function's doc comment) —
 * this bar itself no longer forces a refocus on every touch release the way
 * an earlier version did, since that fought any attempt to deliberately
 * dismiss the on-screen keyboard.
 */
export function TerminalControls({
  keybindings,
  armedModifier,
  onArmModifier,
  onSendBytes,
  onZoom,
}: {
  keybindings: KeyBinding[]
  armedModifier: ModifierId | null
  onArmModifier: (id: ModifierId) => void
  onSendBytes: (bytes: string) => void
  onZoom: (direction: 'in' | 'out') => void
}) {
  return (
    <div className="terminal-controls" role="toolbar" aria-label="터미널 특수키">
      {keybindings.map((binding) => {
        const modifierId = isModifierBinding(binding.id) ? binding.id : null
        return modifierId ? (
          <button
            key={binding.id}
            type="button"
            className={`terminal-key-btn terminal-key-modifier${armedModifier === modifierId ? ' active' : ''}`}
            aria-pressed={armedModifier === modifierId}
            onMouseDown={preventFocusSteal}
            onClick={() => onArmModifier(modifierId)}
          >
            {binding.label}
          </button>
        ) : (
          <button
            key={binding.id}
            type="button"
            className="terminal-key-btn"
            disabled={!binding.bytes}
            onMouseDown={preventFocusSteal}
            onClick={() => onSendBytes(binding.bytes)}
          >
            {binding.label}
          </button>
        )
      })}
      <button
        type="button"
        className="terminal-key-btn terminal-key-action"
        aria-label="글자 축소"
        title="글자 축소"
        onMouseDown={preventFocusSteal}
        onClick={() => onZoom('out')}
      >
        <ZoomOut size={16} />
      </button>
      <button
        type="button"
        className="terminal-key-btn terminal-key-action"
        aria-label="글자 확대"
        title="글자 확대"
        onMouseDown={preventFocusSteal}
        onClick={() => onZoom('in')}
      >
        <ZoomIn size={16} />
      </button>
    </div>
  )
}
