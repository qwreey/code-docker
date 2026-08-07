import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { RestartStatusResponse } from '../../api/types'
import { confirmAndRestartCodeServer, type RestartOutcome } from '../../utils/restartCodeServer'
import { ErrorBanner } from '@code-docker/router-frontend'

const RESTART_OUTCOME_TEXT: Record<RestartOutcome, string> = {
  restarted: '재시작을 요청했습니다. 완료되면 이 배너가 자동으로 사라집니다.',
  declined: '',
  error: '재시작 요청에 실패했습니다. Supervisor 탭에서 직접 재시작해 주세요.',
}

// How often to re-poll GET /api/system/restart-needed after a restart was
// requested, until it self-clears (see internal/restartstatus's doc
// comment for the pid/start comparison that drives that). code-server takes
// a few seconds to actually exit and relaunch under supervisord, so this
// only starts once handleRestart's own request succeeds - no point polling
// while nothing has been asked to restart yet.
const RESTART_POLL_MS = 7000

// Backend-persisted "code-server restart needed" banner (see backend's
// internal/restartstatus) — shared by Mise/Extensions/Claude Code, whose
// installs/uninstalls are what sets the flag. Unlike the old one-shot
// JobPanel-only prompt, this survives navigating away and back: it fetches
// GET /api/system/restart-needed on mount, and again whenever refreshToken
// changes (pass e.g. a job's completion timestamp/id so the banner picks up
// a just-finished install without waiting for a remount). Once a restart is
// actually requested through this banner's own button, it also polls the
// same endpoint every RESTART_POLL_MS until the backend reports the restart
// landed, so the banner disappears on its own instead of waiting for the
// user to navigate away and back or trigger another job.
export function RestartNeededBanner({ refreshToken }: { refreshToken?: unknown }) {
  const [dirty, setDirty] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [waitingForRestart, setWaitingForRestart] = useState(false)
  const [outcome, setOutcome] = useState<RestartOutcome | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Bumped on every mount/refreshToken change so a response from a
  // superseded fetchStatus call (initial fetch or an in-flight poll tick)
  // can't clobber state after something newer has already taken over -
  // same guard the old cancelled-flag effect provided, extended to cover
  // polling too.
  const epochRef = useRef(0)

  function stopPolling() {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    setWaitingForRestart(false)
  }

  function fetchStatus(epoch: number) {
    api
      .get<RestartStatusResponse>('/system/restart-needed')
      .then((res) => {
        if (epochRef.current !== epoch) return
        setDirty(res.dirty)
        if (!res.dirty) stopPolling()
      })
      .catch((e) => {
        // Purely informational - a failed status fetch shouldn't itself
        // surface as a user-facing error.
        console.error('restart-needed fetch failed:', errorMessage(e))
      })
  }

  useEffect(() => {
    const epoch = ++epochRef.current
    fetchStatus(epoch)
    return () => stopPolling()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  if (!dirty) return null

  async function handleRestart() {
    setRestarting(true)
    const result = await confirmAndRestartCodeServer()
    setOutcome(result)
    setRestarting(false)
    if (result === 'restarted') {
      stopPolling()
      setWaitingForRestart(true)
      const epoch = epochRef.current
      pollRef.current = setInterval(() => fetchStatus(epoch), RESTART_POLL_MS)
    }
  }

  return (
    <ErrorBanner
      variant="warning"
      message={
        <span className="restart-needed-banner-content">
          code-server에 반영하려면 재시작이 필요합니다.
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={handleRestart}
            disabled={restarting || waitingForRestart}
          >
            {waitingForRestart ? '재시작 확인 중...' : '지금 재시작'}
          </button>
          {outcome && outcome !== 'declined' && <span>{RESTART_OUTCOME_TEXT[outcome]}</span>}
        </span>
      }
    />
  )
}
