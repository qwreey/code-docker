import type { KeyBinding } from '../../api/types'
import { isModifierBinding, type ModifierId } from './keybindings'

/**
 * Always-visible mobile control bar. Renders from the same KeyBinding list
 * the settings panel edits (see Terminal.tsx), so editing one changes the
 * other. Ctrl/Alt/Shift are recognized by id and rendered as sticky
 * modifiers (armModifier) instead of literal byte-senders (sendBytes) --
 * their `bytes` field is unused.
 */
export function TerminalControls({
  keybindings,
  armedModifier,
  onArmModifier,
  onSendBytes,
}: {
  keybindings: KeyBinding[]
  armedModifier: ModifierId | null
  onArmModifier: (id: ModifierId) => void
  onSendBytes: (bytes: string) => void
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
            onClick={() => onSendBytes(binding.bytes)}
          >
            {binding.label}
          </button>
        )
      })}
    </div>
  )
}
