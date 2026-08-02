import { useMemo } from 'react'
import type { ModelUsageSummary } from '../../api/types'
import { formatCompactNumber } from '../../utils/format'

interface Panel {
  title: string
  rows: { model: string; value: number }[]
}

export function ModelUsageChart({ modelUsage }: { modelUsage: Record<string, ModelUsageSummary> }) {
  const models = useMemo(() => Object.keys(modelUsage), [modelUsage])

  const panels: Panel[] = useMemo(() => {
    const build = (pick: (m: ModelUsageSummary) => number): Panel['rows'] =>
      models
        .map((model) => ({ model, value: pick(modelUsage[model]) }))
        .sort((a, b) => b.value - a.value)

    return [
      { title: '입력 토큰', rows: build((m) => m.inputTokens) },
      { title: '출력 토큰', rows: build((m) => m.outputTokens) },
      { title: '캐시 읽기 토큰', rows: build((m) => m.cacheReadInputTokens) },
    ]
  }, [models, modelUsage])

  if (models.length === 0) {
    return <p className="empty-state">모델 사용 기록이 없습니다.</p>
  }

  return (
    <div className="claude-model-usage">
      {panels.map((panel) => {
        const max = Math.max(1, ...panel.rows.map((r) => r.value))
        return (
          <div className="claude-model-panel" key={panel.title}>
            <div className="claude-model-panel-title">{panel.title}</div>
            <div className="claude-model-panel-rows">
              {panel.rows.map((row) => (
                <div className="claude-model-row" key={row.model}>
                  <span className="claude-model-row-name" title={row.model}>
                    {row.model}
                  </span>
                  <div className="claude-model-row-track" title={`${row.model} · ${row.value.toLocaleString()}`} tabIndex={0}>
                    <div className="claude-model-row-bar" style={{ width: `${(row.value / max) * 100}%` }} />
                  </div>
                  <span className="claude-model-row-value">{formatCompactNumber(row.value)}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
