import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { ResourceHistoryPoint, ResourceHistoryResponse } from '../../api/types'
import { formatBytes } from '../../utils/format'
import './ResourceHistory.css'

const DEFAULT_POLL_MS = 5000
const MIN_POINTS_TO_PLOT = 2

interface SeriesSpec {
  key: string
  label: string
  color: string
  getValue: (p: ResourceHistoryPoint) => number
  format: (v: number) => string
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

function formatDurationShort(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}초`
  return `${Math.round(seconds / 60)}분`
}

// 데이터의 order of magnitude에 맞춰 보기 좋은 상한값을 고른다 (1/2/5/10 * 10^n).
function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const exp = Math.floor(Math.log10(value))
  const base = 10 ** exp
  const norm = value / base
  let niceNorm: number
  if (norm <= 1) niceNorm = 1
  else if (norm <= 2) niceNorm = 2
  else if (norm <= 5) niceNorm = 5
  else niceNorm = 10
  return niceNorm * base
}

function buildTicks(lo: number, hi: number, count = 4): number[] {
  if (hi <= lo) return [lo, lo + 1]
  const ticks: number[] = []
  for (let i = 0; i <= count; i++) ticks.push(lo + ((hi - lo) * i) / count)
  return ticks
}

interface PanelProps {
  title: string
  headerValue?: string
  points: ResourceHistoryPoint[]
  series: SeriesSpec[]
  yDomain: [number, number]
  yTicks: number[]
  yTickFormat: (v: number) => string
  fillArea: boolean
  referenceLine?: { value: number; label: string }
}

function TimeSeriesPanel({ title, headerValue, points, series, yDomain, yTicks, yTickFormat, fillArea, referenceLine }: PanelProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  const tMin = points[0].timestamp
  const tMax = points[points.length - 1].timestamp
  const span = Math.max(1, tMax - tMin)
  const [yLo, yHi] = yDomain
  const yRange = Math.max(1e-9, yHi - yLo)

  const xPct = useCallback((t: number) => ((t - tMin) / span) * 100, [tMin, span])
  const yPct = useCallback((v: number) => 100 - ((clamp(v, yLo, yHi) - yLo) / yRange) * 100, [yLo, yHi, yRange])

  const seriesPaths = useMemo(
    () =>
      series.map((s) => {
        const pts = points.map((p) => ({ x: xPct(p.timestamp), y: yPct(s.getValue(p)) }))
        const linePath = pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ')
        const areaPath = fillArea
          ? `${linePath} L${pts[pts.length - 1].x.toFixed(2)},100 L${pts[0].x.toFixed(2)},100 Z`
          : null
        return { spec: s, pts, linePath, areaPath }
      }),
    [series, points, xPct, yPct, fillArea],
  )

  const updateHoverFromClientX = useCallback(
    (clientX: number) => {
      const wrap = wrapRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      if (rect.width === 0) return
      const frac = clamp((clientX - rect.left) / rect.width, 0, 1)
      const targetT = tMin + frac * span
      let nearest = 0
      let bestDiff = Infinity
      for (let i = 0; i < points.length; i++) {
        const diff = Math.abs(points[i].timestamp - targetT)
        if (diff < bestDiff) {
          bestDiff = diff
          nearest = i
        }
      }
      setHoverIndex(nearest)
    },
    [points, tMin, span],
  )

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setHoverIndex((idx) => clamp((idx ?? points.length - 1) - 1, 0, points.length - 1))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      setHoverIndex((idx) => clamp((idx ?? points.length - 1) + 1, 0, points.length - 1))
    }
  }

  const hoverPoint = hoverIndex != null ? points[hoverIndex] : null
  const hoverXPct = hoverPoint ? xPct(hoverPoint.timestamp) : null
  const tooltipTransform = hoverXPct == null ? undefined : hoverXPct < 15 ? 'translateX(0)' : hoverXPct > 85 ? 'translateX(-100%)' : 'translateX(-50%)'

  return (
    <div className="card rh-panel">
      <div className="rh-panel-header">
        <h2>{title}</h2>
        <div className="rh-panel-header-right">
          {headerValue && <span className="rh-header-value">{headerValue}</span>}
          {series.length >= 2 && (
            <div className="rh-legend">
              {series.map((s) => (
                <span className="rh-legend-item" key={s.key}>
                  <span className="rh-legend-swatch" style={{ background: s.color }} />
                  {s.label}
                  <span className="rh-legend-value">{s.format(s.getValue(points[points.length - 1]))}</span>
                </span>
              ))}
            </div>
          )}
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setShowTable((v) => !v)}>
            {showTable ? '그래프로 보기' : '표로 보기'}
          </button>
        </div>
      </div>

      {showTable ? (
        <div className="rh-table-wrap">
          <table className="rh-table">
            <thead>
              <tr>
                <th>시각</th>
                {series.map((s) => (
                  <th key={s.key}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.timestamp}>
                  <td>{formatClock(p.timestamp)}</td>
                  {series.map((s) => (
                    <td key={s.key}>{s.format(s.getValue(p))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="rh-plot">
            <div className="rh-yaxis">
              {[...yTicks].reverse().map((t) => (
                <span key={t}>{yTickFormat(t)}</span>
              ))}
            </div>
            <div
              className="rh-plot-wrap"
              ref={wrapRef}
              tabIndex={0}
              aria-label={`${title} 추이 차트, 방향키로 시점 탐색`}
              onPointerMove={(e) => updateHoverFromClientX(e.clientX)}
              onPointerLeave={() => setHoverIndex(null)}
              onFocus={() => setHoverIndex(points.length - 1)}
              onBlur={() => setHoverIndex(null)}
              onKeyDown={handleKeyDown}
            >
              <svg className="rh-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
                {yTicks.map((t) => (
                  <line key={t} x1={0} x2={100} y1={yPct(t)} y2={yPct(t)} className="rh-gridline" vectorEffect="non-scaling-stroke" />
                ))}
                {referenceLine && (
                  <line
                    x1={0}
                    x2={100}
                    y1={yPct(referenceLine.value)}
                    y2={yPct(referenceLine.value)}
                    className="rh-reference-line"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {seriesPaths.map(({ spec, areaPath }) =>
                  areaPath ? <path key={spec.key} d={areaPath} fill={spec.color} className="rh-area" /> : null,
                )}
                {seriesPaths.map(({ spec, linePath }) => (
                  <path
                    key={spec.key}
                    d={linePath}
                    stroke={spec.color}
                    strokeWidth={2}
                    className="rh-line"
                    fill="none"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </svg>

              {referenceLine && (
                <div className="rh-reference-label" style={{ top: `${yPct(referenceLine.value)}%` }}>
                  {referenceLine.label}
                </div>
              )}

              {seriesPaths.map(({ spec, pts }) => {
                const last = pts[pts.length - 1]
                return (
                  <span
                    key={spec.key}
                    className="rh-end-dot"
                    style={{ left: `${last.x}%`, top: `${last.y}%`, background: spec.color }}
                  />
                )
              })}

              {hoverXPct != null && <div className="rh-crosshair" style={{ left: `${hoverXPct}%` }} />}

              {hoverPoint && (
                <div className="rh-tooltip" style={{ left: `${hoverXPct}%`, transform: tooltipTransform }}>
                  <div className="rh-tooltip-time">{formatClock(hoverPoint.timestamp)}</div>
                  {series.map((s) => (
                    <div className="rh-tooltip-row" key={s.key}>
                      <span className="rh-tooltip-key" style={{ background: s.color }} />
                      <span className="rh-tooltip-label">{s.label}</span>
                      <span className="rh-tooltip-value">{s.format(s.getValue(hoverPoint))}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rh-xaxis">
              <span>{formatClock(tMin)}</span>
              <span>{formatClock(tMin + span / 2)}</span>
              <span>{formatClock(tMax)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export function ResourceHistory() {
  const [data, setData] = useState<ResourceHistoryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollMs, setPollMs] = useState(DEFAULT_POLL_MS)
  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const resp = await api.get<ResourceHistoryResponse>('/system/resources/history')
      setData(resp)
      setError(null)
      if (resp.intervalSeconds > 0) {
        const next = Math.max(2000, resp.intervalSeconds * 1000)
        setPollMs((prev) => (prev === next ? prev : next))
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, pollMs)
    return () => clearInterval(timer)
  }, [load, pollMs])

  if (error) {
    return <div className="system-summary-notice">리소스 사용량 기록을 불러오지 못했습니다 ({error})</div>
  }

  if (!data) {
    return <div className="system-summary-notice">리소스 사용량 기록을 불러오는 중...</div>
  }

  const { points, diskIOAvailable, netIOAvailable } = data

  if (points.length < MIN_POINTS_TO_PLOT) {
    return (
      <div className="card rh-panel">
        <h2>리소스 사용량 추이</h2>
        <p className="empty-state">데이터 수집 중입니다. 잠시 후 그래프가 표시됩니다.</p>
      </div>
    )
  }

  const latest = points[points.length - 1]
  const spanSeconds = (latest.timestamp - points[0].timestamp) / 1000
  const subtitle = `최근 ${formatDurationShort(spanSeconds)} 데이터 · ${data.intervalSeconds}초 간격`

  const memLimit = latest.memLimitBytes
  const memMaxUsed = Math.max(...points.map((p) => p.memUsedBytes))
  const memDomainMax = memLimit != null ? memLimit : niceMax(memMaxUsed)
  const memTicks = buildTicks(0, memDomainMax)
  const memTickFormat = (v: number) => (memLimit != null ? `${Math.round((v / memLimit) * 100)}%` : formatBytes(v))
  const memHeaderValue =
    memLimit != null
      ? `${formatBytes(latest.memUsedBytes)} (${Math.round((latest.memUsedBytes / memLimit) * 100)}%)`
      : formatBytes(latest.memUsedBytes)

  const diskMax = niceMax(Math.max(1, ...points.flatMap((p) => [p.diskReadBytesPerSec, p.diskWriteBytesPerSec])))
  const netMax = niceMax(Math.max(1, ...points.flatMap((p) => [p.netRxBytesPerSec, p.netTxBytesPerSec])))

  return (
    <div className="rh-section">
      <div className="rh-section-header">
        <h2 className="rh-section-title">리소스 사용량 추이</h2>
        <span className="rh-section-subtitle">{subtitle}</span>
      </div>
      <div className="rh-grid">
        <TimeSeriesPanel
          title="CPU"
          headerValue={`${latest.cpuPercent.toFixed(1)}%`}
          points={points}
          series={[
            {
              key: 'cpu',
              label: 'CPU',
              color: 'var(--viz-cat-1)',
              getValue: (p) => p.cpuPercent,
              format: (v) => `${v.toFixed(1)}%`,
            },
          ]}
          yDomain={[0, 100]}
          yTicks={[0, 25, 50, 75, 100]}
          yTickFormat={(v) => `${v}%`}
          fillArea
        />

        <TimeSeriesPanel
          title="메모리"
          headerValue={memHeaderValue}
          points={points}
          series={[
            {
              key: 'mem',
              label: '메모리 사용량',
              color: 'var(--viz-cat-1)',
              getValue: (p) => p.memUsedBytes,
              format: (v) => formatBytes(v),
            },
          ]}
          yDomain={[0, memDomainMax]}
          yTicks={memTicks}
          yTickFormat={memTickFormat}
          fillArea
          referenceLine={memLimit != null ? { value: memLimit, label: `제한 ${formatBytes(memLimit)}` } : undefined}
        />

        {diskIOAvailable && (
          <TimeSeriesPanel
            title="디스크 I/O"
            points={points}
            series={[
              { key: 'read', label: '읽기', color: 'var(--viz-cat-1)', getValue: (p) => p.diskReadBytesPerSec, format: formatRate },
              { key: 'write', label: '쓰기', color: 'var(--viz-cat-2)', getValue: (p) => p.diskWriteBytesPerSec, format: formatRate },
            ]}
            yDomain={[0, diskMax]}
            yTicks={buildTicks(0, diskMax)}
            yTickFormat={formatRate}
            fillArea={false}
          />
        )}

        {netIOAvailable && (
          <TimeSeriesPanel
            title="네트워크 I/O"
            points={points}
            series={[
              { key: 'rx', label: '수신', color: 'var(--viz-cat-1)', getValue: (p) => p.netRxBytesPerSec, format: formatRate },
              { key: 'tx', label: '송신', color: 'var(--viz-cat-2)', getValue: (p) => p.netTxBytesPerSec, format: formatRate },
            ]}
            yDomain={[0, netMax]}
            yTicks={buildTicks(0, netMax)}
            yTickFormat={formatRate}
            fillArea={false}
          />
        )}
      </div>
    </div>
  )
}
