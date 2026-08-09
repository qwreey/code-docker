import { useCallback, useEffect, useState } from 'react'
import { netgateApi, errorMessage } from '../../api/client'
import type { NetgateOutboundRule } from '../../api/types'
import { ErrorBanner } from '../common/ErrorBanner'
import { Skeleton } from '../common/Skeleton'
import { withViewTransition } from '../../utils/viewTransition'

// Order is the entire point of this list (iptables FORWARD chain is
// first-match-wins - see config.default.yaml's own comment), so edits are
// staged locally and only sent as one PUT (whole-list replace) when 저장 is
// pressed - re-applying after every single reorder click would both spam
// the API and make it easy to save a half-finished reorder by accident.
export function Outbound() {
  const [saved, setSaved] = useState<NetgateOutboundRule[]>([])
  const [rules, setRules] = useState<NetgateOutboundRule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await netgateApi.get<NetgateOutboundRule[]>('/outbound')
      setSaved(data)
      setRules(data)
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

  const dirty = JSON.stringify(rules) !== JSON.stringify(saved)

  function updateRule(index: number, patch: Partial<NetgateOutboundRule>) {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  function moveRule(index: number, direction: -1 | 1) {
    setRules((prev) => {
      const target = index + direction
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function addRule() {
    setRules((prev) => [...prev, { action: 'block', cidr: '' }])
  }

  function removeRule(index: number) {
    setRules((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      const data = await netgateApi.put<NetgateOutboundRule[]>('/outbound', rules)
      setSaved(data)
      setRules(data)
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
      <h2>Outbound 규칙</h2>
      <p className="section-description">
        이 라우터를 게이트웨이로 사용하는 컨테이너가 내보내는 트래픽을 위에서부터 순서대로 검사합니다(first-match-wins)
        - 좁은 예외를 넓은 차단보다 <strong>먼저</strong> 배치해야 실제로 적용됩니다. 변경사항은 저장 후 최대 30초 내
        반영됩니다(재시작 불필요).
      </p>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice && <p className="success-note">{notice}</p>}

      {loading ? (
        <Skeleton />
      ) : (
        <div className="table-wrapper">
          <table className="tailscale-table">
            <thead>
              <tr>
                <th aria-label="순서" className="table-actions-col" />
                <th>동작</th>
                <th>CIDR</th>
                <th aria-label="동작" className="table-actions-col" />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule, i) => (
                <tr key={i}>
                  <td className="table-actions-col">
                    <div className="dialog-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={i === 0}
                        onClick={() => moveRule(i, -1)}
                        aria-label="위로 이동"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        disabled={i === rules.length - 1}
                        onClick={() => moveRule(i, 1)}
                        aria-label="아래로 이동"
                      >
                        ↓
                      </button>
                    </div>
                  </td>
                  <td>
                    <select value={rule.action} onChange={(e) => updateRule(i, { action: e.target.value as NetgateOutboundRule['action'] })}>
                      <option value="allow">allow</option>
                      <option value="block">block</option>
                    </select>
                  </td>
                  <td>
                    <input
                      value={rule.cidr}
                      onChange={(e) => updateRule(i, { cidr: e.target.value })}
                      placeholder="10.0.0.0/8"
                    />
                  </td>
                  <td className="table-actions-col">
                    <button type="button" className="btn btn-danger btn-small" onClick={() => removeRule(i)}>
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
          <button type="button" className="btn btn-secondary" onClick={addRule}>
            규칙 추가
          </button>
          <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={handleSave}>
            {saving ? '저장하는 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}
