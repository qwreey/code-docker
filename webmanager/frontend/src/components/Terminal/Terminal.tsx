import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { Code, Copy, FolderKanban, FolderOpen, Hand, Menu, MousePointer2, Settings, TextSelect } from 'lucide-react'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import '../common/common.css'
import { copyText } from '../../utils/clipboard'
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

// Mobile text input mode. Three genuinely different code paths, because no
// single one has survived contact with every keyboard:
//
//   'native'   - xterm.js's own hidden <textarea>. Real IME composition
//                works, but Android keyboards (Samsung's above all) keep a
//                whole phrase in a predictive buffer and re-emit text they
//                already committed, which lands as duplicated input
//                ("가나다. 가나다. 가나다"). Plain Latin typing is also
//                buffered until a word boundary commits it.
//   'password' - the original 2026-08-19 workaround: a real
//                <input type="password">, the only element type mobile
//                keyboards reliably refuse to run prediction on. Kills the
//                buffering, but a password field also suppresses real IME
//                composition, so Hangul arrives split into jamo
//                ("ㄱㅏㄴㅏㄷㅏ"). Kept selectable because it is the only
//                mode confirmed to stop predictive buffering outright.
//   'diff'     - a plain <textarea> (so composition attaches, same element
//                type xterm itself uses) that is never truncated while
//                typing, with everything already forwarded to the PTY
//                tracked as a string and each change reduced to a
//                common-prefix diff. A keyboard that re-emits text it
//                already committed then produces *no* new bytes at all -
//                exactly the duplication 'native' loses to - and a
//                shortened value produces backspaces rather than a
//                silently dropped keystroke.
//
// Background and the measurements behind each of those claims:
// webmanager/.claude/qa-request/terminal-mobile-input-touch-plan-done.md.
//
// Per-device localStorage like fontSize above, not backend-persisted. Only
// consulted on a touch device (pointer: coarse) - a mouse/trackpad never
// hits any of these keyboard bugs and always uses xterm's own textarea.
export type TerminalInputMode = 'native' | 'password' | 'diff'

const INPUT_MODE_KEY = 'webmanager.terminal.inputMode'
// Superseded by INPUT_MODE_KEY; still read once so a user who explicitly
// opted out of the old boolean workaround keeps xterm's own textarea
// instead of being silently moved onto a mode they never chose.
const LEGACY_MOBILE_INPUT_WORKAROUND_KEY = 'webmanager.terminal.mobileInputWorkaround'

function loadInputMode(): TerminalInputMode {
  try {
    const stored = localStorage.getItem(INPUT_MODE_KEY)
    if (stored === 'native' || stored === 'password' || stored === 'diff') return stored
    if (localStorage.getItem(LEGACY_MOBILE_INPUT_WORKAROUND_KEY) === '0') return 'native'
  } catch {
    // localStorage unavailable (e.g. private browsing) - falls through to
    // the default below
  }
  return 'diff'
}

function saveInputMode(mode: TerminalInputMode) {
  try {
    localStorage.setItem(INPUT_MODE_KEY, mode)
  } catch {
    // localStorage unavailable (e.g. private browsing) - the choice just won't persist
  }
}

// Input debug overlay: shows the last few input-related DOM events (type,
// isComposing, the field's value, the bytes actually forwarded) in a corner
// of the terminal. Off by default and deliberately not pretty - it exists
// because every previous round of guessing at what an Android keyboard
// does has been wrong at least once, and a screenshot of real events from
// the actual device is worth more than a fourth guess.
const INPUT_DEBUG_KEY = 'webmanager.terminal.inputDebug'

function loadInputDebugEnabled(): boolean {
  try {
    return localStorage.getItem(INPUT_DEBUG_KEY) === '1'
  } catch {
    return false
  }
}

function saveInputDebugEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.setItem(INPUT_DEBUG_KEY, '1')
    else localStorage.removeItem(INPUT_DEBUG_KEY)
  } catch {
    // localStorage unavailable (e.g. private browsing) - the toggle just won't persist
  }
}

// What a one-finger drag on the terminal does. A touch screen has to serve
// three jobs a mouse gets separate affordances for, and no default can be
// right for all of them:
//
//   'scroll' - move the viewport / send scroll to a full-screen app. The
//              historical behavior and still the default.
//   'mouse'  - replay the drag as real mouse events on .xterm-screen, so an
//              application that turned mouse tracking on (tmux, vim, htop,
//              Claude Code) receives actual clicks and drags.
//   'select' - the same synthetic mouse events but with shiftKey set, which
//              is xterm's own "force selection" modifier: it selects text
//              even while an application has mouse tracking on. This is the
//              only way to get a text selection on a touch device at all,
//              since xterm renders into elements the browser's own
//              long-press selection can't usefully grab.
//
// Read through a ref so switching modes applies immediately (the touch
// handler is installed once with the xterm instance), same idiom as
// altScreenTouchScrollEnabled below.
export type TouchMode = 'scroll' | 'mouse' | 'select'

const TOUCH_MODE_KEY = 'webmanager.terminal.touchMode'

function loadTouchMode(): TouchMode {
  try {
    const stored = localStorage.getItem(TOUCH_MODE_KEY)
    if (stored === 'scroll' || stored === 'mouse' || stored === 'select') return stored
  } catch {
    // localStorage unavailable (e.g. private browsing) - falls through
  }
  return 'scroll'
}

function saveTouchMode(mode: TouchMode) {
  try {
    localStorage.setItem(TOUCH_MODE_KEY, mode)
  } catch {
    // localStorage unavailable (e.g. private browsing) - the choice just won't persist
  }
}

const TOUCH_MODE_OPTIONS: { id: TouchMode; label: string; title: string; Icon: typeof Hand }[] = [
  { id: 'scroll', label: '스크롤', title: '드래그하면 화면이 스크롤됩니다', Icon: Hand },
  { id: 'mouse', label: '마우스', title: '드래그를 마우스 입력으로 앱에 전달합니다 (tmux/vim/claude 등)', Icon: MousePointer2 },
  { id: 'select', label: '선택', title: '드래그하면 텍스트가 선택됩니다 (복사용)', Icon: TextSelect },
]

