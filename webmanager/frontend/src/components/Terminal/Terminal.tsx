import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import '../common/common.css'
import { api, errorMessage } from '../../api/client'
import type { TerminalSettings } from '../../api/types'
import { DEFAULT_KEYBINDINGS, type ModifierId } from './keybindings'
import { DEFAULT_THEME_ID, findTheme, themeToXterm } from './themes'
import { applyModifier } from './modifiers'
import { TerminalControls } from './TerminalControls'
import { TerminalSettingsPanel } from './TerminalSettingsPanel'
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

export function Terminal() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const armedModifierRef = useRef<ModifierId | null>(null)

  const [state, setState] = useState<ConnectionState>('connecting')
  const [settings, setSettings] = useState<TerminalSettings | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [armedModifier, setArmedModifier] = useState<ModifierId | null>(null)

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
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/terminal`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      setState('connected')
      fitAddon.fit()
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    ws.onclose = () => setState('disconnected')
    ws.onerror = () => setState('disconnected')
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data))
      }
    }

    // Routed through sendBytes so a sticky modifier armed via the on-screen
    // control bar also applies to the very next real keypress/paste.
    const dataDisposable = term.onData((data) => sendBytes(data))

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      dataDisposable.dispose()
      ws.close()
      wsRef.current = null
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <section className="terminal-section">
      <div className="section-header">
        <h1>Terminal</h1>
        <div className="terminal-header-actions">
          <span className={`badge ${STATE_BADGE_CLASS[state]}`}>{STATE_LABEL[state]}</span>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setSettingsOpen(true)}>
            설정
          </button>
        </div>
      </div>
      <p className="section-description">
        브라우저에서 바로 열리는 쉘 세션입니다. 탭을 닫거나 연결이 끊기면 세션이 즉시 종료됩니다.
      </p>
      {settingsError && (
        <p className="section-description">터미널 설정을 불러오지 못했습니다 ({settingsError}) — 기본값을 사용합니다.</p>
      )}
      <TerminalControls
        keybindings={effectiveSettings.keybindings}
        armedModifier={armedModifier}
        onArmModifier={armModifier}
        onSendBytes={sendBytes}
      />
      <div ref={containerRef} className="terminal-container" />
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
