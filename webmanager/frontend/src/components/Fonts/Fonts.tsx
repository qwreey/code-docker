import { useCallback, useEffect, useRef, useState } from 'react'
import { api, apiUrl, errorMessage } from '../../api/client'
import type { FontEntry, FontManifest, FontRecommendationCategory, RecommendationsResponse, RecommendedFont } from '../../api/types'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { CopyButton } from '../common/CopyButton'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import '../common/common.css'
import '../Extensions/Extensions.css'
import './Fonts.css'
import { withViewTransition } from '../../utils/viewTransition'

const SHOW_RECOMMENDATIONS_KEY = 'webmanager.fonts.showRecommendations'

function loadShowRecommendations(): boolean {
  try {
    const stored = localStorage.getItem(SHOW_RECOMMENDATIONS_KEY)
    if (stored === null) return true
    return stored === 'true'
  } catch {
    return true
  }
}

function saveShowRecommendations(value: boolean) {
  try {
    localStorage.setItem(SHOW_RECOMMENDATIONS_KEY, value ? 'true' : 'false')
  } catch {
    // localStorage unavailable (e.g. private browsing) - preference just won't persist
  }
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'Extra Light',
  300: 'Light',
  400: 'Normal',
  500: 'Medium',
  600: 'Semi Bold',
  700: 'Bold',
  800: 'Extra Bold',
  900: 'Black',
}
const WEIGHT_OPTIONS = [100, 200, 300, 400, 500, 600, 700, 800, 900]

function weightLabel(weight: number): string {
  return `${weight} ${WEIGHT_NAMES[weight] ?? ''}`.trim()
}

interface FamilyGroup {
  family: string
  items: FontEntry[]
}

function groupByFamily(fonts: FontEntry[]): FamilyGroup[] {
  const groups: FamilyGroup[] = []
  const index = new Map<string, number>()
  for (const f of fonts) {
    let idx = index.get(f.family)
    if (idx === undefined) {
      idx = groups.length
      index.set(f.family, idx)
      groups.push({ family: f.family, items: [] })
    }
    groups[idx].items.push(f)
  }
  return groups
}

