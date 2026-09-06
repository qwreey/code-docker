import { useEffect, useState } from 'react'
import { Sheet } from '../common/Sheet'
import { ErrorBanner } from '../common/ErrorBanner'
import { ConfirmDialog } from '../common/ConfirmDialog'
import type { KeyBinding, TerminalSettings, TerminalTheme } from '../../api/types'
import type { TerminalInputMode } from './Terminal'
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
  fontFamilies,
  inputMode,
  onChangeInputMode,
  inputDebugEnabled,
  onToggleInputDebug,
  altScreenTouchScrollEnabled,
  onToggleAltScreenTouchScroll,
  autoReconnectEnabled,
  onToggleAutoReconnect,
  controlBarEnabled,
  onToggleControlBarEnabled,
}: {
  open: boolean
  onClose: () => void
  settings: TerminalSettings
  saving: boolean
  error: string | null
  onDismissError: () => void
  onSave: (next: TerminalSettings) => void
  onPreviewTheme: (colors: Record<string, string>) => void
  fontFamilies: string[]
  inputMode: TerminalInputMode
  onChangeInputMode: (mode: TerminalInputMode) => void
  inputDebugEnabled: boolean
  onToggleInputDebug: (enabled: boolean) => void
  altScreenTouchScrollEnabled: boolean
  onToggleAltScreenTouchScroll: (enabled: boolean) => void
  autoReconnectEnabled: boolean
  onToggleAutoReconnect: (enabled: boolean) => void
  controlBarEnabled: boolean
  onToggleControlBarEnabled: (enabled: boolean) => void
}) {
  const [draftKeybindings, setDraftKeybindings] = useState<KeyBinding[]>(settings.keybindings)
  const [draftDetachSequence, setDraftDetachSequence] = useState(bytesToDisplay(settings.detachSequence))
  const [themeDraft, setThemeDraft] = useState<ThemeDraft | null>(null)
  const [confirmDeleteTheme, setConfirmDeleteTheme] = useState<TerminalTheme | null>(null)

  useEffect(() => {
    if (open) {
      setDraftKeybindings(settings.keybindings)
      setDraftDetachSequence(bytesToDisplay(settings.detachSequence))
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

  function saveDetachSequence(display: string) {
    setDraftDetachSequence(display)
    onSave({ ...settings, detachSequence: displayToBytes(display) })
  }

  function selectFontFamily(family: string) {
    onSave({ ...settings, fontFamily: family })
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
    const customThemes = settings.customThemes.filter((t) => t.id !== themeId)
    const themeIdWasSelected = settings.themeId === themeId
    const nextThemeId = themeIdWasSelected ? BUILTIN_THEMES[0].id : settings.themeId
    if (themeIdWasSelected) onPreviewTheme(BUILTIN_THEMES[0].colors)
    onSave({ ...settings, customThemes, themeId: nextThemeId })
    setConfirmDeleteTheme(null)
  }

  return (
    <>
    <Sheet open={open} onClose={onClose} title="터미널 설정">
      {error && <ErrorBanner message={error} onDismiss={onDismissError} />}

      <section className="terminal-settings-section">
        <h4>특수키 (컨트롤 바)</h4>
        <p className="section-description">
          모바일 컨트롤 바에 표시될 버튼입니다. Ctrl/Alt/Shift는 눌러서 다음 입력에 적용되는 sticky 모디파이어로
          동작하며 bytes 값은 사용되지 않습니다.
        </p>
        <label className="checkbox-option">
          <input
            type="checkbox"
            checked={controlBarEnabled}
            onChange={(e) => onToggleControlBarEnabled(e.target.checked)}
          />
          컨트롤 바 표시
        </label>
        <p className="section-description">
          물리 키보드가 이미 있는 데스크탑(마우스/트랙패드)에서는 기본으로 꺼져 있습니다 — 아래 버튼들이 대부분
          잉여 기능이기 때문입니다. 기기별로 저장되며, 다른 두 실험적 옵션과 달리 껐다 켜면 터미널 탭을 나갔다
          들어올 필요 없이 바로 적용됩니다. 바를 끄면 확대/축소(줌) 버튼만 탭 목록 오른쪽으로 자리를 옮겨 계속
          쓸 수 있습니다.
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
        <h4>Attach 종료 시퀀스</h4>
        <p className="section-description">
          SSH나 code-server 터미널에서 <code>attach</code>로 붙었을 때, 이 시퀀스를 입력하면 세션은 그대로 둔 채
          로컬에서만 빠져나갑니다(브라우저 탭을 닫는 것과 동일). 기본값은 Ctrl+]입니다 — Docker 스타일 Ctrl+P Ctrl+Q는
          code-server 자체 단축키(빠른 열기)와 겹쳐서 그 안에서는 안 먹을 수 있어 기본값에서는 제외했지만, 아래에서
          여전히 선택할 수 있습니다. Ctrl+[는 터미널에서 Esc와 완전히 같은 바이트라 vim 등에서 오작동하니 피하는
          것을 권장합니다.
        </p>
        <div className="terminal-keybinding-actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={() => saveDetachSequence('\\x1d')}>
            Ctrl+] (기본값)
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => saveDetachSequence('\\x10\\x11')}>
            Ctrl+P Ctrl+Q
          </button>
        </div>
        <div className="terminal-detach-sequence-row">
          <input
            className="mono-cell"
            value={draftDetachSequence}
            onChange={(e) => setDraftDetachSequence(e.target.value)}
            placeholder="\x1d 형식"
            aria-label="Attach 종료 시퀀스"
          />
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => saveDetachSequence(draftDetachSequence)}
            disabled={saving}
          >
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </section>

      <section className="terminal-settings-section">
        <h4>폰트</h4>
        <p className="section-description">
          웹매니저 터미널에 적용할 폰트입니다. 폰트 탭에서 업로드한 폰트만 선택할 수 있습니다.
        </p>
        <div className="form-field">
          <label htmlFor="terminal-font-select">폰트</label>
          <select
            id="terminal-font-select"
            value={settings.fontFamily}
            onChange={(e) => selectFontFamily(e.target.value)}
          >
            <option value="">시스템 기본</option>
            {fontFamilies.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="terminal-settings-section">
        <h4>자동 재연결</h4>
        <p className="section-description">
          연결이 끊기면(모바일에서 앱을 백그라운드로 보냈다가 돌아오는 경우가 대표적) 잠시 후 자동으로 다시
          연결을 시도합니다. 서버가 실제로 꺼져 있을 때 계속 두드리지 않도록 재시도 간격은 점점 늘어나며(최대
          30초), 화면으로 돌아오면 대기 중이던 재시도를 기다리지 않고 바로 한 번 더 시도합니다. 껐다 켜도 바로
          적용되며, 다른 두 실험적 옵션과 달리 터미널 탭을 나갔다 들어올 필요가 없습니다.
        </p>
        <label className="checkbox-option">
          <input
            type="checkbox"
            checked={autoReconnectEnabled}
            onChange={(e) => onToggleAutoReconnect(e.target.checked)}
          />
          연결이 끊기면 자동으로 재연결
        </label>
      </section>

      <section className="terminal-settings-section">
        <h4>모바일 입력 · 스크롤 (실험적)</h4>
        <p className="section-description">
          모바일 가상 키보드는 예측 입력(자동완성) 때문에 터미널과 잘 맞지 않습니다. 기기/키보드 앱마다 증상이
          달라서, 어느 하나가 항상 옳지 않기 때문에 세 가지 방식 중에 고를 수 있게 해뒀습니다. 터치 기기에서만
          적용되고 데스크탑에는 영향이 없으며, 바꾸면 바로 적용됩니다(탭을 나갔다 들어올 필요 없음).
        </p>
        <div className="form-field">
          <label htmlFor="terminal-input-mode-select">입력 방식</label>
          <select
            id="terminal-input-mode-select"
            value={inputMode}
            onChange={(e) => onChangeInputMode(e.target.value as TerminalInputMode)}
          >
            <option value="diff">새 입력 필드 (권장) — 한글 조합 유지 + 중복 입력 방지</option>
            <option value="password">비밀번호 필드 — 예측 입력 완전 차단, 한글 깨짐</option>
            <option value="native">끔 (xterm 기본) — 예측 입력 버퍼링/중복 발생</option>
          </select>
        </div>
        <p className="section-description">
          <strong>새 입력 필드</strong>는 숨겨진 <code>&lt;textarea&gt;</code>에 입력을 그대로 쌓아두고, 이미
          터미널로 보낸 내용과의 <em>차이만</em> 계산해서 보냅니다. 키보드가 이미 확정한 문장을 다시 흘려보내도
          차이가 없으니 아무것도 안 보내게 되고(중복 입력 방지), 조합은 textarea에서 정상적으로 일어나므로 한글도
          깨지지 않습니다. <strong>비밀번호 필드</strong>는 예측 입력을 확실히 끄는 대신 IME 조합 자체를 막아
          한글이 자모로 쪼개집니다. <strong>끔</strong>은 xterm 기본 동작으로, 삼성 키보드에서
          &quot;가나다. 가나다.&quot;처럼 중복 입력이 생길 수 있습니다.
        </p>
        <label className="checkbox-option">
          <input
            type="checkbox"
            checked={inputDebugEnabled}
            onChange={(e) => onToggleInputDebug(e.target.checked)}
          />
          입력 디버그 표시 (최근 입력 이벤트를 터미널 위에 표시)
        </label>
        <p className="section-description">
          입력이 여전히 이상하면 이걸 켜고 문제가 나는 상황을 한 번 재현한 뒤 화면을 캡처해 주세요. 어떤 이벤트가
          어떤 값으로 오는지, 실제로 어떤 바이트를 보냈는지가 그대로 찍힙니다.
        </p>
        <p className="section-description">
          <code>claude</code>, <code>vim</code>, <code>htop</code>처럼 화면 전체를 쓰는 앱(대체 화면 버퍼)에서는
          터미널 자체를 스크롤할 것이 없기 때문에, 터치 스크롤을 터미널 화면 이동이 아니라 앱에 전달할 스크롤
          입력(마우스 휠 보고 또는 위/아래 키)으로 바꿔 보냅니다. 데스크탑에서 휠을 굴렸을 때와 똑같은 동작이고,
          일반 셸 화면에서는 지금처럼 그대로 스크롤됩니다. 앱이 휠 입력을 이상하게 처리하면 꺼서 예전 동작으로
          되돌릴 수 있습니다.
        </p>
        <label className="checkbox-option">
          <input
            type="checkbox"
            checked={altScreenTouchScrollEnabled}
            onChange={(e) => onToggleAltScreenTouchScroll(e.target.checked)}
          />
          전체 화면 앱에서 터치 스크롤을 앱으로 전달
        </label>
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
                <button type="button" className="btn btn-danger btn-small" onClick={() => setConfirmDeleteTheme(theme)}>
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

    <ConfirmDialog
      open={confirmDeleteTheme !== null}
      onClose={() => setConfirmDeleteTheme(null)}
      onConfirm={() => confirmDeleteTheme && deleteTheme(confirmDeleteTheme.id)}
      title="테마 삭제"
      confirmLabel="삭제"
    >
      &quot;{confirmDeleteTheme?.name}&quot; 사용자 정의 테마를 삭제하시겠습니까?
    </ConfirmDialog>
    </>
  )
}
