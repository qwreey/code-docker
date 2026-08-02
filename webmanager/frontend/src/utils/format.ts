export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '-'
  return `${value.toFixed(1)}%`
}

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '-'
  const abs = Math.abs(value)
  if (abs < 1000) return `${value}`
  if (abs < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`
  if (abs < 1_000_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'

  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 60) return `${totalMinutes}분`

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`
}
