import { useEffect, useState } from 'react'
import { ErrorBanner } from './ErrorBanner'
import { CopyButton } from './CopyButton'
import { systemApi, errorMessage } from '../../api/client'

type EnvVersionStatus = {
  currentVersion: string
  fileVersion: string
  mismatch: boolean
  dismissed: boolean
}

// Single tee'd command rather than a separate `cp ... .bak` step first - two
// steps means people skip the backup half in practice, and this way every
// run also appends to .env.router.bak instead of overwriting it, so older
// backups aren't lost either. Same command shape as webmanager's own
// EnvVersionBanner.tsx.
const MIGRATE_CMD =
  'cat .env.router | tee -a .env.router.bak | docker compose exec -T code-docker-router router-manager --env-migrate > .env.router'

// Hand-ported from webmanager/frontend/src/components/common/
// EnvVersionBanner.tsx (GET/POST /api/system/env-version[/dismiss] - see
// handlers_envversion.go) - router-manager already had the backend
// `--env-migrate` CLI and a startup log warning, but no web UI banner of its
// own, unlike webmanager. Fetched once on mount - .env.router only changes
// on a container recreate (docker compose up -d), never mid-session, so
// there's nothing to poll for.
export function EnvVersionBanner() {
  const [status, setStatus] = useState<EnvVersionStatus | null>(null)

  useEffect(() => {
    systemApi
      .get<EnvVersionStatus>('/env-version')
      .then(setStatus)
      .catch((err) => {
        // Purely informational feature - a failed status fetch shouldn't
        // itself surface as a user-facing error, just stay silent.
        console.error('env-version status fetch failed:', errorMessage(err))
      })
  }, [])

  if (!status || !status.mismatch || status.dismissed) return null

  const dismiss = () => {
    setStatus({ ...status, dismissed: true })
    systemApi.post('/env-version/dismiss').catch((err) => {
      console.error('env-version dismiss failed:', errorMessage(err))
    })
  }

  return (
    <ErrorBanner
      variant="warning"
      onDismiss={dismiss}
      message={
        <>
          .env.router 버전({status.fileVersion || '알수없음'})이 이 이미지의
          example-env.router 버전({status.currentVersion})과 다릅니다 — 새로 추가되거나 바뀐
          설정이 있을 수 있어요. 아래 명령으로 마이그레이션하세요 (백업까지 함께 남습니다):
          <div className="copyable-block">
            <code>{MIGRATE_CMD}</code>
            <CopyButton text={MIGRATE_CMD} />
          </div>
        </>
      }
    />
  )
}
