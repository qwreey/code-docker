export type ProcessState =
  | 'RUNNING'
  | 'STOPPED'
  | 'STARTING'
  | 'STOPPING'
  | 'EXITED'
  | 'FATAL'
  | 'BACKOFF'
  | 'UNKNOWN'

export interface SupervisorProcess {
  name: string
  group: string
  statename: ProcessState
  description: string
  pid: number
  start: number
  now: number
}

export type LogStream = 'stdout' | 'stderr'

export interface LogResponse {
  text: string
}

export interface SshKey {
  id: string
  type: string
  comment: string
  fingerprint: string
  raw: string
}

export interface GitUserConfig {
  name: string
  email: string
}

export interface GitSshHost {
  host: string
  hostname: string
  user: string
  identityFile: string
  publicKey: string
}

export interface GitCredential {
  host: string
  username: string
}
