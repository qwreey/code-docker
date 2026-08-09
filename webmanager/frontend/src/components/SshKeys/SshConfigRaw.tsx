import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { ExpandableEditor } from '../common/ExpandableEditor'
import { RequiresUnlock } from '../common/RequiresUnlock'
import { withViewTransition } from '../../utils/viewTransition'

function SshConfigRawInner() {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ content: string }>('/git/ssh-config/raw')
      setContent(data.content)
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

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await api.put<{ ok: true }>('/git/ssh-config/raw', { content })
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
      <h2>원본 SSH config 편집</h2>
      <p className="raw-config-note">
        <code>~/.ssh/config</code> 전체를 직접 편집합니다. <code>ProxyJump</code>, <code>Port</code>,{' '}
        <code>Host *</code> 같이 위 구조화된 호스트 목록이 다루지 못하는 설정도 여기서 작성할 수 있습니다. 저장 시
        문법을 검사하며, 잘못된 문법은 저장되지 않습니다.
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : (
        <>
          <ExpandableEditor
            value={content}
            onChange={setContent}
            language="plain"
            readOnly={false}
            triggerLabel="원본 편집 (SSH config)"
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

// Wrapped in RequiresUnlock (reads included, not just the save) — unlike
// RawConfigEditor's .gitconfig editor, this file can carry ProxyJump hosts,
// usernames, and internal hostnames that shouldn't be visible without
// unlocking first.
export function SshConfigRaw() {
  return (
    <RequiresUnlock>
      <SshConfigRawInner />
    </RequiresUnlock>
  )
}