// Debug overlay for the input path (INPUT_DEBUG_KEY above). Built
// imperatively rather than as a React node on purpose: it updates on every
// keystroke, and pushing that through component state would re-render the
// whole terminal section for something that is only ever read off a
// screenshot. Kept to the last few lines so it can't grow without bound.
const INPUT_DEBUG_LINES = 12

// JSON.stringify leaves control characters like DEL (0x7f) as invisible raw
// bytes, which is useless in an overlay whose entire job is showing what was
// sent — a backspace rendered as `""` reads as "sent nothing", the opposite
// of the truth. Escape anything below 0x20 plus DEL explicitly.
function debugQuote(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else if (ch === '"' || ch === '\\') out += '\\' + ch
    else out += ch
  }
  return `"${out}"`
}

function createInputDebugOverlay(container: HTMLElement): { log: (line: string) => void; dispose: () => void } {
  const el = document.createElement('div')
  el.className = 'terminal-input-debug'
  container.appendChild(el)
  const lines: string[] = []
  return {
    log(line: string) {
      lines.push(line)
      if (lines.length > INPUT_DEBUG_LINES) lines.shift()
      el.textContent = lines.join('\n')
    },
    dispose() {
      el.remove()
    },
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

// Auto-reconnect: on by default, unlike the two experimental toggles above
// (this is a plain convenience with a safe failure mode - worst case it
// behaves like the toggle was off - not an unstable input workaround). Same
// localStorage load/save shape as those two regardless, for consistency.
const AUTO_RECONNECT_KEY = 'webmanager.terminal.autoReconnect'

function loadAutoReconnectEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_RECONNECT_KEY) !== '0'
  } catch {
    return true
  }
}

function saveAutoReconnectEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(AUTO_RECONNECT_KEY)
    else localStorage.setItem(AUTO_RECONNECT_KEY, '0')
  } catch {
    // localStorage unavailable (e.g. private browsing) - the toggle just won't persist
  }
}

// Control bar visibility (TerminalControls.tsx — modifier keys/arrows/zoom):
// per-device like the toggles above, but with a device-sensitive *default*
// instead of a single hardcoded one. The bar exists to compensate for a
// mobile virtual keyboard missing physical Ctrl/Alt/arrows/Esc, so it's
// wasted vertical space on a mouse/trackpad device that already has real
// keys for all of that — defaults to hidden when `(pointer: fine)` matches
// (desktop) and shown otherwise, falling back to shown (today's behavior)
// wherever matchMedia isn't available to ask. Unlike the two experimental
// toggles above, hiding the bar is a plain conditional render (see the
// <TerminalControls> call below), so — same as autoReconnectEnabled — it
// takes effect immediately with no remount needed: xterm's own
// ResizeObserver (xterm-creation effect) picks up the reclaimed space and
// re-fits on its own, nothing extra to wire up here. Because the fallback
// is computed rather than a fixed constant, storage can't reuse the
// "absence means the (single) default" shape those other toggles use —
// '1'/'0' are stored explicitly once the user actually picks one, and only
// an unset key falls through to the computed device default below.
const CONTROL_BAR_KEY = 'webmanager.terminal.controlBarEnabled'

function defaultControlBarEnabled(): boolean {
  if (typeof window.matchMedia !== 'function') return true
  return !window.matchMedia('(pointer: fine)').matches
}

function loadControlBarEnabled(): boolean {
  try {
    const stored = localStorage.getItem(CONTROL_BAR_KEY)
    if (stored === '1') return true
    if (stored === '0') return false
  } catch {
    // localStorage unavailable (e.g. private browsing) - falls through to
    // the device default below
  }
  return defaultControlBarEnabled()
}

function saveControlBarEnabled(enabled: boolean) {
  try {
    localStorage.setItem(CONTROL_BAR_KEY, enabled ? '1' : '0')
  } catch {
    // localStorage unavailable (e.g. private browsing) - the toggle just won't persist
  }
}

