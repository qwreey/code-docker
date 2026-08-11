import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, apiUrl, errorMessage } from '../../api/client'
import type { ClaudeInteractiveLoginStartResponse, ClaudeOnboardingStatus } from '../../api/types'
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

const XTERM_THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
}

type Phase = 'starting' | 'connecting' | 'running' | 'completed' | 'error'

// InteractiveLoginDialog embeds the real, interactive `claude` CLI (its own
// first-run onboarding wizard - theme picker, then "Select login method")
// in a live terminal, instead of driving `claude auth login` headlessly.
// This exists because the headless flow (see LoginPanel) writes valid
// credentials `claude auth status` recognizes immediately, but never marks
// the interactive wizard's own separate "onboarding complete" state
// (~/.claude.json's hasCompletedOnboarding) - so a bare `claude` launched
// afterward in e.g. code-server's integrated terminal still shows the same
// login-method screen from scratch, ignoring the credentials that already
// exist. Going through the real wizard once is the only way to clear that.
// See root CLAUDE.md's webmanager section for the incident this was built
// to fix. ClaudeCode.tsx only ever opens this dialog when
// GET /api/claude/onboarding-status already reports incomplete - once it's
// complete once, the plain headless flow (LoginPanel) is sufficient on its
// own for logging back in, since re-onboarding is never required again.
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
  // unexpected close as an error) tell "we did this on purpose" apart from
  // a real crash/timeout.
  const closingRef = useRef(false)
  // True once onLoggedIn() has fired, so a second status-poll tick landing
  // before its own interval clears doesn't call it twice.
  const completedRef = useRef(false)
  // Guards the auto-close-on-completed effect so it only ever schedules
  // itself once, even if phase is set to 'completed' again for some reason.
  const closeScheduledRef = useRef(false)

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('starting')
  const [error, setError] = useState<string | null>(null)

  // Best-effort: closes session on disk (SIGHUP -> SIGKILL after grace) if
  // it's still the current one. Safe to call more than once, and safe to
  // call after the CLI already exited on its own.
  const cancelSession = () => {
    const id = sessionIdRef.current
    if (!id) return
    api.post(`/claude/login/interactive/${encodeURIComponent(id)}/cancel`).catch(() => {})
  }

  // Start the interactive session once on mount.
  useEffect(() => {
    let cancelled = false
    api
      .post<ClaudeInteractiveLoginStartResponse>('/claude/login/interactive/start')
      .then((res) => {
        if (cancelled) return
        sessionIdRef.current = res.sessionId
        setSessionId(res.sessionId)
        setPhase('connecting')
      })
      .catch((e) => {
        if (cancelled) return
        setError(errorMessage(e))
        setPhase('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // xterm + WebSocket, created once sessionId is known. Single effect
  // (unlike Terminal.tsx's split xterm/WS effects) since this dialog only
  // ever has one session for its whole lifetime - no tab-switching to
  // support.
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
    // covers the copy affordance.
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

    const dataDisposable = term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data))
      }
    })

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(
      `${protocol}//${window.location.host}${apiUrl(`/claude/login/interactive/${encodeURIComponent(sessionId)}`)}`,
    )
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      setPhase('running')
      fitAddon.fit()
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      term.focus()
    }
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data))
      }
    }
    ws.onclose = () => {
      // Expected once the user clicks the close/done button (closingRef is
      // set first, see handleManualClose). Otherwise (crash, the manager's
      // own 10-minute timeout, network drop) surface it rather than
      // leaving the dialog looking stuck.
      if (!closingRef.current) {
        setError('세션이 예기치 않게 종료되었습니다.')
        setPhase('error')
      }
    }

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
      ws.close()
      wsRef.current = null
    }
  }, [sessionId])

  // Status polling: looks for hasCompletedOnboarding flipping true (see the
  // component doc comment for why this, not auth.loggedIn) - a plain file
  // read server-side (internal/claudecode.HasCompletedOnboarding), cheap
  // enough to poll this often and far more robust than trying to parse
  // completion out of the PTY's own ANSI-heavy output.
  useEffect(() => {
    if (phase !== 'running') return
    const interval = window.setInterval(async () => {
      try {
        const status = await api.get<ClaudeOnboardingStatus>('/claude/onboarding-status')
        if (status.completed && !completedRef.current) {
          completedRef.current = true
          setPhase('completed')
          onLoggedIn()
        }
      } catch {
        // Transient failure - just try again next tick.
      }
    }, STATUS_POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // Unmount for any reason other than handleManualClose (e.g. a parent
  // stopping rendering this dialog directly) - best-effort cancel, mirroring
  // LoginPanel's own unmount-cancel behavior.
  useEffect(() => {
    return () => {
      if (!closingRef.current) cancelSession()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Closes the dialog immediately (removing it from the tree tears down the
  // effect above, closing the WebSocket) while letting the underlying CLI
  // process wind down in the background: two Ctrl+C bytes first (a graceful
  // exit an Ink-style CLI can act on), then an unconditional server-side
  // Close() a couple seconds later as a fallback - confirmed live that the
  // double Ctrl+C alone doesn't always land in time, so this fallback is
  // load-bearing, not just defensive. Both are fire-and-forget: the ws/
  // sessionId refs stay valid after unmount since the closures hold the ref
  // objects themselves, not component state.
  const handleManualClose = () => {
    closingRef.current = true
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

  // Safety net: ClaudeCode.tsx only opens this dialog when
  // GET /api/claude/onboarding-status already reported incomplete, so
  // `claude` should always show its first-run wizard here. But if that
  // check raced with something else completing onboarding in the
  // meantime, the CLI would skip straight to the normal chat REPL with no
  // login screen at all (confirmed live in exactly that race) - the REPL's
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
        {phase === 'error' && error && <div className="interactive-login-status interactive-login-error">{error}</div>}

        <div
          ref={containerRef}
          className="interactive-login-terminal"
          style={{ display: phase === 'starting' || phase === 'error' ? 'none' : 'block' }}
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
