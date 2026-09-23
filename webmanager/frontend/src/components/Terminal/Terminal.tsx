import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import {
  Code,
  Copy,
  FolderKanban,
  FolderOpen,
  Hand,
  Menu,
  MousePointer2,
  Pin,
  Settings,
  TextSelect,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import '../common/common.css'
import { copyText } from '../../utils/clipboard'
import { api, apiUrl, errorMessage, ApiError, onAuthStatusChange, requestUnlock } from '../../api/client'
import type {
  AuthStatus,
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
import { onHostMessage, postToHost, reportEmbedState } from '../../embed'
import { registerTerminalLinks } from './terminalLinks'
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

// The PTY size last sent on each socket (see sendResize).
const sentSizes = new WeakMap<WebSocket, string>()

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
// webmanager/.claude/archive/terminal-mobile-input-touch-plan-done.md.
//
// Per-device localStorage like fontSize above, not backend-persisted. Only
// consulted on a touch device (pointer: coarse) - a mouse/trackpad never
// hits any of these keyboard bugs and always uses xterm's own textarea.
export type TerminalInputMode = 'native' | 'password' | 'diff'

const INPUT_MODE_KEY = 'webmanager.terminal.inputMode'

// The old boolean key ('webmanager.terminal.mobileInputWorkaround') is
// deliberately NOT migrated: every value it could hold selected a mode that
// is known broken on a real device, so carrying that choice forward would
// only preserve a bug. Repo owner's call, 2026-09-06.
function loadInputMode(): TerminalInputMode {
  try {
    const stored = localStorage.getItem(INPUT_MODE_KEY)
    if (stored === 'native' || stored === 'password' || stored === 'diff') return stored
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

// How much visualViewport inset counts as "the on-screen keyboard is up".
// Not simply `> 0`: the inset is a float and a desktop browser reports small
// sub-pixel values (0.45px measured 2026-09-06) from ordinary rounding, so a
// zero comparison leaks. Any real keyboard covers hundreds of pixels, so
// anything under this is noise or a browser UI bar, never a keyboard.
const KEYBOARD_OPEN_MIN_INSET = 80

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
  { id: 'mouse', label: '마우스', title: '드래그(또는 꾹 누른 뒤 드래그)를 마우스 입력으로 앱에 전달합니다 (tmux/vim/claude 등)', Icon: MousePointer2 },
  { id: 'select', label: '선택', title: '드래그하거나 꾹 누른 뒤 드래그하면 텍스트가 선택됩니다 (복사용)', Icon: TextSelect },
]

// Debug overlay for the input path (INPUT_DEBUG_KEY above). Built
// imperatively rather than as a React node on purpose: it updates on every
// keystroke, and pushing that through component state would re-render the
// whole terminal section on each one.
//
// Two different limits. Only the last few lines are *shown*, because the
// overlay sits on top of the terminal and must not swallow it - but the
// copy button hands over a much longer history, since the useful report is
// the whole sequence that went wrong, not the tail of it. A phone
// screenshot can't be pasted anywhere as text either, which is why that
// button exists at all (repo owner, 2026-09-06: "실측한걸 보내줄 수가 없네").
const INPUT_DEBUG_DISPLAY_LINES = 12
const INPUT_DEBUG_HISTORY_LINES = 400

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

function createInputDebugOverlay(
  container: HTMLElement,
  meta: () => string,
): { log: (line: string) => void; dispose: () => void } {
  const el = document.createElement('div')
  el.className = 'terminal-input-debug'

  const bar = document.createElement('div')
  bar.className = 'terminal-input-debug-bar'
  const title = document.createElement('span')
  title.textContent = '입력 디버그'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'terminal-input-debug-btn'
  copy.textContent = '복사'
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'terminal-input-debug-btn'
  clear.textContent = '지우기'
  bar.append(title, copy, clear)

  const body = document.createElement('div')
  body.className = 'terminal-input-debug-log'

  // Shown only when the clipboard write fails. It can, and on this
  // deployment it is the likely case rather than the exotic one: the page is
  // usually served over plain http, where navigator.clipboard doesn't exist
  // at all, leaving document.execCommand('copy') — which is refused unless
  // the browser considers the click a genuine user activation. Rather than
  // dead-end at "복사 실패", drop the whole report into a real, selectable
  // textarea with everything already selected, so the system's own
  // copy affordance finishes the job. The point of this overlay is getting
  // the measurement off the device; it must not have a path where that is
  // impossible.
  const fallback = document.createElement('textarea')
  fallback.className = 'terminal-input-debug-fallback'
  fallback.spellcheck = false
  fallback.hidden = true

  el.append(bar, body, fallback)
  container.appendChild(el)

  const lines: string[] = []
  const render = () => {
    body.textContent = lines.slice(-INPUT_DEBUG_DISPLAY_LINES).join('\n')
  }

  // Tapping either button must not move focus off the input field: that
  // would close the keyboard and fire a blur, i.e. change the very thing
  // being measured. Same preventDefault-on-mousedown trick TerminalControls
  // uses for its own buttons.
  const preventFocusSteal = (e: Event) => e.preventDefault()
  copy.addEventListener('mousedown', preventFocusSteal)
  clear.addEventListener('mousedown', preventFocusSteal)

  let resetLabel = 0
  const onCopy = () => {
    const text = `${meta()}\n${lines.join('\n')}`
    void copyText(text).then((ok) => {
      if (ok) {
        fallback.hidden = true
        copy.textContent = '복사됨'
        window.clearTimeout(resetLabel)
        resetLabel = window.setTimeout(() => {
          copy.textContent = '복사'
        }, 1500)
        return
      }
      fallback.value = text
      fallback.hidden = false
      fallback.focus()
      fallback.select()
      copy.textContent = '길게 눌러 복사'
    })
  }
  const onClear = () => {
    lines.length = 0
    fallback.hidden = true
    copy.textContent = '복사'
    render()
  }
  copy.addEventListener('click', onCopy)
  clear.addEventListener('click', onClear)

  return {
    log(line: string) {
      lines.push(line)
      if (lines.length > INPUT_DEBUG_HISTORY_LINES) lines.shift()
      render()
    },
    dispose() {
      window.clearTimeout(resetLabel)
      copy.removeEventListener('mousedown', preventFocusSteal)
      clear.removeEventListener('mousedown', preventFocusSteal)
      copy.removeEventListener('click', onCopy)
      clear.removeEventListener('click', onClear)
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

// Desktop counterpart of the alt-screen touch forwarding above, for a real
// mouse wheel or trackpad. xterm.js's own alt-screen wheel handler
// (CoreBrowserTerminal, confirmed by reading node_modules/@xterm/xterm)
// converts wheel input into arrow keys, but discards magnitude: it checks
// only whether its internal line accumulator crossed zero and then sends
// exactly one Up/Down keystroke, no matter how many lines that event's delta
// actually represented — any accumulated amount beyond one line is thrown
// away every single event. In the normal buffer this doesn't matter (a
// separate, unrelated widget scrolls the viewport proportionally to the
// full delta), but for a full-screen app it means a fast flick or a
// trackpad's inertial coast phase (many small-delta events, each still
// capped at one line) moves the app's own scroll far less than the physical
// distance suggests — exactly the "have to keep scrolling by hand" pain
// this toggle exists to fix.
//
// The fix mirrors the touch-forwarding approach above rather than
// reimplementing xterm's key-conversion logic: intercept the real wheel
// event via attachCustomWheelEventHandler, accumulate its delta ourselves
// (without the 1-line-per-event cap), and replay it as that many single-line
// synthetic wheel events through the exact same dispatchWheel() xterm's own
// listener already converts correctly — see the xterm-creation effect.
// Off switch kept for the same reason as every other toggle in this group:
// wheel/trackpad delta reporting is notoriously inconsistent across
// OS/browser combinations, and a full-screen app is free to interpret
// repeated arrow keys however it wants.
const ALT_SCREEN_WHEEL_SCROLL_KEY = 'webmanager.terminal.altScreenWheelScroll'

function loadAltScreenWheelScrollEnabled(): boolean {
  try {
    return localStorage.getItem(ALT_SCREEN_WHEEL_SCROLL_KEY) !== '0'
  } catch {
    return true
  }
}

function saveAltScreenWheelScrollEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(ALT_SCREEN_WHEEL_SCROLL_KEY)
    else localStorage.setItem(ALT_SCREEN_WHEEL_SCROLL_KEY, '0')
  } catch {
    // localStorage unavailable (e.g. private browsing) - the toggle just won't persist
  }
}

// Momentum ("fling") scrolling: after a touch-drag is released, keep
// scrolling at the speed the finger let go at and decay to a stop, the way
// Termux and every native Android list behave. On by default - a 1:1 drag
// with a hard stop is the odd one out on a phone, not the safe choice.
// Read through a ref like altScreenTouchScrollEnabled so it applies
// immediately rather than on the next remount.
//
// Where a scroll step is *input* to the running application, momentum is
// only allowed when that input is a mouse-wheel report. An app that turned
// mouse tracking on (vim with mouse=a, tmux) asked for wheel events and
// treats them as scrolling — the same thing a desktop trackpad's inertial
// coast already sends it. An alternate-screen app *without* mouse tracking
// gets arrow keys instead, and a fling there would fire dozens of arrow
// keys into it after the finger already left the screen, so no momentum.
// (The first version refused momentum for both; vim with mouse=a was the
// device report that showed the line was drawn in the wrong place.)
const TOUCH_MOMENTUM_KEY = 'webmanager.terminal.touchMomentum'

function loadTouchMomentumEnabled(): boolean {
  try {
    return localStorage.getItem(TOUCH_MOMENTUM_KEY) !== '0'
  } catch {
    return true
  }
}

// Live composition: forward what the IME is composing on every input event
// instead of waiting for compositionend. On by default, because once the
// field got a real box (see the mobile-input effect) Samsung's keyboard
// started holding a composing region for a whole *word* — so the
// commit-at-compositionend design showed nothing at all until the space bar
// ("안녕하세요 치면 아무것도 안 보이는데, 띄어쓰기를 넣으면 입력이 넘어가",
// 2026-09-14). The prefix diff is what makes forwarding a half-assembled
// syllable safe: ㅇ → 아 → 안 goes out as "ㅇ", "\x7f아", "\x7f안", so the
// terminal shows composition happening instead of an invisible buffer, and a
// keyboard rewriting the whole word only resends what actually changed. The
// toggle is the escape hatch back to the commit-at-end behavior for an app
// that handles backspace badly.
const LIVE_COMPOSITION_KEY = 'webmanager.terminal.liveComposition'

function loadLiveCompositionEnabled(): boolean {
  try {
    return localStorage.getItem(LIVE_COMPOSITION_KEY) !== '0'
  } catch {
    return true
  }
}

function saveLiveCompositionEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(LIVE_COMPOSITION_KEY)
    else localStorage.setItem(LIVE_COMPOSITION_KEY, '0')
  } catch {
    // localStorage unavailable (e.g. private browsing) - the toggle just won't persist
  }
}

// Refocus at each word boundary: blur and immediately refocus the field
// after a space, so the keyboard drops its association with the previous
// word (stale suggestions, a predictive buffer that might re-emit it). The
// repo owner's original design for this bug. Not needed for correctness any
// more — the prefix diff already makes a re-emitted word produce no bytes —
// but it fully clears the suggestion bar after a space, which is the
// behavior the repo owner wanted. On by default since 2026-09-14, once a
// Galaxy showed no keyboard flicker from it. The toggle stays because a
// programmatic focus() outside a real user gesture can still close the
// on-screen keyboard on other Android builds.
const REFOCUS_ON_WORD_KEY = 'webmanager.terminal.refocusOnWord'

function loadRefocusOnWordEnabled(): boolean {
  try {
    return localStorage.getItem(REFOCUS_ON_WORD_KEY) !== '0'
  } catch {
    return true
  }
}

function saveRefocusOnWordEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(REFOCUS_ON_WORD_KEY)
    else localStorage.setItem(REFOCUS_ON_WORD_KEY, '0')
  } catch {
    // localStorage unavailable (e.g. private browsing) - the toggle just won't persist
  }
}

function saveTouchMomentumEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(TOUCH_MOMENTUM_KEY)
    else localStorage.setItem(TOUCH_MOMENTUM_KEY, '0')
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
  onOpenCommit,
  onToggleSidebar,
  restoreSession,
  onRestoreSessionConsumed,
  onActiveSessionChange,
  embedSession,
  embedCwd,
  embedCommand,
}: {
  initialOpen?: { cwd?: string; label?: string; command?: string; session?: string } | null
  onInitialOpenConsumed?: () => void
  onOpenFileManager?: (path: string) => void
  // Opens the project's info dialog over the terminal (App.tsx's
  // openProjectInfo) rather than navigating to the Projects tab.
  onOpenProject?: (path: string) => void
  // A commit hash ctrl+clicked in the terminal, in the session's project.
  onOpenCommit?: (projectPath: string, hash: string) => void
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
  // Embed mode (code-server extension view, see embed.ts). embedSession set
  // means this view *is* that one session: no tab bar, connected straight
  // away (creating it in embedCwd, running embedCommand, if it doesn't
  // exist), and a session that ends shows an "ended" card rather than
  // falling back to Home. embedCwd alone (an unbound panel slot showing
  // Home) is the default directory for new sessions.
  embedSession?: string | null
  embedCwd?: string
  embedCommand?: string
} = {}) {
  const embedded = embedSession !== undefined
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
  // The input debug overlay's log function while that overlay exists, so code
  // outside the mobile-input effect (resize, momentum) writes into the same
  // copyable log rather than needing an overlay of its own.
  const debugLogRef = useRef<((line: string) => void) | null>(null)
  // performance.now() deadline before which a focus redirect must not open the
  // on-screen keyboard — written by the touch handler during drags and momentum
  // (holdFocus there), read by the mobile-input effect's focus redirect.
  const suppressFocusUntilRef = useRef(0)
  // Bytes received from the PTY since the last row-count change, while a
  // resize is being watched (see the repaint nudge in the ResizeObserver) —
  // tells "the application redrew and xterm didn't show it" apart from
  // "nothing came back at all" in a copied debug log.
  const outputProbeRef = useRef<{ bytes: number } | null>(null)

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
  const [touchMomentumEnabled, setTouchMomentumEnabled] = useState<boolean>(loadTouchMomentumEnabled)
  const touchMomentumRef = useRef(touchMomentumEnabled)
  touchMomentumRef.current = touchMomentumEnabled
  // Read through refs by the mobile-input effect rather than listed in its
  // deps: that effect creates the input field, and re-running it would tear
  // the field down and rebuild it — dismissing the keyboard mid-sentence
  // just because a setting was flipped.
  const [liveCompositionEnabled, setLiveCompositionEnabled] = useState<boolean>(loadLiveCompositionEnabled)
  const liveCompositionRef = useRef(liveCompositionEnabled)
  liveCompositionRef.current = liveCompositionEnabled
  const [refocusOnWordEnabled, setRefocusOnWordEnabled] = useState<boolean>(loadRefocusOnWordEnabled)
  const refocusOnWordRef = useRef(refocusOnWordEnabled)
  refocusOnWordRef.current = refocusOnWordEnabled
  const [altScreenTouchScrollEnabled, setAltScreenTouchScrollEnabled] = useState<boolean>(loadAltScreenTouchScrollEnabled)
  // The touch handler is installed once with the xterm instance, so it
  // reads the toggle through a ref rather than closing over the state.
  const altScreenScrollRef = useRef(altScreenTouchScrollEnabled)
  altScreenScrollRef.current = altScreenTouchScrollEnabled
  const [altScreenWheelScrollEnabled, setAltScreenWheelScrollEnabled] = useState<boolean>(loadAltScreenWheelScrollEnabled)
  // Same "listener installed once with the xterm instance" reasoning as
  // altScreenScrollRef right above, this time for the real wheel handler.
  const altScreenWheelScrollRef = useRef(altScreenWheelScrollEnabled)
  altScreenWheelScrollRef.current = altScreenWheelScrollEnabled
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
  const [activeSession, setActiveSession] = useState<string>(() => embedSession || HOME_TAB_ID)
  // Embed only: the session this view shows ended (its shell exited).
  const [sessionEnded, setSessionEnded] = useState(false)
  // Read by the foreground/focus handler, which would otherwise see a plain
  // 'disconnected' state behind the ended card and reconnect - i.e. quietly
  // start a new shell under the card the moment the view got focus.
  const sessionEndedRef = useRef(false)
  sessionEndedRef.current = sessionEnded
  // Embed only: where to recreate the session if it has to be - its live
  // cwd as last seen, else the directory the view was opened with.
  const embedCwdRef = useRef(embedCwd)
  const activeProjectPathRef = useRef<string | null>(null)
  const onOpenCommitRef = useRef(onOpenCommit)
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
  const pendingCreateOptionsRef = useRef<Map<string, { cwd?: string; command?: string }>>(
    new Map(embedSession ? [[embedSession, { cwd: embedCwd, command: embedCommand }]] : []),
  )
  const keyboardInset = useKeyboardInset()
  // Mirrored for keepFocus, which runs inside event handlers created before
  // the current render.
  const keyboardInsetRef = useRef(keyboardInset)
  keyboardInsetRef.current = keyboardInset
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
  // The last list refreshSessions saw, by name - only read to recognize a
  // rename made somewhere else (see refreshSessions).
  const lastSessionsRef = useRef<TerminalSessionInfo[]>([])
  const refreshSessions = useCallback(async () => {
    try {
      const data = await api.get<TerminalSessionInfo[]>('/terminal/sessions')
      // Follow a rename made by another client (another browser tab, the
      // code-server widget) on the session this one is showing. Nothing
      // tells this client about it - the backend re-keys the same session
      // in place and this connection keeps working - so the next list
      // simply lacks the active name, and TerminalTabs' ensureActiveIncluded
      // then kept the old name alive as a ghost tab next to the new one
      // until the user clicked the new one. The shell's pid is what stays
      // the same across a rename. activeSessionRef is updated right here
      // rather than waiting for its effect, so a ws.onclose that consumes
      // this same list doesn't mistake the rename for the session dying.
      const current = activeSessionRef.current
      if (current !== HOME_TAB_ID && !data.some((s) => s.name === current)) {
        const pid = lastSessionsRef.current.find((s) => s.name === current)?.pid
        const moved = pid ? data.find((s) => s.pid === pid) : undefined
        if (moved) {
          activeSessionRef.current = moved.name
          setActiveSession(moved.name)
        }
      }
      lastSessionsRef.current = data
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
  // Sends an explicit size rather than whatever the terminal currently is —
  // the repaint nudge in the ResizeObserver has to put the PTY one row short of
  // the terminal for a moment. Logs sent vs dropped, because a resize silently
  // skipped on a socket that isn't open is otherwise indistinguishable from an
  // application that ignored its SIGWINCH.
  const sendSize = useCallback((cols: number, rows: number, why: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      sentSizes.set(ws, `${cols}x${rows}`)
      debugLogRef.current?.(`  (pty size ${cols}x${rows} sent: ${why})`)
    } else {
      debugLogRef.current?.(`  (pty size ${cols}x${rows} dropped, socket ${ws ? ws.readyState : 'none'}: ${why})`)
    }
  }, [])

  // Only when the grid actually changed: every SIGWINCH makes the shell or a
  // full-screen app repaint, and a pixel-level resize often lands on the
  // same cols/rows. Keyed per socket, so a fresh connection always sends.
  const sendResize = useCallback(() => {
    const term = termRef.current
    const ws = wsRef.current
    if (!term) return
    if (ws && sentSizes.get(ws) === `${term.cols}x${term.rows}`) return
    sendSize(term.cols, term.rows, 'resize')
  }, [sendSize])

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

  // The on-screen keyboard's open/close animation arrives as a burst of
  // keyboardInset changes, and the ResizeObserver refits on whichever
  // intermediate sizes it happens to see — nothing guarantees the last size
  // the PTY hears about is the settled one. Reported from a device as vim's
  // "-- INSERT --" line repeated down the screen after the keyboard closed,
  // fixed only by zooming (which forces its own resize). Refit and resend
  // once more after the animation has had time to finish, so the final state
  // always lands. Costs nothing when everything already matched: the kernel
  // does not deliver SIGWINCH for a window size that didn't change.
  useEffect(() => {
    debugLogRef.current?.(`  (keyboard inset ${Math.round(keyboardInset)}px)`)
    const timers = [250, 600].map((ms) =>
      window.setTimeout(() => {
        fitIfVisible()
        sendResize()
        const term = termRef.current
        debugLogRef.current?.(`  (settle fit +${ms}ms: ${term?.cols}x${term?.rows})`)
      }, ms),
    )
    return () => {
      for (const t of timers) window.clearTimeout(t)
    }
  }, [keyboardInset, fitIfVisible, sendResize])

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
  // The password gate is locked (expired, or the prompt was dismissed), so
  // the WebSocket upgrade is answered 401 before it ever becomes a socket -
  // which reaches the browser as a plain abnormal close, indistinguishable
  // from a network blip. Retrying that can only fail again, every time, for
  // as long as it stays locked (the backoff caps at 30s, so it never stops
  // on its own), and each attempt pops the password prompt once more. So it
  // is detected and retries stop until the gate is open again.
  const [lockedOut, setLockedOut] = useState(false)
  const lockedOutRef = useRef(false)
  const setLockedOutState = useCallback((value: boolean) => {
    lockedOutRef.current = value
    setLockedOut(value)
  }, [])

  // GET /auth/status is ungated, so asking this never prompts by itself.
  // A failed check counts as "not locked": a network problem is exactly the
  // case auto-reconnect exists for.
  const gateLocked = useCallback(async () => {
    try {
      const status = await api.get<AuthStatus>('/auth/status')
      return Boolean(status.required && !status.unlocked)
    } catch {
      return false
    }
  }, [])

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
    if (lockedOutRef.current) return
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
    setLockedOutState(false)
    reconnectAttemptRef.current = 0
    setReconnectNonce((n) => n + 1)
  }, [clearScheduledReconnect, setLockedOutState])

  // Asks for the password and reconnects once it's given. Also what the
  // overlay's button does while locked out.
  const unlockAndReconnect = useCallback(async () => {
    try {
      await requestUnlock()
    } catch {
      // dismissed - stay locked out rather than retrying into another 401
      return
    }
    reconnect()
  }, [reconnect])

  // Unlocking anywhere else (the sidebar's lock indicator, a fingerprint, a
  // gated action in another tab - api/client.ts broadcasts it) resumes this
  // terminal on its own, so a session isn't left sitting behind an overlay
  // after the user has already dealt with the lock.
  useEffect(
    () =>
      onAuthStatusChange(() => {
        if (!lockedOutRef.current) return
        void gateLocked().then((locked) => {
          if (!locked) reconnect()
        })
      }),
    [gateLocked, reconnect],
  )

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
      if (stateRef.current === 'disconnected' && autoReconnectEnabledRef.current && !sessionEndedRef.current) reconnect()
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
    // "Already the active element" is not enough on Android: dismissing the
    // keyboard with the system Back button leaves the field focused, so a
    // .focus() call from a toolbar tap opens it right back up. Measured on a
    // real device 2026-09-06 — the guard above alone did not fix the
    // reported "확대 축소만 하려는데도 키보드가 열려서".
    //
    // visualViewport's inset is the only signal that actually distinguishes
    // an open keyboard from a closed one (see useKeyboardInset). Zero inset
    // therefore means "do nothing": on a phone that is the closed-keyboard
    // case this exists to skip, and on a desktop, where the inset is always
    // zero, re-focusing an element that already has focus was a no-op
    // anyway.
    if (keyboardInsetRef.current < KEYBOARD_OPEN_MIN_INSET) return
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

  const toggleTouchMomentum = useCallback((enabled: boolean) => {
    saveTouchMomentumEnabled(enabled)
    setTouchMomentumEnabled(enabled)
  }, [])

  const toggleLiveComposition = useCallback((enabled: boolean) => {
    saveLiveCompositionEnabled(enabled)
    setLiveCompositionEnabled(enabled)
  }, [])

  const toggleRefocusOnWord = useCallback((enabled: boolean) => {
    saveRefocusOnWordEnabled(enabled)
    setRefocusOnWordEnabled(enabled)
  }, [])

  const toggleAltScreenTouchScroll = useCallback((enabled: boolean) => {
    saveAltScreenTouchScrollEnabled(enabled)
    setAltScreenTouchScrollEnabled(enabled)
  }, [])

  const toggleAltScreenWheelScroll = useCallback((enabled: boolean) => {
    saveAltScreenWheelScrollEnabled(enabled)
    setAltScreenWheelScrollEnabled(enabled)
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
    // Ctrl+click URLs, commit hashes and (in code-server) file paths -
    // disposed with term.
    registerTerminalLinks(term, {
      embedded,
      getCwd: () => embedCwdRef.current,
      getProject: () => activeProjectPathRef.current,
      openCommit: (project, hash) => onOpenCommitRef.current?.(project, hash),
    })
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
    // Momentum tuning. Velocity is carried in px/ms because that is what the
    // touch events give directly; converting to lines happens per frame, so
    // a font-size change mid-fling can't desync it.
    //
    // FRICTION is per 16.67ms (one frame at 60Hz) and normalized by the real
    // frame time below, so a 120Hz screen decelerates over the same wall
    // clock rather than twice as fast. 0.94 lands a hard flick in a bit under
    // a second, which matches how far a Termux fling carries.
    //
    // MIN_VELOCITY is where coasting stops: below ~0.04 px/ms (40 px/s) the
    // movement reads as a stutter rather than motion, and continuing costs a
    // rAF callback per frame for nothing.
    //
    // MAX_FRAME_MS clamps dt so a tab that was backgrounded mid-fling
    // resumes rather than teleporting: requestAnimationFrame stops firing
    // while hidden, so the first frame back can otherwise carry a multi-second
    // dt straight into the scroll distance.
    const MOMENTUM_FRICTION = 0.94
    const MOMENTUM_MIN_VELOCITY = 0.04
    const MOMENTUM_MAX_FRAME_MS = 50
    // Smoothing for the release velocity. A raw last-two-points delta is very
    // noisy on a touchscreen (one 2ms sample with a 1px jitter reads as a
    // violent flick), so the tracked value is an exponential moving average
    // weighted toward recent samples.
    const MOMENTUM_VELOCITY_SMOOTHING = 0.7
    let velocity = 0
    let velocitySeeded = false
    let lastMoveAt = 0
    let momentumFrame = 0
    let startX = 0
    let startY = 0
    let lastX = 0
    let lastY = 0
    let dragging = false
    // Set once a 'mouse'/'select'-mode drag has synthesized its mousedown,
    // so touchmove keeps feeding the same drag and touchend can close it.
    let pointerDragging = false
    let lineRemainder = 0
    // Press-and-hold starts a 'mouse'/'select' drag without any movement,
    // the way native text selection works on a phone. Before this, a drag
    // only began once the finger moved past TOUCH_SCROLL_THRESHOLD, so
    // "long-press here, then drag" — the gesture people actually reach for —
    // sat idle until Android's own long-press gesture claimed the touch
    // (reported: it only worked after tapping first, "약간 애매한 느낌").
    const LONG_PRESS_MS = 350
    let longPressTimer = 0
    // Keeps focus redirects from opening the on-screen keyboard while a touch
    // drag or a momentum coast is under way, and for a moment after. xterm
    // focuses its own textarea from places a synthetic mousedown can't cover:
    // on any platform whose navigator.platform contains "Linux" — which
    // Android does — every selection refresh runs
    // `this._onLinuxMouseSelection.fire(...)`, whose handler is
    // `this.textarea.value = e, this.textarea.focus()`, so a selection drag
    // opened the keyboard mid-drag regardless of the mousedown shadowing in
    // dispatchMouse. And the device reported the keyboard opening during
    // plain scroll-mode flicks too, source not yet identified. The
    // mobile-input effect's focus redirect consults this window and refuses
    // to open the keyboard inside it (see onTextareaFocus there).
    const holdFocus = (ms: number) => {
      suppressFocusUntilRef.current = Math.max(suppressFocusUntilRef.current, performance.now() + ms)
    }
    const clearLongPress = () => {
      if (!longPressTimer) return
      window.clearTimeout(longPressTimer)
      longPressTimer = 0
    }
    // For the contextmenu guard below: whether a touch sequence is in
    // progress or only just finished.
    let touchActive = false
    let lastTouchEndAt = 0
    const onTouchStart = (e: TouchEvent) => {
      // Any touch stops a fling in progress, including a second finger or a
      // plain tap - "tap to catch the scroll" is what every native list does,
      // and letting a tap land on the terminal while it is still moving would
      // position the cursor somewhere the user never aimed at.
      cancelMomentum()
      clearLongPress()
      touchActive = true
      if (e.touches.length !== 1) return
      velocity = 0
      velocitySeeded = false
      lastMoveAt = 0
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      lastX = startX
      lastY = startY
      dragging = false
      pointerDragging = false
      lineRemainder = 0
      if (touchModeRef.current !== 'scroll') {
        longPressTimer = window.setTimeout(() => {
          longPressTimer = 0
          if (pointerDragging) return
          beginPointerDrag(startX, startY)
          // The one cue that the hold registered — without it there is no way
          // to tell "held long enough" from "not yet" before moving.
          navigator.vibrate?.(12)
        }, LONG_PRESS_MS)
      }
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
    // Marks a synthetic single-line event so the real-wheel handler below
    // (attachCustomWheelEventHandler) recognizes and ignores it instead of
    // accumulating it again — without this, every event this function
    // dispatches would loop straight back into that handler.
    const SYNTHETIC_WHEEL_TAG = '__webmanagerSyntheticWheel'
    const dispatchWheel = (lines: number, clientX: number, clientY: number) => {
      const direction = lines > 0 ? 1 : -1
      const steps = Math.min(Math.abs(lines), MAX_WHEEL_STEPS_PER_MOVE)
      const target = wheelTarget()
      for (let i = 0; i < steps; i++) {
        const synthetic = new WheelEvent('wheel', {
          deltaY: direction,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        })
        ;(synthetic as unknown as Record<string, boolean>)[SYNTHETIC_WHEEL_TAG] = true
        target.dispatchEvent(synthetic)
      }
    }
    // 'mouse'/'select' touch modes: replay the drag as the mouse events a
    // desktop would have produced, and let xterm decide what they mean —
    // the same "hand the decision back to xterm" approach dispatchWheel
    // above takes, for the same reason (reimplementing xterm's mouse
    // protocol/selection logic here would immediately drift from it).
    //
    // shiftKey is NOT simply "select mode" — that was the first design and a
    // real device proved it wrong (reported as "내가 터치한 곳부터 선택이
    //시작되지 않고 이상한 곳부터 선택된다"). xterm's own mousedown handler
    // reads:
    //
    //     this._enabled && e.shiftKey ? this._handleIncrementalClick(e)
    //                                 : this._handleSingleClick(e)
    //     _handleIncrementalClick(e) {
    //       this._model.selectionStart && (this._model.selectionEnd = ...)
    //     }
    //
    // so shift means "extend the existing selection from its old anchor",
    // never "start a new one here". Only the shift-less path sets a fresh
    // anchor at the pointer. Shift is therefore used for exactly one thing —
    // getting past the early return that would otherwise hand the event to
    // an application with mouse tracking on — and only when that is actually
    // the situation.
    //
    // Events are dispatched on .xterm-screen with bubbles:true because
    // xterm's selection service starts from a mousedown there and then
    // listens on the document for the rest of the drag.
    const screenRect = () => wheelTarget().getBoundingClientRect()
    // xterm auto-scrolls while a drag sits outside the screen element
    // (_dragScrollAmount), which on touch runs away the moment a finger
    // crosses the bottom edge — reported as "선택하려 하면 최하단으로
    // 스크롤된다". Keeping synthesized coordinates just inside the box means
    // that timer never arms, and a finger dragged past the edge simply
    // selects to the edge.
    const clampToScreen = (clientX: number, clientY: number): [number, number] => {
      const r = screenRect()
      return [
        Math.min(Math.max(clientX, r.left + 1), r.right - 1),
        Math.min(Math.max(clientY, r.top + 1), r.bottom - 1),
      ]
    }
    const dispatchMouse = (type: 'mousedown' | 'mousemove' | 'mouseup', clientX: number, clientY: number, forceSelection: boolean) => {
      const [x, y] = clampToScreen(clientX, clientY)
      // detail: 1 is load-bearing, not decoration. xterm's selection service
      // only anchors a new selection for a click count of exactly one:
      //
      //     this._enabled && e.shiftKey ? this._handleIncrementalClick(e)
      //       : 1 === e.detail ? this._handleSingleClick(e)
      //       : 2 === e.detail ? this._handleDoubleClick(e) : ...
      //
      // A constructed MouseEvent defaults detail to 0, which matches no branch,
      // so a drag in the shell never anchored anything and selected nothing —
      // "모바일에서 아예 선택할 방법이 없더라", with only a real double-tap
      // (detail 2) still selecting a word. It is also what made the previous
      // round's anchor look random: a real tap (detail 1) had planted one
      // earlier and the synthetic drag merely extended from it.
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
        detail: 1,
        shiftKey: forceSelection,
        view: window,
      })
      // xterm's own mousedown listener calls focus() unconditionally
      // (`e.preventDefault(), this.focus(), ...`), which focuses its textarea,
      // which the mobile-input effect redirects to the input field — so every
      // synthetic drag was opening the on-screen keyboard. That shrinks the
      // terminal mid-drag and reflows the rows under the finger, and the
      // selection anchor ends up on whatever line moved there: the device
      // report "그냥 터치하고 움직이면 이상한 곳에 앵커가 박힘", fine only when
      // an earlier tap had already opened the keyboard so nothing moved.
      // A drag never needs the keyboard, so swallow that one focus call for the
      // duration of our own dispatch. xterm's focus() is
      // `this.textarea.focus(...)`, so an own property on the textarea shadows
      // it; deleting that property afterwards restores the prototype method.
      // A real tap's compatibility click is not dispatched through here, so it
      // still focuses and opens the keyboard exactly as before.
      const textarea = term.textarea
      if (type === 'mousedown' && textarea) {
        textarea.focus = () => {}
        try {
          wheelTarget().dispatchEvent(event)
        } finally {
          Reflect.deleteProperty(textarea, 'focus')
        }
        return
      }
      wheelTarget().dispatchEvent(event)
    }
    // Whether this drag has to force its way past mouse reporting: select mode
    // against an application that turned mouse tracking on. Keyed on mouse
    // tracking specifically, not sendsScrollToApp — an alternate-screen app
    // *without* tracking (less) leaves xterm's selection service enabled, and
    // there shift would take the incremental "extend the old anchor" branch.
    // With tracking on, xterm has called selectionService.disable()
    // (`clearSelection(), this._enabled = !1`), so shift only passes the
    // shouldForceSelection gate and the incremental branch — which requires
    // _enabled — is skipped: detail 1 then reaches _handleSingleClick and the
    // anchor lands exactly under the finger. That is why the earlier
    // selectLines() seeding, which anchored at the start of the touched row in
    // vim, is gone.
    let forceSelectionDrag = false
    const beginPointerDrag = (clientX: number, clientY: number) => {
      clearLongPress()
      holdFocus(600)
      const selecting = touchModeRef.current === 'select'
      forceSelectionDrag = selecting && term.modes.mouseTrackingMode !== 'none'
      pointerDragging = true
      dispatchMouse('mousedown', clientX, clientY, forceSelectionDrag)
    }
    const endPointerDrag = (clientX: number, clientY: number) => {
      if (!pointerDragging) return
      pointerDragging = false
      dispatchMouse('mouseup', clientX, clientY, forceSelectionDrag)
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
        if (!pointerDragging) beginPointerDrag(startX, startY)
        holdFocus(600)
        dispatchMouse('mousemove', x, y, forceSelectionDrag)
        lastX = x
        lastY = y
        e.preventDefault()
        return
      }
      if (!dragging && Math.abs(y - startY) < TOUCH_SCROLL_THRESHOLD) return
      dragging = true
      holdFocus(600)
      const rowHeight = container.clientHeight / (term.rows || 1) || 18
      const now = performance.now()
      const dt = lastMoveAt ? now - lastMoveAt : 0
      if (dt > 0) {
        const sample = (lastY - y) / dt
        velocity = velocitySeeded ? velocity * (1 - MOMENTUM_VELOCITY_SMOOTHING) + sample * MOMENTUM_VELOCITY_SMOOTHING : sample
        velocitySeeded = true
      }
      lastMoveAt = now
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
    const cancelMomentum = () => {
      if (!momentumFrame) return
      cancelAnimationFrame(momentumFrame)
      momentumFrame = 0
      debugLogRef.current?.('  (momentum end: caught by touch)')
    }
    // Coasts at the velocity the finger let go at, decaying to a stop. `toApp`
    // picks the same destination the drag itself used: the viewport, or wheel
    // reports to an application that turned mouse tracking on — see
    // TOUCH_MOMENTUM_KEY's doc comment for why that, and only that, input
    // path is safe to coast through.
    const startMomentum = (toApp: boolean) => {
      cancelMomentum()
      let v = velocity
      let prev = performance.now()
      let frames = 0
      let moved = 0
      const finish = (reason: string) => {
        debugLogRef.current?.(`  (momentum end: ${reason}, ${frames} frames, ${moved} lines)`)
      }
      const step = (now: number) => {
        momentumFrame = 0
        // The app can exit or drop mouse tracking mid-coast (vim quits back to
        // the shell). Stop rather than let the rest of the fling change
        // meaning — from wheel reports to viewport scrolling or arrow keys.
        frames++
        holdFocus(400)
        if (toApp !== (altScreenScrollRef.current && sendsScrollToApp(term))) {
          finish('app state changed')
          return
        }
        if (toApp && term.modes.mouseTrackingMode === 'none') {
          finish('mouse tracking turned off')
          return
        }
        const dt = Math.min(now - prev, MOMENTUM_MAX_FRAME_MS)
        prev = now
        const rowHeight = container.clientHeight / (term.rows || 1) || 18
        lineRemainder += (v * dt) / rowHeight
        const lines = Math.trunc(lineRemainder)
        if (lines !== 0) {
          if (toApp) {
            // No scrollback edge to detect here — the app owns its own limits
            // and simply ignores wheel reports past them — so this path only
            // ends when the velocity decays.
            const [x, y] = clampToScreen(lastX, lastY)
            dispatchWheel(lines, x, y)
            lineRemainder -= lines
            moved += Math.abs(lines)
          } else {
            // Stop dead at either end of the scrollback instead of spinning
            // out the remaining velocity against a wall: viewportY not moving
            // is the only signal xterm gives that the scroll had nowhere to go.
            const before = term.buffer.active.viewportY
            term.scrollLines(lines)
            lineRemainder -= lines
            if (term.buffer.active.viewportY === before) {
              finish('scrollback edge')
              return
            }
            moved += Math.abs(lines)
          }
        }
        v *= Math.pow(MOMENTUM_FRICTION, dt / 16.67)
        if (Math.abs(v) < MOMENTUM_MIN_VELOCITY) {
          finish('decayed')
          return
        }
        momentumFrame = requestAnimationFrame(step)
      }
      momentumFrame = requestAnimationFrame(step)
    }
    const onTouchEnd = (e: TouchEvent) => {
      clearLongPress()
      const hadPointerDrag = pointerDragging
      const hadScrollDrag = dragging
      const t = e.changedTouches[0]
      endPointerDrag(t?.clientX ?? lastX, t?.clientY ?? lastY)
      // A drag we already replayed to xterm must not also produce the
      // browser's compatibility mouse events. Android fires mousedown/
      // mouseup/click at the *release* point after a touch sequence whose
      // touchstart wasn't cancelled, and in 'select' mode that late mousedown
      // reaches xterm's _handleSingleClick — clearing the selection the drag
      // just made and anchoring a new empty one. That was the whole of
      // "선택 모드를 켜면 모바일에선 아무것도 안 돼": the selection existed
      // for an instant and was wiped by a click nobody performed. 'mouse' mode
      // only looked fine because an extra click at the end of a vim drag is
      // harmless. A plain tap (no drag) keeps its click, which is what moves
      // the cursor and focuses the terminal.
      if (hadPointerDrag || hadScrollDrag) holdFocus(600)
      if ((hadPointerDrag || hadScrollDrag) && e.cancelable) e.preventDefault()
      if (e.touches.length > 0) return
      touchActive = false
      lastTouchEndAt = performance.now()
      const toApp = altScreenScrollRef.current && sendsScrollToApp(term)
      if (hadScrollDrag && touchModeRef.current === 'scroll') {
        // Each gate is named so a copied debug log says which one refused a
        // fling — "vim 안에서 관성은 없어" on a vim that does have mouse
        // tracking on (mouse=nvi) could not be explained from the code alone.
        const sinceMove = performance.now() - lastMoveAt
        let skip: string | null = null
        if (!touchMomentumRef.current) skip = 'disabled'
        else if (toApp && term.modes.mouseTrackingMode === 'none') skip = 'app without mouse tracking'
        else if (Math.abs(velocity) < MOMENTUM_MIN_VELOCITY) skip = 'too slow'
        // A finger that came to rest before lifting means the user stopped
        // deliberately; only a release that was still moving is a fling.
        else if (sinceMove >= 100) skip = 'finger rested before release'
        debugLogRef.current?.(
          `  (momentum ${skip ? `skipped: ${skip}` : 'start'} v=${velocity.toFixed(2)}px/ms toApp=${toApp} mouse=${term.modes.mouseTrackingMode} buffer=${term.buffer.active.type} idle=${Math.round(sinceMove)}ms)`,
        )
        if (!skip) startMomentum(toApp)
      }
      dragging = false
    }
    // Android's long-press fires contextmenu, and letting it through hands the
    // rest of the touch sequence to native selection/callout UI — which is
    // what used to swallow a press-and-hold drag. The terminal has no native
    // context menu worth keeping on touch; a real right-click on desktop is
    // left alone by only acting while a touch is live or just ended.
    const onContextMenu = (e: MouseEvent) => {
      if (touchActive || performance.now() - lastTouchEndAt < 800) e.preventDefault()
    }
    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    // Not passive: onTouchEnd has to be able to cancel compatibility mouse
    // events after a drag (see its comment).
    container.addEventListener('touchend', onTouchEnd, { passive: false })
    container.addEventListener('touchcancel', onTouchEnd, { passive: false })
    container.addEventListener('contextmenu', onContextMenu)
    // Drives the copy affordance below: xterm's selection is its own state,
    // invisible to window.getSelection(), so nothing else would ever know a
    // touch drag produced one.
    const selectionDisposable = term.onSelectionChange(() => {
      setHasSelection(term.hasSelection())
    })
    const touchCleanup = () => {
      cancelMomentum()
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchEnd)
      container.removeEventListener('contextmenu', onContextMenu)
      clearLongPress()
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

    // Real mouse-wheel/trackpad scrolling over a full-screen app — see
    // ALT_SCREEN_WHEEL_SCROLL_KEY's doc comment above for why xterm's own
    // default handling drops most of a flick's or an inertial coast's
    // distance. Accumulate the event's own delta (never discarding the
    // remainder past one line, unlike xterm's built-in accumulator) and
    // replay it as that many single-line synthetic wheel events through
    // dispatchWheel, which hands each one back to xterm's own listener
    // exactly like the touch path above does. A plain accumulator, not a
    // ref-driven one: it's local to this one wheel handler's closure and
    // never read from outside it.
    let realWheelLineRemainder = 0
    const wheelLinesPerEvent = (event: WheelEvent): number => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * (term.rows || 1)
      const rowHeight = container.clientHeight / (term.rows || 1) || 18
      return event.deltaY / rowHeight
    }
    term.attachCustomWheelEventHandler((event) => {
      if ((event as unknown as Record<string, boolean>)[SYNTHETIC_WHEEL_TAG]) return true
      if (!altScreenWheelScrollRef.current || !sendsScrollToApp(term) || event.deltaY === 0) {
        realWheelLineRemainder = 0
        return true
      }
      realWheelLineRemainder += wheelLinesPerEvent(event)
      const lines = Math.trunc(realWheelLineRemainder)
      if (lines !== 0) {
        dispatchWheel(lines, event.clientX, event.clientY)
        realWheelLineRemainder -= lines
      }
      event.preventDefault()
      return false
    })

    // Repaint nudge for full-screen applications once a row-count change has
    // settled: shrink the PTY one row and straight back, the same trick the
    // backend's nudgeRepaint uses after a scrollback replay. Measured against
    // a real PTY (2026-09-14): vim in Visual mode redraws its "-- VISUAL --"
    // line on the new last row from a single SIGWINCH, with no input needed —
    // yet on the device, after the keyboard opened, that line stayed missing
    // until a drag sent vim some input. So the redraw either never arrived or
    // landed while xterm was still reflowing the alternate buffer across the
    // shrink. A second SIGWINCH delivered after the size has stopped moving
    // covers both. Alternate buffer only: an application there repaints its
    // whole screen anyway, while a shell prompt in the normal buffer (fish)
    // repaints on every SIGWINCH and would stack duplicate prompts.
    const REPAINT_NUDGE_DELAY_MS = 300
    // A container that keeps changing size - VS Code animating a panel pane
    // open or shut, a window being dragged - fired a fit and a PTY resize on
    // every frame, and the app behind it redrew the whole screen each time.
    // The first change of a burst still applies at once (a keyboard opening,
    // a window snapping), the rest wait until the size has held still this
    // long, then apply once.
    const RESIZE_SETTLE_MS = 100
    let lastObservedRows = term.rows
    let repaintNudgeTimer = 0
    let resizeSettleTimer = 0
    let lastResizeAt = 0
    const applyResize = () => {
      // Also fires when the container is hidden on a switch to the Home tab
      // (a 0x0 box is still a size change), which is exactly the case
      // fitIfVisible exists to skip.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      fitAddon.fit()
      sendResize()
      debugLogRef.current?.(
        `  (resize ${container.clientWidth}x${container.clientHeight}px -> ${term.cols}x${term.rows} buffer=${term.buffer.active.type} cursorY=${term.buffer.active.cursorY})`,
      )
      if (term.rows === lastObservedRows) return
      lastObservedRows = term.rows
      outputProbeRef.current = { bytes: 0 }
      window.clearTimeout(repaintNudgeTimer)
      repaintNudgeTimer = window.setTimeout(() => {
        const probe = outputProbeRef.current
        debugLogRef.current?.(`  (output since resize: ${probe?.bytes ?? 0} bytes)`)
        if (term.buffer.active.type !== 'alternate' || term.rows < 2) {
          outputProbeRef.current = null
          return
        }
        outputProbeRef.current = { bytes: 0 }
        sendSize(term.cols, term.rows - 1, 'repaint nudge')
        sendSize(term.cols, term.rows, 'repaint nudge restore')
        window.setTimeout(() => {
          debugLogRef.current?.(`  (output after nudge: ${outputProbeRef.current?.bytes ?? 0} bytes)`)
          outputProbeRef.current = null
        }, 600)
      }, REPAINT_NUDGE_DELAY_MS)
    }
    const resizeObserver = new ResizeObserver(() => {
      const now = performance.now()
      const inBurst = now - lastResizeAt < RESIZE_SETTLE_MS
      lastResizeAt = now
      window.clearTimeout(resizeSettleTimer)
      if (!inBurst) applyResize()
      resizeSettleTimer = window.setTimeout(applyResize, RESIZE_SETTLE_MS)
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      window.clearTimeout(repaintNudgeTimer)
      window.clearTimeout(resizeSettleTimer)
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

    // Header written into whatever the copy button hands over. Without it a
    // pasted log is just a list of events with no way to tell which mode,
    // which keyboard or which device produced them — and that context is
    // exactly what has been missing every time this bug was guessed at.
    const debugMeta = () => {
      const active = document.activeElement
      const field = mobileInputRef.current
      return [
        `# webmanager terminal input debug`,
        `# time: ${new Date().toISOString()}`,
        `# inputMode: ${inputMode}`,
        `# field: ${field ? field.tagName.toLowerCase() + (field instanceof HTMLInputElement ? `[type=${field.type}]` : '') : 'none (xterm textarea)'}`,
        `# focused: ${active === field ? 'workaround field' : active === term.textarea ? 'xterm textarea' : (active?.tagName.toLowerCase() ?? 'none')}`,
        `# pointer: ${typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine'}`,
        `# keyboardInset: ${keyboardInsetRef.current}`,
        `# ua: ${navigator.userAgent}`,
      ].join('\n')
    }
    const debug = inputDebugEnabled ? createInputDebugOverlay(container, debugMeta) : null
    debugLogRef.current = debug ? debug.log : null
    const logEvent = (source: string, e: Event, value?: string) => {
      if (!debug) return
      const composing = 'isComposing' in e ? String((e as InputEvent).isComposing) : '-'
      const key = e instanceof KeyboardEvent ? ` key=${e.key}` : ''
      // `data` is what actually distinguishes "the IME is composing" from
      // "the IME committed a character and moved on" — without it the two
      // read identically in the log, which cost a round trip once already.
      const data = 'data' in e && (e as CompositionEvent).data != null ? ` d=${debugQuote(String((e as CompositionEvent).data))}` : ''
      debug.log(`${source} ${e.type} ic=${composing}${key}${data} v=${debugQuote(value ?? '')}`)
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
        debugLogRef.current = null
        debug.dispose()
      }
    }

    const field = inputMode === 'password' ? document.createElement('input') : document.createElement('textarea')
    if (field instanceof HTMLInputElement) {
      // The whole reason this mode exists: mobile keyboards only reliably
      // refuse to run prediction/composition on a real password input.
      field.type = 'password'
      field.name = `terminal-input-${Math.random().toString(36).slice(2)}`
      field.setAttribute('aria-hidden', 'true')
      field.tabIndex = -1
    } else {
      // Mirror xterm's own hidden helper textarea as closely as possible,
      // attribute for attribute — that element is the one configuration
      // measured to actually get IME composition on the reporting device
      // (with the workaround off, Hangul composes there correctly), so every
      // gratuitous difference is a suspect. Notably NOT set here, unlike the
      // first version of this: aria-hidden, tabIndex=-1, a rows attribute,
      // or a name. The 2026-09-06 device report had Hangul splitting into
      // jamo in this mode too, i.e. composition was not attaching, and those
      // four were the only things distinguishing this field from xterm's.
      field.classList.add('xterm-helper-textarea')
      field.setAttribute('aria-multiline', 'false')
      field.tabIndex = 0
    }
    // "off", not "new-password" - "new-password" is literally the hint
    // Chrome's own save-password heuristic watches for ("this field is for
    // creating a new password"), which turned out to make the unwanted
    // "저장하시겠습니까?" prompt worse, not better (confirmed live,
    // 2026-08-19). Chrome's no-form save-prompt heuristic on mobile may
    // still fire regardless of any attribute here.
    field.autocomplete = 'off'
    field.setAttribute('autocorrect', 'off')
    field.setAttribute('autocapitalize', 'off')
    field.setAttribute('spellcheck', 'false')
    // Invisible, but NOT zero-sized and NOT parked off-screen — and that
    // distinction turned out to be the whole ballgame for IME composition.
    //
    // Measured on a Galaxy (Samsung Browser 30, 2026-09-06): with the field
    // at width:0/height:0/left:-9999em, every single jamo arrived as its own
    // complete compositionstart → input → compositionend cycle, so "안녕"
    // reached the terminal as "ㅇㅏㄴㄴㅕㅇ". The IME was refusing to hold a
    // composing region at all. xterm's own helper textarea, which composes
    // correctly on the same device, is the counter-example: it is given a
    // real box at the cursor cell every render
    // (`width: Math.max(r.width, 1) + 'px'`, measured at 9px). An Android
    // IME needs somewhere to draw composing text; given nowhere, it commits
    // each keystroke instead of composing.
    //
    // pointer-events: none is what makes living inside the terminal's own
    // area safe. A 2026-08-21 detour put a full-size field on top of the
    // terminal and had to be reverted because it swallowed every touch
    // before xterm's mouse handling could see it — breaking tmux pane
    // selection, vim/htop mouse mode and Claude Code's click-driven
    // prompts. A field that only ever needs *focus* does not need
    // hit-testing at all, so taking it out of hit-testing entirely keeps
    // that failure impossible while still giving the IME a real box.
    Object.assign(field.style, {
      position: 'absolute',
      opacity: '0',
      left: '0px',
      top: '0px',
      width: '1ch',
      height: '1.2em',
      zIndex: '-5',
      border: '0',
      padding: '0',
      resize: 'none',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      pointerEvents: 'none',
    })
    // Parented next to xterm's own helper textarea rather than on the
    // container, so the geometry copied below means the same thing (same
    // containing block) instead of being off by the container's padding.
    ;(textarea.parentElement ?? container).appendChild(field)
    mobileInputRef.current = field

    // Track xterm's own helper textarea, which it keeps parked on the cursor
    // cell — that puts this field there too, so a keyboard that draws a
    // composing/candidate popup anchors it where the text is actually going.
    const syncFieldBox = () => {
      const from = textarea.style
      if (from.width) field.style.width = from.width
      if (from.height) field.style.height = from.height
      if (from.left) field.style.left = from.left
      if (from.top) field.style.top = from.top
      if (from.lineHeight) field.style.lineHeight = from.lineHeight
    }
    syncFieldBox()
    const cursorDisposable = term.onCursorMove(syncFieldBox)

    // One sentinel character is always kept in the field: deleting from an
    // already-empty field fires no input event at all (nothing for the
    // browser to report), which is how backspace silently stopped working
    // the first time this was written against a fully-cleared field.
    const ANCHOR = ' '
    let composing = false
    let cleanups: (() => void)[] = []

    // Keys that produce no text — arrows, Home/End, Tab, Escape, F-keys — and
    // Ctrl/Alt chords, as sent by a physical keyboard attached to a touch
    // device (a tablet's keyboard cover). xterm's own handler lives on *its*
    // textarea, and focus here sits on the workaround field instead, so none
    // of these reached the terminal at all. Worse, an arrow the field couldn't
    // use (caret already at the end) was taken by the browser's keyboard
    // spatial navigation and moved focus up onto the session tabs — the device
    // report "태블릿에서 방향키 누르니 포커스가 위쪽 탭 선택으로 넘어간다".
    // Desktop never hit this: a fine pointer uses xterm's textarea directly.
    //
    // Rather than re-derive escape sequences here, replay the keydown on
    // xterm's textarea and let its evaluateKeyboardEvent decide — that keeps
    // application cursor mode (ESC O A vs ESC [ A) and modifier encodings
    // (ESC [1;5D) exactly as xterm has them. It switches on keyCode, which a
    // constructed KeyboardEvent can't carry, so the clone's keyCode is
    // shadowed with the original's (or derived from the key name when a
    // keyboard reports 0). xterm's own data event then goes through
    // term.onData → sendBytes like any other keystroke.
    //
    // Left alone on purpose: anything mid-composition or reported as the IME's
    // keyCode 229; Enter and Backspace, which each mode already handles; plain
    // printable keys, which arrive as text through the field; Ctrl/Meta+V, so a
    // paste still lands in the field and goes out through the diff; and
    // Ctrl/Shift+Space, which Samsung keyboards use to switch input language.
    const FORWARDED_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Tab', 'Escape'])
    const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])
    const KEY_CODES: Record<string, number> = {
      Tab: 9, Escape: 27, PageUp: 33, PageDown: 34, End: 35, Home: 36,
      ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
    }
    const keyCodeFor = (e: KeyboardEvent): number => {
      if (e.keyCode) return e.keyCode
      if (e.key in KEY_CODES) return KEY_CODES[e.key]
      const fkey = /^F(\d{1,2})$/.exec(e.key)
      if (fkey) return 111 + Number(fkey[1])
      return e.key.length === 1 ? e.key.toUpperCase().charCodeAt(0) : 0
    }
    // Returns whether the key was handed to xterm; the caller cancels the
    // original event so the field (and the browser) do nothing with it.
    const forwardSpecialKey = (e: KeyboardEvent): boolean => {
      if (e.isComposing || e.keyCode === 229) return false
      if (e.key === 'Enter' || e.key === 'Backspace') return false
      const special = FORWARDED_KEYS.has(e.key) || /^F\d{1,2}$/.test(e.key)
      const chord = (e.ctrlKey || e.altKey) && e.key.length === 1
      if (!special && !chord) return false
      if (chord && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return false
      if (e.key === ' ' && (e.ctrlKey || e.shiftKey)) return false
      const clone = new KeyboardEvent('keydown', {
        key: e.key,
        code: e.code,
        location: e.location,
        repeat: e.repeat,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        bubbles: true,
        cancelable: true,
      })
      const keyCode = keyCodeFor(e)
      Object.defineProperty(clone, 'keyCode', { get: () => keyCode })
      Object.defineProperty(clone, 'which', { get: () => keyCode })
      textarea.dispatchEvent(clone)
      debug?.log(`  (key ${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key} forwarded to xterm)`)
      return true
    }

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
        if (forwardSpecialKey(e)) {
          e.preventDefault()
          return
        }
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
      const onCompositionUpdate = (e: Event) => logEvent('field', e, field.value)
      field.addEventListener('compositionstart', onCompositionStart)
      field.addEventListener('compositionupdate', onCompositionUpdate)
      field.addEventListener('compositionend', onCompositionEnd)
      field.addEventListener('input', onInput)
      field.addEventListener('keydown', onKeyDown)
      cleanups.push(() => {
        field.removeEventListener('compositionstart', onCompositionStart)
        field.removeEventListener('compositionupdate', onCompositionUpdate)
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
      // Set when the keyboard started inserting *before* the anchor instead of
      // after it, leaving the anchor as the field's last character. See
      // readValue below — this is what put a phantom space into English
      // ("aa " → "aab " → "aabc ") and materialized it on the next character
      // ("claude" + "-" became "claude -").
      let anchorAtEnd = false
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
          anchorAtEnd = false
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
        anchorAtEnd = false
        if (field.value === ANCHOR) return
        field.value = ANCHOR
        sent = ANCHOR
        field.setSelectionRange(ANCHOR.length, ANCHOR.length)
        debug?.log(`  (reset: ${reason})`)
      }
      // The field's text as the diff should see it. Normally just
      // field.value. But a device showed the keyboard sometimes inserting at
      // offset 0 right after a reset — before the anchor rather than after it
      // — so the field read "aa " with the anchor trailing. Diffed raw, that
      // anchor went out to the terminal as a real space that then rode along
      // at the end of the word and became permanent on the next character.
      //
      // The displacement is only unambiguous at one moment: the field was
      // exactly the anchor (sent === ANCHOR) and now ends with it without
      // starting with it — nothing the user typed can produce that shape,
      // since a typed leading space would sit after the anchor, not replace
      // its position. From there on, until the field is repaired or reset,
      // the trailing anchor is moved back to the front before diffing, so
      // the terminal sees exactly what it would have if the caret had been
      // in the right place all along.
      const readValue = () => {
        const raw = field.value
        if (!anchorAtEnd && sent === ANCHOR && raw.length > ANCHOR.length && raw.endsWith(ANCHOR) && !raw.startsWith(ANCHOR)) {
          anchorAtEnd = true
          debug?.log('  (anchor displaced to the end — normalizing)')
        }
        if (!anchorAtEnd) return raw
        if (!raw.endsWith(ANCHOR)) {
          anchorAtEnd = false
          return raw
        }
        return ANCHOR + raw.slice(0, -ANCHOR.length)
      }
      // Keeps the caret pinned to the end of the field after every committed
      // change. This is not cosmetic: a real device typed "claude" and got
      // "edual c" back, because every character was being inserted at the
      // *same* offset — the last position ever set explicitly, right after
      // the anchor — instead of after the previous one. A 0x0 off-screen
      // textarea apparently has no live caret of its own for the keyboard to
      // advance, so the last setSelectionRange wins forever. Re-pinning it
      // after each commit makes the next insert land at the end, which is
      // what the prefix diff assumes. Never done mid-composition: moving the
      // selection under an active IME is how composition gets cancelled.
      const pinCaretToEnd = () => {
        if (composing) return
        // Outside a composition is the safe moment to actually repair a
        // displaced anchor in the field itself (moving text under an active
        // IME cancels the composition), so the normalization in readValue
        // only ever has to cover the stretch while composing.
        if (anchorAtEnd) {
          const repaired = readValue()
          anchorAtEnd = false
          if (field.value !== repaired) {
            field.value = repaired
            debug?.log('  (anchor moved back to the front)')
          }
        }
        const end = field.value.length
        field.setSelectionRange(end, end)
      }
      // See REFOCUS_ON_WORD_KEY. Deferred a task rather than done inside the
      // input handler: blurring a field while the keyboard is still delivering
      // the keystroke that triggered this is the same kind of mid-event
      // mutation that dropped characters in 2026-08-19's synchronous reset.
      // `refocusing` keeps onBlur from treating our own blur as the user
      // leaving the field.
      let refocusTimer = 0
      let refocusing = false
      const scheduleRefocus = () => {
        window.clearTimeout(refocusTimer)
        refocusTimer = window.setTimeout(() => {
          if (document.activeElement !== field) return
          refocusing = true
          field.blur()
          field.focus()
          refocusing = false
          debug?.log(`  (refocus: word boundary, focused=${document.activeElement === field})`)
        }, 0)
      }

      const flush = () => {
        const value = readValue()
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
        if (value === '') {
          scheduleReanchor()
          return
        }
        // Repo owner's own suggestion, and it is the right granularity: an
        // Android keyboard's predictive buffer is per *word*, so a word
        // boundary is the moment it has demonstrably let go. Resetting there
        // keeps the accumulated-value protection exactly where re-emission
        // can still happen (inside the word being typed) while stopping the
        // field from carrying a whole line's worth of stale text.
        if (!composing && added.includes(' ')) {
          resetField('word boundary')
          if (refocusOnWordRef.current) scheduleRefocus()
          return
        }
        if (!composing && value.length > MAX_FIELD_LENGTH) {
          resetField('length cap')
          return
        }
        pinCaretToEnd()
      }
      const onCompositionStart = (e: Event) => {
        composing = true
        logEvent('field', e, field.value)
      }
      const onCompositionEnd = (e: Event) => {
        composing = false
        logEvent('field', e, field.value)
        flush()
        // With live composition, a space typed *inside* the composition
        // was already sent by an input event while `composing` was still
        // true — which is exactly when flush's word-boundary reset is
        // skipped — so compositionend sees no new bytes and flush returns
        // before reaching it. Catch that case here, now that the keyboard
        // has actually let go of the word.
        // Read through readValue, not field.value: a displaced anchor also
        // ends in a space, and treating it as the user's word boundary reset
        // the field on every compositionend — which, with the refocus that
        // follows, put the caret right back where the displacement started.
        const logical = readValue()
        if (logical !== ANCHOR && logical.endsWith(' ')) {
          resetField('word boundary')
          if (refocusOnWordRef.current) scheduleRefocus()
        } else {
          pinCaretToEnd()
        }
      }
      const onInput = (e: Event) => {
        logEvent('field', e, field.value)
        // A composition whose compositionend never arrived — typically one
        // cut off by the page being hidden — would leave `composing` stuck
        // true, silently disabling caret pinning and word-boundary resets from
        // then on. The input event's own isComposing is authoritative.
        if (composing && e instanceof InputEvent && !e.isComposing) composing = false
        // Mid-composition the field holds a half-assembled syllable. With
        // live composition on it goes out anyway, and the next input's diff
        // backspaces over it once the IME assembles it further — that is
        // what makes composition visible in the terminal at all (see
        // LIVE_COMPOSITION_KEY). With it off, nothing is sent until
        // compositionend, which on a keyboard that composes a whole word at
        // a time means nothing until the space bar.
        if (composing && !liveCompositionRef.current) return
        flush()
      }
      // A delete with the caret parked at offset 0, where the native default
      // has nothing before the caret to remove and silently does nothing. A
      // device showed exactly that after returning from another tab:
      // backspace stopped deleting "from some point" and only recovered once
      // something new was typed (typing moves the caret). Deliberately scoped
      // to that one state — the ordinary anchor deletion with the caret at the
      // end is left to the native path that is already confirmed working,
      // since cancelling a delete the keyboard *could* perform would desync
      // its own model of the field. Sends the delete itself, keeps the field
      // consistent with what the terminal now holds, and puts the caret back.
      const deleteAtCaretStart = () => {
        if (composing || field.selectionStart !== 0 || field.selectionEnd !== 0) return false
        const logical = readValue()
        emit('\x7f')
        if (logical !== ANCHOR) {
          const trimmed = logical.slice(0, -1)
          field.value = trimmed.startsWith(ANCHOR) ? trimmed : ANCHOR + trimmed
          sent = field.value
        }
        anchorAtEnd = false
        pinCaretToEnd()
        debug?.log('  (backspace at caret 0 handled)')
        return true
      }
      const onBeforeInput = (ev: Event) => {
        const e = ev as InputEvent
        if (e.inputType === 'deleteContentBackward' && !e.isComposing && deleteAtCaretStart()) e.preventDefault()
      }
      const onKeyDown = (ev: Event) => {
        const e = ev as KeyboardEvent
        logEvent('field', e, field.value)
        if (forwardSpecialKey(e)) {
          e.preventDefault()
          // The shell's cursor just moved away from the end of what this field
          // has accumulated, so a keyboard rewriting that word would now
          // backspace over the wrong characters. A cursor jump is a boundary
          // like a space is — start the next word fresh.
          if (NAVIGATION_KEYS.has(e.key)) resetField('navigation key')
          return
        }
        if (e.key === 'Backspace' && !e.isComposing && deleteAtCaretStart()) {
          e.preventDefault()
          return
        }
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
        if (refocusing) return
        resetField('blur')
      }
      // Every way this field gains focus — a tap on the terminal redirected
      // here, keepFocus, the word-boundary refocus — pins the caret to the
      // end. focus() on Android does not reliably keep the last explicit
      // selection, and a caret that lands at offset 0 is exactly the
      // before-the-anchor insertion readValue has to clean up after; this
      // stops it at the source rather than only repairing it.
      const onFocus = () => {
        pinCaretToEnd()
      }
      // Returning to the page — from another browser tab or app, or the screen
      // turning back on — reconnects the keyboard to this field with a model of
      // its contents nothing guarantees is current, and a composition in
      // progress when the page was hidden never gets its compositionend. The
      // device symptom: a space left behind after "claude-" and backspace dying
      // partway through, both after coming back from another tab. Start over
      // from a known state instead: no composition, anchor only, caret at the
      // end. The terminal itself is untouched; only the field's bookkeeping is
      // reset, exactly as a blur would.
      const resync = (reason: string) => {
        if (document.activeElement !== field) return
        composing = false
        resetField(reason)
        pinCaretToEnd()
      }
      const onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') composing = false
        else resync('resume')
      }
      const onPageShow = () => resync('pageshow')
      const onWindowFocus = () => resync('window focus')
      // Observed only, never acted on: an IME that keeps a composing region
      // fires several of these between one compositionstart/end pair, and an
      // IME that has given up composing fires none. That difference is the
      // single most useful thing in a copied debug log.
      const onCompositionUpdate = (e: Event) => logEvent('field', e, field.value)
      field.addEventListener('compositionstart', onCompositionStart)
      field.addEventListener('compositionupdate', onCompositionUpdate)
      field.addEventListener('compositionend', onCompositionEnd)
      field.addEventListener('input', onInput)
      field.addEventListener('keydown', onKeyDown)
      field.addEventListener('blur', onBlur)
      field.addEventListener('focus', onFocus)
      field.addEventListener('beforeinput', onBeforeInput)
      document.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener('pageshow', onPageShow)
      window.addEventListener('focus', onWindowFocus)
      cleanups.push(() => {
        window.clearTimeout(refocusTimer)
        field.removeEventListener('focus', onFocus)
        field.removeEventListener('beforeinput', onBeforeInput)
        document.removeEventListener('visibilitychange', onVisibilityChange)
        window.removeEventListener('pageshow', onPageShow)
        window.removeEventListener('focus', onWindowFocus)
        field.removeEventListener('compositionstart', onCompositionStart)
        field.removeEventListener('compositionupdate', onCompositionUpdate)
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
      // Inside a touch drag or momentum coast (see holdFocus in the touch
      // handler), whatever focused xterm's textarea was xterm itself, never a
      // user asking to type — so hand focus straight back instead of
      // forwarding it, and the keyboard stays as it was. A tap made after the
      // window has passed redirects normally.
      if (performance.now() < suppressFocusUntilRef.current) {
        textarea.blur()
        debug?.log('  (focus redirect suppressed: touch drag/momentum)')
        return
      }
      debug?.log('  (focus redirected to input field)')
      field.focus()
    }
    textarea.addEventListener('focus', onTextareaFocus)

    return () => {
      textarea.removeEventListener('focus', onTextareaFocus)
      cursorDisposable.dispose()
      for (const fn of cleanups) fn()
      cleanups = []
      field.remove()
      mobileInputRef.current = null
      debugLogRef.current = null
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
    // An embedded view always says where its session lives: the backend
    // ignores it for a live session, and uses it to recreate one that died
    // (idle GC, webmanager restart) under the same name in the same place.
    const cwd = pending?.cwd ?? (embedded ? embedCwdRef.current : undefined)
    if (cwd) params.set('cwd', cwd)
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
      sentSizes.set(ws, `${term.cols}x${term.rows}`)
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
    ws.onclose = (event) => {
      if (wsRef.current !== ws) return
      setState('disconnected')
      // Checked before the session list is even fetched: that fetch is
      // gated too, so while locked it would answer 401 and pop the password
      // prompt again on every single retry.
      void gateLocked().then((locked) => {
        if (locked) {
          if (activeSessionRef.current !== activeSession) return
          clearScheduledReconnect()
          setLockedOutState(true)
          return
        }
        return refreshSessions().then((data) => {
          // Embedded: 1000 is the server closing because the shell exited -
          // the session is over, say so and offer to start it again. Any other
          // close (1006: webmanager restarted, network) falls through to the
          // ordinary reconnect below, which recreates the session if it's
          // gone - that's the whole "survives a refresh/restart" promise of an
          // embedded view, so it must not fall back to Home either way.
          // A 1000 with the list unavailable is still the server saying the
          // session ended - reconnecting would recreate it. 1008 is a name the
          // server refuses outright; retrying it can only fail forever.
          if (embedded) {
            const ended =
              (event.code === 1000 && (!data || !data.some((s) => s.name === activeSession))) || event.code === 1008
            if (ended && activeSessionRef.current === activeSession) {
              sessionEndedRef.current = true
              setSessionEnded(true)
              postToHost({ type: 'session-ended', session: activeSession })
              return
            }
            if (autoReconnectEnabledRef.current && activeSessionRef.current === activeSession) scheduleReconnect()
            return
          }
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
        if (outputProbeRef.current) outputProbeRef.current.bytes += event.data.byteLength
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
  }, [
    activeSession,
    refreshSessions,
    reconnectNonce,
    fitIfVisible,
    scheduleReconnect,
    clearScheduledReconnect,
    gateLocked,
    setLockedOutState,
    embedded,
  ])

  const selectSession = useCallback(
    (name: string) => {
      if (name !== activeSession) setActiveSession(name)
    },
    [activeSession],
  )

  const addSession = useCallback(
    (opts?: SessionCreateOptions) => {
      // Embedded, a new session without a set cwd asks the extension: it
      // knows the workspace folders and which one the user is looking at.
      if (embedded && !opts?.cwd) {
        postToHost({ type: 'new-session', label: opts?.label, command: opts?.command })
        return
      }
      const alsoTaken = activeSession === HOME_TAB_ID ? '' : activeSession
      const name = nextSessionName(sessions, alsoTaken, opts?.label)
      const cwd = opts?.cwd ?? (embedded ? embedCwdRef.current : undefined)
      if (cwd || opts?.command) {
        pendingCreateOptionsRef.current.set(name, { cwd, command: opts?.command })
      }
      setActiveSession(name)
    },
    [sessions, activeSession, embedded],
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

  // Embed: keep the extension told what this view shows - it titles the
  // tab with the session name and restores from the last live cwd.
  const activeInfo = useMemo(
    () => (activeSession === HOME_TAB_ID ? undefined : sessions.find((s) => s.name === activeSession)),
    [sessions, activeSession],
  )
  useEffect(() => {
    if (!embedded) return
    if (activeInfo?.cwd) embedCwdRef.current = activeInfo.cwd
    reportEmbedState({
      session: activeSession === HOME_TAB_ID ? null : activeSession,
      cwd: embedCwdRef.current,
      pinned: activeInfo?.pinned,
    })
  }, [embedded, activeSession, activeInfo])

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

  // Embed: the extension's view actions (pin, rename) and focus hand-off.
  // Done here rather than by the extension itself because this page holds
  // the unlock cookie those gated PATCHes need.
  useEffect(() => {
    if (!embedded) return
    return onHostMessage((msg) => {
      if (msg.type === 'focus') termRef.current?.focus()
      if (activeSession === HOME_TAB_ID) return
      if (msg.type === 'pin') void togglePin(activeSession, msg.pinned)
      if (msg.type === 'rename') void renameSession(activeSession, msg.name)
    })
  }, [embedded, activeSession, togglePin, renameSession])

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
  // Read by the xterm link provider, which is created once.
  useEffect(() => {
    activeProjectPathRef.current = activeProjectPath
    onOpenCommitRef.current = onOpenCommit
  }, [activeProjectPath, onOpenCommit])

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
    <section className={`terminal-section${embedded ? ' terminal-section-embed' : ''}`} style={surfaceStyle}>
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
        {!embedded && <h1>Terminal</h1>}
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
          {/* Embed mode has no tab bar (see embedSession), and the tab bar is
              where pin and the zoom pair normally live - so they move up here
              rather than disappearing with it. Zoom follows the tab bar's own
              rule: only while the control bar (which has its own zoom keys)
              is hidden. */}
          {embedded && activeSession !== HOME_TAB_ID && (
            <button
              type="button"
              className={`btn btn-small btn-secondary${activeInfo?.pinned ? ' terminal-pin-on' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void togglePin(activeSession, !activeInfo?.pinned)}
              title={activeInfo?.pinned ? '고정됨 - 누르면 해제 (유휴 자동 정리 대상이 됨)' : '고정 (유휴 자동 정리에서 제외)'}
              aria-pressed={!!activeInfo?.pinned}
            >
              <Pin size={14} />{' '}
              <span className="btn-label">{activeInfo?.pinned ? '고정됨' : '고정'}</span>
            </button>
          )}
          {embedded && activeSession !== HOME_TAB_ID && !controlBarEnabled && (
            <div className="terminal-zoom-group" role="toolbar" aria-label="터미널 글자 크기 조절">
              <button
                type="button"
                className="btn btn-secondary btn-small"
                aria-label="글자 축소"
                title="글자 축소"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => zoom('out')}
              >
                <ZoomOut size={14} />
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                aria-label="글자 확대"
                title="글자 확대"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => zoom('in')}
              >
                <ZoomIn size={14} />
              </button>
            </div>
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
      {!embedded && (
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
      )}
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
        {sessionEnded && (
          <div className="terminal-disconnect-overlay">
            <div className="terminal-disconnect-card">
              <p>세션이 종료되었습니다</p>
              <p className="terminal-disconnect-subtext">{activeSession}</p>
              <div className="terminal-ended-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  onClick={() => {
                    sessionEndedRef.current = false
                    setSessionEnded(false)
                    reconnect()
                  }}
                >
                  다시 시작
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => postToHost({ type: 'close-request' })}
                >
                  닫기
                </button>
              </div>
            </div>
          </div>
        )}
        {activeSession !== HOME_TAB_ID && state === 'disconnected' && !sessionEnded && (
          <div className="terminal-disconnect-overlay">
            <div className="terminal-disconnect-card">
              {lockedOut ? (
                <>
                  {/* Retrying is pointless until the gate is open, so this
                      says so and offers the prompt instead of counting
                      attempts that can only 401. */}
                  <p>잠금이 해제되어야 연결할 수 있습니다</p>
                  <p className="terminal-disconnect-subtext">비밀번호를 입력하면 이어서 연결합니다.</p>
                  <button type="button" className="btn btn-primary btn-small" onClick={() => void unlockAndReconnect()}>
                    잠금 해제
                  </button>
                </>
              ) : (
                <>
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
                </>
              )}
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
        touchMomentumEnabled={touchMomentumEnabled}
        onToggleTouchMomentum={toggleTouchMomentum}
        liveCompositionEnabled={liveCompositionEnabled}
        onToggleLiveComposition={toggleLiveComposition}
        refocusOnWordEnabled={refocusOnWordEnabled}
        onToggleRefocusOnWord={toggleRefocusOnWord}
        altScreenTouchScrollEnabled={altScreenTouchScrollEnabled}
        onToggleAltScreenTouchScroll={toggleAltScreenTouchScroll}
        altScreenWheelScrollEnabled={altScreenWheelScrollEnabled}
        onToggleAltScreenWheelScroll={toggleAltScreenWheelScroll}
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
