import { useEffect, useState } from 'react'
import {
  Activity,
  Bot,
  Container,
  FileText,
  Folder,
  GitBranch,
  Globe,
  HardDrive,
  KeyRound,
  Network,
  Puzzle,
  Route,
  Server,
  Settings,
  ShieldCheck,
  Signpost,
  Terminal,
  Type,
  Users,
  Waypoints,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { api, errorMessage } from '../../api/client'
import type { SidebarOrder } from '../../api/types'
import { Logo } from '../common/Logo'
import { useTailscaleEnabled } from '../RouterEmbed/useTailscaleEnabled'
import { SECTIONS } from './sections'
import type { SectionId } from './sections'
import { Sidebar, type SidebarItem } from './Sidebar'
import { SidebarFooter } from './SidebarFooter'

// webmanager's own wiring for the generic Sidebar component (see
// Sidebar.tsx's doc comment on why the two were split apart) - owns the
// SECTIONS->SidebarItem mapping, the icon-per-section table, and
// GET/PUT /ui/sidebar-order persistence, none of which the generic
// component needs to know about.
const SECTION_ICON: Record<SectionId, LucideIcon> = {
  supervisor: Server,
  'ssh-keys': KeyRound,
  'git-config': GitBranch,
  'dev-proxy': Route,
  'app-routes': Signpost,
  tailscale: Waypoints,
  dns: Globe,
  net: Network,
  tinyauth: ShieldCheck,
  'router-settings': Settings,
  logs: FileText,
  processes: Activity,
  projects: Folder,
  mise: Wrench,
  dind: Container,
  terminal: Terminal,
  fonts: Type,
  claude: Bot,
  extensions: Puzzle,
  files: HardDrive,
  sessions: Users,
}

const ITEMS: SidebarItem[] = SECTIONS.map((s) => ({
  id: s.id,
  label: s.label,
  icon: SECTION_ICON[s.id],
  enabled: s.implemented,
  badge: s.implemented ? undefined : '구현 예정',
}))

interface SidebarContainerProps {
  active: SectionId
  onSelect: (id: SectionId) => void
  open: boolean
  onClose: () => void
  collapsed: boolean
  onToggleCollapsed: () => void
}

export function SidebarContainer({
  active,
  onSelect,
  open,
  onClose,
  collapsed,
  onToggleCollapsed,
}: SidebarContainerProps) {
  const [order, setOrder] = useState<string[]>([])
  // TAILSCALE_ENABLED=false (router's own env, see docs/router.md#tailscale)
  // idles router's tailscaled entirely - hide the tab once we know it's off
  // rather than embedding a Tailscale management page for a daemon that was
  // never started on purpose. null = still loading - the real item list can
  // just assume "enabled" for now since Sidebar's loading overlay keeps it
  // hidden until this resolves either way (see Sidebar.tsx's `loading` prop).
  const tailscaleEnabled = useTailscaleEnabled()
  const items = tailscaleEnabled === false ? ITEMS.filter((i) => i.id !== 'tailscale') : ITEMS

  useEffect(() => {
    api
      .get<SidebarOrder>('/ui/sidebar-order')
      .then((res) => setOrder(res.order))
      .catch(() => {
        // no saved order yet (or fetch failed) - just keep the default order,
        // this preference isn't important enough to surface an error banner for
      })
  }, [])

  function handleReorder(next: string[]) {
    setOrder(next)
    api.put<{ ok: true }>('/ui/sidebar-order', { order: next }).catch((e) => {
      // best-effort persistence - the reorder still applies locally for this
      // session even if saving it server-side failed
      console.warn('사이드바 순서 저장 실패:', errorMessage(e))
    })
  }

  return (
    <Sidebar
      title="webmanager"
      logo={<Logo size={20} className="sidebar-title-mark" />}
      footer={<SidebarFooter />}
      items={items}
      order={order}
      onReorder={handleReorder}
      active={active}
      onSelect={(id) => onSelect(id as SectionId)}
      open={open}
      onClose={onClose}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      loading={tailscaleEnabled === null}
    />
  )
}
