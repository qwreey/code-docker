import { useEffect, useState } from 'react'
import { ErrorBanner } from '@code-docker/router-frontend'
import { api, errorMessage } from '../../api/client'

type EnvVersionStatus = {
  currentVersion: string
  fileVersion: string
  mismatch: boolean
  dismissed: boolean
}

// Fetched once on mount — .env.webmanager only changes on a container
// recreate (docker compose up -d), never mid-session, so there's nothing to
// poll for. See webmanager/.claude/env-migration-plan.md.
export function EnvVersionBanner() {
  const [status, setStatus] = useState<EnvVersionStatus | null>(null)

  useEffect(() => {
    api
      .get<EnvVersionStatus>('/system/env-version')
      .then(setStatus)
      .catch((err) => {
        // Purely informational feature — a failed status fetch shouldn't
        // itself surface as a user-facing error, just stay silent.
        console.error('env-version status fetch failed:', errorMessage(err))
      })
  }, [])

  if (!status || !status.mismatch || status.dismissed) return null

  const dismiss = () => {
    setStatus({ ...status, dismissed: true })
    api.post('/system/env-version/dismiss').catch((err) => {
      console.error('env-version dismiss failed:', errorMessage(err))
    })
  }

  return (
    <ErrorBanner
      variant="warning"
      onDismiss={dismiss}
      message={
        <span>
          .env.webmanager 버전({status.fileVersion || '알수없음'})이 이 이미지의
          example-env.webmanager 버전({status.currentVersion})과 다릅니다 — 새로 추가되거나
          바뀐 설정이 있을 수 있어요. 먼저 백업해두고:
          <br />
          <code>cp .env.webmanager .env.webmanager.bak</code>
          <br />
          아래 명령으로 마이그레이션하세요:
          <br />
          <code>
            cat .env.webmanager | docker compose exec -T code-docker
            /etc/code-docker/webmanager/webmanager --env-migrate {'>'} .env.webmanager
          </code>
        </span>
      }
    />
  )
}
