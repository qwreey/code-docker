import { useRef, useState } from 'react'
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

  function showHover(el: HTMLElement, index: number) {
    const grid = gridRef.current
    if (!grid) return
    const cellRect = el.getBoundingClientRect()
    const gridRect = grid.getBoundingClientRect()
    setHover({ index, x: cellRect.left - gridRect.left + cellRect.width / 2, y: cellRect.top - gridRect.top })
  }

  return (
    <div className="card perf-card">
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
                코어 {hover.index} · {perCorePercent[hover.index].toFixed(1)}%
                {clockMHz?.[hover.index] ? ` · ${(clockMHz[hover.index] / 1000).toFixed(2)} GHz` : ''}
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
