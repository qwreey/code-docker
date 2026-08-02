// Two-way conversion between the raw byte string stored in KeyBinding.bytes
// (actual control characters, e.g. a real 0x1b byte for Escape) and a
// human-editable text form (the literal 4 characters "\x1b") for use in a
// plain <input type="text">, since real keyboards can't type most control
// bytes directly.

export function bytesToDisplay(bytes: string): string {
  let out = ''
  for (const ch of bytes) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '\\') out += '\\\\'
    else if (code === 0x1b) out += '\\x1b'
    else if (code === 0x09) out += '\\t'
    else if (code === 0x0d) out += '\\r'
    else if (code === 0x0a) out += '\\n'
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0')
    else out += ch
  }
  return out
}

export function displayToBytes(display: string): string {
  let out = ''
  for (let i = 0; i < display.length; i++) {
    const ch = display[i]
    if (ch === '\\' && i + 1 < display.length) {
      const next = display[i + 1]
      if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(display.slice(i + 2, i + 4))) {
        out += String.fromCharCode(parseInt(display.slice(i + 2, i + 4), 16))
        i += 3
        continue
      }
      if (next === 't') {
        out += '\t'
        i += 1
        continue
      }
      if (next === 'n') {
        out += '\n'
        i += 1
        continue
      }
      if (next === 'r') {
        out += '\r'
        i += 1
        continue
      }
      if (next === 'e') {
        out += '\x1b'
        i += 1
        continue
      }
      if (next === '\\') {
        out += '\\'
        i += 1
        continue
      }
    }
    out += ch
  }
  return out
}
