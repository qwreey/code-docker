import type { KeyBinding } from '../../api/types'

// Ids treated specially by TerminalControls/Terminal as sticky modifiers
// instead of literal byte-senders -- see MODIFIER_IDS below. Kept as plain
// string ids (not a discriminant field) so the shape stays exactly the
// backend's KeyBinding contract; their `bytes` value is unused.
export const MODIFIER_IDS = ['ctrl', 'alt', 'shift'] as const
export type ModifierId = (typeof MODIFIER_IDS)[number]

export function isModifierBinding(id: string): id is ModifierId {
  return (MODIFIER_IDS as readonly string[]).includes(id)
}

// Seed defaults shown until the user has saved their own settings (or the
// backend returns an empty list). Order matches the spec: Esc, Ctrl, Alt,
// Shift, Tab, arrows.
export const DEFAULT_KEYBINDINGS: KeyBinding[] = [
  { id: 'esc', label: 'Esc', bytes: '\x1b' },
  { id: 'ctrl', label: 'Ctrl', bytes: '' },
  { id: 'alt', label: 'Alt', bytes: '' },
  { id: 'shift', label: 'Shift', bytes: '' },
  { id: 'tab', label: 'Tab', bytes: '\t' },
  { id: 'up', label: '↑', bytes: '\x1b[A' },
  { id: 'down', label: '↓', bytes: '\x1b[B' },
  { id: 'left', label: '←', bytes: '\x1b[D' },
  { id: 'right', label: '→', bytes: '\x1b[C' },
]
