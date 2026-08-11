import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, errorMessage } from '../../api/client'
import type {
  ClaudeInstallJob,
  ClaudeLogoutResponse,
  ClaudeMiseVersionInfo,
  ClaudeMiseVersionResponse,
  ClaudeOnboardingStatus,
  ClaudePlugin,
  ClaudePluginsResponse,
  ClaudePrefs,
  ClaudeStatus,
  MiseJobStatus,
} from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Sheet } from '../common/Sheet'
import { Skeleton } from '../common/Skeleton'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { RestartNeededBanner } from '../common/RestartNeededBanner'
import { withViewTransition } from '../../utils/viewTransition'
import { formatDurationMs } from '../../utils/format'
import { Heatmap } from './Heatmap'
import { WeeklyChart } from './WeeklyChart'
import { ModelUsageChart } from './ModelUsageChart'
import { JobPanel } from '../Mise/JobPanel'
import { LoginPanel } from './LoginPanel'
import { InteractiveLoginDialog } from './InteractiveLoginDialog'
import { ClaudeSettings } from './ClaudeSettings'
import { SessionLog } from './SessionLog/SessionLog'
import '../common/common.css'
import '../Processes/Processes.css'
import './ClaudeCode.css'

// Mirrors Task Manager's 성능/프로세스 sub-tab pattern (Processes.tsx) - the
// same .processes-tabs/.processes-tab classes are reused rather than
// inventing a new tab bar, same convention Dind.tsx already follows.
type ClaudeSubTab = 'status' | 'analytics' | 'sessions' | 'management'

const JOB_POLL_INTERVAL_MS = 800

// Both NotInstalled and InstalledView's update flow persist their job id
// (see useClaudeInstallJob's `persist` param) - both trap the user behind a
// blocking overlay while a mise install/update job is running, so both need
// to survive a tab switch/remount rather than silently losing track of it.
// They share this one storage key safely since the two flows are mutually
// exclusive (status.installed picks one or the other, see ClaudeCode()).
const CLAUDE_INSTALL_JOB_STORAGE_KEY = 'webmanager.claude.installJobId'

function loadPersistedInstallJobId(): string | null {
  try {
    return localStorage.getItem(CLAUDE_INSTALL_JOB_STORAGE_KEY)
  } catch {
    return null
  }
}

function savePersistedInstallJobId(jobId: string | null) {
  try {
    if (jobId) localStorage.setItem(CLAUDE_INSTALL_JOB_STORAGE_KEY, jobId)
    else localStorage.removeItem(CLAUDE_INSTALL_JOB_STORAGE_KEY)
  } catch {
    // localStorage unavailable (e.g. private browsing) - resuming after a
    // tab switch just won't work, same best-effort contract as every other
    // localStorage use in this app.
  }
}

interface InstallJobState {
  jobId: string
  status: MiseJobStatus | null
}

