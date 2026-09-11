import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ApiError, api, apiUrl, errorMessage, requestUnlock } from '../../api/client'
import type {
  ClaudeInteractiveLoginStartResponse,
  ClaudeInteractiveLoginStatus,
  ClaudeOnboardingStatus,
} from '../../api/types'
import '../common/common.css'
import './ClaudeCode.css'
import './InteractiveLoginDialog.css'

// How often GET /api/claude/onboarding-status is polled while the wizard is
// running, looking for hasCompletedOnboarding to flip true - see the doc
// comment below for why this (not auth.loggedIn) is the signal to wait for.
const STATUS_POLL_INTERVAL_MS = 1500
// How long the "완료!" banner stays up before the dialog closes itself once
// onboarding is genuinely done - long enough to read, short enough not to
// feel stuck.
const AUTO_CLOSE_DELAY_MS = 1500
// Gap between the two Ctrl+C bytes sent when the dialog is closed - Ink-style
// CLIs commonly treat a lone Ctrl+C as "press again to exit," so a single
// byte wouldn't reliably terminate it. Empirically confirmed (live test):
// even the double byte doesn't always land in time, hence the fallback below.
const INTERRUPT_GAP_MS = 250
// How long to wait after the second Ctrl+C for the CLI to exit on its own
// before falling back to an explicit server-side Close() (SIGHUP/SIGKILL) -
// belt and suspenders, same pattern as claudecode.LoginManager.kill(). Fired
// fire-and-forget (not awaited by the UI) since the dialog itself closes
// immediately - see handleManualClose.
const CLOSE_FALLBACK_DELAY_MS = 2000
// Same capped exponential backoff as Terminal.tsx's auto-reconnect (1s, 2s,
// 4s, ... held at 30s) - see RECONNECT_BASE_DELAY_MS there. Returning to the
// foreground or coming back online skips the wait entirely.
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000

const SESSION_ENDED_MESSAGE =
  '로그인 세션이 종료되었습니다. CLI가 종료되었거나, 10분 제한 시간이 지났거나, 서버가 재시작되었습니다.'

const XTERM_THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
}

// 'reconnecting': the WebSocket dropped but the backend still reports the
// session alive. 'locked': a reconnect needs the password gate unlocked and
// the user declined the prompt - retried only on an explicit click, never
// in a loop. 'error': the session itself is gone (or never started).
type Phase = 'starting' | 'connecting' | 'running' | 'reconnecting' | 'locked' | 'completed' | 'error'

