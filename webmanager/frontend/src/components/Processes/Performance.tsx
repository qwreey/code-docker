import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { SystemResources } from '../../api/types'
import { CpuHeatmap } from './CpuHeatmap'
import { MemoryBreakdown } from './MemoryBreakdown'
import { DiskUsageCard } from './SystemSummary'
import { ResourceHistory } from './ResourceHistory'
import './Processes.css'

const POLL_INTERVAL_MS = 4000

// Performance is the "성능" sub-tab: a single shared poll of
// GET /api/system/resources feeds the CPU heatmap, memory breakdown, and
// disk card, followed by the existing time-series graphs (ResourceHistory,
// which does its own polling against the /history endpoint since that's a
// different resource). Temperature was dropped from the UI (deemed not
// useful) even though the backend still reports it - see SystemResources.thermal.
export function Performance() {
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

  const { memory, cpu, disk, hostMemory, cpuCores } = resources

  return (
    <div>
      <div className="perf-top-grid">
        <CpuHeatmap
          perCorePercent={cpuCores.hostPercent}
          available={cpuCores.available}
          clockMHz={cpuCores.hostClockMHz}
          numCpu={cpu.numCpu}
        />
        <MemoryBreakdown
          cgroupUsedBytes={memory.usedBytes}
          cgroupLimitBytes={memory.limitBytes}
          cgroupAvailable={memory.available}
          hostTotalBytes={hostMemory.totalBytes}
          hostFreeBytes={hostMemory.freeBytes}
          hostBuffersBytes={hostMemory.buffersBytes}
          hostCachedBytes={hostMemory.cachedBytes}
          hostAvailable={hostMemory.available}
        />
        <DiskUsageCard disk={disk} />
      </div>

      <ResourceHistory />
    </div>
  )
}
