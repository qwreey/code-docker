export interface FuzzyMatchResult {
  matched: boolean
  // Lower is a tighter/better match (used to rank multiple candidate
  // fields against the same query, e.g. name vs cmdline). Meaningless when
  // matched is false.
  score: number
  // Indices into `text` (the original-case string that was matched
  // against) consumed by the match, in ascending order — callers use these
  // to highlight the matched characters.
  indices: number[]
}

// fuzzyMatch is a plain greedy subsequence match: every character of
// `query` (case-insensitive) must appear in `text` in order, not
// necessarily contiguously — "psql" matches "postgresql", "pcode" matches
// "pid.code-server". An empty query matches everything with no highlighted
// characters.
export function fuzzyMatch(query: string, text: string): FuzzyMatchResult {
  if (!query) return { matched: true, score: 0, indices: [] }

  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const indices: number[] = []
  let searchFrom = 0

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    let found = -1
    for (let i = searchFrom; i < t.length; i++) {
      if (t[i] === ch) {
        found = i
        break
      }
    }
    if (found === -1) return { matched: false, score: Infinity, indices: [] }
    indices.push(found)
    searchFrom = found + 1
  }

  // Prefer a tighter span and an earlier start — the same rough heuristic
  // most fuzzy-finders use so "pid" ranks a literal "pid" prefix above a
  // scattered match of the same three letters later in a long string.
  const span = indices[indices.length - 1] - indices[0] + 1
  const score = span + indices[0] * 0.1
  return { matched: true, score, indices }
}

export interface HighlightSegment {
  text: string
  matched: boolean
}

// buildHighlightSegments splits `text` into contiguous matched/unmatched
// runs from fuzzyMatch's indices, for a caller to render each run as plain
// text or a highlighted <mark>.
export function buildHighlightSegments(text: string, indices: number[]): HighlightSegment[] {
  if (indices.length === 0) return [{ text, matched: false }]

  const matchedAt = new Set(indices)
  const segments: HighlightSegment[] = []
  let current = ''
  let currentMatched = matchedAt.has(0)

  for (let i = 0; i < text.length; i++) {
    const isMatched = matchedAt.has(i)
    if (isMatched !== currentMatched && current) {
      segments.push({ text: current, matched: currentMatched })
      current = ''
    }
    currentMatched = isMatched
    current += text[i]
  }
  if (current) segments.push({ text: current, matched: currentMatched })
  return segments
}
