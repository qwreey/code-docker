import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FolderOpen } from 'lucide-react'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import '../common/common.css'
import { api, apiUrl, errorMessage, ApiError } from '../../api/client'
import type {
  ProcessInfo,
  TerminalProfile,
  TerminalProfilesDoc,
  TerminalSessionInfo,
  TerminalSettings,
} from '../../api/types'
import { buildProcessTree } from '../../utils/processTree'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { DEFAULT_KEYBINDINGS, type ModifierId } from './keybindings'
import { DEFAULT_THEME_ID, findTheme, themeToXterm } from './themes'
import { applyModifier } from './modifiers'
import { TerminalControls } from './TerminalControls'
import { TerminalSettingsPanel } from './TerminalSettingsPanel'
import { TerminalTabs, HOME_TAB_ID } from './TerminalTabs'
import { TerminalHome } from './TerminalHome'
import { useKeyboardInset } from './useKeyboardInset'
import './Terminal.css'

// Options a new session can be created with — only meaningful the moment a
// never-before-seen name is first connected (see the WS-connect effect and
// internal/termsession.Registry.GetOrCreate); reused for both the plain "+"
// tab (no options) and the Home tab's profile launcher (label/cwd/command).
type SessionCreateOptions = { label?: string; cwd?: string; command?: string }

type ConnectionState = 'connecting' | 'connected' | 'disconnected'

const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: '연결 중...',
  connected: '연결됨',
  disconnected: '연결 끊김',
}

const STATE_BADGE_CLASS: Record<ConnectionState, string> = {
  connecting: 'badge-gray',
  connected: 'badge-green',
  disconnected: 'badge-red',
}

const EMPTY_SETTINGS: TerminalSettings = {
  keybindings: [],
  themeId: DEFAULT_THEME_ID,
  customThemes: [],
  homeLabel: '',
}

