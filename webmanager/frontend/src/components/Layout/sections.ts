export type SectionId =
  | 'supervisor'
  | 'ssh-keys'
  | 'git-config'
  | 'tailscale'
  | 'logs'
  | 'processes'
  | 'projects'
  | 'mise'
  | 'dind'
  | 'terminal'
  | 'claude'
  | 'extensions'
  | 'files'

export interface SectionMeta {
  id: SectionId
  label: string
  implemented: boolean
}

export const SECTIONS: SectionMeta[] = [
  { id: 'supervisor', label: 'Supervisor', implemented: true },
  { id: 'ssh-keys', label: 'SSH Keys', implemented: true },
  { id: 'git-config', label: 'Git Config', implemented: true },
  { id: 'tailscale', label: 'Tailscale', implemented: true },
  { id: 'logs', label: 'Logs', implemented: true },
  { id: 'processes', label: 'Task Manager', implemented: true },
  { id: 'projects', label: 'Projects', implemented: true },
  { id: 'mise', label: 'mise', implemented: true },
  { id: 'dind', label: 'Docker (dind)', implemented: true },
  { id: 'terminal', label: 'Terminal', implemented: true },
  { id: 'claude', label: 'Claude Code', implemented: true },
  { id: 'extensions', label: 'Code Extensions', implemented: true },
  { id: 'files', label: 'Files', implemented: true },
]
