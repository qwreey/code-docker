import { useEffect, useState } from 'react'
import {
  Activity,
  Blocks,
  Bot,
  Container,
  FileText,
  Folder,
  FolderSync,
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
  MonitorPlay,
  Terminal,
  Type,
  Users,
  Waypoints,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { api, errorMessage } from '../../api/client'
import type { ProviderInfo, SidebarOrder } from '../../api/types'
import { Logo } from '../common/Logo'
import { useTailscaleEnabled } from '../RouterEmbed/useTailscaleEnabled'
import { SECTIONS } from './sections'
import { providerSectionId, type ActiveId, type SectionId } from './sections'
import { Sidebar, type SidebarGroup, type SidebarItem } from './Sidebar'
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
  vnc: MonitorPlay,
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
  'file-share': FolderSync,
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
  active: ActiveId
  onSelect: (id: ActiveId) => void
  // GET /api/providers, null while loading. Rendered as their own group
  // below the built-in tabs rather than mixed into them: a provider is an
  // attached project's page, not a webmanager feature, it exists only
  // while that project's compose overlay is included, and its title is
  // whatever the project chose - keeping them apart says where each tab
  // comes from, and keeps a provider that is gone next restart out of the
  // persisted drag order.
  providers: ProviderInfo[] | null
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
  providers,
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

  const groups: SidebarGroup[] = [
    {
      label: 'Providers',
      items: (providers ?? []).map((p) => ({ id: providerSectionId(p.id), label: p.title, icon: Blocks })),
    },
  ]

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
      onSelect={(id) => onSelect(id as ActiveId)}
      open={open}
      onClose={onClose}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      loading={tailscaleEnabled === null || providers === null}
      groups={groups}
    />
  )
}
