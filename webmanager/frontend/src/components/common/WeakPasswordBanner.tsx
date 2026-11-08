import { useState } from 'react'
import { ErrorBanner } from './ErrorBanner'
import { useAuthStatus } from './useAuthStatus'

// Shown only once the request behind it is unlocked: the server leaves
// weakPassword out of GET /auth/status for anyone else (see
// handlers_auth.go), so this never needs to decide who may see it. Dismissal
// lasts for the page load - the password stays short until it is changed, so
// the reminder is meant to come back.
export function WeakPasswordBanner() {
  const { status } = useAuthStatus()
  const [dismissed, setDismissed] = useState(false)

  if (!status?.unlocked || !status.weakPassword || dismissed) return null

  return (
    <ErrorBanner
      variant="warning"
      onDismiss={() => setDismissed(true)}
      message={
        <>
          webmanager 비밀번호가 12자보다 짧습니다. 새 비밀번호의 최소 길이는 12자라서, 지금 비밀번호는
          더 짧은 채로 남아 있는 예전 값입니다. 호스트에서 <code>migrate.sh</code>를 다시 실행하면
          바꿀지 물어봅니다. 직접 바꾸려면 <code>.env.webmanager</code>의{' '}
          <code>WEBMANAGER_AUTH_PASSWORD_HASH</code>를 수정하세요 (이 해시는 환경변수 전용이라 웹에서
          바꾸는 화면은 없습니다).
        </>
      }
    />
  )
}
