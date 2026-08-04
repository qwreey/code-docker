import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { ResourceHistoryResponse } from '../../api/types'
import './Processes.css'

interface CpuHeatmapProps {
  perCorePercent: number[]
  available: boolean
  clockMHz?: number[]
  numCpu: number
}

interface HoverState {
  index: number
  x: number
  y: number
}

const DEFAULT_HISTORY_POLL_MS = 5000

// Per-core sparkline in the tooltip reuses GET /api/system/resources/history
// (already polled independently by ResourceHistory for the CPU/mem/disk/net
// graphs below - this is a second, separate poll of the same cheap endpoint,
// kept self-contained here rather than threading history state down from
// Performance so this component doesn't need a parent-shaped API).
function useCoreHistory() {
  const [data, setData] = useState<ResourceHistoryResponse | null>(null)
  const [pollMs, setPollMs] = useState(DEFAULT_HISTORY_POLL_MS)
  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const resp = await api.get<ResourceHistoryResponse>('/system/resources/history')
      setData(resp)
      if (resp.intervalSeconds > 0) {
        const next = Math.max(2000, resp.intervalSeconds * 1000)
        setPollMs((prev) => (prev === next ? prev : next))
      }
    } catch {
      // silently keep last-known history - the heatmap itself still works from perCorePercent
    } finally {
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, pollMs)
    return () => clearInterval(timer)
  }, [load, pollMs])

  return data
}

function formatSpan(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}초`
  return `${Math.round(seconds / 60)}분`
}

function sparklinePath(values: number[], width: number, height: number): string {
  if (values.length < 2) return ''
  const max = Math.max(100, ...values)
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width
      const y = height - (v / max) * height
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

// Fixed absolute bands (not per-dataset quartiles like ClaudeCode/Heatmap.tsx
// uses for message counts) — a CPU percent already has a meaningful absolute
// scale, so "80%" should always read as the same color regardless of what
// the rest of the grid is doing at that moment.
function levelFor(percent: number): number {
  if (percent < 20) return 0
  if (percent < 40) return 1
  if (percent < 60) return 2
  if (percent < 80) return 3
  return 4
}

export function CpuHeatmap({ perCorePercent, available, clockMHz, numCpu }: CpuHeatmapProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const history = useCoreHistory()

  const hoverHistory =
    hover && history
      ? history.points.map((p) => p.hostPerCorePercent?.[hover.index]).filter((v): v is number => v != null)
      : []

  function showHover(el: HTMLElement, index: number) {
    const grid = gridRef.current
    if (!grid) return
    const cellRect = el.getBoundingClientRect()
    const gridRect = grid.getBoundingClientRect()
    setHover({ index, x: cellRect.left - gridRect.left + cellRect.width / 2, y: cellRect.top - gridRect.top })
  }

  return (
    <div className="card perf-card perf-card-cpu">
      <h2>CPU 코어 (호스트 전체기준, {numCpu}개)</h2>
      {!available || perCorePercent.length === 0 ? (
        <p className="empty-state">코어별 CPU 정보를 사용할 수 없습니다.</p>
      ) : (
        <>
          <div className="perf-cpu-grid" ref={gridRef} onMouseLeave={() => setHover(null)}>
            {perCorePercent.map((pct, i) => (
              <div
                key={i}
                className="perf-cpu-cell"
                data-level={levelFor(pct)}
                tabIndex={0}
                onMouseEnter={(e) => showHover(e.currentTarget, i)}
                onFocus={(e) => showHover(e.currentTarget, i)}
                onBlur={() => setHover((h) => (h?.index === i ? null : h))}
              >
                <span className="perf-cpu-cell-label">{i}</span>
              </div>
            ))}
            {hover && (
              <div className="perf-cpu-tooltip" style={{ left: hover.x, top: hover.y }}>
                <div>
                  코어 {hover.index} · {perCorePercent[hover.index].toFixed(1)}%
                  {clockMHz?.[hover.index] ? ` · ${(clockMHz[hover.index] / 1000).toFixed(2)} GHz` : ''}
                </div>
                {hoverHistory.length >= 2 && (
                  <>
                    <svg className="perf-cpu-sparkline" viewBox="0 0 100 28" preserveAspectRatio="none">
                      <path d={sparklinePath(hoverHistory, 100, 28)} />
                    </svg>
                    <div className="perf-cpu-sparkline-stats">
                      최근 {formatSpan(hoverHistory.length * (history?.intervalSeconds ?? 0))} · 최소{' '}
                      {Math.min(...hoverHistory).toFixed(0)}% · 평균{' '}
                      {(hoverHistory.reduce((a, b) => a + b, 0) / hoverHistory.length).toFixed(0)}% · 최대{' '}
                      {Math.max(...hoverHistory).toFixed(0)}%
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="perf-cpu-legend">
            <span>낮음</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <span key={level} className="perf-cpu-legend-swatch" data-level={level} />
            ))}
            <span>높음</span>
          </div>
        </>
      )}
    </div>
  )
}
