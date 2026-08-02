import type { ModifierId } from './keybindings'

// Sticky-modifier byte transforms applied to the *next* single chunk of
// outgoing data (whether it came from a real keypress via term.onData, or
// from a literal-byte control-bar button). This is a deliberately simplified
// take on "modifier + key" rather than a fully general one -- see
// Terminal.tsx for how it's wired (arm on tap, apply+disarm on next send).

// Standard terminal Ctrl encoding: Ctrl+<letter> clears bits 6/7 of the
// character's code, e.g. 'A' (0x41) & 0x1f = 0x01, 'a' (0x61) & 0x1f = 0x01
// (both send Ctrl+A). Only applied when the outgoing chunk is a single
// character that has a sensible ctrl mapping (letters + a few punctuation
// keys) -- anything else (multi-char sequences, digits, ...) passes through
// unchanged since there's no universally agreed ctrl-code for them.
const CTRL_MAPPABLE = /^[a-zA-Z@[\]\\^_?]$/

export function applyCtrl(data: string): string {
  if (data.length === 1 && CTRL_MAPPABLE.test(data)) {
    return String.fromCharCode(data.charCodeAt(0) & 0x1f)
  }
  return data
}

// Standard Meta/Alt encoding: prefix with ESC (what most terminals send for
// Alt+<key>, and what apps like readline/bash expect).
export function applyAlt(data: string): string {
  return '\x1b' + data
}

// Shift has no general terminal-level encoding (a real keyboard's Shift key
// already produces the shifted character before it ever reaches us). We
// only give it a concrete meaning for the two combos that are actually
// useful from an on-screen control bar: Shift+Tab (back-tab) and
// Shift+Arrow (the common "extend selection" CSI modifier). Anything else
// passes through unchanged.
const SHIFT_ARROWS: Record<string, string> = {
  '\x1b[A': '\x1b[1;2A',
  '\x1b[B': '\x1b[1;2B',
  '\x1b[C': '\x1b[1;2C',
  '\x1b[D': '\x1b[1;2D',
}

export function applyShift(data: string): string {
  if (data === '\t') return '\x1b[Z'
  return SHIFT_ARROWS[data] ?? data
}

export function applyModifier(modifier: ModifierId, data: string): string {
  switch (modifier) {
    case 'ctrl':
      return applyCtrl(data)
    case 'alt':
      return applyAlt(data)
    case 'shift':
      return applyShift(data)
    default:
      return data
  }
}
