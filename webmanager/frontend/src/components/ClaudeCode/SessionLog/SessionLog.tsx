import { useState } from 'react'
import type { ClaudeSessionInfo } from '../../../api/types'
import { RequiresUnlock } from '../../common/RequiresUnlock'
import { SessionList } from './SessionList'
import { SessionViewer } from './SessionViewer'
import './SessionLog.css'

// Gated read (unlike most of the app — see webmanager/CLAUDE.md's authgate
// ground rule): this is conversation content, the same trust tier as
// Terminal/File Manager/Logs, per the user's explicit request when this
// feature was scoped (session-log-plan.md).
export function SessionLog() {
  const [selected, setSelected] = useState<ClaudeSessionInfo | null>(null)

  return (
    <RequiresUnlock>
      {selected ? (
        <SessionViewer session={selected} onBack={() => setSelected(null)} />
      ) : (
        <SessionList onSelect={setSelected} />
      )}
    </RequiresUnlock>
  )
}