// nextSessionName picks "세션 N" for the smallest N not already taken (or,
// when a profile supplies a label, that label itself — only falling back to
// "label 2", "label 3", ... if it's already in use), so repeated "+" clicks
// (or a name someone already renamed away from the default pattern) never
// collide. alsoTaken covers the currently-active session specifically —
// it's real and already occupying that name the moment it's picked, but the
// backend may not have confirmed it in `sessions` yet (GET
// /api/terminal/sessions hasn't been refetched since connecting, or is
// still in flight) — without this, clicking "+" before that refetch lands
// would silently "create" the exact name already active (verified live:
// this was a real bug, not a hypothetical one).
function nextSessionName(existing: TerminalSessionInfo[], alsoTaken: string, label?: string): string {
  const taken = new Set(existing.map((s) => s.name))
  taken.add(alsoTaken)
  const base = label?.trim() || '세션'
  if (base === '세션') {
    let n = 1
    while (taken.has(`세션 ${n}`)) n++
    return `세션 ${n}`
  }
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

export function Terminal({
  initialOpen,
  onInitialOpenConsumed,
  onOpenFileManager,
}: {
  initialOpen?: { cwd?: string; label?: string } | null
  onInitialOpenConsumed?: () => void
  onOpenFileManager?: (path: string) => void
} = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const armedModifierRef = useRef<ModifierId | null>(null)

  const [state, setState] = useState<ConnectionState>('connecting')
  const [settings, setSettings] = useState<TerminalSettings | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [armedModifier, setArmedModifier] = useState<ModifierId | null>(null)
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  // HOME_TAB_ID is a virtual tab (never a real termsession.Session), and is
  // also the initial state now: opening the Terminal tab must not silently
  // spawn a shell before the user asks for one, so the Home tab (session
  // list + launch profiles, see TerminalHome.tsx) is what a fresh mount
  // shows, same as after explicitly closing the last real tab. Pre-existing
  // sessions from a previous browser session (e.g. pinned ones) still show
  // up normally via refreshSessions() below — this only affects whether a
  // brand new session gets created/attached on mount.
  const [activeSession, setActiveSession] = useState<string>(HOME_TAB_ID)
  const [sessionActionError, setSessionActionError] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<TerminalProfile[]>([])
  const [profilesError, setProfilesError] = useState<string | null>(null)
  // Item 8: a close request (tab bar X, or Home tab's session list X) goes
  // through requestClose below first, which shows this instead of closing
  // immediately when the session's shell has a foreground child process.
  const [closeConfirm, setCloseConfirm] = useState<{ name: string } | null>(null)
  const [closeConfirmBusy, setCloseConfirmBusy] = useState(false)
  // Carries cwd/command from addSession(opts) through to the WS-connect
  // effect below, keyed by the session name they belong to — a ref (not
  // state) since it's write-then-read-once bookkeeping, not something a
  // render should react to. Cleared once consumed; harmless if it weren't
  // (GetOrCreate ignores opts on reattach) but keeping it tidy avoids
  // resending stale values on an unrelated later reconnect.
  const pendingCreateOptionsRef = useRef<Map<string, { cwd?: string; command?: string }>>(new Map())
  const keyboardInset = useKeyboardInset()

  // Effective settings: fall back to hardcoded defaults until the backend
  // responds (or if it returns an empty keybindings list).
  const effectiveSettings: TerminalSettings = useMemo(() => {
    const base = settings ?? EMPTY_SETTINGS
    return {
      keybindings: base.keybindings.length > 0 ? base.keybindings : DEFAULT_KEYBINDINGS,
      themeId: base.themeId || DEFAULT_THEME_ID,
      customThemes: base.customThemes,
      homeLabel: base.homeLabel,
    }
  }, [settings])

  const currentTheme = useMemo(
    () => findTheme(effectiveSettings.themeId, effectiveSettings.customThemes),
    [effectiveSettings.themeId, effectiveSettings.customThemes],
  )

  // Load persisted settings once on mount. Failure (e.g. backend endpoint
  // not deployed yet) just keeps the hardcoded defaults -- the terminal
  // itself must keep working regardless.
  useEffect(() => {
    let cancelled = false
    api
      .get<TerminalSettings>('/terminal/settings')
      .then((data) => {
        if (!cancelled) setSettings(data)
      })
      .catch((e) => {
        if (!cancelled) setSettingsError(errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Session list for the tab bar — GET /api/terminal/sessions doesn't
  // include a never-yet-connected new session (it's created lazily by the WS
  // handshake itself, see the connection effect below), so this can
  // legitimately come back not yet containing activeSession right after the
  // user opens one; it'll show up once that first connection opens and this
  // refetches.
  const refreshSessions = useCallback(async () => {
    try {
      const data = await api.get<TerminalSessionInfo[]>('/terminal/sessions')
      setSessions(data)
      return data
    } catch {
      // best-effort — the tab bar just falls back to only showing the
      // active tab (TerminalTabs.tsx handles an empty list that way)
      return null
    }
  }, [])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  // Always holds the latest activeSession, readable from inside the
  // WS-connect effect's onclose handler below without making that effect
  // depend on (and re-run/reconnect for) every activeSession change beyond
  // the one it's already keyed on — see its own comment for why.
  const activeSessionRef = useRef(activeSession)
  useEffect(() => {
    activeSessionRef.current = activeSession
  }, [activeSession])

  // Home tab launch profiles — best-effort like refreshSessions above; the
  // Home tab just shows profilesError and an empty list if this fails.
  const refreshProfiles = useCallback(async () => {
    try {
      const data = await api.get<TerminalProfilesDoc>('/terminal/profiles')
      setProfiles(data.profiles)
      setProfilesError(null)
    } catch (e) {
      setProfilesError(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    refreshProfiles()
  }, [refreshProfiles])

  const saveProfiles = useCallback(async (next: TerminalProfile[]) => {
    try {
      await api.put('/terminal/profiles', { profiles: next })
      setProfiles(next)
      setProfilesError(null)
    } catch (e) {
      setProfilesError(errorMessage(e))
    }
  }, [])

  // Apply the active theme live whenever it changes (initial load, or a
  // selection/edit made in the settings panel).
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = themeToXterm(currentTheme)
    }
  }, [currentTheme])

  const sendBytes = useCallback((bytes: string) => {
    if (!bytes) return
    const mod = armedModifierRef.current
    const out = mod ? applyModifier(mod, bytes) : bytes
    if (mod) {
      armedModifierRef.current = null
      setArmedModifier(null)
    }
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(out))
    }
  }, [])

  const armModifier = useCallback((mod: ModifierId) => {
    setArmedModifier((prev) => {
      const next = prev === mod ? null : mod
      armedModifierRef.current = next
      return next
    })
  }, [])

  // Live-preview a theme without persisting it (used while editing a custom
  // theme's colors, and to revert preview on cancel).
  const previewTheme = useCallback((colors: Record<string, string>) => {
    if (termRef.current) {
      termRef.current.options.theme = colors
    }
  }, [])

  const saveSettings = useCallback(async (next: TerminalSettings) => {
    setSaving(true)
    setSaveError(null)
    try {
      await api.put('/terminal/settings', next)
      setSettings(next)
    } catch (e) {
      setSaveError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }, [])

  // Item 5: Home is a virtual tab with no termsession.Session of its own to
  // rename, so its custom title rides along in the same already-persisted
  // TerminalSettings blob (homeLabel) instead of a new backend feature -
  // same save path/semantics as TerminalSettingsPanel's onSave (spreads the
  // *resolved* effectiveSettings, not the possibly-still-null raw
  // `settings`, matching that existing precedent).
  const renameHome = useCallback(
    (label: string) => {
      saveSettings({ ...effectiveSettings, homeLabel: label })
    },
    [saveSettings, effectiveSettings],
  )

  // xterm.js instance itself: created once and reused across session
  // switches (only the WebSocket underneath it changes — see the next
  // effect) so switching tabs doesn't tear down/rebuild the renderer.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new XTerm({
      cursorBlink: true,
      convertEol: true,
      theme: themeToXterm(currentTheme),
    })
    termRef.current = term
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()

    // Routed through sendBytes so a sticky modifier armed via the on-screen
    // control bar also applies to the very next real keypress/paste.
    const dataDisposable = term.onData((data) => sendBytes(data))

    // Stop Ctrl+W from closing the browser window instead of reaching the
    // shell (a real terminal's "delete word backward") — preventDefault()
    // and let xterm still process/send the key normally (return true).
    // Confirmed (repo owner's own testing, matches VS Code/Termix): plain
    // browser TABS reserve Ctrl+W at the OS/browser-chrome level and never
    // dispatch the keydown to page JS at all — no page-level fix exists
    // there (a dedicated Chrome extension is the only real workaround). A
    // window opened as an installed PWA is different — it isn't a browser
    // tab, so Ctrl+W isn't reserved the same way and this handler actually
    // works. This is why installing webmanager as a PWA is tracked as a
    // to-do for the repo owner (root TODO.md) rather than something to
    // build here.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
      }
      return true
    })

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      dataDisposable.dispose()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // WebSocket connection: reopened against the active session's name
  // whenever it changes (switching tabs), independent of the xterm
  // instance above. The server replays that session's scrollback on
  // attach (see internal/termsession), so clearing the display here before
  // reconnecting is enough to avoid the previous session's content
  // lingering while the new one's scrollback streams back in.
  useEffect(() => {
    const term = termRef.current
    const fitAddon = fitAddonRef.current
    if (!term || !fitAddon) return

    if (activeSession === HOME_TAB_ID) {
      // Home tab is active, not a real session (the last real tab may have
      // just been closed) - TerminalHome covers the UI; the previous effect
      // run's cleanup already closed whatever WebSocket was open.
      term.reset()
      return
    }

    term.reset()
    setState('connecting')

    // Only ever non-empty right after addSession(opts) picked this exact
    // name (see there) - consumed once so an unrelated later reconnect to
    // the same still-open tab doesn't keep resending them (harmless either
    // way, since the backend only honors them on actual creation).
    const pending = pendingCreateOptionsRef.current.get(activeSession)
    pendingCreateOptionsRef.current.delete(activeSession)
    const params = new URLSearchParams({ session: activeSession })
    if (pending?.cwd) params.set('cwd', pending.cwd)
    if (pending?.command) params.set('cmd', pending.command)

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}${apiUrl(`/terminal?${params.toString()}`)}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      setState('connected')
      fitAddon.fit()
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      refreshSessions()
    }
    // Also refetches the session list on close, not just on open — the
    // backend now actively closes this connection when the underlying
    // session dies on its own (e.g. Ctrl+D exits the shell), so the tab
    // bar should promptly stop showing a session that no longer exists
    // instead of only noticing on the next unrelated refresh. If the
    // refetch confirms this exact session is gone (not just an ordinary
    // tab-switch-triggered close, which also tears this socket down via
    // the effect cleanup below — activeSessionRef guards against treating
    // that as a death), fall back to the Home tab instead of leaving
    // activeSession pointed at a name TerminalTabs.tsx's
    // ensureActiveIncluded would otherwise keep synthesizing as a ghost
    // tab forever (verified live: this was the actual bug, not
    // hypothetical — closing that ghost tab then 404s since the backend
    // already GC'd the session, and only a full reload reset activeSession
    // back to HOME_TAB_ID).
    // Both handlers guard on wsRef.current === ws (same check the cleanup
    // below uses) since they can fire asynchronously after this effect has
    // already been superseded — switching tabs quickly triggers this
    // effect's own cleanup (ws.close()) for the OLD socket while a NEW
    // effect run has already set wsRef.current to a different socket and
    // possibly already reached 'connecting'/'connected'; without this
    // guard the old socket's delayed onclose/onerror would clobber the new
    // tab's real status back to 'disconnected'. Same bug class as the
    // Ctrl+D ghost-tab fix above (activeSessionRef).
    ws.onclose = () => {
      if (wsRef.current !== ws) return
      setState('disconnected')
      refreshSessions().then((data) => {
        if (data && activeSessionRef.current === activeSession && !data.some((s) => s.name === activeSession)) {
          setActiveSession(HOME_TAB_ID)
        }
      })
    }
    ws.onerror = () => {
      if (wsRef.current !== ws) return
      setState('disconnected')
    }
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data))
      }
    }

    return () => {
      ws.close()
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [activeSession, refreshSessions])

  const selectSession = useCallback(
    (name: string) => {
      if (name !== activeSession) setActiveSession(name)
    },
    [activeSession],
  )

  const addSession = useCallback(
    (opts?: SessionCreateOptions) => {
      const alsoTaken = activeSession === HOME_TAB_ID ? '' : activeSession
      const name = nextSessionName(sessions, alsoTaken, opts?.label)
      if (opts && (opts.cwd || opts.command)) {
        pendingCreateOptionsRef.current.set(name, { cwd: opts.cwd, command: opts.command })
      }
      setActiveSession(name)
    },
    [sessions, activeSession],
  )

  // Consumes an "open in terminal" request handed down from another tab
  // (Projects/Files, see App.tsx's openInTerminal) - runs once on mount only,
  // since Terminal fully unmounts whenever its tab isn't active, so a fresh
  // mount is exactly the one moment a still-pending request should apply.
  useEffect(() => {
    if (initialOpen) {
      addSession(initialOpen)
      onInitialOpenConsumed?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openFileManagerHere = useCallback(async () => {
    if (activeSession === HOME_TAB_ID || !onOpenFileManager) return
    try {
      const res = await api.get<{ cwd: string }>(`/terminal/sessions/${encodeURIComponent(activeSession)}/cwd`)
      onOpenFileManager(res.cwd)
    } catch (e) {
      setSessionActionError(errorMessage(e))
    }
  }, [activeSession, onOpenFileManager])

  const openProfile = useCallback(
    (profile: TerminalProfile) => {
      addSession({ label: profile.label, cwd: profile.cwd, command: profile.command })
    },
    [addSession],
  )

  const togglePin = useCallback(
    async (name: string, pinned: boolean) => {
      try {
        await api.patch(`/terminal/sessions/${encodeURIComponent(name)}`, { pinned })
        await refreshSessions()
      } catch (e) {
        setSessionActionError(errorMessage(e))
      }
    },
    [refreshSessions],
  )

  const renameSession = useCallback(
    async (oldName: string, newName: string) => {
      const trimmed = newName.trim()
      if (!trimmed || trimmed === oldName) return
      try {
        await api.patch(`/terminal/sessions/${encodeURIComponent(oldName)}`, { name: trimmed })
      } catch (e) {
        setSessionActionError(errorMessage(e))
        return
      }
      // If the renamed tab is the one currently connected, its WebSocket
      // needs to move to the new name too (the connection effect below is
      // keyed by activeSession) so pin/close afterward target the session's
      // actual current key on the backend rather than a name that no longer
      // exists there. This does mean the effect tears down and reopens the
      // WebSocket under the new name - deliberately not special-cased to
      // avoid it, since the reconnect is effectively free here: the PTY
      // itself never restarts (internal/termsession.Registry.Rename re-keys
      // the same *Session in place), and the reattach replays scrollback
      // immediately, same as any other tab switch.
      if (oldName === activeSession) setActiveSession(trimmed)
      await refreshSessions()
    },
    [activeSession, refreshSessions],
  )

  const closeSession = useCallback(
    async (name: string) => {
      try {
        await api.del(`/terminal/sessions/${encodeURIComponent(name)}`)
      } catch (e) {
        // A 404 here means the session already died on its own (e.g.
        // Ctrl+D) and the backend already GC'd it — that's exactly the
        // end state closing was trying to reach, so treat it as success
        // and fall through to the same cleanup below instead of leaving
        // the tab stuck with a "session no longer exists" error and
        // activeSession still pointed at the dead name.
        if (!(e instanceof ApiError && e.status === 404)) {
          setSessionActionError(errorMessage(e))
          return
        }
      }
      if (name === activeSession) {
        const remaining = sessions.filter((s) => s.name !== name)
        // No new default session gets created here on purpose - closing
        // the last tab should fall back to the Home tab rather than
        // silently spinning up a fresh "세션 1".
        setActiveSession(remaining.length > 0 ? remaining[0].name : HOME_TAB_ID)
      }
      await refreshSessions()
    },
    [activeSession, sessions, refreshSessions],
  )

  // Item 8: before actually closing a session (tab bar X, or the Home tab's
  // session-list X — pinned sessions never reach here, they have no close
  // button at all per item 3), check whether its shell has any foreground
  // child process running and confirm first if so, so e.g. an accidental
  // click near "+" can't silently kill a running build/editor/ssh session.
  // "Has a child process" is a cheap, reasonable heuristic for "something's
  // running" — it doesn't distinguish a real foreground job from a
  // background one (`sleep 100 &`), and a session whose pid the backend
  // couldn't resolve (defensive-only, see termsession.Info.Pid) just skips
  // the check and closes directly rather than blocking on a check that
  // can't answer. GET /api/processes + buildProcessTree (already used by
  // the Task Manager/Supervisor tabs) is reused rather than adding a
  // dedicated backend endpoint for this.
  const requestClose = useCallback(
    async (name: string) => {
      const session = sessions.find((s) => s.name === name)
      if (!session || !session.pid) {
        closeSession(name)
        return
      }
      try {
        const processes = await api.get<ProcessInfo[]>('/processes')
        const [root] = buildProcessTree(processes, session.pid)
        if (root && root.children.length > 0) {
          setCloseConfirm({ name })
          return
        }
      } catch {
        // best-effort - if the process list itself can't be fetched, fall
        // back to closing directly rather than blocking the user on a
        // check that can't be answered
      }
      closeSession(name)
    },
    [sessions, closeSession],
  )

  const confirmClose = useCallback(async () => {
    if (!closeConfirm) return
    setCloseConfirmBusy(true)
    await closeSession(closeConfirm.name)
    setCloseConfirmBusy(false)
    setCloseConfirm(null)
  }, [closeConfirm, closeSession])

  const surfaceStyle = {
    '--kb-inset': `${keyboardInset}px`,
    // Lets the control bar/surface chrome (Terminal.css) blend into whatever
    // theme is active instead of a hardcoded color — xterm paints its own
    // canvas over .terminal-container's own background per-cell, so that
    // background only ever shows through in the small padding gap around it;
    // matching it to the real theme colors keeps that gap (and the control
    // bar below it) visually part of the terminal instead of a mismatched
    // frame around it (verified live: a hardcoded black looked wrong against
    // the default Dracula theme's #282a36).
    '--term-bg': currentTheme.colors.background ?? '#000',
    '--term-fg': currentTheme.colors.foreground ?? '#e6e6e6',
  } as CSSProperties

  return (
    <section className="terminal-section" style={surfaceStyle}>
      <div className="terminal-topbar">
        <h1>Terminal</h1>
        <div className="terminal-header-actions">
          {activeSession !== HOME_TAB_ID && (
            <span className={`badge ${STATE_BADGE_CLASS[state]}`}>{STATE_LABEL[state]}</span>
          )}
          {activeSession !== HOME_TAB_ID && onOpenFileManager && (
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={openFileManagerHere}
              title="현재 디렉토리를 파일 브라우저에서 열기"
            >
              <FolderOpen size={14} /> 파일 브라우저에서 열기
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setSettingsOpen(true)}>
            설정
          </button>
        </div>
      </div>
      <TerminalTabs
        sessions={sessions}
        activeSession={activeSession}
        onSelect={selectSession}
        onAdd={addSession}
        onTogglePin={togglePin}
        onClose={requestClose}
        onRename={renameSession}
        homeLabel={effectiveSettings.homeLabel}
        onRenameHome={renameHome}
      />
      {settingsError && (
        <p className="terminal-inline-notice">터미널 설정을 불러오지 못했습니다 ({settingsError}) — 기본값을 사용합니다.</p>
      )}
      {sessionActionError && (
        <p className="terminal-inline-notice">{sessionActionError}</p>
      )}
      <div className="terminal-surface">
        {/* containerRef stays mounted even in the empty state - the xterm
            instance is created once (see the effect above) and expects its
            target element to always exist, so hiding it via CSS rather than
            unmounting avoids having to recreate xterm when a session opens
            again. */}
        <div ref={containerRef} className="terminal-container" hidden={activeSession === HOME_TAB_ID} />
        {activeSession === HOME_TAB_ID && (
          <TerminalHome
            sessions={sessions}
            onSelectSession={selectSession}
            onTogglePin={togglePin}
            onCloseSession={requestClose}
            profiles={profiles}
            profilesError={profilesError}
            onSaveProfiles={saveProfiles}
            onOpenProfile={openProfile}
            onNewSession={() => addSession()}
          />
        )}
        {activeSession !== HOME_TAB_ID && (
          <TerminalControls
            keybindings={effectiveSettings.keybindings}
            armedModifier={armedModifier}
            onArmModifier={armModifier}
            onSendBytes={sendBytes}
          />
        )}
      </div>
      <TerminalSettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={effectiveSettings}
        saving={saving}
        error={saveError}
        onDismissError={() => setSaveError(null)}
        onSave={saveSettings}
        onPreviewTheme={previewTheme}
      />
      <ConfirmDialog
        open={closeConfirm !== null}
        onClose={() => setCloseConfirm(null)}
        onConfirm={confirmClose}
        title="세션을 닫으시겠습니까?"
        confirmLabel="닫기"
        busy={closeConfirmBusy}
        busyLabel="닫는 중..."
      >
        <p>
          <strong>{closeConfirm?.name}</strong> 세션에서 프로그램이 실행 중인 것으로 보입니다. 지금 닫으면 강제
          종료됩니다.
        </p>
      </ConfirmDialog>
    </section>
  )
}
