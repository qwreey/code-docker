import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { RestartStatusResponse } from '../../api/types'
import { confirmAndRestartCodeServer, type RestartOutcome } from '../../utils/restartCodeServer'
import { ErrorBanner } from '@code-docker/router-frontend'

const RESTART_OUTCOME_TEXT: Record<RestartOutcome, string> = {
  restarted: '재시작을 요청했습니다.',
  declined: '',
  error: '재시작 요청에 실패했습니다. Supervisor 탭에서 직접 재시작해 주세요.',
}

// Backend-persisted "code-server restart needed" banner (see backend's
// internal/restartstatus) — shared by Mise/Extensions/Claude Code, whose
// installs/uninstalls are what sets the flag. Unlike the old one-shot
// JobPanel-only prompt, this survives navigating away and back: it fetches
// GET /api/system/restart-needed on mount, and again whenever refreshToken
// changes (pass e.g. a job's completion timestamp/id so the banner picks up
// a just-finished install without waiting for a remount).
export function RestartNeededBanner({ refreshToken }: { refreshToken?: unknown }) {
  const [dirty, setDirty] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [outcome, setOutcome] = useState<RestartOutcome | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<RestartStatusResponse>('/system/restart-needed')
      .then((res) => {
        if (!cancelled) setDirty(res.dirty)
      })
      .catch((e) => {
        // Purely informational - a failed status fetch shouldn't itself
        // surface as a user-facing error.
        console.error('restart-needed fetch failed:', errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  if (!dirty) return null

  async function handleRestart() {
    setRestarting(true)
    setOutcome(await confirmAndRestartCodeServer())
    setRestarting(false)
  }

  return (
    <ErrorBanner
      variant="warning"
      message={
        <span className="restart-needed-banner-content">
          code-server에 반영하려면 재시작이 필요합니다.
          <button type="button" className="btn btn-secondary btn-small" onClick={handleRestart} disabled={restarting}>
            지금 재시작
          </button>
          {outcome && outcome !== 'declined' && <span>{RESTART_OUTCOME_TEXT[outcome]}</span>}
        </span>
      }
    />
  )
}
