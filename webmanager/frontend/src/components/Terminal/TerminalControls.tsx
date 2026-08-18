import type { MouseEvent } from 'react'
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
 * Mobile focus/keyboard fix: tapping (or even just touch-scrolling) this bar
 * used to steal focus away from xterm's hidden input textarea, which both
 * dropped xterm's own focus state and dismissed the on-screen keyboard.
 * `onMouseDown={preventFocusSteal}` on every button stops a tap from moving
 * focus to the button in the first place (see preventFocusSteal above);
 * `onFocusTerminal` (Terminal.tsx's `focusTerminal`, calling xterm's own
 * `term.focus()`) is then called both after every button action and on the
 * container's own touchend/pointerup, as a safety net that re-focuses the
 * terminal after any interaction with this toolbar, tap or scroll alike.
 */
export function TerminalControls({
  keybindings,
  armedModifier,
  onArmModifier,
  onSendBytes,
  onFocusTerminal,
}: {
  keybindings: KeyBinding[]
  armedModifier: ModifierId | null
  onArmModifier: (id: ModifierId) => void
  onSendBytes: (bytes: string) => void
  onFocusTerminal: () => void
}) {
  return (
    <div
      className="terminal-controls"
      role="toolbar"
      aria-label="터미널 특수키"
      onTouchEnd={onFocusTerminal}
      onPointerUp={onFocusTerminal}
    >
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
    </div>
  )
}
