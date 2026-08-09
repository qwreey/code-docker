import { useEffect, useState } from 'react'
import { ErrorBanner } from './ErrorBanner'
import { CopyButton } from './CopyButton'
import { api, errorMessage } from '../../api/client'

type EnvVersionStatus = {
  currentVersion: string
  fileVersion: string
  mismatch: boolean
  dismissed: boolean
}

// Single tee'd command rather than a separate `cp ... .bak` step first - two
// steps means people skip the backup half in practice, and this way every
// run also appends to .env.webmanager.bak instead of overwriting it, so
// older backups aren't lost either.
const MIGRATE_CMD =
  'cat .env.webmanager | tee -a .env.webmanager.bak | docker compose exec -T code-docker /etc/code-docker/webmanager/webmanager --env-migrate > .env.webmanager'

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
        <>
          .env.webmanager 버전({status.fileVersion || '알수없음'})이 이 이미지의
          example-env.webmanager 버전({status.currentVersion})과 다릅니다 — 새로 추가되거나
          바뀐 설정이 있을 수 있어요. 아래 명령으로 마이그레이션하세요 (백업까지 함께 남습니다):
          <div className="copyable-block">
            <code>{MIGRATE_CMD}</code>
            <CopyButton text={MIGRATE_CMD} />
          </div>
        </>
      }
    />
  )
}
