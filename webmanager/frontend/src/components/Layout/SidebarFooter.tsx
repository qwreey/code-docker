import { useEffect, useState } from 'react'
import { Lock, LockOpen, Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from '../../useTheme'
import type { ThemeChoice } from '../../theme'
import { requestUnlock } from '../../api/client'
import { useAuthStatus } from '../common/useAuthStatus'
import { withViewTransition } from '../../utils/viewTransition'

const THEME_CYCLE: ThemeChoice[] = ['system', 'light', 'dark']
const THEME_ICON: Record<ThemeChoice, typeof Monitor> = { system: Monitor, light: Sun, dark: Moon }
const THEME_LABEL: Record<ThemeChoice, string> = { system: '자동', light: '라이트', dark: '다크' }

function nextTheme(current: ThemeChoice): ThemeChoice {
  return THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length]
}

// "몇 분 남음" 문구를 주기적으로 다시 계산하기 위한 리렌더 트리거 — 초 단위로
// 실시간 카운트다운할 필요는 없어서(10분짜리 TTL에 분 단위 표시면 충분) 30초
// 주기로만 재렌더.
function useTicker(intervalMs: number) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
}

function formatRemaining(untilIso: string | null | undefined): string {
  if (!untilIso) return ''
  const ms = new Date(untilIso).getTime() - Date.now()
  if (ms <= 0) return '곧 만료'
  const minutes = Math.ceil(ms / 60000)
  return minutes <= 1 ? '1분 미만 남음' : `${minutes}분 남음`
}

// Sidebar footer: 왼쪽엔 비밀번호 게이트 상태(설정 안 돼있으면 아예 숨김),
// 오른쪽엔 테마 토글(자동/라이트/다크를 아이콘 하나로 순환) — 항상 오른쪽 끝에
// 붙도록 margin-left: auto (왼쪽 상태 표시가 없을 때도 유지됨). See
// webmanager/.claude/archive/theme-toggle-plan-done.md.
export function SidebarFooter() {
  const { theme, setTheme } = useTheme()
  const { status, refresh } = useAuthStatus()
  useTicker(30_000)

  async function handleUnlockClick() {
    try {
      await requestUnlock()
      await refresh()
    } catch {
      // user cancelled the prompt - nothing to do
    }
  }

  const ThemeIcon = THEME_ICON[theme]

  return (
    <div className="sidebar-footer">
      {status?.required &&
        (status.unlocked ? (
          <div className="sidebar-lock-status sidebar-lock-status-unlocked" title="잠금 해제됨">
            <LockOpen size={14} aria-hidden="true" />
            <span>{formatRemaining(status.unlockedUntil) || '해제됨'}</span>
          </div>
        ) : (
          <button
            type="button"
            className="sidebar-lock-status"
            onClick={handleUnlockClick}
            title="클릭해서 비밀번호 입력"
          >
            <Lock size={14} aria-hidden="true" />
            <span>잠김</span>
          </button>
        ))}

      <button
        type="button"
        className="sidebar-theme-btn"
        title={`테마: ${THEME_LABEL[theme]} (클릭하면 ${THEME_LABEL[nextTheme(theme)]}로 전환)`}
        onClick={() => withViewTransition(() => setTheme(nextTheme(theme)))}
      >
        <ThemeIcon size={16} aria-hidden="true" />
      </button>
    </div>
  )
}
