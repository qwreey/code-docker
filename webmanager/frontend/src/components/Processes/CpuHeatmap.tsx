import './Processes.css'

interface CpuHeatmapProps {
  perCorePercent: number[]
  available: boolean
  clockMHz?: number[]
  numCpu: number
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
  return (
    <div className="card perf-card">
      <h2>CPU 코어 (호스트 전체)</h2>
      <p className="perf-card-note">
        호스트 머신의 코어 {numCpu}개 전체 사용률입니다. cgroup v2는 코어별 통계를 제공하지 않기 때문에 이 값은{' '}
        <strong>컨테이너 사용량이 아닌 호스트 전체 기준</strong>입니다.
      </p>
      {!available || perCorePercent.length === 0 ? (
        <p className="empty-state">코어별 CPU 정보를 사용할 수 없습니다.</p>
      ) : (
        <>
          <div className="perf-cpu-grid">
            {perCorePercent.map((pct, i) => {
              const mhz = clockMHz?.[i]
              return (
                <div
                  key={i}
                  className="perf-cpu-cell"
                  data-level={levelFor(pct)}
                  tabIndex={0}
                  title={`코어 ${i} · ${pct.toFixed(1)}%${mhz ? ` · ${(mhz / 1000).toFixed(2)} GHz` : ''}`}
                >
                  <span className="perf-cpu-cell-label">{i}</span>
                </div>
              )
            })}
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
