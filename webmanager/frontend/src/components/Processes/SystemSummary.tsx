import { formatBytes, formatPercent } from '../../utils/format'
import './Processes.css'

const DANGER_THRESHOLD = 90

interface DiskInfo {
  path: string
  totalBytes: number
  usedBytes: number
  freeBytes: number
  available: boolean
}

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0))
  const danger = clamped >= DANGER_THRESHOLD
  return (
    <div className="system-summary-bar">
      <div
        className={`system-summary-bar-fill${danger ? ' system-summary-bar-fill-danger' : ''}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

// DiskUsageCard is what's left of the old SystemSummary once the redundant
// CPU/memory "current value" cards were removed (see Performance.tsx and
// CpuHeatmap/MemoryBreakdown below) — those duplicated numbers the
// redesigned graphs already show in their own header/legend. Disk usage
// isn't graphed anywhere else in this tab, so it keeps its own small card
// here instead of being folded away. Pure/presentational: Performance.tsx
// owns the single shared /system/resources poll and passes `disk` down.
export function DiskUsageCard({ disk }: { disk: DiskInfo }) {
  const diskPercent = disk.totalBytes > 0 ? (disk.usedBytes / disk.totalBytes) * 100 : 0

  return (
    <div className="card perf-card perf-card-disk">
      <div className="system-summary-label">
        디스크 (<span className="system-summary-label-path">{disk.path}</span>)
      </div>
      {disk.available ? (
        <>
          <div className="system-summary-value">
            {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
          </div>
          <ProgressBar percent={diskPercent} />
          <div className="system-summary-sub">{formatPercent(diskPercent)} 사용</div>
        </>
      ) : (
        <div className="system-summary-unavailable">확인 불가</div>
      )}
    </div>
  )
}
