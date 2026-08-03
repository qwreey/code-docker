import { useState } from 'react'
import { Pencil, Pin, PinOff, Plus, X } from 'lucide-react'
import type { TerminalSessionInfo } from '../../api/types'

// VS Code-tab-style session switcher (M2 — see archive/terminal-plan-done.md's "영속
// 세션 토글"). Named sessions are created lazily by the WebSocket handshake
// itself (see Terminal.tsx), so right after picking a brand new name there's
// a brief window where it's the active tab but not yet in `sessions` (the
// list hasn't been refetched since connecting) — ensureActiveIncluded below
// synthesizes a placeholder tab for that window instead of the tab bar
// flickering empty. activeSession is null only right after the last tab was
// explicitly closed, or before the user has opened a first one on a fresh
// mount (Terminal.tsx shows an empty state then) — nothing to synthesize or
// highlight in that case.
function ensureActiveIncluded(sessions: TerminalSessionInfo[], activeSession: string | null): TerminalSessionInfo[] {
  if (!activeSession || sessions.some((s) => s.name === activeSession)) return sessions
  return [
    ...sessions,
    { name: activeSession, pinned: false, createdAt: '', lastAttachedAt: '', attached: false },
  ]
}

export function TerminalTabs({
  sessions,
  activeSession,
  onSelect,
  onAdd,
  onTogglePin,
  onClose,
  onRename,
}: {
  sessions: TerminalSessionInfo[]
  activeSession: string | null
  onSelect: (name: string) => void
  onAdd: () => void
  onTogglePin: (name: string, pinned: boolean) => void
  onClose: (name: string) => void
  onRename: (oldName: string, newName: string) => void
}) {
  const tabs = ensureActiveIncluded(sessions, activeSession)
  // Only one tab can be under rename at a time - { name: the tab being
  // renamed, value: the in-progress input text }.
  const [editing, setEditing] = useState<{ name: string; value: string } | null>(null)

  const startEditing = (name: string) => setEditing({ name, value: name })

  // Functional setState form so this is safe to call twice for the same
  // edit (e.g. Enter fires this, then the resulting unmount fires onBlur,
  // which also fires this) - the second call reads editing as already null
  // and no-ops instead of submitting onRename twice.
  const commitEditing = () => {
    setEditing((current) => {
      if (!current) return null
      const value = current.value.trim()
      if (value && value !== current.name) onRename(current.name, value)
      return null
    })
  }

  return (
    <div className="terminal-tabbar" role="tablist" aria-label="터미널 세션">
      {tabs.map((s) => {
        const active = s.name === activeSession
        const isEditing = editing?.name === s.name
        return (
          <div
            key={s.name}
            className={`terminal-tab${active ? ' terminal-tab-active' : ''}`}
            role="tab"
            aria-selected={active}
          >
            {isEditing ? (
              <input
                type="text"
                className="terminal-tab-rename-input"
                value={editing.value}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setEditing({ name: s.name, value: e.target.value })}
                onBlur={commitEditing}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitEditing()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setEditing(null)
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="terminal-tab-label"
                onClick={() => onSelect(s.name)}
                onDoubleClick={() => startEditing(s.name)}
                title="더블클릭하여 이름 변경"
              >
                {s.name}
              </button>
            )}
            {!isEditing && (
              <button
                type="button"
                className="terminal-tab-rename"
                onClick={() => startEditing(s.name)}
                title="이름 변경"
                aria-label={`${s.name} 이름 변경`}
              >
                <Pencil size={12} />
              </button>
            )}
            <button
              type="button"
              className={`terminal-tab-pin${s.pinned ? ' terminal-tab-pinned' : ''}`}
              onClick={() => onTogglePin(s.name, !s.pinned)}
              title={s.pinned ? '세션 유지 해제' : '세션 유지 (탭을 닫아도 계속 실행)'}
              aria-label={s.pinned ? '세션 유지 해제' : '세션 유지'}
            >
              {s.pinned ? <Pin size={13} /> : <PinOff size={13} />}
            </button>
            <button
              type="button"
              className="terminal-tab-close"
              onClick={() => onClose(s.name)}
              title="세션 종료"
              aria-label={`${s.name} 세션 종료`}
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
      <button type="button" className="terminal-tab-add" aria-label="새 세션" onClick={onAdd}>
        <Plus size={15} />
      </button>
    </div>
  )
}