// InteractiveLoginDialog embeds the real, interactive `claude` CLI (its own
// first-run onboarding wizard - theme picker, then "Select login method")
// in a live terminal, instead of driving `claude auth login` headlessly.
// This exists because on the CLI it was built against (2.1.220) the
// headless flow (see LoginPanel) wrote valid credentials but never marked
// the wizard's own separate "onboarding complete" state (~/.claude.json's
// hasCompletedOnboarding) - so a bare `claude` in e.g. code-server's
// integrated terminal still showed the login-method screen from scratch.
// Current CLIs (measured 2.1.252-2.1.267) set that flag from `claude auth
// login` too, and the flag isn't one-time either: the CLI's own `/logout`
// resets it. See webmanager/CLAUDE.md for both incidents. ClaudeCode.tsx
// makes this dialog the primary CTA only while onboarding-status reports
// incomplete; elsewhere it's a fallback that can open on an instance that
// is already onboarded - see the baseline check in the status poll below.
//
// This dialog polls that same onboarding-status endpoint (not
// GET /api/claude/status's auth.loggedIn) to decide when it's safe to
// close: loggedIn flips true as soon as the OAuth handshake completes, but
// (confirmed live) the CLI still shows a few more onboarding screens after
// that (a "press Enter to continue," then a security notice) before it
// actually sets hasCompletedOnboarding - closing on loggedIn alone cuts the
// wizard off before that, defeating the whole point. hasCompletedOnboarding
// only flips after oauthAccount is already set, so by the time it's true,
// login is guaranteed true too - onLoggedIn() is called at that point, not
// on any earlier signal.
//
// The WebSocket reconnects on its own. Signing in means leaving this tab to
// copy the OAuth code, and mobile Chrome kills a backgrounded tab's
// WebSocket - which used to drop the dialog straight into an error state
// and strand the user one Enter-press short of the wizard's last screen,
// with credentials saved but hasCompletedOnboarding still false (the exact
// bug above, reached a different way). The PTY never depended on the
// socket (relayTerminalSession only detaches on close), so a drop is
// recoverable: each attempt first asks GET .../status whether the session
// is still there, because a failed WebSocket handshake looks identical
// (close code 1006) whether the cause was a network drop, a finished
// session's 404 or an expired password gate's 401.
//
// No `open` prop - the parent mounts this component exactly while the
// dialog should be visible (`{showInteractiveLogin && <InteractiveLoginDialog .../>}`),
// so mount/unmount doubles as the dialog's own open/close lifecycle.
export function InteractiveLoginDialog({ onClose, onLoggedIn }: { onClose: () => void; onLoggedIn: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  // Set right before this component tears itself down via handleManualClose
  // - lets the WS's own onclose handler (which otherwise treats an
  // unexpected close as a dropped connection) tell "we did this on purpose"
  // apart from a real disconnect.
  const closingRef = useRef(false)
  // Separate from closingRef because StrictMode runs the mount effect's
  // cleanup and setup back to back: this one is reset on setup, so a
  // simulated unmount doesn't permanently disable reconnecting.
  const unmountedRef = useRef(false)
  // True once onLoggedIn() has fired, so a second status-poll tick landing
  // before its own interval clears doesn't call it twice.
  const completedRef = useRef(false)
  // hasCompletedOnboarding as first seen by the status poll. Only a
  // false->true flip counts as completion: opened as the fallback on an
  // already-onboarded instance, the flag is true from the first tick, and
  // treating that as "done" closed the dialog before the user could log in.
  const baselineCompletedRef = useRef<boolean | null>(null)
  // Guards the auto-close-on-completed effect so it only ever schedules
  // itself once, even if phase is set to 'completed' again for some reason.
  const closeScheduledRef = useRef(false)
  // Bumped by every startSession call, so a start or status request still in
  // flight from a superseded session can't act on the new one.
  const startGenRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const probingRef = useRef(false)
  const openedOnceRef = useRef(false)

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('starting')
  const [error, setError] = useState<string | null>(null)
  // Bumped to open a fresh WebSocket to the same session - see reconnect.
  const [connectNonce, setConnectNonce] = useState(0)
  // Read by the window/document listeners, which are registered once.
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  // Best-effort: closes session on disk (SIGHUP -> SIGKILL after grace) if
  // it's still the current one. Safe to call more than once, and safe to
  // call after the CLI already exited on its own.
  const cancelSession = () => {
    const id = sessionIdRef.current
    if (!id) return
    api.post(`/claude/login/interactive/${encodeURIComponent(id)}/cancel`).catch(() => {})
  }

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }

  const reconnectAllowed = () => !closingRef.current && !unmountedRef.current && !completedRef.current

  // Starts (or, from the error state, restarts) the interactive session. A
  // restart supersedes whatever the manager still held server-side.
  const startSession = () => {
    const gen = ++startGenRef.current
    clearReconnectTimer()
    reconnectAttemptRef.current = 0
    openedOnceRef.current = false
    setError(null)
    setPhase('starting')
    api
      .post<ClaudeInteractiveLoginStartResponse>('/claude/login/interactive/start')
      .then((res) => {
        if (gen !== startGenRef.current) return
        if (closingRef.current || unmountedRef.current) {
          // The dialog went away while this was in flight - nothing will
          // ever attach, so don't leave the CLI running until the timeout.
          api.post(`/claude/login/interactive/${encodeURIComponent(res.sessionId)}/cancel`).catch(() => {})
          return
        }
        sessionIdRef.current = res.sessionId
        setSessionId(res.sessionId)
        setPhase('connecting')
      })
      .catch((e) => {
        if (gen !== startGenRef.current || unmountedRef.current) return
        setError(errorMessage(e))
        setPhase('error')
      })
  }

  // One reconnect attempt: confirm the session is still alive, then bump
  // connectNonce so the WebSocket effect dials it again. The status route is
  // behind the same password gate as the socket, so an expired unlock
  // surfaces here as a 401 - which api.get turns into the usual unlock
  // prompt and a transparent retry. Only a declined prompt reaches the catch
  // below as a 401, and that parks in 'locked' instead of retrying on a
  // timer, since every retry would just ask again.
  const reconnect = async () => {
    const id = sessionIdRef.current
    const gen = startGenRef.current
    // An in-flight probe already owns the next step (it reschedules or
    // dials when it settles), so leave any pending timer alone for it.
    if (!id || probingRef.current || !reconnectAllowed()) return
    clearReconnectTimer()
    const ws = wsRef.current
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

    probingRef.current = true
    let alive: boolean
    try {
      const res = await api.get<ClaudeInteractiveLoginStatus>(
        `/claude/login/interactive/${encodeURIComponent(id)}/status`,
      )
      alive = res.alive
    } catch (e) {
      if (gen !== startGenRef.current || !reconnectAllowed()) return
      if (e instanceof ApiError && e.status === 401) {
        setPhase('locked')
        return
      }
      // No answer at all (offline, timeout, server restarting) - not proof
      // the session is gone, so keep trying.
      scheduleReconnect()
      return
    } finally {
      probingRef.current = false
    }

    if (gen !== startGenRef.current || !reconnectAllowed()) return
    if (!alive) {
      setError(SESSION_ENDED_MESSAGE)
      setPhase('error')
      return
    }
    setPhase('reconnecting')
    setConnectNonce((n) => n + 1)
  }

  const scheduleReconnect = () => {
    if (reconnectTimerRef.current !== null || !reconnectAllowed()) return
    const attempt = reconnectAttemptRef.current + 1
    reconnectAttemptRef.current = attempt
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS)
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null
      void reconnect()
    }, delay)
  }

  // Skips the backoff: a user action, or a moment when the previous failure
  // is likely no longer true (back in the foreground, network back).
  const reconnectNow = () => {
    reconnectAttemptRef.current = 0
    void reconnect()
  }

  // Start the interactive session once on mount.
  useEffect(() => {
    unmountedRef.current = false
    startSession()
    return () => {
      unmountedRef.current = true
      clearReconnectTimer()
      // Unmount for any reason other than handleManualClose (e.g. a parent
      // stopping rendering this dialog directly) - best-effort cancel,
      // mirroring LoginPanel's own unmount-cancel behavior. Deliberately
      // not done on pagehide/visibilitychange: backgrounding the tab is
      // exactly what a user copying the OAuth code does.
      if (!closingRef.current) cancelSession()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // xterm instance, created once per sessionId and kept across reconnects
  // (the WebSocket lives in its own effect below, like Terminal.tsx's split).
  useEffect(() => {
    const container = containerRef.current
    if (!sessionId || !container) return

    const term = new XTerm({
      cursorBlink: true,
      convertEol: true,
      theme: XTERM_THEME,
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace",
    })
    termRef.current = term
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()
    // Without this, the wizard renders but keystrokes (including a plain
    // Enter) go nowhere until the user clicks inside the terminal first -
    // confirmed live. A dialog that just opened should already own focus.
    term.focus()

    // The CLI prints "(c to copy)" next to its sign-in URL - that's the
    // app itself asking the *terminal* to write the link to the OS
    // clipboard via an OSC 52 escape sequence, which xterm.js does not
    // handle on its own (same gap code-server's own terminal has, see root
    // CLAUDE.md's xclip/wl-copy shims). This registers that handler for
    // just this dialog's terminal so "c" actually works: OSC 52 payload
    // shape is "<selector>;<base64>", we only care about the base64 half.
    // Clicking the link directly already works (the CLI emits it as an
    // OSC 8 hyperlink, which xterm.js supports natively) - this only
    // covers the copy affordance. A reconnect's scrollback replay can't
    // re-trigger it: termsession strips OSC 52 before it enters the ring.
    const oscDisposable = term.parser.registerOscHandler(52, (data) => {
      const b64 = data.split(';')[1]
      if (!b64 || b64 === '?') return true
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        void navigator.clipboard.writeText(new TextDecoder().decode(bytes))
      } catch {
        // Malformed payload or clipboard API unavailable - not worth
        // surfacing, the link is still clickable either way.
      }
      return true
    })

    // Keystrokes typed while disconnected are dropped rather than queued -
    // replaying stale input into a wizard screen that may have changed is
    // worse than asking the user to press the key again.
    const dataDisposable = term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data))
      }
    })

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      const currentWs = wsRef.current
      if (currentWs && currentWs.readyState === WebSocket.OPEN) {
        currentWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      dataDisposable.dispose()
      oscDisposable.dispose()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  // WebSocket to the current session, reopened whenever connectNonce is
  // bumped by reconnect.
  useEffect(() => {
    const term = termRef.current
    const fitAddon = fitAddonRef.current
    if (!sessionId || !term || !fitAddon) return

    // The size rides on the URL because relayTerminalSession applies it
    // before snapshotting the scrollback it replays - the "resize" message
    // sent from onopen arrives too late for that (same as Terminal.tsx).
    fitAddon.fit()
    const params = new URLSearchParams({ cols: String(term.cols), rows: String(term.rows) })
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(
      `${protocol}//${window.location.host}${apiUrl(`/claude/login/interactive/${encodeURIComponent(sessionId)}?${params.toString()}`)}`,
    )
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      if (wsRef.current !== ws) return
      reconnectAttemptRef.current = 0
      // The server replays the session's scrollback on every attach, so a
      // reattach would otherwise stack a second copy under what is still on
      // screen. Reset here rather than before dialing so the last screen
      // stays readable while reconnecting - open is always dispatched
      // before the first message, so nothing replayed is lost.
      term.reset()
      setPhase((p) => (p === 'completed' ? p : 'running'))
      fitAddon.fit()
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      // Only on the first connect: refocusing on every reconnect would pop
      // a phone's keyboard back open each time the tab returns.
      if (!openedOnceRef.current) term.focus()
      openedOnceRef.current = true
    }
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data))
      }
    }
    ws.onclose = () => {
      // Guarded like Terminal.tsx's: a superseded socket's late close must
      // not clobber the state of the one that replaced it. Expected closes
      // (handleManualClose, auto-close after completion, unmount) are
      // filtered by reconnectAllowed inside scheduleReconnect.
      if (wsRef.current !== ws || !reconnectAllowed()) return
      setPhase('reconnecting')
      scheduleReconnect()
    }

    return () => {
      ws.close()
      if (wsRef.current === ws) wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, connectNonce])

  // Foreground return / network back: retry now instead of waiting out the
  // backoff. Both 'focus' and 'visibilitychange' for the same reason
  // Terminal.tsx listens to both (mobile doesn't reliably fire 'focus').
  useEffect(() => {
    const onForeground = () => {
      if (phaseRef.current === 'reconnecting') reconnectNow()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') onForeground()
    }
    window.addEventListener('focus', onForeground)
    window.addEventListener('online', onForeground)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onForeground)
      window.removeEventListener('online', onForeground)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Status polling: looks for hasCompletedOnboarding flipping true (see the
  // component doc comment for why this, not auth.loggedIn) - a plain file
  // read server-side (internal/claudecode.HasCompletedOnboarding), cheap
  // enough to poll this often and far more robust than trying to parse
  // completion out of the PTY's own ANSI-heavy output. Keeps running while
  // disconnected: the flow may have finished on the server side anyway.
  const pollActive = sessionId !== null && phase !== 'starting' && phase !== 'completed'
  useEffect(() => {
    if (!pollActive) return
    const interval = window.setInterval(async () => {
      try {
        const status = await api.get<ClaudeOnboardingStatus>('/claude/onboarding-status')
        if (baselineCompletedRef.current === null) baselineCompletedRef.current = status.completed
        if (status.completed && !baselineCompletedRef.current && !completedRef.current) {
          completedRef.current = true
          clearReconnectTimer()
          setPhase('completed')
          onLoggedIn()
        }
      } catch {
        // Transient failure - just try again next tick.
      }
    }, STATUS_POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollActive])

  // Closes the dialog immediately (removing it from the tree tears down the
  // effects above, closing the WebSocket) while letting the underlying CLI
  // process wind down in the background: two Ctrl+C bytes first (a graceful
  // exit an Ink-style CLI can act on), then an unconditional server-side
  // Close() a couple seconds later as a fallback - confirmed live that the
  // double Ctrl+C alone doesn't always land in time, so this fallback is
  // load-bearing, not just defensive. Both are fire-and-forget: the ws/
  // sessionId refs stay valid after unmount since the closures hold the ref
  // objects themselves, not component state.
  const handleManualClose = () => {
    closingRef.current = true
    clearReconnectTimer()
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode('\x03'))
      window.setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode('\x03'))
        }
      }, INTERRUPT_GAP_MS)
    }
    window.setTimeout(cancelSession, CLOSE_FALLBACK_DELAY_MS)
    // Without a detected completion the parent still shows the status it
    // had when this opened, so a login finished here in fallback mode - or
    // one abandoned after credentials were saved, the logged-in-but-not-
    // onboarded state ClaudeCode.tsx warns about - would stay invisible
    // until a manual reload. onLoggedIn is the parent's status reload.
    if (!completedRef.current) onLoggedIn()
    onClose()
  }

  // Auto-close once hasCompletedOnboarding is genuinely true (see the
  // status-polling effect above) - shows a brief "완료!" banner, then
  // reuses the same graceful-then-forced close handleManualClose already
  // does for the user-initiated path.
  useEffect(() => {
    if (phase !== 'completed' || closeScheduledRef.current) return
    closeScheduledRef.current = true
    const t = window.setTimeout(handleManualClose, AUTO_CLOSE_DELAY_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // Safety net: `claude` only shows its first-run wizard while onboarding is
  // incomplete. Opened as the fallback on an already-onboarded instance, or
  // when onboarding completed elsewhere in the meantime, the CLI skips
  // straight to the normal chat REPL with no login screen at all (the race
  // was confirmed live) - the REPL's
  // own `/login` slash command reopens the same login-method chooser the
  // wizard shows, so this button types it in rather than trying to
  // auto-detect "which screen is this" from the PTY's own ANSI-heavy
  // output (fragile, CLI-version-dependent). Harmless to click during the
  // wizard itself too (the CLI ignores keys a plain selection screen
  // doesn't recognize).
  const handleOpenLoginMenu = () => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode('/login\r'))
    }
    termRef.current?.focus()
  }

  const handleUnlockAndReconnect = () => {
    requestUnlock()
      .then(() => {
        setPhase('reconnecting')
        reconnectNow()
      })
      .catch(() => {})
  }

  const terminalVisible = phase !== 'starting' && phase !== 'error'
  const terminalStale = phase === 'reconnecting' || phase === 'locked'

  return (
    <div className="interactive-login-backdrop" onClick={handleManualClose}>
      <div
        className="card interactive-login-card"
        role="dialog"
        aria-modal="true"
        aria-label="Claude Code 로그인"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Claude Code 로그인</h2>
        <p className="interactive-login-guide">
          아래는 실제 <code>claude</code> CLI 터미널입니다. 화면 안내를 따라 테마 선택 → 로그인 방법 선택 →
          브라우저에서 로그인까지 진행해주세요. 로그인 링크는 클릭하면 바로 열립니다. 온보딩이 완전히 끝나면
          자동으로 닫힙니다.
        </p>

        {phase === 'starting' && <div className="interactive-login-status">시작하는 중...</div>}
        {phase === 'connecting' && <div className="interactive-login-status">연결하는 중...</div>}
        {phase === 'reconnecting' && (
          <div className="interactive-login-status interactive-login-status-row">
            <span>연결이 끊겨 다시 연결하는 중... 로그인은 서버에서 계속 진행 중입니다.</span>
            <button type="button" className="btn btn-secondary btn-small" onClick={reconnectNow}>
              지금 재연결
            </button>
          </div>
        )}
        {phase === 'locked' && (
          <div className="interactive-login-status interactive-login-status-row interactive-login-error">
            <span>잠금이 만료되어 다시 연결할 수 없습니다. 잠금을 해제하면 이어서 진행합니다.</span>
            <button type="button" className="btn btn-secondary btn-small" onClick={handleUnlockAndReconnect}>
              잠금 해제 후 재연결
            </button>
          </div>
        )}
        {phase === 'error' && error && (
          <div className="interactive-login-status interactive-login-status-row interactive-login-error">
            <span>{error}</span>
            <button type="button" className="btn btn-secondary btn-small" onClick={startSession}>
              로그인 다시 시작
            </button>
          </div>
        )}

        <div
          ref={containerRef}
          className={`interactive-login-terminal${terminalStale ? ' interactive-login-terminal-stale' : ''}`}
          style={{ display: terminalVisible ? 'block' : 'none' }}
        />

        {phase === 'running' && (
          <div className="interactive-login-actions interactive-login-actions-left">
            <button type="button" className="btn btn-secondary btn-small" onClick={handleOpenLoginMenu}>
              로그인 메뉴 열기 (/login)
            </button>
          </div>
        )}

        {phase === 'completed' && (
          <p className="interactive-login-status interactive-login-success">
            온보딩 완료! 잠시 후 자동으로 닫힙니다...
          </p>
        )}

        <div className="interactive-login-actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={handleManualClose}>
            {phase === 'completed' ? '완료' : '닫기'}
          </button>
        </div>
      </div>
    </div>
  )
}
