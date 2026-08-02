import { useMemo } from 'react'
import type { DailyActivity } from '../../api/types'
import { formatCompactNumber } from '../../utils/format'

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토']

export function WeeklyChart({ dailyActivity }: { dailyActivity: DailyActivity[] }) {
  const days = useMemo(() => {
    return [...dailyActivity].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-7)
  }, [dailyActivity])

  if (days.length === 0) {
    return <p className="empty-state">아직 활동 기록이 없습니다.</p>
  }

  const max = Math.max(1, ...days.map((d) => Math.max(d.messageCount, d.toolCallCount)))
  const maxMessageDate = days.reduce((best, d) => (d.messageCount > best.messageCount ? d : best), days[0]).date
  const maxToolDate = days.reduce((best, d) => (d.toolCallCount > best.toolCallCount ? d : best), days[0]).date

  return (
    <div className="claude-weekly">
      <div className="claude-weekly-legend">
        <span className="claude-legend-item">
          <span className="claude-legend-swatch claude-legend-swatch-1" /> 메시지
        </span>
        <span className="claude-legend-item">
          <span className="claude-legend-swatch claude-legend-swatch-2" /> 툴 호출
        </span>
      </div>
      <div className="claude-weekly-bars">
        {days.map((d) => {
          const [, m, day] = d.date.split('-')
          const weekday = WEEKDAY_LABELS[new Date(`${d.date}T00:00:00Z`).getUTCDay()]
          const msgPct = (d.messageCount / max) * 100
          const toolPct = (d.toolCallCount / max) * 100
          return (
            <div className="claude-weekly-group" key={d.date}>
              <div className="claude-weekly-bar-pair">
                <div className="claude-weekly-bar-track">
                  {d.date === maxMessageDate && d.messageCount > 0 && (
                    <span className="claude-weekly-bar-label">{formatCompactNumber(d.messageCount)}</span>
                  )}
                  <div
                    className="claude-weekly-bar claude-weekly-bar-1"
                    style={{ height: `${msgPct}%` }}
                    title={`${d.date} · 메시지 ${d.messageCount.toLocaleString()}`}
                    tabIndex={0}
                  />
                </div>
                <div className="claude-weekly-bar-track">
                  {d.date === maxToolDate && d.toolCallCount > 0 && (
                    <span className="claude-weekly-bar-label">{formatCompactNumber(d.toolCallCount)}</span>
                  )}
                  <div
                    className="claude-weekly-bar claude-weekly-bar-2"
                    style={{ height: `${toolPct}%` }}
                    title={`${d.date} · 툴 호출 ${d.toolCallCount.toLocaleString()}`}
                    tabIndex={0}
                  />
                </div>
              </div>
              <div className="claude-weekly-axis-label">
                {Number(m)}/{Number(day)} ({weekday})
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
