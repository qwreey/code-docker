import { useRef, useState, type FormEvent } from 'react'
import { api, errorMessage } from '../../api/client'
import type { LookupExtensionResponse } from '../../api/types'
import { ConfirmDialog } from '../common/ConfirmDialog'
import '../common/common.css'
import './Extensions.css'

// Matches backend/internal/extensions' VSIXInstallTimeout (download 3 min +
// install 60s) plus margin; the default client timeout would abort a
// legitimate large download.
const VSIX_INSTALL_TIMEOUT_MS = 250_000

interface InstallFromUrlProps {
  installed: Set<string>
  installing: Set<string>
  // Installs from open-vsx through the same path as a recommended extension,
  // so it shares that row's progress state and restart prompt.
  onInstall: (id: string) => void
  onVsixInstalled: (id: string) => void
  onError: (message: string) => void
}

export function InstallFromUrl({ installed, installing, onInstall, onVsixInstalled, onError }: InstallFromUrlProps) {
  const [text, setText] = useState('')
  const [looking, setLooking] = useState(false)
  const [result, setResult] = useState<LookupExtensionResponse | null>(null)
  const [vsixConfirmOpen, setVsixConfirmOpen] = useState(false)
  const [vsixInstalling, setVsixInstalling] = useState<string | null>(null)

  // A lookup answering after the text changed (or a newer lookup started)
  // must not overwrite what the user is now looking at.
  const lookupSeq = useRef(0)

  function handleTextChange(value: string) {
    lookupSeq.current++
    setText(value)
    setResult(null)
    setLooking(false)
  }

  async function handleLookup(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || looking) return
    const seq = ++lookupSeq.current
    setLooking(true)
    setResult(null)
    try {
      const res = await api.get<LookupExtensionResponse>(`/code-extensions/lookup?text=${encodeURIComponent(text)}`)
      if (seq === lookupSeq.current) setResult(res)
    } catch (err) {
      if (seq === lookupSeq.current) onError(errorMessage(err))
    } finally {
      if (seq === lookupSeq.current) setLooking(false)
    }
  }

  async function confirmVsixInstall() {
    setVsixConfirmOpen(false)
    const id = result?.id
    if (!id || vsixInstalling) return
    setVsixInstalling(id)
    try {
      await api.post<{ ok: true }>('/code-extensions/install-vsix', { id }, VSIX_INSTALL_TIMEOUT_MS)
      onVsixInstalled(id)
    } catch (err) {
      onError(errorMessage(err))
    } finally {
      setVsixInstalling(null)
    }
  }

  const id = result?.id
  const info = result?.openVsx
  const fallback = result?.vsixFallback
  const isInstalled = id ? installed.has(id) : false
  const isInstalling = id ? installing.has(id) : false

  return (
    <div className="extensions-url-install">
      <form className="extensions-url-form" onSubmit={handleLookup}>
        <input
          type="text"
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          placeholder="마켓플레이스 URL 또는 publisher.name 붙여넣기"
          aria-label="익스텐션 URL 또는 id"
        />
        <button type="submit" className="btn btn-primary btn-small" disabled={looking || !text.trim()}>
          {looking ? '확인 중...' : '확인'}
        </button>
      </form>

      {result && !result.matched && (
        <p className="extensions-url-hint">
          VS Code 마켓플레이스 또는 open-vsx 주소, 혹은 publisher.name 형식의 id를 찾지 못했습니다.
        </p>
      )}

      {result?.matched && id && info?.found && (
        <div className="extensions-row">
          <div className="extensions-row-info">
            <div className="extensions-row-label">{info.label || id}</div>
            {info.description && <div className="extensions-row-description">{info.description}</div>}
            <div className="extensions-row-id">
              {id}
              {info.version && ` · ${info.version}`}
              <a
                className="extensions-more-link"
                href={`https://open-vsx.org/extension/${encodeURIComponent(id.split('.')[0])}/${encodeURIComponent(id.split('.')[1])}`}
                target="_blank"
                rel="noreferrer"
              >
                open-vsx ↗
              </a>
              {info.homepage && (
                <a className="extensions-more-link" href={info.homepage} target="_blank" rel="noreferrer">
                  홈페이지 ↗
                </a>
              )}
            </div>
          </div>
          {isInstalled ? (
            <span className="badge badge-green">설치됨</span>
          ) : (
            <button type="button" className="btn btn-primary btn-small" onClick={() => onInstall(id)} disabled={isInstalling}>
              {isInstalling ? '설치 중...' : '설치'}
            </button>
          )}
        </div>
      )}

      {result?.matched && id && info && !info.found && (
        <div className="extensions-row">
          <div className="extensions-row-info">
            <div className="extensions-row-label">{id}</div>
            <div className="extensions-row-description">
              open-vsx에 없는 익스텐션입니다. code-server는 open-vsx에서만 설치하므로 일반 설치는 할 수 없습니다.
            </div>
            {fallback && (
              <div className="extensions-row-description">
                대신 {fallback.host}에서 .vsix 파일을 직접 받아 설치할 수 있습니다.
              </div>
            )}
          </div>
          {isInstalled ? (
            <span className="badge badge-green">설치됨</span>
          ) : (
            fallback && (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => setVsixConfirmOpen(true)}
                disabled={vsixInstalling !== null}
              >
                {vsixInstalling === id ? '설치 중...' : '.vsix로 설치...'}
              </button>
            )
          )}
        </div>
      )}

      <ConfirmDialog
        open={vsixConfirmOpen}
        onClose={() => setVsixConfirmOpen(false)}
        onConfirm={confirmVsixInstall}
        title=".vsix 직접 설치"
        confirmLabel="다운로드하고 설치"
        danger={false}
      >
        {fallback && id && (
          <>
            <p>
              &quot;{id}&quot;은(는) open-vsx에 없습니다. <strong>{fallback.host}</strong>에서 최신 .vsix 파일을 직접
              내려받아 설치할까요?
            </p>
            <ul className="extensions-vsix-notes">
              <li>Microsoft 마켓플레이스 이용 약관은 공식 Visual Studio 제품 밖에서의 사용을 허용하지 않을 수 있습니다. 본인 책임 하에 진행하세요.</li>
              <li>파일 크기는 최대 {Math.round(fallback.maxBytes / (1024 * 1024))} MB까지 받으며, 받은 파일이 요청한 익스텐션의 올바른 .vsix인지 확인한 뒤에만 설치합니다.</li>
              <li>open-vsx에 없으니 code-server가 새 버전을 찾지 못합니다. 업데이트하려면 같은 방법으로 다시 설치해야 합니다.</li>
            </ul>
          </>
        )}
      </ConfirmDialog>
    </div>
  )
}
