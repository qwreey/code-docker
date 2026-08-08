import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  Bot,
  Container,
  FileText,
  Folder,
  GitBranch,
  Globe,
  GripVertical,
  HardDrive,
  KeyRound,
  Puzzle,
  Route,
  Server,
  Signpost,
  Terminal,
  Users,
  Waypoints,
  Wrench,
} from 'lucide-react'
import { api, errorMessage } from '../../api/client'
import type { SidebarOrder } from '../../api/types'
import { Logo } from '../common/Logo'
import { SECTIONS } from './sections'
import type { SectionId, SectionMeta } from './sections'
import { SidebarFooter } from './SidebarFooter'
import './Layout.css'

// 탭 하나당 아이콘 하나 - 목록이 길어질수록 라벨 텍스트만으로는 훑어보기
// 어려워서 추가함. SidebarFooter.tsx의 THEME_ICON과 같은 Record 매핑 패턴.
const SECTION_ICON: Record<SectionId, typeof Server> = {
  supervisor: Server,
  'ssh-keys': KeyRound,
  'git-config': GitBranch,
  'dev-proxy': Route,
  'app-routes': Signpost,
  tailscale: Waypoints,
  dns: Globe,
  logs: FileText,
  processes: Activity,
  projects: Folder,
  mise: Wrench,
  dind: Container,
  terminal: Terminal,
  claude: Bot,
  extensions: Puzzle,
  files: HardDrive,
  sessions: Users,
}

interface SidebarProps {
  active: SectionId
  onSelect: (id: SectionId) => void
  open: boolean
  onClose: () => void
}

// reconcileOrder applies a persisted id order on top of the current SECTIONS
// list: known ids move to their saved position (in saved order), anything
// saved-but-no-longer-a-real-section is dropped, and any real section not
// present in the saved order (new tabs added since the user last reordered)
// is appended at the end in its original/default order.
function reconcileOrder(saved: string[]): SectionMeta[] {
  const byId = new Map(SECTIONS.map((s) => [s.id, s]))
  const ordered: SectionMeta[] = []
  const seen = new Set<string>()
  for (const id of saved) {
    const section = byId.get(id as SectionId)
    if (section && !seen.has(id)) {
      ordered.push(section)
      seen.add(id)
    }
  }
  for (const section of SECTIONS) {
    if (!seen.has(section.id)) ordered.push(section)
  }
  return ordered
}

export function Sidebar({ active, onSelect, open, onClose }: SidebarProps) {
  const [sections, setSections] = useState<SectionMeta[]>(SECTIONS)
  const [dragOverId, setDragOverId] = useState<SectionId | null>(null)
  const dragIdRef = useRef<SectionId | null>(null)

  useEffect(() => {
    api
      .get<SidebarOrder>('/ui/sidebar-order')
      .then((res) => {
        if (res.order.length > 0) setSections(reconcileOrder(res.order))
      })
      .catch(() => {
        // no saved order yet (or fetch failed) - just keep the default order,
        // this preference isn't important enough to surface an error banner for
      })
  }, [])

  function saveOrder(next: SectionMeta[]) {
    setSections(next)
    api
      .put<{ ok: true }>('/ui/sidebar-order', { order: next.map((s) => s.id) })
      .catch((e) => {
        // best-effort persistence - the reorder still applies locally for this
        // session even if saving it server-side failed
        console.warn('사이드바 순서 저장 실패:', errorMessage(e))
      })
  }

  function handleDrop(targetId: SectionId) {
    const draggedId = dragIdRef.current
    dragIdRef.current = null
    setDragOverId(null)
    if (!draggedId || draggedId === targetId) return

    const next = [...sections]
    const fromIndex = next.findIndex((s) => s.id === draggedId)
    const toIndex = next.findIndex((s) => s.id === targetId)
    if (fromIndex === -1 || toIndex === -1) return
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    saveOrder(next)
  }

  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <nav className={'sidebar' + (open ? ' sidebar-open' : '')} aria-label="섹션 메뉴">
        <div className="sidebar-title">
          <Logo size={20} className="sidebar-title-mark" />
          webmanager
        </div>
        <div className="sidebar-list-wrap">
          <ul className="sidebar-list">
            {sections.map((section) => {
              const SectionIcon = SECTION_ICON[section.id]
              return (
                <li
                  key={section.id}
                  draggable
                  className={dragOverId === section.id ? 'sidebar-drag-over' : undefined}
                  onDragStart={() => {
                    dragIdRef.current = section.id
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (dragOverId !== section.id) setDragOverId(section.id)
                  }}
                  onDragLeave={() => setDragOverId((prev) => (prev === section.id ? null : prev))}
                  onDrop={(e) => {
                    e.preventDefault()
                    handleDrop(section.id)
                  }}
                  onDragEnd={() => {
                    dragIdRef.current = null
                    setDragOverId(null)
                  }}
                >
                  <button
                    type="button"
                    className={
                      'sidebar-item' +
                      (section.id === active ? ' sidebar-item-active' : '') +
                      (!section.implemented ? ' sidebar-item-disabled' : '')
                    }
                    onClick={() => {
                      onSelect(section.id)
                      onClose()
                    }}
                  >
                    {/* 평소엔 섹션 아이콘, hover/focus 시 같은 자리에서 드래그
                        핸들(GripVertical)로 크로스페이드 - 드래그 가능함을
                        암시. 실제 드래그 로직은 위 <li>의 핸들러 그대로. */}
                    <span className="sidebar-icon-slot">
                      <SectionIcon size={16} className="sidebar-item-icon" aria-hidden="true" />
                      <GripVertical size={16} className="sidebar-drag-handle" aria-hidden="true" />
                    </span>
                    <span>{section.label}</span>
                    {!section.implemented && <span className="sidebar-badge">구현 예정</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
        <SidebarFooter />
      </nav>
    </>
  )
}
