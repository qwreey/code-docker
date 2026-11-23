import type { SystemResources } from '../../api/types'
import { formatBytes } from '../../utils/format'
import './Processes.css'

interface MemoryBreakdownProps {
  cgroup: SystemResources['memory']
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

function StackedBar({ segments, totalBytes }: { segments: Segment[]; totalBytes: number }) {
  return (
    <div className="perf-mem-stack">
      {segments.map((s) => (
        <div
          key={s.key}
          className="perf-mem-seg"
          style={{ width: `${(s.bytes / totalBytes) * 100}%`, background: s.colorVar }}
          title={`${s.label}: ${formatBytes(s.bytes)}`}
        />
      ))}
    </div>
  )
}

function Legend({ segments, total }: { segments: Segment[]; total: string }) {
  return (
    <div className="perf-mem-legend">
      {segments.map((s) => (
        <span className="perf-mem-legend-item" key={s.key}>
          <span className="perf-mem-legend-swatch" style={{ background: s.colorVar }} />
          {s.label} {formatBytes(s.bytes)}
        </span>
      ))}
      <span className="perf-mem-legend-total">{total}</span>
    </div>
  )
}

// MemoryBreakdown shows two distinct scopes side by side: this container's
// cgroup and the host's physical memory, both as stacked bars. Both matter
// together because the cgroup may have no limit (limitBytes null), and then
// the host's physical total is the only ceiling left to show.
//
// The container's headline figure is the working set, not memory.current:
// the latter counts page cache, which the kernel keeps until the limit
// forces it out, so a container that has read a lot of files reads ~100%
// while it can still start processes. Colors follow the entity across both
// bars: in-use cat-1, cache cat-2.
export function MemoryBreakdown({
  cgroup,
  hostTotalBytes,
  hostFreeBytes,
  hostBuffersBytes,
  hostCachedBytes,
  hostAvailable,
}: MemoryBreakdownProps) {
  const limit = cgroup.limitBytes
  const workingPercent = cgroup.available && limit ? (cgroup.workingSetBytes / limit) * 100 : null
  const cgroupDanger = workingPercent != null && workingPercent >= 90

  const cacheBytes = Math.max(0, cgroup.fileBytes - cgroup.shmemBytes)
  const cgroupSegments: Segment[] = cgroup.statAvailable
    ? [
        { key: 'anon', label: '프로그램', bytes: cgroup.anonBytes, colorVar: 'var(--viz-cat-1)' },
        { key: 'cache', label: '캐시', bytes: cacheBytes, colorVar: 'var(--viz-cat-2)' },
        {
          key: 'other',
          label: '커널·공유 메모리',
          bytes: Math.max(0, cgroup.usedBytes - cgroup.anonBytes - cacheBytes),
          colorVar: 'var(--viz-cat-3)',
        },
        ...(limit ? [{ key: 'free', label: '여유', bytes: Math.max(0, limit - cgroup.usedBytes), colorVar: 'var(--color-gray-border)' }] : []),
      ].filter((s) => s.bytes > 0)
    : []
  const cgroupBarTotal = limit ?? cgroup.usedBytes

  const hostUsed = Math.max(0, hostTotalBytes - hostFreeBytes - hostBuffersBytes - hostCachedBytes)
  const hostSegments: Segment[] =
    hostAvailable && hostTotalBytes > 0
      ? [
          { key: 'used', label: '사용 중', bytes: hostUsed, colorVar: 'var(--viz-cat-1)' },
          { key: 'cache', label: '캐시·버퍼', bytes: hostCachedBytes + hostBuffersBytes, colorVar: 'var(--viz-cat-2)' },
          { key: 'free', label: '여유', bytes: hostFreeBytes, colorVar: 'var(--color-gray-border)' },
        ].filter((s) => s.bytes > 0)
      : []

  return (
    <div className="card perf-card">
      <h2>메모리</h2>

      <div className="perf-mem-scope">
        <div className="perf-mem-scope-label">컨테이너 (cgroup)</div>
        {cgroup.available ? (
          <>
            {cgroupSegments.length > 0 ? (
              <StackedBar segments={cgroupSegments} totalBytes={cgroupBarTotal} />
            ) : (
              <div className="system-summary-bar">
                <div
                  className={`system-summary-bar-fill${cgroupDanger ? ' system-summary-bar-fill-danger' : ''}`}
                  style={{ width: `${Math.min(100, workingPercent ?? 0)}%` }}
                />
              </div>
            )}
            <div className={`perf-mem-scope-sub${cgroupDanger ? ' perf-mem-scope-danger' : ''}`}>
              실사용 {formatBytes(cgroup.workingSetBytes)}
              {limit != null
                ? ` / ${formatBytes(limit)} (${(workingPercent ?? 0).toFixed(1)}%)`
                : ' · 제한 없음 (아래 호스트 메모리 참고)'}
              {cgroup.statAvailable && ` · 캐시 포함 ${formatBytes(cgroup.usedBytes)}`}
              {cgroupDanger && ' · 상한에 가까움'}
            </div>
            {cgroupSegments.length > 0 && (
              <Legend segments={cgroupSegments} total={limit != null ? `제한 ${formatBytes(limit)}` : ''} />
            )}
          </>
        ) : (
          <div className="system-summary-unavailable">확인 불가</div>
        )}
      </div>

      <div className="perf-mem-scope">
        <div className="perf-mem-scope-label">호스트 실제 메모리</div>
        {hostSegments.length > 0 ? (
          <>
            <StackedBar segments={hostSegments} totalBytes={hostTotalBytes} />
            <Legend segments={hostSegments} total={`총 ${formatBytes(hostTotalBytes)}`} />
          </>
        ) : (
          <div className="system-summary-unavailable">확인 불가</div>
        )}
      </div>
    </div>
  )
}
