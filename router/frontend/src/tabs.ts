// router/frontend's own top-level tab list - split out of App.tsx into its
// own module (hand-kept-duplicate counterpart of webmanager's own
// components/Layout/sections.ts) so App.tsx (splitPath/isTab) and
// components/Layout/SidebarContainer.tsx (icon-per-tab mapping) can both
// import it without a circular App.tsx<->SidebarContainer.tsx dependency.
export type Tab = 'dev-proxy' | 'app-routes' | 'tailscale' | 'dns' | 'net' | 'tinyauth' | 'settings'

export const TABS: { id: Tab; label: string }[] = [
  { id: 'dev-proxy', label: 'Dev Proxy' },
  { id: 'app-routes', label: 'App Routes' },
  { id: 'tailscale', label: 'Tailscale' },
  { id: 'dns', label: 'DNS' },
  { id: 'net', label: 'Net 관리' },
  { id: 'tinyauth', label: 'tinyauth' },
  { id: 'settings', label: '설정' },
]

export function isTab(v: string | null): v is Tab {
  return TABS.some((t) => t.id === v)
}
