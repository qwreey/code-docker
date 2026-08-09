import { useCallback, useEffect, useState } from 'react'
import { netgateApi, errorMessage } from '../../api/client'
import type { NetgateBandwidth } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

const EMPTY: NetgateBandwidth = { totalMbps: 0, services: [] }

// totalMbps와 서비스별 리밋을 하나의 문서로 취급 - Outbound.tsx와 동일하게 로컬에서
// 편집하고 저장 버튼을 눌러야만 한 번의 PUT(전체 치환)으로 반영된다. 서비스별 리밋은
// totalMbps에서 빌려오는 게 아니라 각자 독립적인 하드캡이라는 점을 서버 쪽 검증과
// shaping.default.sh 양쪽에서 그대로 따른다 - 자세한 내용은 config.default.yaml의
// bandwidth: 주석 참고.
export function Bandwidth() {
  const [saved, setSaved] = useState<NetgateBandwidth>(EMPTY)
  const [draft, setDraft] = useState<NetgateBandwidth>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await netgateApi.get<NetgateBandwidth>('/bandwidth')
      setSaved(data)
      setDraft(data)
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

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  function addService() {
    setDraft((prev) => ({ ...prev, services: [...prev.services, { targetHost: '', limitMbps: 10 }] }))
  }

  function updateService(index: number, patch: Partial<NetgateBandwidth['services'][number]>) {
    setDraft((prev) => ({
      ...prev,
      services: prev.services.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }))
  }

  function removeService(index: number) {
    setDraft((prev) => ({ ...prev, services: prev.services.filter((_, i) => i !== index) }))
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      const data = await netgateApi.put<NetgateBandwidth>('/bandwidth', draft)
      setSaved(data)
      setDraft(data)
      setNotice('저장됨 (최대 30초 내 반영)')
      setTimeout(() => setNotice(null), 3000)
    } catch (e) {
      setSaveError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <h2>대역폭 제한</h2>
      <p className="section-description">
        이 라우터가 기본 인터페이스로 내보내는 전체 트래픽(라우터 자신의 트래픽 포함)에 대한 하드 리밋과,
        code-docker/dind 등 개별 컨테이너별 하드 리밋을 설정합니다. 두 값은 서로 빌려주고 빌려받지 않는 독립적인
        상한선입니다 - 전체 리밋과 별개로 서비스별 리밋이 각각 적용됩니다. 네트워크 소진(bandwidth exhaustion)
        공격을 막기 위한 용도입니다. 변경사항은 저장 후 최대 30초 내 반영됩니다(재시작 불필요).
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice && <p className="success-note">{notice}</p>}

      {loading ? (
        <Skeleton />
      ) : (
        <>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="netgate-bw-total">전체 상한 (Mbps, 0 = 무제한)</label>
              <input
                id="netgate-bw-total"
                type="number"
                min={0}
                value={draft.totalMbps}
                onChange={(e) => setDraft((prev) => ({ ...prev, totalMbps: Number(e.target.value) }))}
              />
            </div>
          </div>

          {draft.services.length === 0 ? (
            <p className="empty-state">등록된 서비스별 리밋이 없습니다.</p>
          ) : (
            <div className="table-wrapper">
              <table className="tailscale-table">
                <thead>
                  <tr>
                    <th>대상 호스트</th>
                    <th>상한 (Mbps)</th>
                    <th aria-label="동작" className="table-actions-col" />
                  </tr>
                </thead>
                <tbody>
                  {draft.services.map((s, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          value={s.targetHost}
                          onChange={(e) => updateService(i, { targetHost: e.target.value })}
                          placeholder="code-docker"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={1}
                          value={s.limitMbps}
                          onChange={(e) => updateService(i, { limitMbps: Number(e.target.value) })}
                        />
                      </td>
                      <td className="table-actions-col">
                        <button type="button" className="btn btn-danger btn-small" onClick={() => removeService(i)}>
                          삭제
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="form-grid-inline">
            {saveError && <ErrorBanner message={saveError} onDismiss={() => setSaveError(null)} />}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={addService}>
                서비스 리밋 추가
              </button>
              <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={handleSave}>
                {saving ? '저장하는 중...' : '저장'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
