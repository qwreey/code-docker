// Ctrl/Cmd+click on a file path in the terminal, inside the code-server
// extension (embed.ts): the extension opens it in an editor, at the line and
// column if the output named one (`src/foo.ts:12:5`, `foo.py(12,5)`, ...).
// What VS Code's own terminal does for its link detection, minus the
// existence check up front - this frame can't stat files cheaply, so every
// path-looking token is a candidate and the extension resolves it on click
// (falling back to Quick Open with the text when nothing matches).
import type { ILink, ILinkProvider, IBufferLine, Terminal } from '@xterm/xterm'

import { postToHost } from '../../embed'

// A path-looking token: absolute, ~/, ./ or ../, or anything with a slash
// or a file extension. Stops at whitespace and the quote/bracket characters
// output usually wraps a path in. The optional suffix is the position.
const PATH_RE =
  /(?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)*\/?(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/g

function looksLikePath(p: string): boolean {
  if (p.includes('/')) return /[\w]/.test(p) && !/^\/+$/.test(p)
  // No slash: only name.ext, and not a number or a version ("1.2.3").
  return /^[\w@+-][\w.@+-]*\.[A-Za-z][\w]{0,9}$/.test(p)
}

// The line's text with, for every UTF-16 index, the 1-based cell column it
// sits in - wide characters (Korean, CJK) take two cells, so a string index
// is not a column.
function lineText(line: IBufferLine, cols: number): { text: string; cellOf: number[] } {
  let text = ''
  const cellOf: number[] = []
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    if (cell.getWidth() === 0) continue // right half of a wide char
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) cellOf.push(x + 1)
    text += chars
  }
  return { text, cellOf }
}

export function registerFileLinks(term: Terminal, getCwd: () => string | undefined) {
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)
      if (!line) return callback(undefined)
      const { text, cellOf } = lineText(line, term.cols)
      const links: ILink[] = []
      for (const m of text.matchAll(PATH_RE)) {
        const full = m[0]
        const path = full.replace(/(?::\d+(?::\d+)?|\(\d+(?:,\s*\d+)?\))$/, '')
        const before = text[(m.index ?? 0) - 1]
        // Part of a URL (scheme://host/...) or an option (--foo=bar/baz).
        if (before === ':' || before === '=' || before === '/') continue
        if (!looksLikePath(path)) continue
        const start = m.index ?? 0
        const end = start + full.length - 1
        const lineNo = Number(m[1] ?? m[3]) || undefined
        const col = Number(m[2] ?? m[4]) || undefined
        links.push({
          range: { start: { x: cellOf[start], y }, end: { x: cellOf[end], y } },
          text: full,
          decorations: { underline: true, pointerCursor: true },
          activate(event) {
            if (!event.ctrlKey && !event.metaKey) return
            event.preventDefault()
            postToHost({ type: 'open-file', path, line: lineNo, col, cwd: getCwd() })
          },
        })
      }
      callback(links.length ? links : undefined)
    },
  }
  return term.registerLinkProvider(provider)
}
