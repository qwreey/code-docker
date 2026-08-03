import { useState } from 'react'
import { Pin, PinOff, Plus, X } from 'lucide-react'
import type { TerminalProfile, TerminalSessionInfo } from '../../api/types'
import './TerminalHome.css'

function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

type ProfileDraft = {
  editingId: string | null // null == creating a brand new profile
  label: string
  cwd: string
  command: string
}

const EMPTY_DRAFT: ProfileDraft = { editingId: null, label: '', cwd: '', command: '' }

// The Home tab (TerminalTabs.tsx's always-present, unclosable first tab) —
// what Terminal.tsx shows instead of an empty state when no real session is
// active. Two independent things live here: a switcher for whatever
// sessions are already open, and a small CRUD list of launch profiles (a
// label plus optional starting directory/command) so opening a terminal at
// a frequently-used location doesn't mean retyping `cd` every time.
export function TerminalHome({
  sessions,
  onSelectSession,
  onTogglePin,
  onCloseSession,
  profiles,
  profilesError,
  onSaveProfiles,
  onOpenProfile,
  onNewSession,
}: {
  sessions: TerminalSessionInfo[]
  onSelectSession: (name: string) => void
  onTogglePin: (name: string, pinned: boolean) => void
  onCloseSession: (name: string) => void
  profiles: TerminalProfile[]
  profilesError: string | null
  onSaveProfiles: (next: TerminalProfile[]) => void
  onOpenProfile: (profile: TerminalProfile) => void
  onNewSession: () => void
}) {
  const [draft, setDraft] = useState<ProfileDraft | null>(null)

  function startCreate() {
    setDraft(EMPTY_DRAFT)
  }

  function startEdit(profile: TerminalProfile) {
    setDraft({ editingId: profile.id, label: profile.label, cwd: profile.cwd ?? '', command: profile.command ?? '' })
  }

  function commitDraft() {
    if (!draft) return
    const label = draft.label.trim()
    if (!label) return
    const cwd = draft.cwd.trim() || undefined
    const command = draft.command.trim() || undefined

    if (draft.editingId) {
      onSaveProfiles(
        profiles.map((p) => (p.id === draft.editingId ? { ...p, label, cwd, command } : p)),
      )
    } else {
      onSaveProfiles([...profiles, { id: genId(), label, cwd, command }])
    }
    setDraft(null)
  }

  function deleteProfile(profile: TerminalProfile) {
    if (!window.confirm(`"${profile.label}" 프로파일을 삭제하시겠습니까?`)) return
    onSaveProfiles(profiles.filter((p) => p.id !== profile.id))
    if (draft?.editingId === profile.id) setDraft(null)
  }

  return (
    <div className="terminal-home">
      <section className="terminal-home-section">
        <div className="terminal-home-section-header">
          <h2>열린 세션</h2>
          <button type="button" className="btn btn-secondary btn-small" onClick={onNewSession}>
            <Plus size={14} /> 새 세션
          </button>
        </div>
        {sessions.length === 0 ? (
          <p className="terminal-home-empty">열린 세션이 없습니다.</p>
        ) : (
          <ul className="terminal-home-session-list">
            {sessions.map((s) => (
              <li key={s.name} className="terminal-home-session-row">
                <button type="button" className="terminal-home-session-name" onClick={() => onSelectSession(s.name)}>
                  {s.name}
                </button>
                <span className="terminal-home-session-meta">
                  {s.attached ? '연결됨' : `${new Date(s.lastAttachedAt).toLocaleString()} 마지막 연결`}
                </span>
                <button
                  type="button"
                  className={`terminal-home-icon-btn${s.pinned ? ' terminal-tab-pinned' : ''}`}
                  onClick={() => onTogglePin(s.name, !s.pinned)}
                  title={s.pinned ? '세션 유지 해제' : '세션 유지'}
                  aria-label={s.pinned ? '세션 유지 해제' : '세션 유지'}
                >
                  {s.pinned ? <Pin size={14} /> : <PinOff size={14} />}
                </button>
                <button
                  type="button"
                  className="terminal-home-icon-btn"
                  onClick={() => onCloseSession(s.name)}
                  title="세션 종료"
                  aria-label={`${s.name} 세션 종료`}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="terminal-home-section">
        <div className="terminal-home-section-header">
          <h2>프로파일</h2>
          {!draft && (
            <button type="button" className="btn btn-secondary btn-small" onClick={startCreate}>
              <Plus size={14} /> 새 프로파일
            </button>
          )}
        </div>
        {profilesError && <p className="terminal-inline-notice">프로파일을 불러오지 못했습니다 ({profilesError}).</p>}

        {profiles.length === 0 && !draft && (
          <p className="terminal-home-empty">
            자주 여는 위치나 실행할 명령을 프로파일로 저장해두면 한 번에 새 세션을 열 수 있습니다.
          </p>
        )}

        {profiles.length > 0 && (
          <ul className="terminal-home-profile-list">
            {profiles.map((p) => (
              <li key={p.id} className="terminal-home-profile-card">
                <div className="terminal-home-profile-info">
                  <span className="terminal-home-profile-label">{p.label}</span>
                  {p.cwd && <span className="terminal-home-profile-detail mono-cell">{p.cwd}</span>}
                  {p.command && <span className="terminal-home-profile-detail mono-cell">{p.command}</span>}
                </div>
                <div className="terminal-home-profile-actions">
                  <button type="button" className="btn btn-primary btn-small" onClick={() => onOpenProfile(p)}>
                    실행
                  </button>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => startEdit(p)}>
                    편집
                  </button>
                  <button type="button" className="btn btn-danger btn-small" onClick={() => deleteProfile(p)}>
                    삭제
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {draft && (
          <div className="card terminal-home-profile-form">
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="th-profile-label">이름</label>
                <input
                  id="th-profile-label"
                  type="text"
                  value={draft.label}
                  autoFocus
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  placeholder="예: 블로그 서버"
                />
              </div>
              <div className="form-field">
                <label htmlFor="th-profile-cwd">시작 위치 (선택)</label>
                <input
                  id="th-profile-cwd"
                  type="text"
                  value={draft.cwd}
                  onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                  placeholder="/code/Projects/blog"
                />
              </div>
              <div className="form-field">
                <label htmlFor="th-profile-command">실행할 명령 (선택)</label>
                <input
                  id="th-profile-command"
                  type="text"
                  value={draft.command}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  placeholder="npm run dev"
                />
              </div>
            </div>
            <div className="terminal-home-profile-form-actions">
              <button type="button" className="btn btn-primary btn-small" onClick={commitDraft} disabled={!draft.label.trim()}>
                저장
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => setDraft(null)}>
                취소
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
