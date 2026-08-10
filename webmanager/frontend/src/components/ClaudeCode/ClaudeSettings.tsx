import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { ClaudeSettingsRaw } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ExpandableEditor } from '../common/ExpandableEditor'
import { withViewTransition } from '../../utils/viewTransition'
import '../common/common.css'
import './ClaudeCode.css'

// Just enough parsing to drive the autoCompactEnabled toggle - no typed
// schema for the rest of the file, matching the explicit "skip a
// schema-validating editor" call webmanager/CLAUDE.md already made for
// code-server's own settings.json. null means "content isn't a JSON object
// right now" (mid-edit syntax error), which disables the toggle rather than
// guessing.
function parseAutoCompactEnabled(content: string): boolean | null {
  try {
    const obj: unknown = JSON.parse(content)
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
    // Omitted/absent means enabled - see root CLAUDE.md's binary-string
    // research note on this key's actual default.
    return (obj as Record<string, unknown>).autoCompactEnabled !== false
  } catch {
    return null
  }
}

/**
 * Claude Code CLI's own settings.json - a raw CodeMirror editor plus a
 * friendly toggle for autoCompactEnabled, both reading/writing the SAME
 * in-memory `content` string fetched once by this component. This is
 * deliberate: SshConfigRaw.tsx and GitConfig/RawConfigEditor.tsx each
 * independently re-GET their file on mount, which silently discards
 * whichever sub-view had unsaved edits whenever the user switched between a
 * structured tab and the raw tab (a real data-loss bug already shipped once
 * from that exact shape). Owning one fetch/one piece of state here and
 * having the toggle mutate `content` directly (rather than a second copy)
 * avoids that class of bug entirely.
 */
export function ClaudeSettings() {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // Snapshot of what was last loaded/saved, so handleSave can detect the
  // file changing elsewhere (e.g. edited directly on disk) while this
  // editor sat open, instead of silently clobbering it - same pattern as
  // RawConfigEditor/SshConfigRaw.
  const loadedContentRef = useRef('')

  const load = useCallback(async () => {
    try {
      const data = await api.get<ClaudeSettingsRaw>('/claude/settings')
      setContent(data.content)
      loadedContentRef.current = data.content
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      withViewTransition(() => setLoading(false))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const autoCompactEnabled = useMemo(() => parseAutoCompactEnabled(content), [content])

  function handleToggleAutoCompact(checked: boolean) {
    let obj: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(content)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>
      }
    } catch {
      // Content wasn't valid JSON - the toggle is disabled in that state, so
      // this branch is unreachable from the UI, but fall back to {} rather
      // than throwing either way.
    }
    if (checked) {
      delete obj.autoCompactEnabled
    } else {
      obj.autoCompactEnabled = false
    }
    setContent(JSON.stringify(obj, null, 2))
  }

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const latest = await api.get<ClaudeSettingsRaw>('/claude/settings')
      if (latest.content !== loadedContentRef.current) {
        setError('다른 곳에서 이 설정이 이미 바뀌었어요 — 새로고침한 뒤 다시 편집해주세요. 지금 저장하면 그 변경이 사라집니다.')
        return
      }
      await api.put<{ ok: true }>('/claude/settings', { content })
      loadedContentRef.current = content
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(`저장 실패 — 변경 사항이 적용되지 않았습니다: ${errorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <h2>settings.json</h2>
      <p className="raw-config-note">
        Claude Code CLI 자체의 설정 파일입니다 (모델, 테마, 자동 압축 등). 스키마 검증 없이 원본 텍스트를 그대로
        편집합니다 — code-server 자체 편집기가 이 파일을 다루기에 더 나으니, 세밀한 조정은 그쪽을 권장합니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : (
        <>
          <label className="claude-settings-toggle">
            <input
              type="checkbox"
              checked={autoCompactEnabled ?? true}
              disabled={autoCompactEnabled === null}
              onChange={(e) => handleToggleAutoCompact(e.target.checked)}
            />
            자동 압축(auto-compact) 사용
          </label>
          {autoCompactEnabled === null && (
            <p className="claude-settings-note">
              아래 JSON 문법 오류로 토글을 사용할 수 없습니다 — 원본을 먼저 고쳐주세요.
            </p>
          )}
          <ExpandableEditor
            value={content}
            onChange={setContent}
            language="plain"
            readOnly={false}
            triggerLabel="원본 편집 (settings.json)"
          />
          <div className="raw-config-actions">
            <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
              {saving ? '저장하는 중...' : saved ? '저장됨' : '저장'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
