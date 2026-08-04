// Very small, best-effort User-Agent summarizer — just enough to turn a long
// raw UA string into something like "Chrome · Windows" for a table cell.
// Deliberately not a real UA-parsing library: order matters (Edge/OPR must
// be checked before Chrome, since they also contain "Chrome/" in their UA),
// and any string that doesn't match anything just falls back to the raw
// value so nothing is ever silently dropped.
const BROWSER_PATTERNS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/CriOS\//, 'Chrome'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

const OS_PATTERNS: [RegExp, string][] = [
  [/Windows/, 'Windows'],
  [/Mac OS X/, 'macOS'],
  [/Android/, 'Android'],
  [/iPhone|iPad|iOS/, 'iOS'],
  [/Linux/, 'Linux'],
]

function match(patterns: [RegExp, string][], ua: string): string | null {
  for (const [re, label] of patterns) {
    if (re.test(ua)) return label
  }
  return null
}

export function summarizeUserAgent(ua: string): string {
  if (!ua) return '알 수 없음'
  const browser = match(BROWSER_PATTERNS, ua)
  const os = match(OS_PATTERNS, ua)
  if (browser && os) return `${browser} · ${os}`
  if (browser) return browser
  if (os) return os
  return ua
}
