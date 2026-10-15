import type { Terminal as XTerm } from '@xterm/xterm'

// Cell width of a string the way xterm's default (Unicode 6) width table
// counts it: combining/conjoining marks 0, East Asian wide and fullwidth 2,
// everything else 1. Only has to be right for what a phone keyboard composes
// into, Hangul above all.
export function stringCellWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1160 && cp <= 0x11ff) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200b) continue
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

/**
 * Marks the text the keyboard is still composing, which on a touch device is
 * otherwise invisible: focus lives on the mobile-input field, not xterm's own
 * textarea, so xterm's composition-view never shows.
 *
 * - live: the composing text has already gone to the PTY (live composition)
 *   and its echo sits just left of the cursor, so the mark underlines those
 *   cells instead of drawing the text a second time. That is what tells
 *   "backspace will take a jamo out of this word" apart from "backspace will
 *   delete a committed character".
 * - not live: nothing is sent until compositionend, so the text is drawn in a
 *   box at the cursor, the way xterm's own composition-view does on desktop.
 *
 * Positioned from the cursor on every render, so right after a keystroke it
 * can sit one cell early until the echo moves the cursor. A composing word
 * that wraps onto the cursor's line is only marked on that line.
 */
export function createCompositionMark(term: XTerm, screen: HTMLElement) {
  const mark = document.createElement('div')
  mark.className = 'terminal-composition-mark'
  mark.hidden = true
  screen.appendChild(mark)
  let text = ''
  let live = true

  const render = () => {
    const buffer = term.buffer.active
    const row = buffer.baseY + buffer.cursorY - buffer.viewportY
    if (!text || row < 0 || row >= term.rows) {
      mark.hidden = true
      return
    }
    const cellWidth = screen.clientWidth / term.cols
    const cellHeight = screen.clientHeight / term.rows
    const startCol = live ? Math.max(0, buffer.cursorX - stringCellWidth(text)) : buffer.cursorX
    mark.hidden = false
    mark.classList.toggle('pending', !live)
    mark.textContent = live ? '' : text
    Object.assign(mark.style, {
      left: `${startCol * cellWidth}px`,
      top: `${row * cellHeight}px`,
      width: live ? `${(buffer.cursorX - startCol) * cellWidth}px` : '',
      height: `${cellHeight}px`,
      lineHeight: `${cellHeight}px`,
      fontFamily: term.options.fontFamily ?? '',
      fontSize: `${term.options.fontSize ?? 15}px`,
    })
  }

  const disposables = [term.onRender(render), term.onCursorMove(render)]

  return {
    set(next: string, nextLive: boolean) {
      if (next === text && nextLive === live) return
      text = next
      live = nextLive
      render()
    },
    dispose() {
      for (const d of disposables) d.dispose()
      mark.remove()
    },
  }
}
