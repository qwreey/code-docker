import { useEffect, useState } from 'react'
import { Sheet } from '../common/Sheet'
import { ErrorBanner } from '../common/ErrorBanner'
import type { KeyBinding, TerminalSettings, TerminalTheme } from '../../api/types'
import { BUILTIN_THEMES, THEME_COLOR_KEYS, findTheme, type ThemeColorKey } from './themes'
import { bytesToDisplay, displayToBytes } from './escapeCodec'
import './TerminalSettingsPanel.css'

function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

type ThemeDraft = {
  editingId: string | null // null == creating a brand new custom theme
  name: string
  colors: Record<ThemeColorKey, string>
}

function seedDraft(theme: TerminalTheme, editingId: string | null): ThemeDraft {
  const colors = {} as Record<ThemeColorKey, string>
  for (const key of THEME_COLOR_KEYS) {
    colors[key] = theme.colors[key] ?? '#000000'
  }
  return { editingId, name: editingId ? theme.name : `${theme.name} 사본`, colors }
}

export function TerminalSettingsPanel({
  open,
  onClose,
  settings,
  saving,
  error,
  onDismissError,
  onSave,
  onPreviewTheme,
}: {
  open: boolean
  onClose: () => void
  settings: TerminalSettings
  saving: boolean
  error: string | null
  onDismissError: () => void
  onSave: (next: TerminalSettings) => void
  onPreviewTheme: (colors: Record<string, string>) => void
}) {
  const [draftKeybindings, setDraftKeybindings] = useState<KeyBinding[]>(settings.keybindings)
  const [themeDraft, setThemeDraft] = useState<ThemeDraft | null>(null)

  useEffect(() => {
    if (open) {
      setDraftKeybindings(settings.keybindings)
      setThemeDraft(null)
    }
    // Only resync when the panel opens (or settings identity changes while
    // open, e.g. after a save) -- not on every settings.keybindings render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings])

  if (!open) return null

  function updateBinding(id: string, patch: Partial<KeyBinding>) {
    setDraftKeybindings((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)))
  }

  function removeBinding(id: string) {
    setDraftKeybindings((prev) => prev.filter((b) => b.id !== id))
  }

  function addBinding() {
    setDraftKeybindings((prev) => [...prev, { id: genId(), label: '새 키', bytes: '' }])
  }

  function saveKeybindings() {
    onSave({ ...settings, keybindings: draftKeybindings })
  }

  function selectTheme(themeId: string) {
    const theme = findTheme(themeId, settings.customThemes)
    onPreviewTheme(theme.colors)
    onSave({ ...settings, themeId })
  }

  function startCreateTheme() {
    const base = findTheme(settings.themeId, settings.customThemes)
    const draft = seedDraft(base, null)
    setThemeDraft(draft)
    onPreviewTheme(draft.colors)
  }

  function startEditTheme(theme: TerminalTheme) {
    const draft = seedDraft(theme, theme.id)
    setThemeDraft(draft)
    onPreviewTheme(draft.colors)
  }

  function cancelThemeDraft() {
    setThemeDraft(null)
    onPreviewTheme(findTheme(settings.themeId, settings.customThemes).colors)
  }

  function updateDraftColor(key: ThemeColorKey, value: string) {
    setThemeDraft((prev) => {
      if (!prev) return prev
      const next = { ...prev, colors: { ...prev.colors, [key]: value } }
      onPreviewTheme(next.colors)
      return next
    })
  }

  function saveThemeDraft() {
    if (!themeDraft) return
    const id = themeDraft.editingId ?? genId()
    const saved: TerminalTheme = { id, name: themeDraft.name.trim() || '이름 없는 테마', colors: themeDraft.colors }
    const customThemes = themeDraft.editingId
      ? settings.customThemes.map((t) => (t.id === id ? saved : t))
      : [...settings.customThemes, saved]
    setThemeDraft(null)
    onSave({ ...settings, customThemes, themeId: id })
  }

  function deleteTheme(themeId: string) {
    if (!window.confirm('이 사용자 정의 테마를 삭제하시겠습니까?')) return
    const customThemes = settings.customThemes.filter((t) => t.id !== themeId)
    const themeIdWasSelected = settings.themeId === themeId
    const nextThemeId = themeIdWasSelected ? BUILTIN_THEMES[0].id : settings.themeId
    if (themeIdWasSelected) onPreviewTheme(BUILTIN_THEMES[0].colors)
    onSave({ ...settings, customThemes, themeId: nextThemeId })
  }

  return (
    <Sheet open={open} onClose={onClose} title="터미널 설정">
      {error && <ErrorBanner message={error} onDismiss={onDismissError} />}

      <section className="terminal-settings-section">
        <h4>특수키 (컨트롤 바)</h4>
        <p className="section-description">
          모바일 컨트롤 바에 표시될 버튼입니다. Ctrl/Alt/Shift는 눌러서 다음 입력에 적용되는 sticky 모디파이어로
          동작하며 bytes 값은 사용되지 않습니다.
        </p>
        <div className="terminal-keybinding-list">
          {draftKeybindings.map((b) => (
            <div key={b.id} className="terminal-keybinding-row">
              <input
                className="terminal-keybinding-label"
                value={b.label}
                onChange={(e) => updateBinding(b.id, { label: e.target.value })}
                aria-label="라벨"
              />
              <input
                className="terminal-keybinding-bytes mono-cell"
                value={bytesToDisplay(b.bytes)}
                onChange={(e) => updateBinding(b.id, { bytes: displayToBytes(e.target.value) })}
                placeholder="\x1b[A 형식"
                aria-label="바이트"
              />
              <button type="button" className="btn btn-danger btn-small" onClick={() => removeBinding(b.id)}>
                삭제
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-keybinding-actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={addBinding}>
            + 키 추가
          </button>
          <button type="button" className="btn btn-primary btn-small" onClick={saveKeybindings} disabled={saving}>
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </section>

      <section className="terminal-settings-section">
        <h4>색 테마</h4>
        <p className="section-description">
          기본 제공 테마 10종은 수정할 수 없습니다. 항목을 선택하면 즉시 적용되고 저장됩니다.
        </p>
        <div className="terminal-theme-grid">
          {BUILTIN_THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`terminal-theme-swatch${settings.themeId === theme.id ? ' active' : ''}`}
              style={{ background: theme.colors.background, color: theme.colors.foreground }}
              onClick={() => selectTheme(theme.id)}
              title={theme.name}
            >
              {theme.name}
            </button>
          ))}
          {settings.customThemes.map((theme) => (
            <div key={theme.id} className="terminal-theme-custom-item">
              <button
                type="button"
                className={`terminal-theme-swatch${settings.themeId === theme.id ? ' active' : ''}`}
                style={{ background: theme.colors.background, color: theme.colors.foreground }}
                onClick={() => selectTheme(theme.id)}
                title={theme.name}
              >
                {theme.name}
              </button>
              <div className="terminal-theme-custom-actions">
                <button type="button" className="btn btn-secondary btn-small" onClick={() => startEditTheme(theme)}>
                  편집
                </button>
                <button type="button" className="btn btn-danger btn-small" onClick={() => deleteTheme(theme.id)}>
                  삭제
                </button>
              </div>
            </div>
          ))}
        </div>

        {!themeDraft && (
          <button type="button" className="btn btn-secondary btn-small" onClick={startCreateTheme}>
            + 사용자 정의 테마 추가
          </button>
        )}

        {themeDraft && (
          <div className="terminal-theme-editor">
            <div className="form-field">
              <label htmlFor="terminal-theme-name">이름</label>
              <input
                id="terminal-theme-name"
                value={themeDraft.name}
                onChange={(e) => setThemeDraft((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              />
            </div>
            <div className="terminal-theme-color-grid">
              {THEME_COLOR_KEYS.map((key) => (
                <label key={key} className="terminal-theme-color-field">
                  <span>{key}</span>
                  <input
                    type="color"
                    value={themeDraft.colors[key]}
                    onChange={(e) => updateDraftColor(key, e.target.value)}
                  />
                </label>
              ))}
            </div>
            <div className="terminal-keybinding-actions">
              <button type="button" className="btn btn-secondary btn-small" onClick={cancelThemeDraft}>
                취소
              </button>
              <button type="button" className="btn btn-primary btn-small" onClick={saveThemeDraft} disabled={saving}>
                {saving ? '저장 중...' : '테마 저장'}
              </button>
            </div>
          </div>
        )}
      </section>
    </Sheet>
  )
}
