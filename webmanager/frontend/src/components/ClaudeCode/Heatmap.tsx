import { useMemo, useState } from 'react'
import type { DailyActivity } from '../../api/types'

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토']

function toDateKey(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function monthKey(y: number, m: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}`
}

function levelFor(messageCount: number, thresholds: number[]): number {
  if (messageCount <= 0) return 0
  if (messageCount <= thresholds[0]) return 1
  if (messageCount <= thresholds[1]) return 2
  if (messageCount <= thresholds[2]) return 3
  return 4
}

interface MonthCell {
  key: string
  inMonth: boolean
  day: number
  entry: DailyActivity | undefined
  level: number
}

export function Heatmap({ dailyActivity }: { dailyActivity: DailyActivity[] }) {
  const byDate = useMemo(() => {
    const map = new Map<string, DailyActivity>()
    for (const entry of dailyActivity) map.set(entry.date, entry)
    return map
  }, [dailyActivity])

  const { minYear, minMonth, maxYear, maxMonth } = useMemo(() => {
    if (dailyActivity.length === 0) {
      const now = new Date()
      return { minYear: now.getUTCFullYear(), minMonth: now.getUTCMonth(), maxYear: now.getUTCFullYear(), maxMonth: now.getUTCMonth() }
    }
    let min = dailyActivity[0].date
    let max = dailyActivity[0].date
    for (const entry of dailyActivity) {
      if (entry.date < min) min = entry.date
      if (entry.date > max) max = entry.date
    }
    const [minY, minM] = min.split('-').map(Number)
    const [maxY, maxM] = max.split('-').map(Number)
    return { minYear: minY, minMonth: minM - 1, maxYear: maxY, maxMonth: maxM - 1 }
  }, [dailyActivity])

  const [view, setView] = useState(() => ({ year: maxYear, month: maxMonth }))

  const levelThresholds = useMemo(() => {
    const counts = dailyActivity.map((e) => e.messageCount).filter((n) => n > 0).sort((a, b) => a - b)
    if (counts.length === 0) return [0, 0, 0]
    const at = (p: number) => counts[Math.min(counts.length - 1, Math.floor(counts.length * p))]
    return [at(0.25), at(0.5), at(0.75)]
  }, [dailyActivity])

  const cells = useMemo<MonthCell[]>(() => {
    const firstOfMonth = new Date(Date.UTC(view.year, view.month, 1))
    const daysInMonth = new Date(Date.UTC(view.year, view.month + 1, 0)).getUTCDate()
    const leadingBlanks = firstOfMonth.getUTCDay()
    const result: MonthCell[] = []
    for (let i = 0; i < leadingBlanks; i++) {
      result.push({ key: `blank-${i}`, inMonth: false, day: 0, entry: undefined, level: 0 })
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const key = toDateKey(view.year, view.month, day)
      const entry = byDate.get(key)
      result.push({ key, inMonth: true, day, entry, level: levelFor(entry?.messageCount ?? 0, levelThresholds) })
    }
    return result
  }, [view, byDate, levelThresholds])

  if (dailyActivity.length === 0) {
    return <p className="empty-state">아직 활동 기록이 없습니다.</p>
  }

  const canGoPrev = monthKey(view.year, view.month) > monthKey(minYear, minMonth)
  const canGoNext = monthKey(view.year, view.month) < monthKey(maxYear, maxMonth)

  function shiftMonth(delta: number) {
    setView((prev) => {
      const d = new Date(Date.UTC(prev.year, prev.month + delta, 1))
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() }
    })
  }

  return (
    <div className="claude-heatmap">
      <div className="claude-heatmap-nav">
        <button type="button" className="btn btn-secondary btn-small" onClick={() => shiftMonth(-1)} disabled={!canGoPrev}>
          이전
        </button>
        <div className="claude-heatmap-month">
          {view.year}년 {view.month + 1}월
        </div>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => shiftMonth(1)} disabled={!canGoNext}>
          다음
        </button>
      </div>

      <div className="claude-heatmap-weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <div className="claude-heatmap-weekday" key={label}>
            {label}
          </div>
        ))}
      </div>

      <div className="claude-heatmap-grid">
        {cells.map((cell) =>
          cell.inMonth ? (
            <div
              key={cell.key}
              className="claude-heatmap-cell"
              data-level={cell.level}
              tabIndex={0}
              title={
                cell.entry
                  ? `${cell.key} · 메시지 ${cell.entry.messageCount.toLocaleString()} · 세션 ${cell.entry.sessionCount.toLocaleString()} · 툴콜 ${cell.entry.toolCallCount.toLocaleString()}`
                  : `${cell.key} · 활동 없음`
              }
            >
              <span className="claude-heatmap-daynum">{cell.day}</span>
            </div>
          ) : (
            <div key={cell.key} className="claude-heatmap-cell claude-heatmap-cell-blank" aria-hidden="true" />
          ),
        )}
      </div>

      <div className="claude-heatmap-legend">
        <span>적음</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className="claude-heatmap-legend-swatch" data-level={level} />
        ))}
        <span>많음</span>
      </div>
    </div>
  )
}
