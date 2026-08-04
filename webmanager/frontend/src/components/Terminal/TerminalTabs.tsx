import { useRef, useState } from 'react'
import { Home, Pencil, Pin, PinOff, Plus, X } from 'lucide-react'
import type { TerminalSessionInfo } from '../../api/types'

// Sentinel for the Home tab — a virtual, always-present, unclosable tab
// (never a real termsession.Session, see TerminalHome.tsx) that Terminal.tsx
// treats as its default activeSession instead of null.
export const HOME_TAB_ID = '__home__'

const TAB_ORDER_KEY = 'webmanager.terminal.tabOrder'

// Tab order is a client-side-only UI preference (localStorage, like
// Extensions.tsx's show/hide toggle) rather than a backend-persisted
// setting — unlike the sidebar's fixed set of tabs, terminal tabs come and
// go constantly (new sessions, renames, closes), so there's no stable id
// set to reconcile server-side across devices the way sidebar-order does.
function loadTabOrder(): string[] {
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function saveTabOrder(order: string[]) {
  try {
    localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order))
  } catch {
    // localStorage unavailable (e.g. private browsing) - reorder still
    // applies for this session, just won't persist across reloads
  }
}

// reconcileTabOrder applies a saved name order on top of the live session
// list — same idea as Layout/Sidebar.tsx's reconcileOrder: known names move
// to their saved position, anything saved-but-no-longer-open is dropped,
// and any real session not present in the saved order (opened since the
// user last reordered) is appended at the end in its original order.
function reconcileTabOrder(sessions: TerminalSessionInfo[], order: string[]): TerminalSessionInfo[] {
  const byName = new Map(sessions.map((s) => [s.name, s]))
  const ordered: TerminalSessionInfo[] = []
  const seen = new Set<string>()
  for (const name of order) {
    const s = byName.get(name)
    if (s && !seen.has(name)) {
      ordered.push(s)
      seen.add(name)
    }
  }
  for (const s of sessions) {
    if (!seen.has(s.name)) ordered.push(s)
  }
  return ordered
}

