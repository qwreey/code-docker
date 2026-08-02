export type SectionId =
  | 'supervisor'
  | 'ssh-keys'
  | 'git-config'
  | 'tailscale'
  | 'mise'
  | 'dind'
  | 'terminal'

export interface SectionMeta {
  id: SectionId
  label: string
  implemented: boolean
}

export const SECTIONS: SectionMeta[] = [
  { id: 'supervisor', label: 'Supervisor', implemented: true },
  { id: 'ssh-keys', label: 'SSH Keys', implemented: true },
  { id: 'git-config', label: 'Git Config', implemented: true },
  { id: 'tailscale', label: 'Tailscale', implemented: false },
  { id: 'mise', label: 'mise', implemented: false },
  { id: 'dind', label: 'Docker (dind)', implemented: false },
  { id: 'terminal', label: 'Terminal', implemented: false },
]