// Shared by both the NotInstalled install button and the InstalledView
// "지금 업데이트" button - POST /api/claude/install always resolves+installs
// the latest version, so "install" and "update" are the same backend action.
//
// Deliberately does NOT call onDone() as soon as the job succeeds - that
// used to swap the whole view (NotInstalled -> InstalledView) out from under
// the user mid-read of the install log. Success instead exposes `succeeded`
// so the caller can offer an explicit "다시 로드" action; onDone only fires
// when the caller invokes `reload()`.
function useClaudeInstallJob(onDone: () => void, persist = false) {
  const [job, setJob] = useState<InstallJobState | null>(() => {
    if (!persist) return null
    const jobId = loadPersistedInstallJobId()
    return jobId ? { jobId, status: null } : null
  })
  const [error, setError] = useState<string | null>(null)

  const busy = job !== null && (!job.status || job.status.running)
  const succeeded = Boolean(job?.status && !job.status.running && job.status.exitCode === 0)

  const start = useCallback(async () => {
    if (busy) return
    setError(null)
    try {
      const res = await api.post<ClaudeInstallJob>('/claude/install')
      if (persist) savePersistedInstallJobId(res.jobId)
      setJob({ jobId: res.jobId, status: null })
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [busy, persist])

  useEffect(() => {
    if (!job || (job.status && !job.status.running)) return
    let cancelled = false

    const poll = async () => {
      try {
        const status = await api.get<MiseJobStatus>(`/mise/jobs/${encodeURIComponent(job.jobId)}`)
        if (cancelled) return
        setJob((prev) => (prev && prev.jobId === job.jobId ? { ...prev, status } : prev))
      } catch (e) {
        if (cancelled) return
        if (persist && e instanceof ApiError && e.status === 404) {
          // Stale/unknown job id (e.g. server restarted since it was
          // persisted) - not retryable, drop back to the pre-job state
          // rather than getting stuck showing an error forever.
          savePersistedInstallJobId(null)
          setJob(null)
          return
        }
        setError(errorMessage(e))
      }
    }

    poll()
    const timer = setInterval(poll, JOB_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.jobId, job?.status?.running])

  const close = useCallback(() => {
    if (persist) savePersistedInstallJobId(null)
    setJob(null)
  }, [persist])

  const reload = useCallback(() => {
    if (persist) savePersistedInstallJobId(null)
    setJob(null)
    onDone()
  }, [persist, onDone])

  return { job, busy, succeeded, error, start, close, reload, clearError: () => setError(null) }
}

function NotInstalled({ onInstalled }: { onInstalled: () => void }) {
  const { job, busy, succeeded, error, start, close, reload, clearError } = useClaudeInstallJob(onInstalled, true)

  return (
    <div className="claude-ghost-wrap">
      <div className="claude-skeleton-grid" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div className="claude-skeleton-card" key={i}>
            <div className="claude-skeleton-line claude-skeleton-line-short" />
            <div className="claude-skeleton-line" />
            <div className="claude-skeleton-line claude-skeleton-line-short" />
          </div>
        ))}
      </div>
      <div className="claude-install-overlay" role="dialog" aria-modal="true">
        <div className="claude-install-message">
          <p>
            Claude Code가 설치되어 있지 않습니다 — 아래 버튼으로 설치하거나, 이미 설치되어 있다면{' '}
            <code>WEBMANAGER_CLAUDE_BINPATH</code>를 설정하세요.
          </p>
          {error && <ErrorBanner message={error} onDismiss={clearError} />}
          {job ? (
            <>
              <JobPanel kind="install" toolLabel="Claude Code" status={job.status} onClose={close} />
              {succeeded && (
                <button type="button" className="btn btn-primary claude-install-reload" onClick={reload}>
                  다시 로드
                </button>
              )}
            </>
          ) : (
            <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>
              Claude Code 설치
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function InstalledCharts({ stats }: { stats: NonNullable<ClaudeStatus['stats']> }) {
  return (
    <div className="claude-viz">
      <div className="card">
        <h2>활동 히트맵</h2>
        <Heatmap dailyActivity={stats.dailyActivity ?? []} />
      </div>

      <div className="card">
        <h2>최근 7일</h2>
        <WeeklyChart dailyActivity={stats.dailyActivity ?? []} />
      </div>

      <div className="card">
        <h2>모델별 토큰 사용량</h2>
        <ModelUsageChart modelUsage={stats.modelUsage ?? {}} />
      </div>
    </div>
  )
}

function PluginsTable({ plugins }: { plugins: ClaudePlugin[] }) {
  if (plugins.length === 0) {
    return <p className="empty-state">설치된 스킬/플러그인이 없습니다.</p>
  }

  return (
    <div className="table-wrapper">
      <table className="claude-plugins-table">
        <thead>
          <tr>
            <th>이름</th>
            <th>버전</th>
            <th>Scope</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>
          {plugins.map((plugin) => {
            const [name, marketplace] = plugin.id.split('@')
            return (
              <tr key={plugin.id}>
                <td>
                  <div>{name || plugin.id}</div>
                  {marketplace && <div className="claude-plugin-marketplace">{marketplace}</div>}
                </td>
                <td>{plugin.version}</td>
                <td>{plugin.scope}</td>
                <td>
                  {plugin.enabled ? (
                    <span className="badge badge-green">활성</span>
                  ) : (
                    <span className="badge badge-gray">비활성</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// UpdateBanner only renders when a mise-managed claude-code install is
// outdated and no update job is currently running - the up-to-date/hidden
// states show nothing here at all, per the "banner only when there's
// actually an update" redesign (the up-to-date case is instead a small tag
// next to the page title, see ClaudeVersionTag). Once a job starts,
// InstalledView swaps this out for a full-tab overlay instead (see
// .claude-install-overlay below) - a small flex-wrap banner isn't wide
// enough for JobPanel's log box, and an update running in the background
// isn't something the rest of this view should stay interactive during.
function UpdateBanner({
  miseVersion,
  onUpdate,
  updateBusy,
  updateError,
  onDismissUpdateError,
}: {
  miseVersion: ClaudeMiseVersionInfo
  onUpdate: () => void
  updateBusy: boolean
  updateError: string | null
  onDismissUpdateError: () => void
}) {
  return (
    <div className="claude-update-banner">
      <div className="claude-update-banner-text">
        Claude Code 업데이트 가능: {miseVersion.current} → {miseVersion.latest}
      </div>
      {updateError && <ErrorBanner message={updateError} onDismiss={onDismissUpdateError} />}
      <button type="button" className="btn btn-primary btn-small" onClick={onUpdate} disabled={updateBusy}>
        지금 업데이트
      </button>
    </div>
  )
}

// Small muted tag next to the "Claude Code" page title - shown whenever the
// current mise-managed version is known, regardless of outdated/up-to-date
// (the update-available case additionally gets the louder UpdateBanner
// above).
function ClaudeVersionTag({ version }: { version: string }) {
  return <span className="claude-version-tag">v{version}</span>
}

// Logout button for the "로그인 상태" card - gated behind a mandatory
// ConfirmDialog (never window.confirm, see webmanager/CLAUDE.md's UI dialog
// conventions) since ending the CLI's authenticated session is destructive
// and not undoable from here.
function LogoutButton({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConfirm() {
    setBusy(true)
    setError(null)
    try {
      await api.post<ClaudeLogoutResponse>('/claude/logout')
      setConfirmOpen(false)
      onLoggedOut()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="claude-logout-wrap">
      <button
        type="button"
        className="btn btn-secondary btn-small"
        onClick={() => {
          setError(null)
          setConfirmOpen(true)
        }}
      >
        로그아웃
      </button>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleConfirm}
        title="Claude Code 로그아웃"
        confirmLabel="로그아웃"
        busy={busy}
        busyLabel="로그아웃하는 중..."
      >
        현재 계정에서 로그아웃합니다. 다시 사용하려면 로그인이 필요합니다.
      </ConfirmDialog>
    </div>
  )
}

function InstalledView({
  status,
  miseVersion,
  onUpdated,
  onLoggedIn,
  onLoggedOut,
}: {
  status: ClaudeStatus
  miseVersion: ClaudeMiseVersionInfo | null
  onUpdated: () => void
  onLoggedIn: () => void
  onLoggedOut: () => void
}) {
  const auth = status.auth ?? null
  const stats = status.stats ?? null
  // persist=true - an update is exactly the kind of in-flight job you
  // shouldn't lose track of by switching sub-tabs or the sidebar, same
  // reasoning as NotInstalled's install job below.
  const {
    job: updateJob,
    busy: updateBusy,
    succeeded: updateSucceeded,
    error: updateError,
    start: startUpdate,
    close: closeUpdateJob,
    reload: reloadUpdateJob,
    clearError: clearUpdateError,
  } = useClaudeInstallJob(onUpdated, true)
  // Snapshot of miseVersion at the moment the update was kicked off, so the
  // "X → Y" text in the in-progress overlay reflects what triggered the
  // update rather than the live (already-current-by-the-time-you-reload)
  // version - otherwise a page remount while a persisted job is still
  // running shows a self-contradictory "업데이트 중: 2.1.226 → 2.1.226".
  // Stays null (version delta omitted) if the job was resumed from a
  // persisted id on a fresh mount, since the "before" snapshot is lost then.
  const [updateFromVersion, setUpdateFromVersion] = useState<ClaudeMiseVersionInfo | null>(null)
  const handleStartUpdate = useCallback(() => {
    setUpdateFromVersion(miseVersion)
    startUpdate()
  }, [miseVersion, startUpdate])

  // Which login CTA is primary depends on whether this instance has ever
  // finished the CLI's own onboarding wizard (~/.claude.json's
  // hasCompletedOnboarding - see InteractiveLoginDialog's doc comment for
  // why this isn't just auth.loggedIn): once it has, the plain headless
  // flow (LoginPanel - `claude auth login`) is sufficient on its own for
  // logging back in, since re-onboarding is never required again, and the
  // heavier terminal dialog is only offered as a "고급" fallback. Only
  // before that first completion is the interactive dialog actually
  // necessary (it's the only thing that can drive the wizard to
  // completion) - so it's the primary CTA in that case, with the headless
  // flow demoted to "고급" instead. null (still loading) defaults to the
  // interactive dialog being primary, same as the "never onboarded" case -
  // the safer default, since skipping a wizard that's actually still
  // needed is worse than one extra click for someone already onboarded.
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null)
  useEffect(() => {
    if (auth?.loggedIn) return
    let cancelled = false
    api
      .get<ClaudeOnboardingStatus>('/claude/onboarding-status')
      .then((res) => {
        if (!cancelled) setOnboardingCompleted(res.completed)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [auth?.loggedIn])

  const [showInteractiveLogin, setShowInteractiveLogin] = useState(false)
  const [showAdvancedLogin, setShowAdvancedLogin] = useState(false)

  return (
    <div className="claude-installed-wrap">
      {miseVersion?.outdated && !updateJob && (
        <UpdateBanner
          miseVersion={miseVersion}
          onUpdate={handleStartUpdate}
          updateBusy={updateBusy}
          updateError={updateError}
          onDismissUpdateError={clearUpdateError}
        />
      )}
      {updateJob && (
        <div className="claude-install-overlay" role="dialog" aria-modal="true">
          <div className="claude-install-message">
            <p>
              Claude Code 업데이트 중
              {updateFromVersion && `: ${updateFromVersion.current} → ${updateFromVersion.latest}`}
            </p>
            <JobPanel kind="install" toolLabel="Claude Code" status={updateJob.status} onClose={closeUpdateJob} />
            {updateSucceeded && (
              <button type="button" className="btn btn-primary claude-install-reload" onClick={reloadUpdateJob}>
                다시 로드
              </button>
            )}
          </div>
        </div>
      )}
      <div className="claude-cards">
      <div className="claude-card">
        <div className="claude-card-label">로그인 상태</div>
        {auth?.loggedIn ? (
          <>
            <div className="claude-card-value">{auth.email}</div>
            <div className="claude-card-sub">{auth.subscriptionType} 구독</div>
            <LogoutButton onLoggedOut={onLoggedOut} />
          </>
        ) : onboardingCompleted ? (
          <div className="claude-login-panel">
            <LoginPanel onLoggedIn={onLoggedIn} />
            <div className="claude-card-note">
              <button
                type="button"
                className="claude-advanced-login-toggle"
                onClick={() => setShowInteractiveLogin(true)}
              >
                안 되면: 터미널로 로그인
              </button>
            </div>
            {showInteractiveLogin && (
              <InteractiveLoginDialog
                onLoggedIn={onLoggedIn}
                onClose={() => setShowInteractiveLogin(false)}
              />
            )}
          </div>
        ) : (
          <div className="claude-login-panel">
            <button
              type="button"
              className="btn btn-primary btn-small"
              onClick={() => setShowInteractiveLogin(true)}
            >
              로그인
            </button>
            <div className="claude-card-note">
              <button
                type="button"
                className="claude-advanced-login-toggle"
                onClick={() => setShowAdvancedLogin((v) => !v)}
              >
                {showAdvancedLogin ? '고급 옵션 숨기기' : '고급: 브라우저에서만 로그인'}
              </button>
            </div>
            {showAdvancedLogin && <LoginPanel onLoggedIn={onLoggedIn} />}
            {showInteractiveLogin && (
              <InteractiveLoginDialog
                onLoggedIn={onLoggedIn}
                onClose={() => setShowInteractiveLogin(false)}
              />
            )}
          </div>
        )}
      </div>

      <div className="claude-card">
        <div className="claude-card-label">총 사용량</div>
        {stats ? (
          <>
            <div className="claude-card-value">{stats.totalSessions.toLocaleString()} 세션</div>
            <div className="claude-card-sub">{stats.totalMessages.toLocaleString()} 메시지</div>
            {stats.firstSessionDate && (
              <div className="claude-card-footnote">
                {new Date(stats.firstSessionDate).toLocaleDateString()}부터 사용 중
              </div>
            )}
          </>
        ) : (
          <div className="claude-card-note">통계를 확인할 수 없습니다.</div>
        )}
      </div>

      <div className="claude-card">
        <div className="claude-card-label">오늘 / 이번 주</div>
        {stats ? (
          <>
            <div className="claude-card-value">
              오늘 {stats.today.sessionCount}세션 · {stats.today.messageCount}메시지
            </div>
            <div className="claude-card-sub">
              이번 주 {stats.week.sessionCount}세션 · {stats.week.messageCount}메시지
            </div>
          </>
        ) : (
          <div className="claude-card-note">통계를 확인할 수 없습니다.</div>
        )}
      </div>

      <div className="claude-card">
        <div className="claude-card-label">가장 긴 세션</div>
        {stats ? (
          <>
            <div className="claude-card-value">{stats.longestSessionMessageCount.toLocaleString()} 메시지</div>
            <div className="claude-card-sub">{formatDurationMs(stats.longestSessionDurationMs)}</div>
          </>
        ) : (
          <div className="claude-card-note">통계를 확인할 수 없습니다.</div>
        )}
      </div>
      </div>
    </div>
  )
}

export function ClaudeCode() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null)
  const [plugins, setPlugins] = useState<ClaudePlugin[]>([])
  const [prefs, setPrefs] = useState<ClaudePrefs | null>(null)
  const [miseVersion, setMiseVersion] = useState<ClaudeMiseVersionInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [subTab, setSubTab] = useState<ClaudeSubTab>('status')
  const [restartCheckToken, setRestartCheckToken] = useState(0)

  const loadingRef = useRef(false)

  // Deliberately excludes the mise version check - that's a separate,
  // possibly-slow `mise latest` network round-trip (see
  // handleClaudeMiseVersion's doc comment on the backend), so it must never
  // block the page's main content from showing up.
  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const [statusData, pluginsData, prefsData] = await Promise.all([
        api.get<ClaudeStatus>('/claude/status'),
        api.get<ClaudePluginsResponse>('/claude/plugins'),
        api.get<ClaudePrefs>('/claude/prefs'),
      ])
      setStatus(statusData)
      setPlugins(pluginsData.plugins)
      setPrefs(prefsData)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      withViewTransition(() => setLoading(false))
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const loadMiseVersion = useCallback(async () => {
    try {
      const res = await api.get<ClaudeMiseVersionResponse>('/claude/mise-version')
      setMiseVersion(res.miseVersion)
    } catch {
      // Best-effort, same degrade-to-null contract as the backend - the
      // version tag/banner just don't show rather than surfacing an error
      // banner for what's a non-essential check.
      setMiseVersion(null)
    }
  }, [])

  // Only fires the (possibly slow) version check once the fast path above
  // has confirmed Claude is installed, and skips it entirely when the user
  // turned it off - matching the "hideVersionCheck" pref's whole point.
  useEffect(() => {
    if (!status?.installed || !prefs || prefs.hideVersionCheck) {
      setMiseVersion(null)
      return
    }
    loadMiseVersion()
  }, [status?.installed, prefs, loadMiseVersion])

  const handleRefresh = useCallback(() => {
    load()
    if (prefs && !prefs.hideVersionCheck) loadMiseVersion()
  }, [load, loadMiseVersion, prefs])

  const handleUpdated = useCallback(() => {
    load()
    loadMiseVersion()
    setRestartCheckToken((t) => t + 1)
  }, [load, loadMiseVersion])

  const handleInstalled = useCallback(() => {
    load()
    setRestartCheckToken((t) => t + 1)
  }, [load])

  async function handleToggleHideVersionCheck(checked: boolean) {
    const prev = prefs
    setPrefs({ hideVersionCheck: checked })
    try {
      await api.put<{ ok: true }>('/claude/prefs', { hideVersionCheck: checked })
    } catch (e) {
      setPrefs(prev)
      setError(errorMessage(e))
    }
  }

  return (
    <section>
      <div className="section-header">
        <h1>
          Claude Code
          {miseVersion && <ClaudeVersionTag version={miseVersion.current} />}
        </h1>
        <div className="claude-header-actions">
          {status?.installed && (
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setSettingsOpen(true)}>
              설정
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-small" onClick={handleRefresh} disabled={loading}>
            {loading ? '불러오는 중...' : '새로고침'}
          </button>
        </div>
      </div>
      <p className="section-description">Claude Code CLI의 로그인 상태와 사용 통계를 보여줍니다.</p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <RestartNeededBanner refreshToken={restartCheckToken} />
      {loading && !status ? (
        <Skeleton />
      ) : (
        status &&
        (status.installed ? (
          <>
            <div className="processes-tabs">
              <button
                type="button"
                className={`processes-tab${subTab === 'status' ? ' processes-tab-active' : ''}`}
                onClick={() => setSubTab('status')}
              >
                상태
              </button>
              <button
                type="button"
                className={`processes-tab${subTab === 'analytics' ? ' processes-tab-active' : ''}`}
                onClick={() => setSubTab('analytics')}
              >
                세부 분석
              </button>
              <button
                type="button"
                className={`processes-tab${subTab === 'sessions' ? ' processes-tab-active' : ''}`}
                onClick={() => setSubTab('sessions')}
              >
                대화 로그
              </button>
              <button
                type="button"
                className={`processes-tab${subTab === 'management' ? ' processes-tab-active' : ''}`}
                onClick={() => setSubTab('management')}
              >
                관리
              </button>
            </div>

            {subTab === 'status' && (
              <InstalledView
                status={status}
                miseVersion={miseVersion}
                onUpdated={handleUpdated}
                onLoggedIn={load}
                onLoggedOut={load}
              />
            )}

            {subTab === 'analytics' &&
              (status.stats ? (
                <InstalledCharts stats={status.stats} />
              ) : (
                <p className="empty-state">통계를 확인할 수 없습니다.</p>
              ))}

            {subTab === 'sessions' && (
              <div className="card">
                <h2>대화 로그</h2>
                <p className="section-description">
                  이 인스턴스에서 진행된 Claude Code 대화 기록입니다. 비밀번호로 보호됩니다.
                </p>
                <SessionLog />
              </div>
            )}

            {subTab === 'management' && (
              <>
                <ClaudeSettings />
                <div className="card">
                  <h2>Skills / Plugins</h2>
                  <PluginsTable plugins={plugins} />
                </div>
              </>
            )}
          </>
        ) : (
          <NotInstalled onInstalled={handleInstalled} />
        ))
      )}

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Claude Code 설정">
        <label className="claude-settings-toggle">
          <input
            type="checkbox"
            checked={prefs?.hideVersionCheck ?? false}
            onChange={(e) => handleToggleHideVersionCheck(e.target.checked)}
          />
          버전 확인 끄기
        </label>
        <p className="claude-settings-note">
          mise로 관리되는 Claude Code 버전이 최신인지 확인하지 않습니다. 켜져 있으면 페이지 제목 옆의 버전
          표시와 업데이트 안내 배너가 모두 사라집니다.
        </p>
      </Sheet>
    </section>
  )
}
