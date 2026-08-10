export type SectionId =
  | 'supervisor'
  | 'ssh-keys'
  | 'git-config'
  | 'dev-proxy'
  | 'app-routes'
  | 'tailscale'
  | 'dns'
  | 'net'
  | 'tinyauth'
  | 'router-settings'
  | 'logs'
  | 'processes'
  | 'projects'
  | 'mise'
  | 'dind'
  | 'terminal'
  | 'fonts'
  | 'claude'
  | 'extensions'
  | 'files'
  | 'sessions'

export interface SectionMeta {
  id: SectionId
  label: string
  implemented: boolean
}

export const SECTIONS: SectionMeta[] = [
  { id: 'supervisor', label: 'Supervisor', implemented: true },
  { id: 'ssh-keys', label: 'SSH Keys', implemented: true },
  { id: 'git-config', label: 'Git Config', implemented: true },
  { id: 'dev-proxy', label: 'Dev Proxy', implemented: true },
  { id: 'app-routes', label: 'App Routes', implemented: true },
  { id: 'tailscale', label: 'Tailscale', implemented: true },
  { id: 'dns', label: 'DNS', implemented: true },
  { id: 'net', label: 'Net 관리', implemented: true },
  { id: 'tinyauth', label: 'tinyauth', implemented: true },
  { id: 'router-settings', label: 'Router 설정', implemented: true },
  { id: 'logs', label: 'Logs', implemented: true },
  { id: 'processes', label: 'Task Manager', implemented: true },
  { id: 'projects', label: 'Projects', implemented: true },
  { id: 'mise', label: 'mise', implemented: true },
  { id: 'dind', label: 'Docker (dind)', implemented: true },
  { id: 'terminal', label: 'Terminal', implemented: true },
  { id: 'fonts', label: '폰트', implemented: true },
  { id: 'claude', label: 'Claude Code', implemented: true },
  { id: 'extensions', label: 'Code Extensions', implemented: true },
  { id: 'files', label: 'Files', implemented: true },
  { id: 'sessions', label: 'Sessions', implemented: true },
]
