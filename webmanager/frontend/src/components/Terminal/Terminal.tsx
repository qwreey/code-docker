import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FolderKanban, FolderOpen, Settings } from 'lucide-react'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import '../common/common.css'
import { api, apiUrl, errorMessage, ApiError } from '../../api/client'
import type {
  FontManifest,
  ProcessInfo,
  ProjectsResponse,
  TerminalProfile,
  TerminalProfilesDoc,
  TerminalSessionInfo,
  TerminalSettings,
} from '../../api/types'
import { buildProcessTree } from '../../utils/processTree'
import { projectPathForCwd } from '../../utils/projectPath'
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

// Short enough that cwd (and thus "프로젝트로 이동") catches up to a `cd`
// within a beat, long enough to stay a cheap background poll.
const CWD_POLL_INTERVAL_MS = 3000

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
  fontFamily: '',
  detachSequence: '',
}

// Same literal stack as index.css's --mono token — xterm.js's fontFamily
// option feeds a canvas 2D context's `font` string directly, which (unlike
// a real CSS property) doesn't resolve var(--mono), so the fallback chain
// has to be spelled out here instead of referencing the CSS variable.
const DEFAULT_MONO_STACK = "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace"

function resolveFontFamily(selected: string): string {
  return selected ? `'${selected}', ${DEFAULT_MONO_STACK}` : DEFAULT_MONO_STACK
}

// Zoom (font size) is deliberately per-device localStorage, not part of the
// backend-persisted TerminalSettings blob — same "client-side-only UI
// preference" idiom as Extensions.tsx's SHOW_RECOMMENDATIONS_KEY, since a
// phone and a desktop monitor want different zoom levels, not one synced
// value. FONT_SIZE_DEFAULT matches xterm.js's own built-in default (never
// explicitly set before now) so an already-open terminal doesn't visibly
// jump the first time this ships.
const FONT_SIZE_STORAGE_KEY = 'webmanager.terminal.fontSize'
const FONT_SIZE_DEFAULT = 15
const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32
const FONT_SIZE_STEP = 1

function loadFontSize(): number {
  try {
    const stored = Number(localStorage.getItem(FONT_SIZE_STORAGE_KEY))
    if (Number.isFinite(stored) && stored >= FONT_SIZE_MIN && stored <= FONT_SIZE_MAX) return stored
  } catch {
    // localStorage unavailable (e.g. private browsing) - falls back to default
  }
  return FONT_SIZE_DEFAULT
}

function saveFontSize(value: number) {
  try {
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(value))
  } catch {
    // localStorage unavailable (e.g. private browsing) - zoom just won't persist
  }
}

// Experimental mobile IME-buffering workaround (see the touch-device block
// in the xterm-creation effect below) - enabled by default, but real-device
// testing (2026-08-19) found it still has rough edges (typing speed under
// fast consecutive input), so an escape hatch to fall back to xterm's own
// default textarea is worth keeping. Per-device localStorage like fontSize
// above, not backend-persisted - toggling only takes effect the next time
// the Terminal tab is fully remounted (leave and reopen it), since the
// touch-device setup runs once in the xterm-creation effect, not on every
// render.
const MOBILE_INPUT_WORKAROUND_KEY = 'webmanager.terminal.mobileInputWorkaround'

function loadMobileInputWorkaroundEnabled(): boolean {
  try {
    return localStorage.getItem(MOBILE_INPUT_WORKAROUND_KEY) !== '0'
  } catch {
    return true
  }
}

function saveMobileInputWorkaroundEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(MOBILE_INPUT_WORKAROUND_KEY)
    else localStorage.setItem(MOBILE_INPUT_WORKAROUND_KEY, '0')
  } catch {
    // localStorage unavailable (e.g. private browsing) - the toggle just won't persist
  }
}

