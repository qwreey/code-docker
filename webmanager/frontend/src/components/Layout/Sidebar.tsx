import { SECTIONS } from './sections'
import type { SectionId } from './sections'
import './Layout.css'

interface SidebarProps {
  active: SectionId
  onSelect: (id: SectionId) => void
}

export function Sidebar({ active, onSelect }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="섹션 메뉴">
      <div className="sidebar-title">webmanager</div>
      <ul className="sidebar-list">
        {SECTIONS.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              className={
                'sidebar-item' +
                (section.id === active ? ' sidebar-item-active' : '') +
                (!section.implemented ? ' sidebar-item-disabled' : '')
              }
              onClick={() => onSelect(section.id)}
            >
              <span>{section.label}</span>
              {!section.implemented && <span className="sidebar-badge">구현 예정</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
