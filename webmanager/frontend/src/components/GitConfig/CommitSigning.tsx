import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../api/client'
import type { GitSigningConfig, GitSigningMode, SshSigningKey } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { CopyButton } from '../common/CopyButton'
import { GpgKeys } from './GpgKeys'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

const MODE_LABELS: Record<GitSigningMode, string> = {
  none: '없음',
  ssh: 'SSH',
  gpg: 'GPG',
}

export function CommitSigning() {
  const [mode, setMode] = useState<GitSigningMode>('none')
  const [signingKey, setSigningKey] = useState('')
  const [commitGpgSign, setCommitGpgSign] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [generatingSshKey, setGeneratingSshKey] = useState(false)
  const [sshKeyError, setSshKeyError] = useState<string | null>(null)
  const [generatedSshKey, setGeneratedSshKey] = useState<SshSigningKey | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<GitSigningConfig>('/git/signing')
      .then((data) => {
        if (cancelled) return
        setMode(data.mode)
        setSigningKey(data.signingKey)
        setCommitGpgSign(data.commitGpgSign)
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e))
      })
      .finally(() => {
        if (!cancelled) withViewTransition(() => setLoading(false))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const data = await api.put<GitSigningConfig>('/git/signing', {
        mode,
        signingKey,
        commitGpgSign,
      })
      setMode(data.mode)
      setSigningKey(data.signingKey)
      setCommitGpgSign(data.commitGpgSign)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  async function handleGenerateSshKey() {
    setGeneratingSshKey(true)
    setSshKeyError(null)
    try {
      const data = await api.post<SshSigningKey>('/git/signing/ssh-key')
      setGeneratedSshKey(data)
      setSigningKey(data.publicKeyPath)
    } catch (e) {
      setSshKeyError(errorMessage(e))
    } finally {
      setGeneratingSshKey(false)
    }
  }

  return (
    <div className="card">
      <h2>커밋 서명</h2>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loading ? (
        <Skeleton />
      ) : (
        <>
          <form onSubmit={handleSubmit}>
            <div className="radio-group">
              {(Object.keys(MODE_LABELS) as GitSigningMode[]).map((m) => (
                <label key={m} className="radio-option">
                  <input
                    type="radio"
                    name="signing-mode"
                    value={m}
                    checked={mode === m}
                    onChange={() => setMode(m)}
                  />
                  {MODE_LABELS[m]}
                </label>
              ))}
            </div>

            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="signing-key">
                  서명 키 ({mode === 'ssh' ? 'identity 파일 경로' : mode === 'gpg' ? 'GPG 키 ID' : '-'})
                </label>
                <input
                  id="signing-key"
                  value={signingKey}
                  onChange={(e) => setSigningKey(e.target.value)}
                  disabled={mode === 'none'}
                  placeholder={mode === 'ssh' ? '/code/.ssh/signing_key.pub' : mode === 'gpg' ? 'ABCDEF1234567890' : ''}
                />
              </div>
            </div>

            <label className="checkbox-option">
              <input
                type="checkbox"
                checked={commitGpgSign}
                onChange={(e) => setCommitGpgSign(e.target.checked)}
              />
              커밋마다 자동 서명
            </label>

            <div className="commit-signing-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? '저장하는 중...' : saved ? '저장됨' : '저장'}
              </button>
            </div>
          </form>

          {mode === 'ssh' && (
            <div className="ssh-signing-key-section">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={generatingSshKey}
                onClick={handleGenerateSshKey}
              >
                {generatingSshKey ? '생성하는 중...' : '새 서명용 SSH 키 생성'}
              </button>
              {sshKeyError && <ErrorBanner message={sshKeyError} onDismiss={() => setSshKeyError(null)} />}
              {generatedSshKey && (
                <div className="new-key-callout">
                  <p>
                    새 서명용 SSH 키가 생성되었습니다 (아직 저장되지 않음 — <strong>저장</strong> 버튼을 눌러야
                    적용됩니다). 이 공개키를 GitHub/GitLab의 서명 검증 키(signing key)로 등록하세요.
                  </p>
                  <div className="copyable-block">
                    <code>{generatedSshKey.publicKey}</code>
                    <CopyButton text={generatedSshKey.publicKey} />
                  </div>
                </div>
              )}
            </div>
          )}

          {mode === 'gpg' && (
            <GpgKeys
              onUseKey={(keyId) => {
                setMode('gpg')
                setSigningKey(keyId)
              }}
            />
          )}
        </>
      )}
    </div>
  )
}
