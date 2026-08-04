import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type {
  ClaudeInstallJob,
  ClaudeMiseVersionInfo,
  ClaudeMiseVersionResponse,
  ClaudePlugin,
  ClaudePluginsResponse,
  ClaudePrefs,
  ClaudeStatus,
  MiseJobStatus,
} from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Sheet } from '../common/Sheet'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'
import { formatDurationMs } from '../../utils/format'
import { Heatmap } from './Heatmap'
import { WeeklyChart } from './WeeklyChart'
import { ModelUsageChart } from './ModelUsageChart'
import { JobPanel } from '../Mise/JobPanel'
import { LoginPanel } from './LoginPanel'
import { SessionLog } from './SessionLog/SessionLog'
import '../common/common.css'
import './ClaudeCode.css'

const JOB_POLL_INTERVAL_MS = 800

interface InstallJobState {
  jobId: string
  status: MiseJobStatus | null
}

// Shared by both the NotInstalled install button and the InstalledView
// "지금 업데이트" button - POST /api/claude/install always resolves+installs
// the latest version, so "install" and "update" are the same backend action.
function useClaudeInstallJob(onDone: () => void) {
  const [job, setJob] = useState<InstallJobState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const busy = job !== null && (!job.status || job.status.running)

  const start = useCallback(async () => {
    if (busy) return
    setError(null)
    try {
      const res = await api.post<ClaudeInstallJob>('/claude/install')
      setJob({ jobId: res.jobId, status: null })
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [busy])

  useEffect(() => {
    if (!job || (job.status && !job.status.running)) return
    let cancelled = false

    const poll = async () => {
      try {
        const status = await api.get<MiseJobStatus>(`/mise/jobs/${encodeURIComponent(job.jobId)}`)
        if (cancelled) return
        setJob((prev) => (prev && prev.jobId === job.jobId ? { ...prev, status } : prev))
        if (!status.running && status.exitCode === 0) {
          onDone()
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e))
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

  return { job, busy, error, start, close: () => setJob(null), clearError: () => setError(null) }
}

function NotInstalled({ onInstalled }: { onInstalled: () => void }) {
  const { job, busy, error, start, close, clearError } = useClaudeInstallJob(onInstalled)

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
      <div className="claude-install-overlay">
        <div className="claude-install-message">
          <p>
            Claude Code가 설치되어 있지 않습니다 — 아래 버튼으로 설치하거나, 이미 설치되어 있다면{' '}
            <code>WEBMANAGER_CLAUDE_BINPATH</code>를 설정하세요.
          </p>
          {error && <ErrorBanner message={error} onDismiss={clearError} />}
          {job ? (
            <JobPanel kind="install" toolLabel="Claude Code" status={job.status} onClose={close} />
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
// outdated - the up-to-date/hidden states show nothing here at all, per the
// "banner only when there's actually an update" redesign (the up-to-date
// case is instead a small tag next to the page title, see ClaudeVersionTag).
function UpdateBanner({
  miseVersion,
  onUpdate,
  updateJob,
  updateBusy,
  updateError,
  onCloseUpdateJob,
  onDismissUpdateError,
}: {
  miseVersion: ClaudeMiseVersionInfo
  onUpdate: () => void
  updateJob: InstallJobState | null
  updateBusy: boolean
  updateError: string | null
  onCloseUpdateJob: () => void
  onDismissUpdateError: () => void
}) {
  return (
    <div className="claude-update-banner">
      <div className="claude-update-banner-text">
        Claude Code 업데이트 가능: {miseVersion.current} → {miseVersion.latest}
      </div>
      {updateError && <ErrorBanner message={updateError} onDismiss={onDismissUpdateError} />}
      {updateJob ? (
        <JobPanel kind="install" toolLabel="Claude Code" status={updateJob.status} onClose={onCloseUpdateJob} />
      ) : (
        <button type="button" className="btn btn-primary btn-small" onClick={onUpdate} disabled={updateBusy}>
          지금 업데이트
        </button>
      )}
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

function InstalledView({
  status,
  plugins,
  miseVersion,
  onUpdated,
  onLoggedIn,
}: {
  status: ClaudeStatus
  plugins: ClaudePlugin[]
  miseVersion: ClaudeMiseVersionInfo | null
  onUpdated: () => void
  onLoggedIn: () => void
}) {
  const auth = status.auth ?? null
  const stats = status.stats ?? null
  const { job: updateJob, busy: updateBusy, error: updateError, start: startUpdate, close: closeUpdateJob, clearError: clearUpdateError } =
    useClaudeInstallJob(onUpdated)

  return (
    <>
      {miseVersion?.outdated && (
        <UpdateBanner
          miseVersion={miseVersion}
          onUpdate={startUpdate}
          updateJob={updateJob}
          updateBusy={updateBusy}
          updateError={updateError}
          onCloseUpdateJob={closeUpdateJob}
          onDismissUpdateError={clearUpdateError}
        />
      )}
      <div className="claude-cards">
      <div className="claude-card">
        <div className="claude-card-label">로그인 상태</div>
        {auth?.loggedIn ? (
          <>
            <div className="claude-card-value">{auth.email}</div>
            <div className="claude-card-sub">{auth.subscriptionType} 구독</div>
          </>
        ) : (
          <LoginPanel onLoggedIn={onLoggedIn} />
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
      {stats && <InstalledCharts stats={stats} />}
      <div className="card">
        <h2>Skills / Plugins</h2>
        <PluginsTable plugins={plugins} />
      </div>
      <div className="card">
        <h2>대화 로그</h2>
        <p className="section-description">
          이 인스턴스에서 진행된 Claude Code 대화 기록입니다. 비밀번호로 보호됩니다.
        </p>
        <SessionLog />
      </div>
    </>
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
  }, [load, loadMiseVersion])

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
      {loading && !status ? (
        <Skeleton />
      ) : (
        status &&
        (status.installed ? (
          <InstalledView
            status={status}
            plugins={plugins}
            miseVersion={miseVersion}
            onUpdated={handleUpdated}
            onLoggedIn={load}
          />
        ) : (
          <NotInstalled onInstalled={load} />
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
