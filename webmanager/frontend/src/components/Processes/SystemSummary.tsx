import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { DiskBreakdownResponse } from '../../api/types'
import { formatBytes, formatPercent } from '../../utils/format'
import './Processes.css'

const DANGER_THRESHOLD = 90
const BREAKDOWN_SCAN_POLL_MS = 2000
// Entries below this share of the total get folded into "기타" — also caps
// how many get their own color, since the categorical palette only defines
// 3 distinct hues (--viz-cat-1/2/3, see Processes.css) before running out.
const OTHER_THRESHOLD_PERCENT = 4
const MAX_OWN_COLOR_SEGMENTS = 3

interface DiskInfo {
  path: string
  totalBytes: number
  usedBytes: number
  freeBytes: number
  available: boolean
}

interface Segment {
  key: string
  label: string
  bytes: number
  colorVar: string
}

function buildSegments(data: DiskBreakdownResponse): Segment[] {
  if (data.totalBytes <= 0) return []

  const sorted = [...data.entries].sort((a, b) => b.sizeBytes - a.sizeBytes)
  const ownColor: Segment[] = []
  let otherBytes = 0
  for (const entry of sorted) {
    const percent = (entry.sizeBytes / data.totalBytes) * 100
    if (ownColor.length < MAX_OWN_COLOR_SEGMENTS && percent >= OTHER_THRESHOLD_PERCENT) {
      ownColor.push({
        key: entry.path,
        label: entry.name,
        bytes: entry.sizeBytes,
        colorVar: `var(--viz-cat-${ownColor.length + 1})`,
      })
    } else {
      otherBytes += entry.sizeBytes
    }
  }

  const segments = [...ownColor]
  if (otherBytes > 0) {
    segments.push({ key: '__other__', label: '기타', bytes: otherBytes, colorVar: 'var(--viz-seq-3)' })
  }
  if (data.freeBytes > 0) {
    segments.push({ key: '__free__', label: '여유', bytes: data.freeBytes, colorVar: 'var(--color-gray-border)' })
  }
  return segments
}

// DiskBreakdownSection is a Windows Storage Sense / Samsung 저장공간 분석기류
// "무엇이 어디서 얼마나 쓰는지" 뷰 — 컨테이너 자신의 루트 파일시스템을
// 최상위 디렉토리 단위로 du한 결과(internal/diskusage)를 스택형 바로 보여줌.
// 위의 DiskUsageCard와 달리 Performance.tsx의 공유 폴링에 얹지 않고 자체
// 데이터 흐름을 가짐 — 전체 루트 du는 느릴 수 있어(캐시+수동 새로고침 원칙),
// 마운트 시 한 번만 불러오고 스캔 중일 때만 짧게 폴링하다 멈춤(Projects 탭과
// 동일한 패턴, CpuHeatmap의 별도 히스토리 폴링과 같은 이유로 자체 fetch를 둠).
function DiskBreakdownSection() {
  const [data, setData] = useState<DiskBreakdownResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await api.get<DiskBreakdownResponse>('/system/disk-breakdown')
      setData(res)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [])

  const triggerScan = useCallback(async () => {
    setBusy(true)
    try {
      const res = await api.post<DiskBreakdownResponse>('/system/disk-breakdown/scan')
      setData(res)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!data?.scanning) return
    const timer = setInterval(load, BREAKDOWN_SCAN_POLL_MS)
    return () => clearInterval(timer)
  }, [data?.scanning, load])

  if (error) {
    return <div className="system-summary-notice">디스크 사용량 분석을 불러오지 못했습니다 ({error})</div>
  }
  if (!data) {
    return <div className="empty-state">불러오는 중...</div>
  }

  const segments = buildSegments(data)
  const scanningNow = data.scanning || busy

  return (
    <div className="perf-mem-scope">
      <div className="perf-disk-breakdown-header">
        <span className="perf-mem-scope-label">컨테이너 디스크 사용량 ({data.root})</span>
        <button type="button" className="btn btn-secondary btn-small" onClick={triggerScan} disabled={scanningNow}>
          {scanningNow ? '분석 중...' : '새로고침'}
        </button>
      </div>

      {!data.available ? (
        <div className="system-summary-unavailable">확인 불가</div>
      ) : segments.length === 0 ? (
        <p className="empty-state">
          {scanningNow ? '분석 중입니다 — 완료되면 자동으로 갱신됩니다.' : '아직 분석하지 않았습니다. 새로고침을 눌러주세요.'}
        </p>
      ) : (
        <>
          <div className="perf-mem-stack">
            {segments.map((s) => (
              <div
                key={s.key}
                className="perf-mem-seg"
                style={{ width: `${(s.bytes / data.totalBytes) * 100}%`, background: s.colorVar }}
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
            <span className="perf-mem-legend-total">총 {formatBytes(data.totalBytes)}</span>
          </div>
          {data.scannedAt && (
            <div className="perf-mem-scope-sub">{new Date(data.scannedAt).toLocaleString('ko-KR')} 기준</div>
          )}
        </>
      )}
    </div>
  )
}

// DiskUsageCard is what's left of the old SystemSummary once the redundant
// CPU/memory "current value" cards were removed (see Performance.tsx and
// CpuHeatmap/MemoryBreakdown below) — those duplicated numbers the
// redesigned graphs already show in their own header/legend.
//
// The free-vs-used framing (a progress bar toward `disk.totalBytes`) that
// used to lead this card was dropped — "how much room is left" isn't the
// useful question here, "what's actually using the space" is, which is
// exactly what DiskBreakdownSection's folder-percentage view already
// answers. DiskBreakdownSection is now the primary content; the host/mount
// numbers for `disk.path` (fed by Performance.tsx's shared /system/resources
// poll, a different scope than DiskBreakdownSection's own container-root du
// — see its doc comment) are kept only as a compact secondary caption below
// it, since the underlying host mount's total capacity isn't otherwise
// visible from the du-based breakdown alone.
export function DiskUsageCard({ disk }: { disk: DiskInfo }) {
  const diskPercent = disk.totalBytes > 0 ? (disk.usedBytes / disk.totalBytes) * 100 : 0
  const danger = disk.available && diskPercent >= DANGER_THRESHOLD

  return (
    <div className="card perf-card perf-card-disk">
      <DiskBreakdownSection />

      <div className={`perf-disk-host-note${danger ? ' perf-disk-host-note-danger' : ''}`}>
        호스트 마운트 <span className="system-summary-label-path">{disk.path}</span>:{' '}
        {disk.available
          ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} (${formatPercent(diskPercent)} 사용)`
          : '확인 불가'}
      </div>
    </div>
  )
}
