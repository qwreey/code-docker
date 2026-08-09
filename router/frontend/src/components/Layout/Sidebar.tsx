import { useRef, useState, type ReactNode } from 'react'
import { GripVertical, type LucideIcon } from 'lucide-react'
import './Layout.css'

// Generic sidebar item - deliberately not tied to webmanager's own
// SectionId/SECTIONS (see SidebarContainer.tsx, which owns that mapping).
// Kept ID-string-generic on purpose: this component was pulled apart from a
// webmanager-only implementation on 2026-08-08 so it could be hand-copied
// into router/frontend's own SPA too (same tab-count-growing problem, see
// root CLAUDE.md's "사이드바 공유" note) without either side needing to
// depend on the other's types.
export interface SidebarItem {
  id: string
  label: string
  icon: LucideIcon
  enabled?: boolean
  badge?: string
}

interface SidebarProps {
  title: string
  logo?: ReactNode
  footer?: ReactNode
  items: SidebarItem[]
  // Persisted order (ids) - empty means "use items' own order as given".
  // Reconciling a saved order against the current item list (dropping
  // stale ids, appending new ones) is this component's job since it's pure
  // list logic; fetching/persisting the order itself is the caller's job
  // (see SidebarContainer.tsx) so this component makes no API calls of its
  // own.
  order: string[]
  onReorder: (order: string[]) => void
  active: string
  onSelect: (id: string) => void
  open: boolean
  onClose: () => void
}

// Applies a persisted id order on top of the current items list: known ids
// move to their saved position (in saved order), anything saved-but-
// no-longer-present is dropped, and any current item not present in the
// saved order (new tabs added since the user last reordered) is appended
// at the end in its original/default order.
function reconcileOrder(items: SidebarItem[], saved: string[]): SidebarItem[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  const ordered: SidebarItem[] = []
  const seen = new Set<string>()
  for (const id of saved) {
    const item = byId.get(id)
    if (item && !seen.has(id)) {
      ordered.push(item)
      seen.add(id)
    }
  }
  for (const item of items) {
    if (!seen.has(item.id)) ordered.push(item)
  }
  return ordered
}

export function Sidebar({ title, logo, footer, items, order, onReorder, active, onSelect, open, onClose }: SidebarProps) {
  const sections = order.length > 0 ? reconcileOrder(items, order) : items
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const dragIdRef = useRef<string | null>(null)

  function handleDrop(targetId: string) {
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
    onReorder(next.map((s) => s.id))
  }

  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <nav className={'sidebar' + (open ? ' sidebar-open' : '')} aria-label="섹션 메뉴">
        <div className="sidebar-title">
          {logo}
          {title}
        </div>
        <div className="sidebar-list-wrap">
          <ul className="sidebar-list">
            {sections.map((section) => {
              const SectionIcon = section.icon
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
                      (section.enabled === false ? ' sidebar-item-disabled' : '')
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
                    {section.badge && <span className="sidebar-badge">{section.badge}</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
        {footer}
      </nav>
    </>
  )
}
