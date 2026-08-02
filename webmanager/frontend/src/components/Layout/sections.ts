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
  { id: 'processes', label: '작업 관리자', implemented: true },
  { id: 'projects', label: '프로젝트', implemented: true },
  { id: 'mise', label: 'mise', implemented: true },
  { id: 'dind', label: 'Docker (dind)', implemented: false },
  { id: 'terminal', label: 'Terminal', implemented: true },
  { id: 'claude', label: 'Claude Code', implemented: true },
  { id: 'extensions', label: '익스텐션', implemented: true },
  { id: 'files', label: '파일', implemented: true },
]
