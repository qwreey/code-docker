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

export interface TailscaleGlobalConfig {
  socksAddress: string
  retryInterval: number
}

export interface TailscaleForward {
  name: string
  localPort: number
  remoteHost: string
  remotePort: number
  retryInterval: number
}

export type TailscalePublishMode = 'tcp' | 'tls-terminated-tcp'

export interface TailscalePublish {
  name: string
  tailscalePort: number
  localPort: number
  mode: TailscalePublishMode
}

export type GitSigningMode = 'none' | 'ssh' | 'gpg'

export interface GitSigningConfig {
  mode: GitSigningMode
  signingKey: string
  commitGpgSign: boolean
}

export interface SshSigningKey {
  publicKeyPath: string
  publicKey: string
}

export interface GpgKey {
  keyId: string
  uid: string
  createdAt: string
}

export interface GpgKeyCreated {
  keyId: string
  uid: string
  publicKey: string
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  timestamp: number
  level: LogLevel
  message: string
  app?: string
}

export interface LogsAppsResponse {
  apps: string[]
  mock: boolean
}

export interface LogEntriesResponse {
  entries: LogEntry[]
  mock: boolean
}

export interface ProcessInfo {
  pid: number
  ppid: number
  name: string
  username: string
  status: string
  cpuPercent: number
  memPercent: number
  rssBytes: number
  cmdline: string
}

export type PortProtocol = 'tcp' | 'udp'

export interface PortInfo {
  protocol: PortProtocol
  localAddress: string
  localPort: number
  pid: number
  processName: string
}

export type ProcessSignal = 'TERM' | 'KILL'

export interface ClaudeAuthStatus {
  loggedIn: boolean
  email: string
  subscriptionType: string
  authMethod: string
}

export interface ClaudeStatsWindow {
  sessionCount: number
  messageCount: number
}

export interface ClaudeStats {
  totalSessions: number
  totalMessages: number
  firstSessionDate: string
  longestSessionMessageCount: number
  longestSessionDurationMs: number
  today: ClaudeStatsWindow
  week: ClaudeStatsWindow
}

export interface ClaudeStatus {
  installed: boolean
  auth?: ClaudeAuthStatus | null
  stats?: ClaudeStats | null
}

export interface SystemResources {
  memory: {
    usedBytes: number
    limitBytes: number | null
    available: boolean
  }
  cpu: {
    percent: number
    limitCores: number | null
    numCpu: number
    available: boolean
  }
  disk: {
    path: string
    totalBytes: number
    usedBytes: number
    freeBytes: number
    available: boolean
  }
}