// Capped exponential backoff for scheduled auto-reconnect attempts: 1s, 2s,
// 4s, 8s, 16s, then held at the 30s cap. 1s is fast enough that the common
// mobile case (a brief app-background blip) recovers almost instantly; the
// 30s cap keeps a genuinely-down backend from being hammered forever while
// still checking often enough that the tab comes back within half a minute
// of the server returning. Picked by judgment, not measurement - revisit if
// a real outage shows either end is wrong. The foreground-return path below
// bypasses this entirely and retries immediately, since that's the actual
// mobile scenario this feature targets.
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000

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
  onToggleSidebar,
  restoreSession,
  onRestoreSessionConsumed,
  onActiveSessionChange,
}: {
  initialOpen?: { cwd?: string; label?: string; command?: string; session?: string } | null
  onInitialOpenConsumed?: () => void
  onOpenFileManager?: (path: string) => void
  // Opens the project's info dialog over the terminal (App.tsx's
  // openProjectInfo) rather than navigating to the Projects tab.
  onOpenProject?: (path: string) => void
  // Given only while this tab is the active section: the Terminal tab hides
  // the app's own mobile top bar (see App.tsx) to reclaim the vertical space
  // a phone keyboard makes precious, and adopts its hamburger into its own
  // header instead.
  onToggleSidebar?: () => void
  // Session name restored from the URL (?session=...). Unlike initialOpen's
  // own session field, which always names a session another tab just looked
  // at, this one comes from a reload or a bookmark and may well be dead —
  // so it is verified against the live list before being selected.
  restoreSession?: string | null
  onRestoreSessionConsumed?: () => void
  onActiveSessionChange?: (name: string | null) => void
} = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const armedModifierRef = useRef<ModifierId | null>(null)
  // Only ever set on touch devices (see the mobile input workaround below).
  // keepFocus() needs this: xterm's own public `.focus()` always
  // targets its real textarea directly, which would silently re-enable
  // predictive-text buffering (the exact bug the workaround exists to
  // avoid) the moment any toolbar button is pressed if left unchecked.
  const mobileInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  const [state, setState] = useState<ConnectionState>('connecting')
  const [settings, setSettings] = useState<TerminalSettings | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [armedModifier, setArmedModifier] = useState<ModifierId | null>(null)
  const [fontSize, setFontSize] = useState<number>(loadFontSize)
  const [inputMode, setInputModeState] = useState<TerminalInputMode>(loadInputMode)
  const [inputDebugEnabled, setInputDebugEnabledState] = useState<boolean>(loadInputDebugEnabled)
  const [touchMode, setTouchModeState] = useState<TouchMode>(loadTouchMode)
  // The touch handler is installed once with the xterm instance (same as
  // altScreenScrollRef below), so it reads the mode through a ref.
  const touchModeRef = useRef(touchMode)
  touchModeRef.current = touchMode
  // Set while a selection exists after a 'select'-mode drag, so a copy
  // affordance can appear (a touch device has no Ctrl+C, and xterm's own
  // selection is invisible to the browser's native copy UI).
  const [hasSelection, setHasSelection] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [altScreenTouchScrollEnabled, setAltScreenTouchScrollEnabled] = useState<boolean>(loadAltScreenTouchScrollEnabled)
  // The touch handler is installed once with the xterm instance, so it
  // reads the toggle through a ref rather than closing over the state.
  const altScreenScrollRef = useRef(altScreenTouchScrollEnabled)
  altScreenScrollRef.current = altScreenTouchScrollEnabled
  const [autoReconnectEnabled, setAutoReconnectEnabledState] = useState<boolean>(loadAutoReconnectEnabled)
  // Unlike mobileInputWorkaroundEnabled above (only read once, at xterm
  // creation - toggling it requires leaving/re-entering the tab), this one
  // has to affect a ws.onclose handler that may already be sitting inside a
  // closure from an earlier render, waiting for the socket to drop - so it's
  // read through a ref, same "ref mirrors state for a listener installed
  // once" idiom as altScreenScrollRef right above, not the mobile-input
  // pattern. Don't copy the mobile-input pattern for a setting that needs to
  // take effect live.
  const autoReconnectEnabledRef = useRef(autoReconnectEnabled)
  autoReconnectEnabledRef.current = autoReconnectEnabled
  // No ref mirror needed here, unlike autoReconnectEnabled right above -
  // this only ever gates a plain conditional render (<TerminalControls>
  // below and TerminalTabs' zoom group), so plain state already re-applies
  // on every render with no listener-closure staleness to work around.
  const [controlBarEnabled, setControlBarEnabledState] = useState<boolean>(loadControlBarEnabled)
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
  // Same response also carries codeServerUrl (WEBMANAGER_CODE_SERVER_URL),
  // which the "code로 열기" link below needs — piggybacking on this existing
  // request keeps that link at exact parity with the Projects tab's own
  // one (see ProjectTable.tsx) without adding backend plumbing just to
  // deliver one string to this component.
  const [codeServerUrl, setCodeServerUrl] = useState('')
  useEffect(() => {
    api
      .get<ProjectsResponse>('/projects')
      .then((res) => {
        setProjectRoots(res.roots)
        setCodeServerUrl(res.codeServerUrl)
      })
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

  // Always holds the latest connection state, readable from the foreground
  // handler below without making that effect re-subscribe its listeners on
  // every 'connecting' <-> 'connected' <-> 'disconnected' transition - same
  // "ref mirrors state for a stable listener" idiom as activeSessionRef
  // above.
  const stateRef = useRef(state)
  stateRef.current = state

  // Pending auto-reconnect timer + the attempt count driving its backoff.
  // Refs, not state, because they must survive the WS-connect effect below
  // tearing itself down and recreating on every reconnect attempt (it's
  // keyed on reconnectNonce) without losing the count - only a real
  // successful connection (ws.onopen) or an explicit user-initiated
  // reconnect should reset it back to 0.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  // Drives the "재연결 중..." overlay below - null whenever nothing is
  // scheduled, otherwise which attempt is pending and when it fires, so the
  // overlay can show live feedback instead of looking identical to a plain
  // idle-disconnected state.
  const [pendingReconnect, setPendingReconnect] = useState<{ attempt: number; retryAt: number } | null>(null)

  const clearScheduledReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    setPendingReconnect(null)
  }, [])

  // Schedules the next auto-reconnect attempt at a capped exponential delay
  // (see RECONNECT_BASE_DELAY_MS/RECONNECT_MAX_DELAY_MS above), firing by
  // bumping reconnectNonce - the same signal the manual 재연결 button uses,
  // so a scheduled attempt and a manual one both flow through the one
  // WS-connect effect below. Guards against double-scheduling (a stray
  // second onclose for a socket that's already being replaced) and against
  // the Home tab, which is never a real session to reconnect.
  const scheduleReconnect = useCallback(() => {
    if (activeSessionRef.current === HOME_TAB_ID) return
    if (reconnectTimerRef.current !== null) return
    const attempt = reconnectAttemptRef.current + 1
    reconnectAttemptRef.current = attempt
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS)
    setPendingReconnect({ attempt, retryAt: Date.now() + delay })
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      setReconnectNonce((n) => n + 1)
    }, delay)
  }, [])

  // Manual reconnect (the overlay's button) and the foreground-return fast
  // path below both go through this: cancel whatever's pending and retry
  // immediately, resetting the backoff back to attempt 1 - a user action (or
  // the app coming back to the foreground) is a strong enough signal that
  // it's worth trying right now rather than respecting a delay computed for
  // an unattended background retry.
  const reconnect = useCallback(() => {
    clearScheduledReconnect()
    reconnectAttemptRef.current = 0
    setReconnectNonce((n) => n + 1)
  }, [clearScheduledReconnect])

  // Ticks once a second only while a reconnect is actually pending, purely
  // to re-render the overlay's countdown below - retrySecondsLeft itself is
  // derived fresh from pendingReconnect.retryAt on every render rather than
  // stored as its own state, so this doesn't need to (and shouldn't) try to
  // keep a duplicate counter in sync.
  const [, forceReconnectCountdownTick] = useState(0)
  useEffect(() => {
    if (!pendingReconnect) return
    const id = setInterval(() => forceReconnectCountdownTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [pendingReconnect])
  const retrySecondsLeft = pendingReconnect ? Math.max(0, Math.ceil((pendingReconnect.retryAt - Date.now()) / 1000)) : 0

  // Several clients can be attached to one session at once (phone, tablet,
  // laptop) and the backend applies resizes last-write-wins with no
  // ownership concept — relayTerminalSession accepts an unsolicited resize
  // from any attached connection at any time. So the window regaining focus
  // is the natural moment for this client to re-claim the PTY size: coming
  // back to the laptop after using the same session on a phone would
  // otherwise leave the terminal stuck at the phone's dimensions.
  // Deliberately one message on the focus transition, not polling while
  // focused — one resize is all it takes to win.
  //
  // This is also auto-reconnect's fast path: waiting out a scheduled
  // backoff after a phone was simply backgrounded and foregrounded again
  // would make even a 1-second-old disconnect feel sluggish, so returning to
  // the foreground jumps straight to an immediate retry instead. Both
  // 'focus' and 'visibilitychange' are listened for (one handler, not two
  // near-duplicate ones) - on mobile, backgrounding a tab/PWA is known to
  // not always fire a plain window 'focus' on return (browser/OS-dependent),
  // while 'visibilitychange' is the more reliable signal for exactly that
  // case; not independently verified live in this repo, so keep both rather
  // than betting entirely on one.
  useEffect(() => {
    if (activeSession === HOME_TAB_ID) return
    const onForeground = () => {
      fitIfVisible()
      sendResize()
      if (stateRef.current === 'disconnected' && autoReconnectEnabledRef.current) reconnect()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') onForeground()
    }
    window.addEventListener('focus', onForeground)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onForeground)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [activeSession, fitIfVisible, sendResize, reconnect])

  // keepFocus is what every control-bar button (TerminalControls.tsx) goes
  // through after its action, and it deliberately never *opens* the
  // on-screen keyboard — it only keeps an already-open one from closing.
  //
  // The distinction only matters on a phone: focus() on a text field is
  // also the gesture that opens the virtual keyboard, so an unconditional
  // refocus from a toolbar tap means pressing Ctrl, an arrow key or zoom
  // pops the keyboard up even when the user only wanted to change the font
  // size and never intended to type — reported as exactly that, "확대
  // 축소만 하려는데도 키보드가 열려서". Refocusing when the field already
  // has focus is still needed (that is what keeps the tap from dismissing
  // an open keyboard, which is why this call exists at all), so the guard
  // is "already the active element" rather than dropping the call
  // entirely: keyboard open stays open, keyboard closed stays closed.
  //
  // When a mobile input field is active, the target MUST be that field and
  // not xterm's own real textarea — `XTerm.focus()` always targets the real
  // textarea directly, which is exactly the element the workaround exists
  // to keep real keystrokes away from. Confirmed live 2026-08-21 as more
  // than theoretical: a version that called `XTerm.focus()` unconditionally
  // let one toolbar button press silently revive the predictive-text
  // buffering bug for the rest of that typing session.
  //
  // Not conditional on being a touch device: on desktop, TerminalControls'
  // own preventFocusSteal already stops the button from taking focus in the
  // first place, so the only case this changes there is a tap after focus
  // genuinely moved elsewhere — where sending the byte still works (the WS
  // write needs no focus at all) and silently yanking focus back was never
  // load-bearing.
  const keepFocus = useCallback(() => {
    const target = mobileInputRef.current ?? termRef.current?.textarea ?? null
    if (!target || document.activeElement !== target) return
    target.focus()
  }, [])

  const zoom = useCallback(
    (direction: 'in' | 'out') => {
      setFontSize((prev) => {
        const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, prev + (direction === 'in' ? FONT_SIZE_STEP : -FONT_SIZE_STEP)))
        saveFontSize(next)
        return next
      })
      keepFocus()
    },
    [keepFocus],
  )

  const changeInputMode = useCallback((mode: TerminalInputMode) => {
    saveInputMode(mode)
    setInputModeState(mode)
  }, [])

  const toggleInputDebug = useCallback((enabled: boolean) => {
    saveInputDebugEnabled(enabled)
    setInputDebugEnabledState(enabled)
  }, [])

  const changeTouchMode = useCallback((mode: TouchMode) => {
    saveTouchMode(mode)
    setTouchModeState(mode)
  }, [])

  const toggleAltScreenTouchScroll = useCallback((enabled: boolean) => {
    saveAltScreenTouchScrollEnabled(enabled)
    setAltScreenTouchScrollEnabled(enabled)
  }, [])

  const toggleAutoReconnect = useCallback((enabled: boolean) => {
    saveAutoReconnectEnabled(enabled)
    setAutoReconnectEnabledState(enabled)
  }, [])

  const toggleControlBarEnabled = useCallback((enabled: boolean) => {
    saveControlBarEnabled(enabled)
    setControlBarEnabledState(enabled)
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
    keepFocus()
  }, [keepFocus])

  const armModifier = useCallback((mod: ModifierId) => {
    setArmedModifier((prev) => {
      const next = prev === mod ? null : mod
      armedModifierRef.current = next
      return next
    })
    keepFocus()
  }, [keepFocus])

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
    let startX = 0
    let startY = 0
    let lastX = 0
    let lastY = 0
    let dragging = false
    // Set once a 'mouse'/'select'-mode drag has synthesized its mousedown,
    // so touchmove keeps feeding the same drag and touchend can close it.
    let pointerDragging = false
    let lineRemainder = 0
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      lastX = startX
      lastY = startY
      dragging = false
      pointerDragging = false
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
    // 'mouse'/'select' touch modes: replay the drag as the mouse events a
    // desktop would have produced, and let xterm decide what they mean —
    // the same "hand the decision back to xterm" approach dispatchWheel
    // above takes, for the same reason (reimplementing xterm's mouse
    // protocol/selection logic here would immediately drift from it).
    //
    // shiftKey is what separates the two modes. xterm treats shift as
    // "force selection": with it set, a drag selects text even while an
    // application has mouse tracking on; without it, an application that
    // asked for mouse reports gets them. That single flag is the whole
    // difference, so 'select' is not a separate implementation — it is
    // 'mouse' with the modifier xterm already understands.
    //
    // Events are dispatched on .xterm-screen with bubbles:true because
    // xterm's selection service starts from a mousedown there and then
    // listens on the document for the rest of the drag.
    const dispatchMouse = (type: 'mousedown' | 'mousemove' | 'mouseup', clientX: number, clientY: number, forceSelection: boolean) => {
      wheelTarget().dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: 0,
          buttons: type === 'mouseup' ? 0 : 1,
          shiftKey: forceSelection,
          view: window,
        }),
      )
    }
    const endPointerDrag = (clientX: number, clientY: number) => {
      if (!pointerDragging) return
      pointerDragging = false
      dispatchMouse('mouseup', clientX, clientY, touchModeRef.current === 'select')
    }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const y = e.touches[0].clientY
      const x = e.touches[0].clientX
      const mode = touchModeRef.current
      if (mode !== 'scroll') {
        // Both axes count here, unlike scroll mode: a selection drag is
        // most often horizontal, and requiring vertical movement to start
        // one would make selecting a single line impossible.
        if (!pointerDragging && Math.abs(y - startY) < TOUCH_SCROLL_THRESHOLD && Math.abs(x - startX) < TOUCH_SCROLL_THRESHOLD) return
        const forceSelection = mode === 'select'
        if (!pointerDragging) {
          pointerDragging = true
          dispatchMouse('mousedown', startX, startY, forceSelection)
        }
        dispatchMouse('mousemove', x, y, forceSelection)
        lastX = x
        lastY = y
        e.preventDefault()
        return
      }
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
    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0]
      endPointerDrag(t?.clientX ?? lastX, t?.clientY ?? lastY)
    }
    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    container.addEventListener('touchend', onTouchEnd, { passive: true })
    container.addEventListener('touchcancel', onTouchEnd, { passive: true })
    // Drives the copy affordance below: xterm's selection is its own state,
    // invisible to window.getSelection(), so nothing else would ever know a
    // touch drag produced one.
    const selectionDisposable = term.onSelectionChange(() => {
      setHasSelection(term.hasSelection())
    })
    const touchCleanup = () => {
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchEnd)
      selectionDisposable.dispose()
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
      oscDisposable.dispose()
      dataDisposable.dispose()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mobile text-input path — see the TerminalInputMode doc comment near the
  // top of this file for what each mode does and which keyboard bug it
  // exists for.
  //
  // Deliberately its own effect rather than a branch inside the
  // xterm-creation effect it used to live in: that one is keyed on [] and
  // never re-runs, so changing the mode only took effect after leaving and
  // re-entering the Terminal tab. That is a miserable loop when the whole
  // point of having modes is trying them against a real phone, so this one
  // is keyed on the mode and applies live. It relies on effects running in
  // declaration order — the creation effect above has already populated
  // termRef/containerRef by the time this first runs.
  useEffect(() => {
    const term = termRef.current
    const container = containerRef.current
    const textarea = term?.textarea
    if (!term || !container || !textarea) return

    const debug = inputDebugEnabled ? createInputDebugOverlay(container) : null
    const logEvent = (source: string, e: Event, value?: string) => {
      if (!debug) return
      const composing = 'isComposing' in e ? String((e as InputEvent).isComposing) : '-'
      const key = e instanceof KeyboardEvent ? ` key=${e.key}` : ''
      debug.log(`${source} ${e.type} ic=${composing}${key} v=${debugQuote(value ?? '')}`)
    }
    const emit = (bytes: string) => {
      debug?.log(`  -> ${debugQuote(bytes)}`)
      sendBytes(bytes)
    }

    // The workaround fields only exist on a touch device: a mouse/trackpad
    // never hits predictive buffering or the duplication bug, and swapping
    // out the element real keystrokes land on is not a risk worth taking
    // there. The debug overlay is still installed on desktop (attached to
    // xterm's own textarea below) so the same instrumentation can be read
    // in a desktop browser's device emulation.
    const isTouchDevice = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    const useField = isTouchDevice && inputMode !== 'native'

    if (!useField) {
      if (!debug) return
      const onNativeEvent = (e: Event) => logEvent('xterm', e, textarea.value)
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'keydown']) {
        textarea.addEventListener(type, onNativeEvent)
      }
      return () => {
        for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'keydown']) {
          textarea.removeEventListener(type, onNativeEvent)
        }
        debug.dispose()
      }
    }

    const field = inputMode === 'password' ? document.createElement('input') : document.createElement('textarea')
    if (field instanceof HTMLInputElement) {
      // The whole reason this mode exists: mobile keyboards only reliably
      // refuse to run prediction/composition on a real password input.
      field.type = 'password'
    } else {
      // Same element type xterm's own hidden helper uses, which is what
      // makes real IME composition attach here at all (a single-line
      // <input>, password or not, gets a different Android input type and
      // never fires compositionstart — measured 2026-09-03).
      field.rows = 1
    }
    // "off", not "new-password" - "new-password" is literally the hint
    // Chrome's own save-password heuristic watches for ("this field is for
    // creating a new password"), which turned out to make the unwanted
    // "저장하시겠습니까?" prompt worse, not better (confirmed live,
    // 2026-08-19). "off" plus a random name at least avoids matching common
    // field-name autofill heuristics; Chrome's no-form save-prompt
    // heuristic on mobile may still fire regardless of any attribute here.
    field.autocomplete = 'off'
    field.name = `terminal-input-${Math.random().toString(36).slice(2)}`
    field.setAttribute('autocorrect', 'off')
    field.setAttribute('autocapitalize', 'off')
    field.setAttribute('spellcheck', 'false')
    field.setAttribute('aria-hidden', 'true')
    field.tabIndex = -1
    // Same fully-invisible, off-screen placement as xterm's own hidden
    // textarea (xterm.css's .xterm-helper-textarea) — never meant to be
    // seen, only to hold real DOM/keyboard focus. Deliberately NOT
    // overlaying the terminal: a 2026-08-21 detour tried that (so a tap
    // would land on it directly with no focus redirect needed) and it
    // swallowed every touch before xterm's own mouse handling could see it,
    // breaking tmux pane selection, vim/htop mouse mode and Claude Code's
    // click-driven prompts. Staying off to the side keeps taps landing on
    // xterm first; the focus listener below is what redirects afterwards.
    Object.assign(field.style, {
      position: 'absolute',
      opacity: '0',
      left: '-9999em',
      top: '0',
      width: '0',
      height: '0',
      zIndex: '-5',
      border: '0',
      padding: '0',
      resize: 'none',
    })
    container.appendChild(field)
    mobileInputRef.current = field

    // One sentinel character is always kept in the field: deleting from an
    // already-empty field fires no input event at all (nothing for the
    // browser to report), which is how backspace silently stopped working
    // the first time this was written against a fully-cleared field.
    const ANCHOR = ' '
    let composing = false
    let cleanups: (() => void)[] = []

    if (inputMode === 'password') {
      // Length-based diff against a field that is reset back to ANCHOR after
      // every keystroke. Correct only because a password field suppresses
      // composition entirely, so every event really is a single plain
      // append or a single backspace — which is also exactly why Hangul
      // breaks in this mode.
      let baseline = ANCHOR
      field.value = ANCHOR
      field.setSelectionRange(ANCHOR.length, ANCHOR.length)

      // Resetting .value synchronously inside the input handler made fast
      // consecutive typing drop characters (confirmed live 2026-08-19):
      // mutating a focused field's value while Android's IME/webview bridge
      // is still processing that same keystroke stalls or desyncs it.
      // Deferring to the next animation frame lets it finish. The equality
      // check stops a stale reset from clobbering a value a newer keystroke
      // already moved past.
      let resetScheduled = false
      const scheduleReset = () => {
        if (resetScheduled) return
        resetScheduled = true
        const expected = field.value
        requestAnimationFrame(() => {
          resetScheduled = false
          if (field.value !== expected) return
          field.value = ANCHOR
          field.setSelectionRange(ANCHOR.length, ANCHOR.length)
          baseline = ANCHOR
        })
      }
      const processValueChange = () => {
        const value = field.value
        if (value.length > baseline.length) {
          emit(value.slice(baseline.length))
        } else if (value.length < baseline.length) {
          emit('\x7f'.repeat(baseline.length - value.length))
        }
        baseline = value
        scheduleReset()
      }
      const onCompositionStart = (e: Event) => {
        composing = true
        logEvent('field', e, field.value)
      }
      const onCompositionEnd = (e: Event) => {
        composing = false
        logEvent('field', e, field.value)
        processValueChange()
      }
      const onInput = (e: Event) => {
        logEvent('field', e, field.value)
        if (composing) return
        processValueChange()
      }
      const onKeyDown = (ev: Event) => {
        const e = ev as KeyboardEvent
        logEvent('field', e, field.value)
        // Enter never reaches the input-event handling above — a
        // single-line <input> doesn't insert a line break the way a
        // <textarea> does. Most mobile keyboards (Gboard included) do
        // dispatch a real keydown for Enter even though they don't for
        // ordinary character keys.
        if (e.key === 'Enter' && !composing) {
          e.preventDefault()
          emit('\r')
        }
      }
      field.addEventListener('compositionstart', onCompositionStart)
      field.addEventListener('compositionend', onCompositionEnd)
      field.addEventListener('input', onInput)
      field.addEventListener('keydown', onKeyDown)
      cleanups.push(() => {
        field.removeEventListener('compositionstart', onCompositionStart)
        field.removeEventListener('compositionend', onCompositionEnd)
        field.removeEventListener('input', onInput)
        field.removeEventListener('keydown', onKeyDown)
      })
    } else {
      // 'diff' mode. The field is left to accumulate the line being typed
      // instead of being truncated after every keystroke, and `sent` holds
      // exactly what has already been forwarded to the PTY from it. Each
      // change is reduced to a common-prefix diff, which is what makes this
      // immune to the duplication bug: a keyboard that re-emits or rewrites
      // a phrase it already committed produces a value equal to what was
      // already sent, so the diff is empty and nothing goes out. The
      // previous designs all truncated the field, which meant every such
      // re-emission looked like brand new text.
      let sent = ANCHOR
      field.value = ANCHOR
      field.setSelectionRange(ANCHOR.length, ANCHOR.length)

      // Re-anchoring has to be deferred for the same reason the password
      // mode's reset is (see above), and is only ever needed when the field
      // ran empty — i.e. after a backspace, never mid-burst.
      let reanchorScheduled = false
      const scheduleReanchor = () => {
        if (reanchorScheduled) return
        reanchorScheduled = true
        requestAnimationFrame(() => {
          reanchorScheduled = false
          if (composing || field.value !== '') return
          field.value = ANCHOR
          sent = ANCHOR
          field.setSelectionRange(ANCHOR.length, ANCHOR.length)
        })
      }

      // Resetting the field back to the anchor is the one thing that must
      // be done sparingly here, and it is worth being explicit about why:
      // the accumulated value IS the protection against duplication. Clear
      // it while the keyboard still considers that text its own, and the
      // keyboard's next rewrite of the phrase looks like brand new input
      // again — which is the bug, reintroduced. So there is deliberately no
      // idle timer: the field is only reset at moments the keyboard itself
      // has demonstrably let go of the text.
      //
      // Those moments are Enter (the line is over, see onKeyDown), blur
      // (the IME session ends with focus — this is precisely the "tap
      // outside, tap back in and it's fine for a while" behavior reported
      // from a Galaxy, made explicit rather than left to chance), and a
      // hard length cap so a session that somehow never hits either can't
      // grow without bound.
      const MAX_FIELD_LENGTH = 512
      const resetField = (reason: string) => {
        if (field.value === ANCHOR) return
        field.value = ANCHOR
        sent = ANCHOR
        field.setSelectionRange(ANCHOR.length, ANCHOR.length)
        debug?.log(`  (reset: ${reason})`)
      }

      const flush = () => {
        const value = field.value
        if (value === sent) return
        let common = 0
        const max = Math.min(value.length, sent.length)
        while (common < max && value[common] === sent[common]) common++
        const removed = sent.length - common
        const added = value.slice(common)
        sent = value
        if (removed > 0) emit('\x7f'.repeat(removed))
        if (added) {
          // A <textarea> can legitimately gain a real newline: not every
          // keyboard's Enter arrives as a keydown (onKeyDown below only
          // catches the ones that do), and some insert the break through a
          // plain input event instead. A PTY wants CR for that, and the
          // line is over either way, so translate and reset rather than
          // letting a stray '\n' accumulate in the field forever.
          const hadNewline = added.includes('\n')
          emit(hadNewline ? added.replace(/\n/g, '\r') : added)
          if (hadNewline) {
            resetField('newline')
            return
          }
        }
        if (value === '') scheduleReanchor()
        else if (!composing && value.length > MAX_FIELD_LENGTH) resetField('length cap')
      }
      const onCompositionStart = (e: Event) => {
        composing = true
        logEvent('field', e, field.value)
      }
      const onCompositionEnd = (e: Event) => {
        composing = false
        logEvent('field', e, field.value)
        flush()
      }
      const onInput = (e: Event) => {
        logEvent('field', e, field.value)
        // Nothing is sent mid-composition: the field holds a half-assembled
        // syllable, and forwarding it would be the jamo-by-jamo bug.
        if (composing) return
        flush()
      }
      const onKeyDown = (ev: Event) => {
        const e = ev as KeyboardEvent
        logEvent('field', e, field.value)
        if (e.key === 'Enter' && !composing) {
          // The line is over, so the field's accumulated copy of it is
          // meaningless from here on — reset rather than carrying it into
          // the next line's diffs.
          e.preventDefault()
          flush()
          emit('\r')
          resetField('enter')
        }
      }
      const onBlur = () => {
        composing = false
        resetField('blur')
      }
      field.addEventListener('compositionstart', onCompositionStart)
      field.addEventListener('compositionend', onCompositionEnd)
      field.addEventListener('input', onInput)
      field.addEventListener('keydown', onKeyDown)
      field.addEventListener('blur', onBlur)
      cleanups.push(() => {
        field.removeEventListener('compositionstart', onCompositionStart)
        field.removeEventListener('compositionend', onCompositionEnd)
        field.removeEventListener('input', onInput)
        field.removeEventListener('keydown', onKeyDown)
        field.removeEventListener('blur', onBlur)
      })
    }

    // Whenever xterm's own textarea would become focused — its internal
    // click-to-focus handler, or any keepFocus() call — steal focus back to
    // this field. That is what keeps every existing focus path on the
    // workaround field without special-casing each call site. (keepFocus
    // itself targets mobileInputRef directly; this listener covers every
    // OTHER path, above all xterm's own real click-to-focus.)
    const onTextareaFocus = () => {
      field.focus()
    }
    textarea.addEventListener('focus', onTextareaFocus)

    return () => {
      textarea.removeEventListener('focus', onTextareaFocus)
      for (const fn of cleanups) fn()
      cleanups = []
      field.remove()
      mobileInputRef.current = null
      debug?.dispose()
    }
  }, [inputMode, inputDebugEnabled, sendBytes])

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
      // A real connection is exactly what auto-reconnect's backoff exists
      // to reach - reset it so the *next* drop starts back at the fast 1s
      // retry instead of picking up wherever this one left off.
      reconnectAttemptRef.current = 0
      setPendingReconnect(null)
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
          // Session genuinely gone (e.g. Ctrl+D exited the shell) - nothing
          // to reconnect to, so fall back to Home instead of scheduling a
          // retry that would just silently resurrect it under the backend's
          // GetOrCreate-on-attach semantics (a "closed" tab quietly coming
          // back to life would be far more confusing than just losing it).
          setActiveSession(HOME_TAB_ID)
          return
        }
        // Still the active tab (this refetch itself is async, so the user
        // may have switched away or closed it while it was in flight) and
        // not confirmed dead - safe to schedule an automatic retry. Runs
        // even if the refetch itself failed (data === null, best-effort) -
        // a network hiccup isn't proof the session is gone, and the manual
        // 재연결 button always remains available regardless.
        if (autoReconnectEnabledRef.current && activeSessionRef.current === activeSession) {
          scheduleReconnect()
        }
      })
    }
    ws.onerror = () => {
      if (wsRef.current !== ws) return
      setState('disconnected')
      // No scheduleReconnect() call here: per the WebSocket spec an error is
      // always followed by a close event, and ws.onclose above is the one
      // that actually schedules a retry (after confirming via refreshSessions
      // the session isn't just plain gone) - scheduling from both would risk
      // a double-scheduled attempt.
    }
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data))
      }
    }

    return () => {
      ws.close()
      if (wsRef.current === ws) wsRef.current = null
      // Cancels any pending auto-reconnect timer for THIS attempt on every
      // teardown - unmount, switching to another tab/Home mid-backoff, or
      // this effect re-running because a scheduled retry just fired. The
      // last case is a harmless no-op (the timer already cleared itself
      // before bumping reconnectNonce) but the first two are exactly the
      // "don't keep retrying a tab the user left" guard this exists for.
      clearScheduledReconnect()
    }
  }, [activeSession, refreshSessions, reconnectNonce, fitIfVisible, scheduleReconnect, clearScheduledReconnect])

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

  // A touch device is the only place the touch-mode selector means
  // anything, and it also can't change while the page is open.
  const isCoarsePointer = useMemo(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
    [],
  )

  const copySelection = useCallback(async () => {
    const term = termRef.current
    if (!term || !term.hasSelection()) return
    const ok = await copyText(term.getSelection())
    setCopyState(ok ? 'copied' : 'failed')
    if (ok) term.clearSelection()
    window.setTimeout(() => setCopyState('idle'), 1500)
  }, [])

  // Reports the active session up so App.tsx can keep it in the URL - which
  // is what makes a reload land back on the same session, and a terminal tab
  // bookmarkable.
  useEffect(() => {
    onActiveSessionChange?.(activeSession === HOME_TAB_ID ? null : activeSession)
  }, [activeSession, onActiveSessionChange])

  // Restores ?session=<name> from the URL. Deliberately not routed through
  // the initialOpen path below: selecting an unknown name there would
  // silently *create* a new shell (sessions are created lazily by the WS
  // handshake, there is no separate create call), so a stale bookmark would
  // quietly spawn a process every time it was opened. Verify against the
  // real list first and fall back to the Home tab instead.
  useEffect(() => {
    if (!restoreSession) return
    let cancelled = false
    void refreshSessions().then((list) => {
      if (cancelled) return
      if (list?.some((s) => s.name === restoreSession)) setActiveSession(restoreSession)
      onRestoreSessionConsumed?.()
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // The session poll above already carries each session's live cwd (read
  // server-side from /proc/<pid>/cwd), so this tracks a plain `cd` within a
  // poll interval. Deliberately not the on-demand GET .../cwd that
  // openFileManagerHere uses: the "code로 열기" link needs a path at render
  // time to build a real <a href>, and only a real anchor gets middle-click
  // / ctrl-click "open in a new tab" from the browser for free.
  const activeCwd = useMemo(() => {
    if (activeSession === HOME_TAB_ID) return null
    return sessions.find((s) => s.name === activeSession)?.cwd ?? null
  }, [sessions, activeSession])

  const activeProjectPath = useMemo(
    () => (activeCwd ? projectPathForCwd(activeCwd, projectRoots) : null),
    [activeCwd, projectRoots],
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
        {/* The app's own mobile top bar is hidden while this tab is active
            (App.css's .app-shell-terminal rule) and its hamburger moves
            here, so the two bars become one row. A phone keyboard already
            eats most of the viewport; spending 3.6rem of what's left on a
            second bar carrying nothing but a menu button isn't worth it. */}
        {onToggleSidebar && (
          <button
            type="button"
            className="terminal-hamburger-btn"
            onClick={onToggleSidebar}
            aria-label="메뉴 열기"
          >
            <Menu size={18} />
          </button>
        )}
        <h1>Terminal</h1>
        <div className="terminal-header-actions">
          {isCoarsePointer && activeSession !== HOME_TAB_ID && (
            <div className="terminal-touch-mode" role="group" aria-label="터치 동작 모드">
              {TOUCH_MODE_OPTIONS.map(({ id, label, title, Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={`btn btn-small ${touchMode === id ? 'btn-primary' : 'btn-secondary'}`}
                  // Same reason TerminalControls' buttons do this: without
                  // it the tap moves DOM focus off the terminal, which
                  // dismisses the on-screen keyboard.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => changeTouchMode(id)}
                  title={title}
                  aria-pressed={touchMode === id}
                >
                  <Icon size={14} /> <span className="btn-label">{label}</span>
                </button>
              ))}
            </div>
          )}
          {hasSelection && activeSession !== HOME_TAB_ID && (
            <button
              type="button"
              className="btn btn-primary btn-small"
              onMouseDown={(e) => e.preventDefault()}
              onClick={copySelection}
              title="선택한 텍스트를 클립보드로 복사"
            >
              <Copy size={14} />{' '}
              <span className="btn-label">
                {copyState === 'copied' ? '복사됨' : copyState === 'failed' ? '복사 실패' : '복사'}
              </span>
            </button>
          )}
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
          {/* A real <a href>, not a button with an onClick: that is what makes
              middle-click / ctrl-click open a new tab (browser default, no
              handler needed), and target="_top" breaks out of the iframe when
              webmanager is embedded. Do not "clean this up" into an onClick.
              Falls back to window.location.origin when codeServerUrl is unset,
              same as the Projects tab does. */}
          {activeCwd && (
            <a
              className="btn btn-secondary btn-small"
              href={`${codeServerUrl || window.location.origin}/?folder=${encodeURIComponent(activeCwd)}`}
              target="_top"
              rel="noopener"
              title={`현재 디렉토리를 code에서 열기 (${activeCwd}) — 가운데 클릭하면 새 탭`}
            >
              <Code size={14} /> <span className="btn-label">code로 열기</span>
            </a>
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
        showZoomGroup={!controlBarEnabled}
        onZoom={zoom}
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
        {/* Distinguishes "waiting on a scheduled auto-reconnect" from a
            plain idle disconnect (autoReconnectEnabled off, or Home) - a
            silent identical overlay in the former case reads as broken
            ("why isn't it retrying?") when it actually is. The manual
            button still works either way; while a retry is pending it also
            jumps the queue (reconnect() resets the backoff), so it's never
            just a duplicate of waiting. */}
        {activeSession !== HOME_TAB_ID && state === 'disconnected' && (
          <div className="terminal-disconnect-overlay">
            <div className="terminal-disconnect-card">
              {pendingReconnect ? (
                <>
                  <p>재연결 중... ({pendingReconnect.attempt}번째 시도)</p>
                  <p className="terminal-disconnect-subtext">
                    {retrySecondsLeft > 0 ? `${retrySecondsLeft}초 후 다시 시도` : '지금 시도 중...'}
                  </p>
                </>
              ) : (
                <p>연결이 해제되었습니다{autoReconnectEnabled ? '' : ' (자동 재연결 꺼짐)'}</p>
              )}
              <button type="button" className="btn btn-primary btn-small" onClick={reconnect}>
                {pendingReconnect ? '지금 재연결' : '재연결'}
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
        {activeSession !== HOME_TAB_ID && controlBarEnabled && (
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
        inputMode={inputMode}
        onChangeInputMode={changeInputMode}
        inputDebugEnabled={inputDebugEnabled}
        onToggleInputDebug={toggleInputDebug}
        altScreenTouchScrollEnabled={altScreenTouchScrollEnabled}
        onToggleAltScreenTouchScroll={toggleAltScreenTouchScroll}
        autoReconnectEnabled={autoReconnectEnabled}
        onToggleAutoReconnect={toggleAutoReconnect}
        controlBarEnabled={controlBarEnabled}
        onToggleControlBarEnabled={toggleControlBarEnabled}
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
