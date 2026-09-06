import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { Home, Pencil, Pin, PinOff, Plus, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { TerminalSessionInfo } from '../../api/types'

// Same "don't let a tap steal DOM focus" guard TerminalControls.tsx uses on
// its own buttons (including its own zoom pair) - kept as a small local
// copy rather than importing from there since these zoom buttons render
// only when TerminalControls itself is NOT mounted (see showZoomGroup
// below), so there's no shared instance to reuse. Matters most on a touch
// device that has explicitly turned the control bar off (the default is
// pointer:fine only, but the toggle is per-device and overridable) - the
// zoom() callback these buttons call already ends in focusTerminal(), this
// just stops an intermediate focus flicker before that runs.
function preventFocusSteal(event: MouseEvent) {
  event.preventDefault()
}

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
  showZoomGroup,
  onZoom,
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
  // Terminal.tsx's controlBarEnabled toggle, inverted - the zoom pair
  // TerminalControls.tsx normally carries moves here instead, so it's never
  // rendered in both places at once (see this component's own render below
  // and TerminalControls.tsx's doc comment).
  showZoomGroup: boolean
  onZoom: (direction: 'in' | 'out') => void
}) {
  // Only one tab can be under rename at a time - { name: the tab being
  // renamed (HOME_TAB_ID for the Home tab itself), value: the in-progress
  // input text }.
  const [editing, setEditing] = useState<{ name: string; value: string } | null>(null)
  // Shared by both rename inputs below (Home's and a session tab's) since
  // only one can ever be mounted at a time - `editing` is a single value,
  // not per-tab state. Focus is claimed explicitly here via useLayoutEffect
  // rather than the plain `autoFocus` prop this used to carry: autoFocus
  // only fires on the DOM node's initial mount, so it's at the mercy of
  // exactly when React happens to create that node relative to whatever
  // else is re-rendering around it (a tab switch's reconnect cascade, the
  // 3s session-list poll, ...) - a suspected but unconfirmed cause of a
  // real report that renaming a 2nd+ tab could leave the input unfocused
  // and unresponsive to clicks. Driving focus from an effect keyed on the
  // edit target instead makes it deterministic: it (re)claims focus/select
  // every time `editing` starts pointing at a (possibly new) name,
  // regardless of what else caused that render.
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  // The tab strip scrolls horizontally now (see Terminal.css's
  // .terminal-tab-list), so the active tab can sit off-screen — most
  // obviously right after a reload restores a session from ?session=, where
  // nothing the user did put it there. Bring it into view whenever it
  // changes; 'nearest' means an already-visible tab is left alone rather
  // than yanked to an edge.
  const tabListRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const active = tabListRef.current?.querySelector('.terminal-tab-active')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeSession])
  useLayoutEffect(() => {
    if (!editing) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
    // Deliberately keyed on editing?.name only, not the whole `editing`
    // object - the object's `value` field changes on every keystroke
    // (onChange), and re-running this on every keystroke would re-select
    // the whole field after each character typed instead of just claiming
    // focus once when a rename starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.name])
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
    <div className="terminal-tabbar">
      {/* Wrapping tab list is its own flex child (flex:1) so the zoom group
          below stays a plain sibling at the row's far right — including
          while the tab list itself wraps to a 2nd/3rd line, since a sibling
          only ever occupies the first line's remaining space, it never gets
          pushed down with the tabs the way one more wrapping item inside
          this div would. See Terminal.css's .terminal-tabbar/.terminal-tab-list/
          .terminal-zoom-group for the layout side of this. */}
      <div className="terminal-tab-list" role="tablist" aria-label="터미널 세션" ref={tabListRef}>
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
            ref={renameInputRef}
            type="text"
            className="terminal-tab-rename-input"
            value={editing.value}
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
            onClick={(e) => {
              // Stops this click from also reaching any ancestor click
              // handling (none currently on .terminal-tab-home itself, but
              // this button and the session-tab one below intentionally
              // match each other rather than one being defensive and the
              // other not) before it starts editing.
              e.stopPropagation()
              startEditing(HOME_TAB_ID, homeLabel || '홈')
            }}
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
            // Not draggable while its own rename input is open - dragging a
            // tab you're actively renaming makes no sense anyway, and this
            // is defensive hardening against a real, if unconfirmed here,
            // WebKit quirk where a click/focus on an <input> nested inside a
            // draggable=true ancestor can be swallowed as a potential-drag
            // gesture instead of reaching the input normally (see the
            // rename-input useLayoutEffect above for the actual suspected
            // root cause this bug report points at).
            draggable={!isEditing}
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
                ref={renameInputRef}
                type="text"
                className="terminal-tab-rename-input"
                value={editing.value}
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
                title={s.cwd ? `${s.cwd} — 더블클릭하여 이름 변경` : '더블클릭하여 이름 변경'}
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
                onClick={(e) => {
                  // See the matching stopPropagation on the Home tab's own
                  // rename button above - this tab's wrapping div has no
                  // click handler of its own today, but it does have drag
                  // handlers, and this keeps the two pencil buttons
                  // identical rather than one being hardened and the other
                  // not.
                  e.stopPropagation()
                  startEditing(s.name, s.name)
                }}
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
      {/* Only rendered while the control bar (TerminalControls.tsx) itself is
          hidden - see Terminal.tsx's controlBarEnabled. Reuses Terminal.tsx's
          own zoom() callback (font-size state + fit + PTY resize), never a
          second copy of that logic - this is purely a second place to
          trigger it from. align-self: center (set on .terminal-zoom-group in
          Terminal.css) is what keeps it vertically centered against the tab
          area even though .terminal-tabbar's own items are align-items:
          flex-start (needed so the group doesn't stretch to the tab list's
          full wrapped height). */}
      {showZoomGroup && (
        <div className="terminal-zoom-group" role="toolbar" aria-label="터미널 글자 크기 조절">
          <button
            type="button"
            className="terminal-zoom-btn"
            aria-label="글자 축소"
            title="글자 축소"
            onMouseDown={preventFocusSteal}
            onClick={() => onZoom('out')}
          >
            <ZoomOut size={15} />
          </button>
          <button
            type="button"
            className="terminal-zoom-btn"
            aria-label="글자 확대"
            title="글자 확대"
            onMouseDown={preventFocusSteal}
            onClick={() => onZoom('in')}
          >
            <ZoomIn size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