export function Fonts() {
  const [fonts, setFonts] = useState<FontEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({})

  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadFamily, setUploadFamily] = useState('')
  const [uploadWeight, setUploadWeight] = useState(400)
  const [uploadStyle, setUploadStyle] = useState<'normal' | 'italic' | 'oblique'>('normal')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editFamily, setEditFamily] = useState('')
  const [editWeight, setEditWeight] = useState(400)
  const [editStyle, setEditStyle] = useState<'normal' | 'italic' | 'oblique'>('normal')
  const [saving, setSaving] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<FontEntry | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [recommended, setRecommended] = useState<FontRecommendationCategory[]>([])
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set())
  const [recommendCategoryOpen, setRecommendCategoryOpen] = useState<Record<string, boolean>>({})
  const [showRecommendations, setShowRecommendations] = useState(loadShowRecommendations)

  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const [manifest, recommendations] = await Promise.all([
        api.get<FontManifest>('/fonts'),
        api.get<RecommendationsResponse>('/recommendations'),
      ])
      setFonts(manifest.fonts)
      setRecommended(recommendations.fonts ?? [])
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      withViewTransition(() => setLoading(false))
      loadingRef.current = false
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function toggleGroup(family: string) {
    setGroupOpen((prev) => ({ ...prev, [family]: !(prev[family] ?? true) }))
  }

  function isGroupOpen(family: string): boolean {
    return groupOpen[family] ?? true
  }

  function handleFileChange(file: File | null) {
    setUploadFile(file)
    if (file && !uploadFamily) {
      setUploadFamily(file.name.replace(/\.(ttf|otf|woff2?|)$/i, ''))
    }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!uploadFile) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      fd.append('family', uploadFamily)
      fd.append('weight', String(uploadWeight))
      fd.append('style', uploadStyle)
      const res = await fetch(apiUrl('/fonts'), { method: 'POST', body: fd })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `업로드 요청이 실패했습니다 (${res.status})`)
      }
      setUploadOpen(false)
      setUploadFamily('')
      setUploadWeight(400)
      setUploadStyle('normal')
      setUploadFile(null)
      setError(null)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setUploading(false)
    }
  }

  function startEdit(f: FontEntry) {
    setEditingId(f.id)
    setEditFamily(f.family)
    setEditWeight(f.weight)
    setEditStyle((f.style as 'normal' | 'italic' | 'oblique') || 'normal')
  }

  async function saveEdit() {
    if (!editingId) return
    setSaving(true)
    try {
      await api.patch(`/fonts/${editingId}`, { family: editFamily, weight: editWeight, style: editStyle })
      setEditingId(null)
      setError(null)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.del(`/fonts/${deleteTarget.id}`)
      setDeleteTarget(null)
      setError(null)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDeleting(false)
    }
  }

  async function handleInstallRecommended(id: string) {
    if (installingIds.has(id)) return
    setInstallingIds((prev) => new Set(prev).add(id))
    try {
      const font = await api.post<FontEntry>('/fonts/install', { id })
      setFonts((prev) => [...prev, font])
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setInstallingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  function toggleRecommendCategory(category: string) {
    setRecommendCategoryOpen((prev) => ({ ...prev, [category]: !(prev[category] ?? true) }))
  }

  function isRecommendCategoryOpen(category: string): boolean {
    return recommendCategoryOpen[category] ?? true
  }

  function handleShowRecommendationsChange(checked: boolean) {
    setShowRecommendations(checked)
    saveShowRecommendations(checked)
  }

  const groups = groupByFamily(fonts)
  const installedFamilies = new Set(fonts.map((f) => f.family))

  return (
    <section>
      <div className="section-header">
        <h1>폰트</h1>
        <div className="extensions-header-controls">
          <label className="extensions-recommend-toggle">
            <input
              type="checkbox"
              checked={showRecommendations}
              onChange={(e) => handleShowRecommendationsChange(e.target.checked)}
            />
            추천 표시
          </label>
          <button type="button" className="btn btn-secondary btn-small" onClick={load} disabled={loading}>
            {loading ? '불러오는 중...' : '새로고침'}
          </button>
        </div>
      </div>
      <p className="section-description">
        업로드한 폰트는 webmanager 웹터미널(터미널 설정에서 선택)과 code-server 양쪽에서 사용할 수 있습니다.
      </p>

      <div className="fonts-code-server-hint card">
        <p>
          code-server에서 사용하려면 <code>Ctrl+Shift+P</code> → <em>Open User Settings (JSON)</em>에서
          아래처럼 폰트 이름을 붙여넣으세요.
        </p>
        <pre className="fonts-hint-example mono-cell">{`"editor.fontFamily": "'폰트 이름', monospace",\n"terminal.integrated.fontFamily": "'폰트 이름'"`}</pre>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading && fonts.length === 0 ? (
        <Skeleton />
      ) : (
        <>
          {groups.length === 0 && !uploadOpen && <p className="empty-state">업로드된 폰트가 없습니다.</p>}

          {groups.map((group) => {
            const isOpen = isGroupOpen(group.family)
            return (
              <div className="extensions-group" key={group.family}>
                <button
                  type="button"
                  className="extensions-group-toggle"
                  onClick={() => toggleGroup(group.family)}
                  aria-expanded={isOpen}
                >
                  <span className={`extensions-chevron ${isOpen ? 'extensions-chevron-open' : ''}`}>▶</span>
                  <h2 className="extensions-group-title">{group.family}</h2>
                  <CopyButton text={group.family} />
                </button>
                {isOpen && (
                  <ul className="extensions-list">
                    {group.items.map((f) => (
                      <li className="extensions-row fonts-row" key={f.id}>
                        {editingId === f.id ? (
                          <div className="fonts-edit-form">
                            <div className="form-field">
                              <label htmlFor={`fonts-edit-family-${f.id}`}>패밀리</label>
                              <input
                                id={`fonts-edit-family-${f.id}`}
                                value={editFamily}
                                onChange={(e) => setEditFamily(e.target.value)}
                              />
                            </div>
                            <div className="form-field">
                              <label htmlFor={`fonts-edit-weight-${f.id}`}>굵기</label>
                              <select
                                id={`fonts-edit-weight-${f.id}`}
                                value={editWeight}
                                onChange={(e) => setEditWeight(Number(e.target.value))}
                              >
                                {WEIGHT_OPTIONS.map((w) => (
                                  <option key={w} value={w}>
                                    {weightLabel(w)}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="form-field">
                              <label htmlFor={`fonts-edit-style-${f.id}`}>스타일</label>
                              <select
                                id={`fonts-edit-style-${f.id}`}
                                value={editStyle}
                                onChange={(e) => setEditStyle(e.target.value as 'normal' | 'italic' | 'oblique')}
                              >
                                <option value="normal">normal</option>
                                <option value="italic">italic</option>
                                <option value="oblique">oblique</option>
                              </select>
                            </div>
                            <div className="fonts-edit-actions">
                              <button
                                type="button"
                                className="btn btn-secondary btn-small"
                                onClick={() => setEditingId(null)}
                                disabled={saving}
                              >
                                취소
                              </button>
                              <button
                                type="button"
                                className="btn btn-primary btn-small"
                                onClick={saveEdit}
                                disabled={saving}
                              >
                                {saving ? '저장 중...' : '저장'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="extensions-row-info">
                              <div className="extensions-row-label">
                                {weightLabel(f.weight)} {f.style !== 'normal' && <span>· {f.style}</span>}
                                {f.builtin && <span className="badge badge-green">기본 제공</span>}
                              </div>
                              <div className="extensions-row-id">{f.originalFilename}</div>
                            </div>
                            <div className="fonts-row-actions">
                              <button
                                type="button"
                                className="btn btn-secondary btn-small"
                                onClick={() => startEdit(f)}
                              >
                                편집
                              </button>
                              <button
                                type="button"
                                className="btn btn-danger btn-small"
                                onClick={() => setDeleteTarget(f)}
                              >
                                삭제
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </>
      )}

      {showRecommendations &&
        (loading && recommended.length === 0 ? null : recommended.length === 0 ? null : (
          <>
            <h2 className="fonts-recommend-heading">추천 폰트</h2>
            {recommended.map((group) => {
              const isOpen = isRecommendCategoryOpen(group.category)
              return (
                <div className="extensions-group" key={group.category || '기타'}>
                  <button
                    type="button"
                    className="extensions-group-toggle"
                    onClick={() => toggleRecommendCategory(group.category)}
                    aria-expanded={isOpen}
                  >
                    <span className={`extensions-chevron ${isOpen ? 'extensions-chevron-open' : ''}`}>▶</span>
                    <h3 className="extensions-group-title">{group.category || '기타'}</h3>
                  </button>
                  {isOpen && (
                    <ul className="extensions-list">
                      {group.fonts.map((rf: RecommendedFont) => {
                        const isInstalled = installedFamilies.has(rf.label)
                        const isInstalling = installingIds.has(rf.id)
                        return (
                          <li className="extensions-row" key={rf.id}>
                            <div className="extensions-row-info">
                              <div className="extensions-row-label">{rf.label}</div>
                              <div className="extensions-row-description">{rf.description}</div>
                            </div>
                            {isInstalled ? (
                              <span className="badge badge-green">설치됨</span>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-primary btn-small"
                                onClick={() => handleInstallRecommended(rf.id)}
                                disabled={isInstalling}
                              >
                                {isInstalling ? '설치 중...' : '설치'}
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )
            })}
          </>
        ))}

      {!uploadOpen && (
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setUploadOpen(true)}>
          + 폰트 업로드
        </button>
      )}

      {uploadOpen && (
        <form onSubmit={handleUpload} className="card fonts-upload-form">
          <div className="form-field">
            <label htmlFor="fonts-upload-file">파일 (.ttf/.otf/.woff/.woff2)</label>
            <input
              id="fonts-upload-file"
              type="file"
              accept=".ttf,.otf,.woff,.woff2"
              onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="form-field">
            <label htmlFor="fonts-upload-family">패밀리 이름</label>
            <input
              id="fonts-upload-family"
              value={uploadFamily}
              onChange={(e) => setUploadFamily(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="fonts-upload-weight">굵기</label>
            <select id="fonts-upload-weight" value={uploadWeight} onChange={(e) => setUploadWeight(Number(e.target.value))}>
              {WEIGHT_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  {weightLabel(w)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="fonts-upload-style">스타일</label>
            <select
              id="fonts-upload-style"
              value={uploadStyle}
              onChange={(e) => setUploadStyle(e.target.value as 'normal' | 'italic' | 'oblique')}
            >
              <option value="normal">normal</option>
              <option value="italic">italic</option>
              <option value="oblique">oblique</option>
            </select>
          </div>
          <div className="fonts-edit-actions">
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setUploadOpen(false)}
              disabled={uploading}
            >
              취소
            </button>
            <button type="submit" className="btn btn-primary btn-small" disabled={uploading || !uploadFile}>
              {uploading ? '업로드 중...' : '업로드'}
            </button>
          </div>
        </form>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="폰트 삭제"
        confirmLabel="삭제"
        busy={deleting}
        busyLabel="삭제 중..."
      >
        {deleteTarget && (
          <>
            &quot;{deleteTarget.family}&quot; ({weightLabel(deleteTarget.weight)}) 폰트를 삭제하시겠습니까?
          </>
        )}
      </ConfirmDialog>
    </section>
  )
}
