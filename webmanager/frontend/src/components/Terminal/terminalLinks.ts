// Ctrl/Cmd+click links in the terminal:
//   - a URL opens in a new browser tab (inside the code-server extension,
//     embed.ts's window.open bridge hands it to the extension);
//   - a file path, inside the extension only, opens in a code-server editor
//     at the line and column if the output named one (`src/foo.ts:12:5`,
//     `foo.py(12,5)`, ...) - every path-looking token is a candidate, since
//     this frame can't stat files cheaply, and the extension resolves it on
//     click (falling back to Quick Open with the text when nothing matches);
//   - a commit hash opens the session's project with its git history on
//     that commit - only while the session sits in a known project.
import type { ILink, ILinkProvider, IBufferLine, Terminal } from '@xterm/xterm'

import { postToHost } from '../../embed'

// Up to the first whitespace or a character output usually wraps a URL in;
// trailing punctuation that ends a sentence is trimmed off below.
const URL_RE = /\bhttps?:\/\/[^\s"'<>`]+/g

// A path-looking token: absolute, ~/, ./ or ../, or anything with a slash
// or a file extension. Stops at whitespace and the quote/bracket characters
// output usually wraps a path in. The optional suffix is the position.
const PATH_RE =
  /(?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)*\/?(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/g

// 7-40 hex characters standing alone. Both a digit and a letter are
// required, which rules out plain numbers (a PID, a byte count) and words
// like "decade" while missing only the rare all-digit or all-letter hash.
const HASH_RE = /\b[0-9a-f]{7,40}\b/g

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

export type TerminalLinkOptions = {
  // Set inside the code-server extension: file paths become links.
  embedded: boolean
  getCwd: () => string | undefined
  // null while the session isn't inside a known project: no hash links.
  getProject: () => string | null
  openCommit: (project: string, hash: string) => void
}

export function registerTerminalLinks(term: Terminal, opts: TerminalLinkOptions) {
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)
      if (!line) return callback(undefined)
      const { text, cellOf } = lineText(line, term.cols)
      const links: ILink[] = []
      // [start, end) string ranges already linked: a hash inside a URL or a
      // path is part of that link, not a commit of its own.
      const taken: [number, number][] = []
      const free = (start: number, end: number) => taken.every(([s, e]) => end <= s || start >= e)
      const add = (start: number, text: string, onActivate: () => void) => {
        const end = start + text.length
        taken.push([start, end])
        links.push({
          range: { start: { x: cellOf[start], y }, end: { x: cellOf[end - 1], y } },
          text,
          decorations: { underline: true, pointerCursor: true },
          activate(event) {
            if (!event.ctrlKey && !event.metaKey) return
            event.preventDefault()
            onActivate()
          },
        })
      }

      for (const m of text.matchAll(URL_RE)) {
        const url = m[0].replace(/[.,;:!?)\]}]+$/, '')
        add(m.index ?? 0, url, () => window.open(url, '_blank', 'noopener'))
      }

      if (opts.embedded) {
        for (const m of text.matchAll(PATH_RE)) {
          const full = m[0]
          const start = m.index ?? 0
          if (!free(start, start + full.length)) continue
          const path = full.replace(/(?::\d+(?::\d+)?|\(\d+(?:,\s*\d+)?\))$/, '')
          const before = text[start - 1]
          // Part of a URL (scheme://host/...) or an option (--foo=bar/baz).
          if (before === ':' || before === '=' || before === '/') continue
          if (!looksLikePath(path)) continue
          const lineNo = Number(m[1] ?? m[3]) || undefined
          const col = Number(m[2] ?? m[4]) || undefined
          add(start, full, () => postToHost({ type: 'open-file', path, line: lineNo, col, cwd: opts.getCwd() }))
        }
      }

      if (opts.getProject()) {
        for (const m of text.matchAll(HASH_RE)) {
          const hash = m[0]
          const start = m.index ?? 0
          if (!/\d/.test(hash) || !/[a-f]/.test(hash) || !free(start, start + hash.length)) continue
          add(start, hash, () => {
            const project = opts.getProject()
            if (project) opts.openCommit(project, hash)
          })
        }
      }

      callback(links.length ? links : undefined)
    },
  }
  return term.registerLinkProvider(provider)
}
