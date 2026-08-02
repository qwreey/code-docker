export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-'

  const units: [string, number][] = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ]

  let remaining = Math.floor(seconds)
  const parts: string[] = []

  for (const [label, size] of units) {
    if (remaining >= size) {
      const value = Math.floor(remaining / size)
      remaining -= value * size
      parts.push(`${value}${label}`)
    }
    if (parts.length === 2) break
  }

  return parts.length > 0 ? parts.join(' ') : '0s'
}

export function formatTimestamp(unixSeconds: number): string {
  if (!unixSeconds) return '-'
  return new Date(unixSeconds * 1000).toLocaleString()
}
