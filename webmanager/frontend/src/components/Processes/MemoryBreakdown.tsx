import { formatBytes } from '../../utils/format'
import './Processes.css'

interface MemoryBreakdownProps {
  cgroupUsedBytes: number
  cgroupLimitBytes: number | null
  cgroupAvailable: boolean
  hostTotalBytes: number
  hostFreeBytes: number
  hostBuffersBytes: number
  hostCachedBytes: number
  hostAvailable: boolean
}

interface Segment {
  key: string
  label: string
  bytes: number
  colorVar: string
}

// MemoryBreakdown shows two distinct scopes side by side: this container's
// cgroup used/limit (unchanged from before this redesign — a single ratio,
// so a plain progress bar is enough), and the host's physical memory as a
// stacked bar. Both matter together specifically because the cgroup may
// report "no limit set" (cgroupLimitBytes null), in which case the host's
// physical total is the only meaningful ceiling left to show.
export function MemoryBreakdown({
  cgroupUsedBytes,
  cgroupLimitBytes,
  cgroupAvailable,
  hostTotalBytes,
  hostFreeBytes,
  hostBuffersBytes,
  hostCachedBytes,
  hostAvailable,
}: MemoryBreakdownProps) {
  const cgroupPercent = cgroupAvailable && cgroupLimitBytes ? (cgroupUsedBytes / cgroupLimitBytes) * 100 : null
  const cgroupDanger = cgroupPercent != null && cgroupPercent >= 90

  const hostUsed = Math.max(0, hostTotalBytes - hostFreeBytes - hostBuffersBytes - hostCachedBytes)
  const segments: Segment[] =
    hostAvailable && hostTotalBytes > 0
      ? [
          { key: 'used', label: '사용 중', bytes: hostUsed, colorVar: 'var(--viz-cat-1)' },
          { key: 'cache', label: '캐시', bytes: hostCachedBytes, colorVar: 'var(--viz-cat-2)' },
          { key: 'buffers', label: '버퍼', bytes: hostBuffersBytes, colorVar: 'var(--viz-cat-3)' },
          { key: 'free', label: '여유', bytes: hostFreeBytes, colorVar: 'var(--color-gray-border)' },
        ].filter((s) => s.bytes > 0)
      : []

  return (
    <div className="card perf-card">
      <h2>메모리</h2>

      <div className="perf-mem-scope">
        <div className="perf-mem-scope-label">컨테이너 (cgroup)</div>
        {cgroupAvailable ? (
          <>
            <div className="system-summary-bar">
              <div
                className={`system-summary-bar-fill${cgroupDanger ? ' system-summary-bar-fill-danger' : ''}`}
                style={{ width: `${Math.min(100, cgroupPercent ?? 0)}%` }}
              />
            </div>
            <div className="perf-mem-scope-sub">
              {formatBytes(cgroupUsedBytes)}
              {cgroupLimitBytes != null
                ? ` / ${formatBytes(cgroupLimitBytes)} (${(cgroupPercent ?? 0).toFixed(1)}%)`
                : ' · 제한 없음 (아래 호스트 메모리 참고)'}
            </div>
          </>
        ) : (
          <div className="system-summary-unavailable">확인 불가</div>
        )}
      </div>

      <div className="perf-mem-scope">
        <div className="perf-mem-scope-label">호스트 실제 메모리</div>
        {segments.length > 0 ? (
          <>
            <div className="perf-mem-stack">
              {segments.map((s) => (
                <div
                  key={s.key}
                  className="perf-mem-seg"
                  style={{ width: `${(s.bytes / hostTotalBytes) * 100}%`, background: s.colorVar }}
                  title={`${s.label}: ${formatBytes(s.bytes)}`}
                />
              ))}
            </div>
            <div className="perf-mem-legend">
              {segments.map((s) => (
                <span className="perf-mem-legend-item" key={s.key}>
                  <span className="perf-mem-legend-swatch" style={{ background: s.colorVar }} />
                  {s.label} {formatBytes(s.bytes)}
                </span>
              ))}
              <span className="perf-mem-legend-total">총 {formatBytes(hostTotalBytes)}</span>
            </div>
          </>
        ) : (
          <div className="system-summary-unavailable">확인 불가</div>
        )}
      </div>
    </div>
  )
}
