import { useState } from 'react'
import { Globe, Network, Route, Settings, ShieldCheck, Signpost, Waypoints, type LucideIcon } from 'lucide-react'
import { TABS, type Tab } from '../../tabs'
import { Sidebar, type SidebarItem } from './Sidebar'
import { SidebarFooter } from './SidebarFooter'

// router-manager's own wiring for the generic Sidebar component - hand-kept
// duplicate of webmanager's own SidebarContainer.tsx (see Sidebar.tsx's own
// doc comment on why the two were split apart). Deliberately simpler than
// webmanager's: no GET/PUT /ui/sidebar-order persistence - router only has 7
// tabs, not worth a new backend endpoint for this yet (see
// router/.claude/net-auth-expansion-plan.md §5) - so a drag reorder here
// still works, it just resets on reload instead of persisting.
const TAB_ICON: Record<Tab, LucideIcon> = {
  'dev-proxy': Route,
  'app-routes': Signpost,
  tailscale: Waypoints,
  dns: Globe,
  net: Network,
  tinyauth: ShieldCheck,
  settings: Settings,
}

const ITEMS: SidebarItem[] = TABS.map((t) => ({ id: t.id, label: t.label, icon: TAB_ICON[t.id] }))

interface SidebarContainerProps {
  active: Tab
  onSelect: (id: Tab) => void
  open: boolean
  onClose: () => void
}

export function SidebarContainer({ active, onSelect, open, onClose }: SidebarContainerProps) {
  const [order, setOrder] = useState<string[]>([])

  return (
    <Sidebar
      title="router"
      footer={<SidebarFooter />}
      items={ITEMS}
      order={order}
      onReorder={setOrder}
      active={active}
      onSelect={(id) => onSelect(id as Tab)}
      open={open}
      onClose={onClose}
    />
  )
}
