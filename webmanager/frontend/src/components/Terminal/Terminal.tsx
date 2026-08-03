import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import '../common/common.css'
import { api, apiUrl, errorMessage } from '../../api/client'
import type { TerminalSessionInfo, TerminalSettings } from '../../api/types'
import { DEFAULT_KEYBINDINGS, type ModifierId } from './keybindings'
import { DEFAULT_THEME_ID, findTheme, themeToXterm } from './themes'
import { applyModifier } from './modifiers'
import { TerminalControls } from './TerminalControls'
import { TerminalSettingsPanel } from './TerminalSettingsPanel'
import { TerminalTabs } from './TerminalTabs'
import { useKeyboardInset } from './useKeyboardInset'
import './Terminal.css'

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
}

// nextSessionName picks "세션 N" for the smallest N not already taken, so
// repeated "+" clicks (or a name someone already renamed away from the
// default pattern) never collide. alsoTaken covers the currently-active
// session specifically — it's real and already occupying that name the
// moment it's picked, but the backend may not have confirmed it in
// `sessions` yet (GET /api/terminal/sessions hasn't been refetched since
// connecting, or is still in flight) — without this, clicking "+" before
// that refetch lands would silently "create" the exact name already active
// (verified live: this was a real bug, not a hypothetical one).
function nextSessionName(existing: TerminalSessionInfo[], alsoTaken: string): string {
  const taken = new Set(existing.map((s) => s.name))
  taken.add(alsoTaken)
  let n = 1
  while (taken.has(`세션 ${n}`)) n++
  return `세션 ${n}`
}

export function Terminal() {
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
  // null means "no session selected" - this is also the initial state now:
  // opening the Terminal tab must not silently spawn a shell before the user
  // asks for one, so the empty state (.terminal-empty-state, "세션 열기"
  // button) is what a fresh mount shows, same as after explicitly closing the
  // last tab. Pre-existing sessions from a previous browser session (e.g.
  // pinned ones) still show up normally via refreshSessions() below — this
  // only affects whether a brand new session gets created on mount.
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [sessionActionError, setSessionActionError] = useState<string | null>(null)
  const keyboardInset = useKeyboardInset()

  // Effective settings: fall back to hardcoded defaults until the backend
  // responds (or if it returns an empty keybindings list).
  const effectiveSettings: TerminalSettings = useMemo(() => {
    const base = settings ?? EMPTY_SETTINGS
    return {
      keybindings: base.keybindings.length > 0 ? base.keybindings : DEFAULT_KEYBINDINGS,
      themeId: base.themeId || DEFAULT_THEME_ID,
      customThemes: base.customThemes,
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
    } catch {
      // best-effort — the tab bar just falls back to only showing the
      // active tab (TerminalTabs.tsx handles an empty list that way)
    }
  }, [])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

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

    if (!activeSession) {
      // No session to connect to (the last tab was just closed) - the empty
      // state below covers the UI; the previous effect run's cleanup
      // already closed whatever WebSocket was open.
      term.reset()
      return
    }

    term.reset()
    setState('connecting')

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(
      `${protocol}//${window.location.host}${apiUrl(`/terminal?session=${encodeURIComponent(activeSession)}`)}`,
    )
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
    // instead of only noticing on the next unrelated refresh.
    ws.onclose = () => {
      setState('disconnected')
      refreshSessions()
    }
    ws.onerror = () => setState('disconnected')
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

  const addSession = useCallback(() => {
    setActiveSession(nextSessionName(sessions, activeSession ?? ''))
  }, [sessions, activeSession])

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
        setSessionActionError(errorMessage(e))
        return
      }
      if (name === activeSession) {
        const remaining = sessions.filter((s) => s.name !== name)
        // No new default session gets created here on purpose - closing
        // the last tab should leave an explicit empty state (below) rather
        // than silently spinning up a fresh "세션 1".
        setActiveSession(remaining.length > 0 ? remaining[0].name : null)
      }
      await refreshSessions()
    },
    [activeSession, sessions, refreshSessions],
  )

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
          {activeSession && <span className={`badge ${STATE_BADGE_CLASS[state]}`}>{STATE_LABEL[state]}</span>}
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
        onClose={closeSession}
        onRename={renameSession}
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
        <div ref={containerRef} className="terminal-container" hidden={!activeSession} />
        {!activeSession && (
          <div className="terminal-empty-state">
            <p>열린 세션이 없습니다.</p>
            <button type="button" className="btn btn-primary" onClick={addSession}>
              세션 열기
            </button>
          </div>
        )}
        {activeSession && (
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
    </section>
  )
}
