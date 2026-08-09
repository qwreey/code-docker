import { useState } from 'react'
import type { ClaudeSessionInfo } from '../../../api/types'
import { RequiresUnlock } from '../../common/RequiresUnlock'
import { Sheet } from '../../common/Sheet'
import { SessionList } from './SessionList'
import { SessionViewer } from './SessionViewer'
import './SessionLog.css'

// Gated read (unlike most of the app — see webmanager/CLAUDE.md's authgate
// ground rule): this is conversation content, the same trust tier as
// Terminal/File Manager/Logs, per the user's explicit request when this
// feature was scoped (session-log-plan.md).
//
// SessionList stays mounted at all times and the transcript opens in a Sheet
// overlay on top of it instead of replacing it inline - this is what keeps
// the list's scroll position intact across open/close (it used to reset
// because selecting a session unmounted SessionList entirely).
//
// projectFilter/emptyMessage pass straight through to SessionList - added so
// Projects/ProjectSessionHistory.tsx can reuse this exact list+viewer+gate
// wiring scoped to one project instead of duplicating it.
export function SessionLog({ projectFilter, emptyMessage }: { projectFilter?: string; emptyMessage?: string }) {
  const [selected, setSelected] = useState<ClaudeSessionInfo | null>(null)

  return (
    <RequiresUnlock>
      <SessionList onSelect={setSelected} projectFilter={projectFilter} emptyMessage={emptyMessage} />
      <Sheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? selected.cwd || selected.project : '대화 로그'}
      >
        {selected && <SessionViewer session={selected} />}
      </Sheet>
    </RequiresUnlock>
  )
}