// Alt-screen touch scrolling: a touch-drag over a full-screen application
// is delivered to that application as scroll input (see the touch handler in
// the xterm-creation effect) instead of moving xterm's own viewport. On by
// default — the old behavior was simply broken for those apps — but this is
// a mobile-only behavior change of the same kind as the IME workaround
// above, and the input it produces depends on what the application does with
// a wheel event, so an escape hatch back to plain viewport scrolling is
// worth having. Read through a ref, so unlike the workaround above it takes
// effect immediately rather than on the next remount.
const ALT_SCREEN_TOUCH_SCROLL_KEY = 'webmanager.terminal.altScreenTouchScroll'

function loadAltScreenTouchScrollEnabled(): boolean {
  try {
    return localStorage.getItem(ALT_SCREEN_TOUCH_SCROLL_KEY) !== '0'
  } catch {
    return true
  }
}

function saveAltScreenTouchScrollEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(ALT_SCREEN_TOUCH_SCROLL_KEY)
    else localStorage.setItem(ALT_SCREEN_TOUCH_SCROLL_KEY, '0')
  } catch {
    // localStorage unavailable (e.g. private browsing) - the toggle just won't persist
  }
}

// sendsScrollToApp reports whether the running application, not the
// viewport, is what should receive a scroll. True in the alternate screen
// buffer (a full-screen app: there is no scrollback to move through) and
// whenever mouse tracking is on, which an application only enables because
// it wants to handle wheel events itself — including in the normal buffer,
// where the alt-buffer check alone would miss it.
function sendsScrollToApp(term: XTerm): boolean {
  return term.buffer.active.type === 'alternate' || term.modes.mouseTrackingMode !== 'none'
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
  onOpenProject,
}: {
  initialOpen?: { cwd?: string; label?: string; command?: string; session?: string } | null
  onInitialOpenConsumed?: () => void
  onOpenFileManager?: (path: string) => void
  // Opens the project's info dialog over the terminal (App.tsx's
  // openProjectInfo) rather than navigating to the Projects tab.
  onOpenProject?: (path: string) => void
} = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const armedModifierRef = useRef<ModifierId | null>(null)
  // Only ever set on touch devices (see the mobile input workaround below).
  // focusTerminal() needs this: xterm's own public `.focus()` always
  // targets its real textarea directly, which would silently re-enable
  // predictive-text buffering (the exact bug the workaround exists to
  // avoid) the moment any toolbar button is pressed if left unchecked.
  const mobileInputRef = useRef<HTMLInputElement | null>(null)

  const [state, setState] = useState<ConnectionState>('connecting')
  const [settings, setSettings] = useState<TerminalSettings | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [armedModifier, setArmedModifier] = useState<ModifierId | null>(null)
  const [fontSize, setFontSize] = useState<number>(loadFontSize)
  const [mobileInputWorkaroundEnabled, setMobileInputWorkaroundEnabled] = useState<boolean>(loadMobileInputWorkaroundEnabled)
  const [altScreenTouchScrollEnabled, setAltScreenTouchScrollEnabled] = useState<boolean>(loadAltScreenTouchScrollEnabled)
  // The touch handler is installed once with the xterm instance, so it
  // reads the toggle through a ref rather than closing over the state.
  const altScreenScrollRef = useRef(altScreenTouchScrollEnabled)
  altScreenScrollRef.current = altScreenTouchScrollEnabled
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
  // Bumped by the disconnect overlay's "재연결" button to force the
  // WS-connect effect below to re-run against the same activeSession
  // without changing it — that effect is only otherwise keyed on
  // activeSession/refreshSessions, neither of which changes on demand.
  const [reconnectNonce, setReconnectNonce] = useState(0)

  // Effective settings: fall back to hardcoded defaults until the backend
  // responds (or if it returns an empty keybindings list).
  const effectiveSettings: TerminalSettings = useMemo(() => {
    const base = settings ?? EMPTY_SETTINGS
    return {
      keybindings: base.keybindings.length > 0 ? base.keybindings : DEFAULT_KEYBINDINGS,
      themeId: base.themeId || DEFAULT_THEME_ID,
      customThemes: base.customThemes,
      homeLabel: base.homeLabel,
      fontFamily: base.fontFamily,
      detachSequence: base.detachSequence,
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
    // Session cwd is read live off /proc/<pid>/cwd on the backend, but this
    // frontend cache only otherwise refetches on connect/disconnect/rename -
    // a plain `cd` in an already-open session left it stale until one of
    // those fired, which broke "프로젝트로 이동" and the Projects tab's
    // reverse link right after cd. Poll while the tab is mounted so both
    // stay in sync with the shell's actual directory.
    const timer = setInterval(refreshSessions, CWD_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
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

  // Projects tab's scan roots, used to resolve a session's cwd to a project
  // path (see utils/projectPath.ts) for the "프로젝트로 이동" jump button.
  // Best-effort/silent on failure - GET /api/projects is cheap (a cached
  // snapshot, see handlers_projects.go), but this feature is a convenience,
  // not something worth surfacing an error banner for.
  const [projectRoots, setProjectRoots] = useState<string[]>([])
  useEffect(() => {
    api
      .get<ProjectsResponse>('/projects')
      .then((res) => setProjectRoots(res.roots))
      .catch(() => {})
  }, [])

  // Font Manager family names for the settings panel's font picker —
  // best-effort/silent like projectRoots above, the panel just falls back
  // to only offering "시스템 기본" if this fails.
  const [fontFamilies, setFontFamilies] = useState<string[]>([])
  useEffect(() => {
    api
      .get<FontManifest>('/fonts')
      .then((res) => setFontFamilies(Array.from(new Set(res.fonts.map((f) => f.family))).sort()))
      .catch(() => {})
  }, [])

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

  // Fits xterm to its container, but only when that container is actually
  // laid out. The container carries `hidden` while the Home tab is showing
  // (which is what a fresh mount shows), and FitAddon measures via
  // getComputedStyle: on a display:none box it reads 0x0 and clamps to its
  // own 2x1 minimum. That bogus size then reached the PTY through
  // sendResize, so a session could be told it was two columns wide.
  const fitIfVisible = useCallback(() => {
    const container = containerRef.current
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return
    fitAddonRef.current?.fit()
  }, [])

  // Apply the selected Font Manager family live, same "initial value at
  // creation, then kept in sync by its own effect" shape as the theme
  // effect above. A font swap can change cell metrics, so re-fit afterward
  // (same call the ResizeObserver below already makes for size changes).
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontFamily = resolveFontFamily(effectiveSettings.fontFamily)
      fitIfVisible()
    }
  }, [effectiveSettings.fontFamily, fitIfVisible])

  // Tells the backend the PTY's size changed — shared by the ResizeObserver
  // below (container size changed) and the zoom effect further down (font
  // size changed, which can shift cols/rows without the container itself
  // resizing, so the ResizeObserver alone would never fire for it).
  const sendResize = useCallback(() => {
    const term = termRef.current
    const ws = wsRef.current
    if (term && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
  }, [])

  // Apply the zoom (font size) level live — same "initial value at creation,
  // then kept in sync by its own effect" shape as theme/fontFamily above.
  // Unlike those two, a font size change reliably shifts cols/rows within
  // the same container, so this is the one live-apply effect that also
  // needs to notify the backend via sendResize (the ResizeObserver only
  // fires on the container's own size changing, not xterm's internal cell
  // metrics).
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize
      fitIfVisible()
      sendResize()
    }
  }, [fontSize, fitIfVisible, sendResize])

  // Re-focuses the terminal. Used after every mobile-toolbar key/zoom
  // button action (see TerminalControls.tsx) since tapping a button would
  // otherwise shift DOM focus to the button itself (`preventFocusSteal`'s
  // onMouseDown there stops most of that, this is the rest), which both
  // drops xterm's own focus state and closes the virtual keyboard. Calling
  // this from inside the same synchronous touch-derived event handler keeps
  // it within the user-gesture context most mobile browsers require to
  // reopen the keyboard programmatically.
  //
  // When the mobile-input-workaround is active, focus MUST go straight to
  // it, not to xterm's own real textarea — `XTerm.focus()` always targets
  // that real textarea directly, and while its own onTextareaFocus listener
  // (below) does redirect that back here, going through xterm briefly
  // focuses the real textarea first, which is exactly the element the
  // workaround exists to keep real keystrokes away from. Short-circuiting
  // straight to mobileInputRef skips that round-trip entirely — confirmed
  // live, 2026-08-21, as more than theoretical: a version of this that
  // called `XTerm.focus()` unconditionally let one toolbar button press
  // silently revive the predictive-text buffering bug for the rest of that
  // typing session.
  const focusTerminal = useCallback(() => {
    if (mobileInputRef.current) {
      mobileInputRef.current.focus()
      return
    }
    termRef.current?.focus()
  }, [])

  const zoom = useCallback(
    (direction: 'in' | 'out') => {
      setFontSize((prev) => {
        const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, prev + (direction === 'in' ? FONT_SIZE_STEP : -FONT_SIZE_STEP)))
        saveFontSize(next)
        return next
      })
      focusTerminal()
    },
    [focusTerminal],
  )

  const toggleMobileInputWorkaround = useCallback((enabled: boolean) => {
    saveMobileInputWorkaroundEnabled(enabled)
    setMobileInputWorkaroundEnabled(enabled)
  }, [])

  const toggleAltScreenTouchScroll = useCallback((enabled: boolean) => {
    saveAltScreenTouchScrollEnabled(enabled)
    setAltScreenTouchScrollEnabled(enabled)
  }, [])

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
    focusTerminal()
  }, [focusTerminal])

  const armModifier = useCallback((mod: ModifierId) => {
    setArmedModifier((prev) => {
      const next = prev === mod ? null : mod
      armedModifierRef.current = next
      return next
    })
    focusTerminal()
  }, [focusTerminal])

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
      fontFamily: resolveFontFamily(effectiveSettings.fontFamily),
      fontSize,
    })
    termRef.current = term
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)
    term.open(container)
    // Not fitAddon.fit() unconditionally: on a fresh mount the Home tab is
    // active, so this container is still `hidden` here — see fitIfVisible.
    if (container.clientWidth > 0 && container.clientHeight > 0) fitAddon.fit()

    // xterm.js v6 doesn't scroll its scrollback via a plain native
    // `overflow-y: auto` div — .xterm-viewport is wrapped in a vendored
    // copy of Monaco's virtualized ScrollableElement widget, which owns
    // `scrollTop` internally and only moves in response to its own wheel/
    // scrollbar-drag handlers (confirmed by reading node_modules/@xterm/xterm
    // — writing viewport.scrollTop directly, tried first, silently did
    // nothing). The supported way in is the public `term.scrollLines(n)`
    // API, which both this Terminal instance and xterm's own wheel handler
    // route through — so translate vertical touch-drag distance into line
    // counts using the container's actual per-row pixel height instead.
    // Only engages past a small movement threshold so an ordinary tap still
    // reaches xterm's own click-to-focus/cursor-position handling
    // unhindered — only a real drag preventDefault()s (dropping the
    // synthetic click that would otherwise follow). The threshold is
    // deliberately generous (mobile touch "slop" from natural hand tremor
    // easily exceeds a few px) so a genuine tap-to-focus isn't misread as a
    // drag and swallowed.
    const TOUCH_SCROLL_THRESHOLD = 16
    // A single touch-drag can't be allowed to fire an unbounded number of
    // wheel events: each one is a keystroke (or mouse report) to the
    // application, and a fast flick across a short screen would otherwise
    // send a burst of dozens at once.
    const MAX_WHEEL_STEPS_PER_MOVE = 6
    let startY = 0
    let lastY = 0
    let dragging = false
    let lineRemainder = 0
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      startY = e.touches[0].clientY
      lastY = startY
      dragging = false
      lineRemainder = 0
    }
    // A full-screen application (claude, vim, htop, ...) runs in the
    // alternate screen buffer, which has no scrollback at all — so
    // term.scrollLines() there is either a silent no-op or, worse, drags
    // the view through the normal buffer's pile of stale redraws, which is
    // exactly what "touch-scrolling claude moves the terminal instead of
    // scrolling the app" was. What such an app expects instead is the
    // scroll *as input*: a mouse report if it turned mouse tracking on,
    // arrow keys if it didn't.
    //
    // Rather than reimplement that decision, hand it back to xterm.js by
    // synthesizing the wheel event a desktop mouse would have produced and
    // dispatching it on .xterm-screen, exactly where a real one lands.
    // xterm's own listeners then pick whichever of the three behaviors
    // applies (mouse report / arrow keys / viewport scroll — see
    // CoreBrowserTerminal's wheel handling), so touch and wheel can't drift
    // apart. DOM_DELTA_LINE with ±1 per event is used because xterm sends
    // exactly one arrow key per wheel event regardless of magnitude.
    const wheelTarget = () => container.querySelector('.xterm-screen') ?? container
    const dispatchWheel = (lines: number, clientX: number, clientY: number) => {
      const direction = lines > 0 ? 1 : -1
      const steps = Math.min(Math.abs(lines), MAX_WHEEL_STEPS_PER_MOVE)
      const target = wheelTarget()
      for (let i = 0; i < steps; i++) {
        target.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: direction,
            deltaMode: WheelEvent.DOM_DELTA_LINE,
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
          }),
        )
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const y = e.touches[0].clientY
      if (!dragging && Math.abs(y - startY) < TOUCH_SCROLL_THRESHOLD) return
      dragging = true
      const rowHeight = container.clientHeight / (term.rows || 1) || 18
      lineRemainder += (lastY - y) / rowHeight
      lastY = y
      const lines = Math.trunc(lineRemainder)
      if (lines !== 0) {
        // The normal buffer keeps the direct 1:1 scrollLines path: it moves
        // with the finger instead of being quantized into wheel clicks, and
        // it bypasses the viewport's smooth-scroll animation, which reads as
        // lag under direct manipulation.
        if (altScreenScrollRef.current && sendsScrollToApp(term)) {
          dispatchWheel(lines, e.touches[0].clientX, y)
        } else {
          term.scrollLines(lines)
        }
        lineRemainder -= lines
      }
      e.preventDefault()
    }
    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    const touchCleanup = () => {
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
    }

    // Mobile virtual keyboards (Gboard etc.) run predictive/autocorrect text
    // through the same DOM composition API (compositionstart/update/end)
    // real IME composition (Hangul assembly, etc.) needs, so xterm.js's
    // default hidden textarea buffers plain Latin typing exactly like a
    // real IME until a word boundary commits it ("aaaa" not appearing until
    // a space is pressed). These attributes alone don't stop it (harmless
    // baseline regardless); see the touch-device block below for what
    // actually does.
    if (term.textarea) {
      term.textarea.setAttribute('autocorrect', 'off')
      term.textarea.setAttribute('autocapitalize', 'off')
      term.textarea.setAttribute('autocomplete', 'off')
      term.textarea.setAttribute('spellcheck', 'false')
    }

    // Confirmed live (2026-08-19) that CSS-only masking (-webkit-text-
    // security) isn't enough — the keyboard only suppresses predictive
    // composition for a real <input type="password">, which <textarea>
    // (xterm.js's own hidden input) structurally cannot be. So on a touch
    // device only, mint an actual password-type <input>, redirect focus to
    // it every time term.textarea would otherwise become focused (its own
    // internal click-to-focus, or any focusTerminal() call below), and feed
    // what it captures through the same sendBytes() pipeline term.onData
    // already uses — xterm itself never receives real keystrokes on a
    // touch device, this input does. Left a no-op on desktop (mouse/
    // trackpad users never hit the buffering bug, and this is a real
    // behavior swap not worth the risk there).
    //
    // A 2026-08-21 detour tried instead overlaying this input directly on
    // top of the whole terminal (full size, still invisible) so a tap would
    // land on it AS the real target with no redirect needed — that did make
    // open/close/reopen fully native, but it also meant EVERY touch was
    // swallowed by this input before it could ever reach xterm's own mouse
    // handling, breaking mouse-click-driven terminal UIs entirely on touch
    // (tmux pane selection, vim/htop mouse mode, Claude Code's own
    // click-driven interactive prompts) — confirmed a hard requirement, not
    // optional, so that approach was reverted back to this redirect-based
    // one despite its own on-screen-keyboard-dismiss quirks (see
    // focusTerminal() above for the one concrete bug that detour did
    // legitimately catch and that's kept fixed here too).
    const isTouchDevice =
      loadMobileInputWorkaroundEnabled() &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches
    let mobileInputCleanup: (() => void) | undefined
    if (isTouchDevice && term.textarea) {
      const mobileInput = document.createElement('input')
      mobileInput.type = 'password'
      // "off", not "new-password" - "new-password" is literally the hint
      // Chrome's own save-password heuristic watches for ("this field is
      // for creating a new password"), which turned out to make the
      // unwanted "저장하시겠습니까?" prompt worse, not better (confirmed
      // live, 2026-08-19). "off" plus a random name at least avoids
      // matching common field-name autofill heuristics; Chrome's no-form
      // save-prompt heuristic on mobile may still fire regardless of any
      // attribute here — that's a known Chrome quirk (autocomplete=off is
      // deliberately ignored for the save-prompt decision, only affects
      // autofill *suggestions*), not something fixable client-side.
      mobileInput.autocomplete = 'off'
      mobileInput.name = `terminal-input-${Math.random().toString(36).slice(2)}`
      mobileInput.setAttribute('autocorrect', 'off')
      mobileInput.setAttribute('autocapitalize', 'off')
      mobileInput.setAttribute('spellcheck', 'false')
      mobileInput.setAttribute('aria-hidden', 'true')
      mobileInput.tabIndex = -1
      // Same fully-invisible, off-screen placement as xterm's own hidden
      // textarea (xterm.css's .xterm-helper-textarea) - never meant to be
      // seen, only to hold real DOM/keyboard focus. Deliberately NOT
      // overlaying the terminal (tried, reverted — see the doc comment
      // above): staying off to the side and out of the hit-testing path
      // entirely is what lets a real tap land on xterm's own screen/textarea
      // first, so xterm's normal mouse-click handling (cursor positioning,
      // mouse-tracking-protocol apps) keeps working; onTextareaFocus below
      // is what redirects the resulting focus attempt here afterward.
      Object.assign(mobileInput.style, {
        position: 'absolute',
        opacity: '0',
        left: '-9999em',
        top: '0',
        width: '0',
        height: '0',
        zIndex: '-5',
        border: '0',
        padding: '0',
      })
      container.appendChild(mobileInput)
      mobileInputRef.current = mobileInput

      // Confirmed live (2026-08-19): fully clearing the field to '' after
      // every keystroke breaks backspace — deleting from an already-empty
      // field is a no-op with nothing for the browser to fire an input
      // event about, so backspace silently did nothing. Keeping one
      // sentinel character in the field at all times means there's always
      // something for backspace to consume. baseline tracks what we've
      // already forwarded to the PTY; every input/compositionend event is
      // diffed against it (length-based, not full text diffing - real
      // single-keystroke mobile input is always a plain append or a plain
      // backspace, never a mid-string edit) rather than assuming the field
      // was actually reset back to ANCHOR since the browser may not have
      // gotten to that reset yet on fast consecutive typing (see
      // scheduleReset below).
      const ANCHOR = ' '
      let baseline = ANCHOR
      mobileInput.value = ANCHOR
      mobileInput.setSelectionRange(ANCHOR.length, ANCHOR.length)

      // Also confirmed live: resetting .value synchronously inside the
      // input handler made fast consecutive typing drop characters -
      // mutating a focused field's value while Android's own IME/webview
      // bridge is still processing that same keystroke appears to stall or
      // desync it. Deferring the reset to the next animation frame lets
      // that processing fully finish first. The equality check guards
      // against a stale reset clobbering a value that's already moved on
      // by the time the frame runs (e.g. two keystrokes landed before this
      // fired) - in that case the newer keystroke's own scheduled reset
      // takes over instead.
      let resetScheduled = false
      const scheduleReset = () => {
        if (resetScheduled) return
        resetScheduled = true
        const expected = mobileInput.value
        requestAnimationFrame(() => {
          resetScheduled = false
          if (mobileInput.value !== expected) return
          mobileInput.value = ANCHOR
          mobileInput.setSelectionRange(ANCHOR.length, ANCHOR.length)
          baseline = ANCHOR
        })
      }

      // Shared by onInput (plain typing) and onCompositionEnd (IME commit)
      // — both just need "what changed vs. baseline", the source doesn't
      // matter once composition itself is done.
      const processValueChange = () => {
        const value = mobileInput.value
        if (value.length > baseline.length) {
          sendBytes(value.slice(baseline.length))
        } else if (value.length < baseline.length) {
          sendBytes('\x7f'.repeat(baseline.length - value.length))
        }
        baseline = value
        scheduleReset()
      }

      let composing = false
      const onCompositionStart = () => {
        composing = true
      }
      // Real IME composition (Hangul assembly etc.) still legitimately
      // fires compositionstart/end regardless of input type - that's
      // OS/keyboard-level, not something a password field suppresses. Only
      // commit on compositionend so an in-progress multi-keystroke syllable
      // isn't sent character-by-character as it's being assembled.
      const onCompositionEnd = () => {
        composing = false
        processValueChange()
      }
      const onInput = () => {
        if (composing) return
        processValueChange()
      }
      const onKeyDown = (e: KeyboardEvent) => {
        // Enter never reaches the input-event handling above - a
        // single-line <input> doesn't insert a line break the way xterm's
        // own <textarea> did, so this is the one key still driven by
        // keydown. Most mobile keyboards (Gboard included) do dispatch a
        // real keydown for Enter even though they don't for ordinary
        // character keys.
        if (e.key === 'Enter' && !composing) {
          e.preventDefault()
          sendBytes('\r')
        }
      }
      mobileInput.addEventListener('compositionstart', onCompositionStart)
      mobileInput.addEventListener('compositionend', onCompositionEnd)
      mobileInput.addEventListener('input', onInput)
      mobileInput.addEventListener('keydown', onKeyDown)

      // Whenever xterm's own textarea would become focused - its internal
      // click-to-focus handler, or any focusTerminal() call elsewhere in
      // this file - immediately steal focus back to this input instead.
      // This is what keeps the keyboard in password mode across every
      // existing focus path without having to special-case each call site.
      // (focusTerminal() itself also short-circuits straight to
      // mobileInputRef now, skipping this round-trip when it's the one
      // calling — this listener is what covers every OTHER path, above all
      // xterm's own real click-to-focus.)
      const onTextareaFocus = () => {
        mobileInput.focus()
      }
      term.textarea.addEventListener('focus', onTextareaFocus)

      mobileInputCleanup = () => {
        term.textarea?.removeEventListener('focus', onTextareaFocus)
        mobileInput.remove()
        mobileInputRef.current = null
      }
    }

    // A program running inside the PTY (tmux/vim with set-clipboard, etc.)
    // can ask the terminal to copy to the OS clipboard via an OSC 52 escape
    // sequence — xterm.js doesn't handle that on its own (same gap the
    // xclip/wl-copy shims paper over for code-server's own terminal, see
    // root CLAUDE.md), and this main terminal never registered a handler
    // for it (only InteractiveLoginDialog.tsx's standalone login PTY did).
    // OSC 52 payload shape is "<selector>;<base64>", only the base64 half
    // matters here.
    const oscDisposable = term.parser.registerOscHandler(52, (data) => {
      const b64 = data.split(';')[1]
      if (!b64 || b64 === '?') return true
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        void navigator.clipboard.writeText(new TextDecoder().decode(bytes))
      } catch {
        // Malformed payload or clipboard API unavailable - not worth
        // surfacing an error for.
      }
      return true
    })

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
      // Also fires when the container is hidden on a switch to the Home tab
      // (a 0x0 box is still a size change), which is exactly the case
      // fitIfVisible exists to skip.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      fitAddon.fit()
      sendResize()
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      touchCleanup?.()
      mobileInputCleanup?.()
      oscDisposable.dispose()
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

    // The container was hidden until the render that scheduled this effect
    // committed, so fit here (now that it has a real box) rather than
    // trusting whatever size the terminal happens to be carrying. The size
    // rides along on the connect URL because the backend has to apply it
    // *before* it snapshots and replays scrollback — the "resize" control
    // message sent from onopen below arrives too late for that, since the
    // server doesn't read client messages until the replay is done.
    fitIfVisible()
    params.set('cols', String(term.cols))
    params.set('rows', String(term.rows))

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}${apiUrl(`/terminal?${params.toString()}`)}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      setState('connected')
      // Still sent even though the size already went out as a query param
      // above: the container can legitimately have changed size between
      // this effect running and the handshake completing.
      fitIfVisible()
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
  }, [activeSession, refreshSessions, reconnectNonce, fitIfVisible])

  const reconnect = useCallback(() => {
    setReconnectNonce((n) => n + 1)
  }, [])

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
      if (initialOpen.session) {
        selectSession(initialOpen.session)
      } else {
        addSession(initialOpen)
      }
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

  const activeProjectPath = useMemo(() => {
    if (activeSession === HOME_TAB_ID) return null
    const cwd = sessions.find((s) => s.name === activeSession)?.cwd
    return cwd ? projectPathForCwd(cwd, projectRoots) : null
  }, [sessions, activeSession, projectRoots])

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
            <span className={`badge ${STATE_BADGE_CLASS[state]} terminal-status-badge`} title={STATE_LABEL[state]}>
              <span className="terminal-status-dot" aria-hidden="true" />
              <span className="btn-label">{STATE_LABEL[state]}</span>
            </span>
          )}
          {activeSession !== HOME_TAB_ID && onOpenFileManager && (
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={openFileManagerHere}
              title="현재 디렉토리를 파일 브라우저에서 열기"
            >
              <FolderOpen size={14} /> <span className="btn-label">파일 브라우저에서 열기</span>
            </button>
          )}
          {activeSession !== HOME_TAB_ID && onOpenProject && activeProjectPath && (
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => onOpenProject(activeProjectPath)}
              title="현재 디렉토리가 속한 프로젝트 정보 보기"
            >
              <FolderKanban size={14} /> <span className="btn-label">프로젝트 정보</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => setSettingsOpen(true)}
            title="설정"
          >
            <Settings size={14} /> <span className="btn-label">설정</span>
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
        {activeSession !== HOME_TAB_ID && state === 'disconnected' && (
          <div className="terminal-disconnect-overlay">
            <div className="terminal-disconnect-card">
              <p>연결이 해제되었습니다</p>
              <button type="button" className="btn btn-primary btn-small" onClick={reconnect}>
                재연결
              </button>
            </div>
          </div>
        )}
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
            projectRoots={projectRoots}
            onOpenProject={onOpenProject}
          />
        )}
        {activeSession !== HOME_TAB_ID && (
          <TerminalControls
            keybindings={effectiveSettings.keybindings}
            armedModifier={armedModifier}
            onArmModifier={armModifier}
            onSendBytes={sendBytes}
            onZoom={zoom}
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
        fontFamilies={fontFamilies}
        mobileInputWorkaroundEnabled={mobileInputWorkaroundEnabled}
        onToggleMobileInputWorkaround={toggleMobileInputWorkaround}
        altScreenTouchScrollEnabled={altScreenTouchScrollEnabled}
        onToggleAltScreenTouchScroll={toggleAltScreenTouchScroll}
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
