import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { SystemResources } from '../../api/types'
import { formatBytes, formatPercent } from '../../utils/format'
import './Processes.css'

const POLL_INTERVAL_MS = 4000
const DANGER_THRESHOLD = 90

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

export function SystemSummary() {
  const [resources, setResources] = useState<SystemResources | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const data = await api.get<SystemResources>('/system/resources')
      setResources(data)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  if (error) {
    return <div className="system-summary-notice">컨테이너 리소스 정보를 불러오지 못했습니다 ({error})</div>
  }

  if (!resources) {
    return <div className="system-summary-notice">컨테이너 리소스 정보를 불러오는 중...</div>
  }

  const { memory, cpu, disk } = resources
  const memPercent = memory.limitBytes ? (memory.usedBytes / memory.limitBytes) * 100 : null
  const diskPercent = disk.totalBytes > 0 ? (disk.usedBytes / disk.totalBytes) * 100 : 0

  return (
    <div className="system-summary">
      <div className="system-summary-card">
        <div className="system-summary-label">메모리</div>
        {memory.available ? (
          <>
            <div className="system-summary-value">{formatBytes(memory.usedBytes)}</div>
            {memPercent !== null ? (
              <>
                <ProgressBar percent={memPercent} />
                <div className="system-summary-sub">
                  {formatPercent(memPercent)} · 제한 {formatBytes(memory.limitBytes as number)}
                </div>
              </>
            ) : (
              <div className="system-summary-sub">제한 없음</div>
            )}
          </>
        ) : (
          <div className="system-summary-unavailable">확인 불가</div>
        )}
      </div>

      <div className="system-summary-card">
        <div className="system-summary-label">CPU</div>
        {cpu.available ? (
          <>
            <div className="system-summary-value">{formatPercent(cpu.percent)}</div>
            <div className="system-summary-sub">
              {cpu.limitCores != null ? `제한 ${cpu.limitCores.toFixed(1)} 코어` : `호스트 ${cpu.numCpu}코어 중`}
            </div>
          </>
        ) : (
          <div className="system-summary-unavailable">확인 불가</div>
        )}
      </div>

      <div className="system-summary-card">
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
    </div>
  )
}