// VS Code-tab-style session switcher (M2 — see archive/terminal-plan-done.md's "영속
// 세션 토글"). Named sessions are created lazily by the WebSocket handshake
// itself (see Terminal.tsx), so right after picking a brand new name there's
// a brief window where it's the active tab but not yet in `sessions` (the
// list hasn't been refetched since connecting) — ensureActiveIncluded below
// synthesizes a placeholder tab for that window instead of the tab bar
// flickering empty. activeSession is HOME_TAB_ID right after the last real
// tab was explicitly closed, or before the user has opened a first one on a
// fresh mount (Terminal.tsx shows the Home tab then) — nothing to
// synthesize or highlight among real sessions in that case.
function ensureActiveIncluded(sessions: TerminalSessionInfo[], activeSession: string): TerminalSessionInfo[] {
  if (activeSession === HOME_TAB_ID || sessions.some((s) => s.name === activeSession)) return sessions
  return [
    ...sessions,
    { name: activeSession, pinned: false, createdAt: '', lastAttachedAt: '', attached: false, pid: 0 },
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
  homeLabel,
  onRenameHome,
}: {
  sessions: TerminalSessionInfo[]
  activeSession: string
  onSelect: (name: string) => void
  onAdd: () => void
  onTogglePin: (name: string, pinned: boolean) => void
  onClose: (name: string) => void
  onRename: (oldName: string, newName: string) => void
  homeLabel: string
  onRenameHome: (label: string) => void
}) {
  // Only one tab can be under rename at a time - { name: the tab being
  // renamed (HOME_TAB_ID for the Home tab itself), value: the in-progress
  // input text }.
  const [editing, setEditing] = useState<{ name: string; value: string } | null>(null)
  const [order, setOrderState] = useState<string[]>(loadTabOrder)
  const tabs = reconcileTabOrder(ensureActiveIncluded(sessions, activeSession), order)
  // Drag-to-reorder, same plain HTML5 drag-event pattern used by
  // TerminalHome.tsx's profile list and Layout/Sidebar.tsx's tab list — a
  // ref for the dragged name (doesn't need to trigger a render) plus state
  // just for the drop-target highlight. The Home tab is deliberately not
  // draggable and never a drop target, so it can't be reordered out of
  // first position.
  const dragIdRef = useRef<string | null>(null)
  const [dragOverName, setDragOverName] = useState<string | null>(null)

  function setOrder(next: string[]) {
    setOrderState(next)
    saveTabOrder(next)
  }

  const startEditing = (name: string, value: string) => setEditing({ name, value })

  // Functional setState form so this is safe to call twice for the same
  // edit (e.g. Enter fires this, then the resulting unmount fires onBlur,
  // which also fires this) - the second call reads editing as already null
  // and no-ops instead of submitting onRename/onRenameHome twice.
  const commitEditing = () => {
    setEditing((current) => {
      if (!current) return null
      const value = current.value.trim()
      if (current.name === HOME_TAB_ID) {
        if (value && value !== homeLabel) onRenameHome(value)
      } else if (value && value !== current.name) {
        onRename(current.name, value)
      }
      return null
    })
  }

  function handleDrop(targetName: string) {
    const draggedName = dragIdRef.current
    dragIdRef.current = null
    setDragOverName(null)
    if (!draggedName || draggedName === targetName) return

    const next = tabs.map((t) => t.name)
    const fromIndex = next.indexOf(draggedName)
    const toIndex = next.indexOf(targetName)
    if (fromIndex === -1 || toIndex === -1) return
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    setOrder(next)
  }

  return (
    <div className="terminal-tabbar" role="tablist" aria-label="터미널 세션">
      {/* Home is always first and never draggable/closable — a landing tab
          (session list + launch profiles), not a real session. Its title is
          still user-renamable (backend-persisted via TerminalSettings.homeLabel,
          same as keybindings/theme) — see the pin/rename affordance rules
          shared with real tabs below (only shown while active). */}
      <div
        className={`terminal-tab terminal-tab-home${activeSession === HOME_TAB_ID ? ' terminal-tab-active' : ''}`}
        role="tab"
        aria-selected={activeSession === HOME_TAB_ID}
      >
        {editing?.name === HOME_TAB_ID ? (
          <input
            type="text"
            className="terminal-tab-rename-input"
            value={editing.value}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setEditing({ name: HOME_TAB_ID, value: e.target.value })}
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
            onClick={() => onSelect(HOME_TAB_ID)}
            onDoubleClick={() => activeSession === HOME_TAB_ID && startEditing(HOME_TAB_ID, homeLabel || '홈')}
            title="더블클릭하여 이름 변경"
          >
            <Home size={13} />
            {homeLabel || '홈'}
          </button>
        )}
        {activeSession === HOME_TAB_ID && editing?.name !== HOME_TAB_ID && (
          <button
            type="button"
            className="terminal-tab-rename"
            onClick={() => startEditing(HOME_TAB_ID, homeLabel || '홈')}
            title="이름 변경"
            aria-label="홈 탭 이름 변경"
          >
            <Pencil size={12} />
          </button>
        )}
      </div>
      {tabs.map((s) => {
        const active = s.name === activeSession
        const isEditing = editing?.name === s.name
        return (
          <div
            key={s.name}
            className={
              'terminal-tab' +
              (active ? ' terminal-tab-active' : '') +
              (dragOverName === s.name ? ' terminal-tab-drag-over' : '')
            }
            role="tab"
            aria-selected={active}
            draggable
            onDragStart={() => {
              dragIdRef.current = s.name
            }}
            onDragOver={(e) => {
              e.preventDefault()
              if (dragOverName !== s.name) setDragOverName(s.name)
            }}
            onDragLeave={() => setDragOverName((prev) => (prev === s.name ? null : prev))}
            onDrop={(e) => {
              e.preventDefault()
              handleDrop(s.name)
            }}
            onDragEnd={() => {
              dragIdRef.current = null
              setDragOverName(null)
            }}
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
                onDoubleClick={() => active && startEditing(s.name, s.name)}
                title="더블클릭하여 이름 변경"
              >
                {s.name}
              </button>
            )}
            {/* Rename affordance: only the active tab shows it (item 4) -
                an inactive tab's pencil icon would just be visual noise
                for a tab you'd have to select before it does anything
                useful anyway. */}
            {active && !isEditing && (
              <button
                type="button"
                className="terminal-tab-rename"
                onClick={() => startEditing(s.name, s.name)}
                title="이름 변경"
                aria-label={`${s.name} 이름 변경`}
              >
                <Pencil size={12} />
              </button>
            )}
            {/* Pin: the active tab gets the full interactive toggle;
                an inactive-but-pinned tab still shows a plain, non-interactive
                indicator so pinned tabs stay recognizable at a glance without
                selecting each one — see item 4/8 of the terminal UX pass. */}
            {active ? (
              <button
                type="button"
                className={`terminal-tab-pin${s.pinned ? ' terminal-tab-pinned' : ''}`}
                onClick={() => onTogglePin(s.name, !s.pinned)}
                title={
                  s.pinned
                    ? '세션 유지 해제 — 고정된 탭은 닫을 수 없습니다'
                    : '세션 유지 (탭을 닫아도 계속 실행) — 고정하면 실수로 닫히지 않도록 닫기 버튼도 사라집니다'
                }
                aria-label={s.pinned ? '세션 유지 해제' : '세션 유지'}
              >
                {s.pinned ? <Pin size={13} /> : <PinOff size={13} />}
              </button>
            ) : (
              s.pinned && (
                <span className="terminal-tab-pin-indicator" title="고정된 세션 — 닫을 수 없습니다" aria-label="고정된 세션">
                  <Pin size={12} />
                </span>
              )
            )}
            {/* Close: hidden entirely once pinned (item 3) - pinning now
                also means "can't be closed from the UI", not just "survives
                idle GC". */}
            {!s.pinned && (
              <button
                type="button"
                className="terminal-tab-close"
                onClick={() => onClose(s.name)}
                title="세션 종료"
                aria-label={`${s.name} 세션 종료`}
              >
                <X size={13} />
              </button>
            )}
          </div>
        )
      })}
      <button type="button" className="terminal-tab-add" aria-label="새 세션" onClick={onAdd}>
        <Plus size={15} />
      </button>
    </div>
  )
}
