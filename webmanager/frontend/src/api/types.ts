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
  label?: string
  note?: string
  disableStart: boolean
  disableStop: boolean
  disableRestart: boolean
  disableLogs: boolean
}

export type LogStream = 'stdout' | 'stderr'

export interface LogResponse {
  text: string
}

export interface DindContainer {
  id: string
  names: string
  image: string
  command: string
  state: string
  status: string
  ports: string
  created: string
}

export interface DindImage {
  id: string
  repository: string
  tag: string
  size: string
  created: string
}

export interface SshKey {
  id: string
  type: string
  comment: string
  fingerprint: string
  raw: string
}

// Mirrors internal/sshkeys.Entry — GET /api/ssh/keys returns the whole
// authorized_keys file as an ordered mix of key and standalone "#" comment
// entries (people use those as freeform section markers). Exactly one of
// key/text is set, matching kind.
export type SshEntryKind = 'key' | 'comment'

export interface SshEntry {
  id: string
  kind: SshEntryKind
  key?: SshKey
  text?: string
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

export interface KnownHostEntry {
  host: string
  keyType: string
  fingerprint: string
  raw: string
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

export interface TailscalePeerInfo {
  hostName: string
  dnsName: string
  tailscaleIPs: string[]
  relay: string
  direct: boolean
  online: boolean
  tags: string[]
  os: string
}

export interface TailscaleStatus {
  backendState: string
  authUrl: string
  tailnetName: string
  self: TailscalePeerInfo | null
  peers: TailscalePeerInfo[]
}

export interface TailscaleStatusResponse {
  available: boolean
  status?: TailscaleStatus
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
  hasMore: boolean
}

export interface LogsRangeResponse {
  earliest: number | null // unix ms
  latest: number | null // unix ms
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

export interface DailyActivity {
  date: string // "YYYY-MM-DD"
  messageCount: number
  sessionCount: number
  toolCallCount: number
}

export interface DailyModelTokens {
  date: string
  tokensByModel: Record<string, number>
}

export interface ModelUsageSummary {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
}

export interface ClaudeStats {
  totalSessions: number
  totalMessages: number
  firstSessionDate: string
  longestSessionMessageCount: number
  longestSessionDurationMs: number
  today: ClaudeStatsWindow
  week: ClaudeStatsWindow
  dailyActivity: DailyActivity[]
  dailyModelTokens: DailyModelTokens[]
  hourCounts: Record<string, number>
  modelUsage: Record<string, ModelUsageSummary>
}

export interface ClaudeMiseVersionInfo {
  current: string
  latest: string
  outdated: boolean
}

export interface ClaudeStatus {
  installed: boolean
  auth?: ClaudeAuthStatus | null
  stats?: ClaudeStats | null
}

export interface ClaudeMiseVersionResponse {
  miseVersion: ClaudeMiseVersionInfo | null
}

export interface ClaudeInstallJob {
  jobId: string
}

export interface ClaudeLoginStartResponse {
  sessionId: string
}

export interface ClaudeLoginStatus {
  running: boolean
  lines: string[]
  url: string
  exitCode: number | null
}

export interface ClaudePrefs {
  hideVersionCheck: boolean
}

export interface ClaudePlugin {
  id: string
  version: string
  scope: string
  enabled: boolean
  installPath: string
  installedAt: string
  lastUpdated: string
}

export interface ClaudePluginsResponse {
  plugins: ClaudePlugin[]
}

export interface ClaudeSessionInfo {
  project: string
  sessionId: string
  cwd: string
  modifiedAt: string
  sizeBytes: number
  preview: string
}

export interface ClaudeSessionsResponse {
  sessions: ClaudeSessionInfo[]
}

export interface ClaudeSessionLinesResponse {
  lines: string[]
  cursor: number
  hasMore: boolean
}

export interface ReclaimableEntry {
  pattern: string
  path: string
  sizeBytes: number
}

export interface ProjectInfo {
  root: string
  name: string
  path: string
  totalSizeBytes: number
  reclaimableSizeBytes: number
  reclaimable: ReclaimableEntry[]
  lastModified: string
  stale: boolean
  techStack: string[]
  scannedAt: string
}

export interface ProjectsResponse {
  roots: string[]
  scanning: boolean
  scannedAt: string | null
  projects: ProjectInfo[]
  codeServerUrl: string
}

// HostMemoryBreakdown/HostCpuInfo/ThermalZoneInfo mirror the real, merged
// backend contract exactly (handlers_system.go's hostMemoryResources/
// cpuCoreResources/thermalZone) — HOST-WIDE data (not scoped to this
// container's cgroup, see the Go doc comments), deliberately kept separate
// from `memory`/`cpu` above.
export interface HostMemoryBreakdown {
  totalBytes: number
  freeBytes: number
  buffersBytes: number
  cachedBytes: number
  available: boolean
}

export interface HostCpuInfo {
  hostPercent: number[] // indexed by host core number
  hostClockMHz?: number[] // parallel to hostPercent; absent if unreadable
  available: boolean
}

export interface ThermalZoneInfo {
  label: string
  celsius: number
}

// DiskBreakdownEntry/DiskBreakdownResponse mirror internal/diskusage's
// Entry/Response — a separate question from SystemResources.disk above
// (which is one statfs number for a single configured mount): this is a
// per-top-level-directory breakdown of the container's own root filesystem,
// cached server-side and only recomputed on an explicit POST .../scan.
export interface DiskBreakdownEntry {
  name: string
  path: string
  sizeBytes: number
}

export interface DiskBreakdownResponse {
  root: string
  available: boolean
  scanning: boolean
  scannedAt: string | null
  totalBytes: number
  freeBytes: number
  entries: DiskBreakdownEntry[]
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
  hostMemory: HostMemoryBreakdown
  cpuCores: HostCpuInfo
  thermal: ThermalZoneInfo[] // empty array, not a flag, means "nothing readable"
}

export interface RecommendedExtension {
  id: string
  label: string
  description: string
  category: string
}

export interface RecommendationsResponse {
  extensions: RecommendedExtension[]
  mise?: MiseRecommendationCategory[]
}

export interface ResourceHistoryPoint {
  timestamp: number // unix ms
  cpuPercent: number
  memUsedBytes: number
  memLimitBytes: number | null
  diskReadBytesPerSec: number
  diskWriteBytesPerSec: number
  netRxBytesPerSec: number
  netTxBytesPerSec: number
  // HOST-WIDE per-core percent for this tick — omitted (not present in the
  // JSON at all) on ticks where the read failed; check the response-level
  // hostCpuAvailable flag rather than per-point presence to distinguish
  // "no visibility at all" from "this one tick failed".
  hostPerCorePercent?: number[]
  // HOST-WIDE physical memory breakdown for this tick — unrelated to
  // memUsedBytes/memLimitBytes above, which stay cgroup-scoped. Zeroed
  // (not omitted) on ticks where the read failed; check hostMemAvailable.
  hostMemTotalBytes: number
  hostMemFreeBytes: number
  hostMemBuffersBytes: number
  hostMemCachedBytes: number
}

export interface ResourceHistoryResponse {
  intervalSeconds: number
  windowSeconds: number
  diskIOAvailable: boolean
  netIOAvailable: boolean
  hostCpuAvailable: boolean
  hostMemAvailable: boolean
  points: ResourceHistoryPoint[]
}

export interface CodeExtensionsResponse {
  installed: string[]
}

export interface MiseRecommendedTool {
  id: string
  label: string
  description: string
}

export interface MiseRecommendationCategory {
  category: string
  tools: MiseRecommendedTool[]
}

export interface MiseToolEntry {
  name: string
  version: string
  requestedVersion: string
  installPath: string
  source: { type: string; path: string } | null
  installed: boolean
  active: boolean
}

// GET /api/mise/tools's body - a flat array, not a map: a single tool name
// can have more than one entry (e.g. two installed versions), which a
// Record<name, entry> can't represent. Each entry carries its own `name`.
export interface MiseToolsResponse {
  tools: MiseToolEntry[]
}

export interface MiseJob {
  jobId: string
}

export interface MiseJobStatus {
  running: boolean
  exitCode: number | null
  lines: string[]
}

export interface MiseEnvResponse {
  env: Record<string, string>
}

// GET /api/system/restart-needed's body - true as long as code-server's
// live PID still matches whatever was recorded when a mise/extension/Claude
// Code install or uninstall last completed (see backend's
// internal/restartstatus). Self-clears once code-server actually restarts.
export interface RestartStatusResponse {
  dirty: boolean
}

export interface LFSStatus {
  installed: boolean
}

export interface AuthStatus {
  required: boolean
  unlocked: boolean
  unlockedUntil?: string | null // RFC3339, only set when unlocked
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  symlinkTarget?: string
  size: number
  mode: string // e.g. "-rw-r--r--"
  modTime: string
}

export interface FileStat extends FileEntry {
  modeOctal: string
  uid: number
  gid: number
  owner?: string
  group?: string
  changeTime: string
  createdTime?: string
  createdTimeAvailable: boolean
}

export interface FileContent {
  content: string
  truncated: boolean
}

export interface FileOpResult {
  path: string
  ok: boolean
  error?: string
}

export interface FileUploadResult {
  name: string
  ok: boolean
  error?: string
}

export interface KeyBinding {
  id: string
  label: string
  bytes: string // literal bytes/escape sequence sent to the PTY, e.g. "\x1b" for Escape, "\x03" for Ctrl+C
}

export interface TerminalTheme {
  id: string
  name: string
  colors: Record<string, string> // xterm.js theme keys -> hex color strings
}

export interface TerminalSettings {
  keybindings: KeyBinding[]
  themeId: string
  customThemes: TerminalTheme[]
  homeLabel: string // custom Home tab title, "" = use the default "홈"
}

// Mirrors internal/termsession.Info — M2 named sessions (see
// webmanager/.claude/terminal-plan.md's "영속 세션 토글").
export interface TerminalSessionInfo {
  name: string
  pinned: boolean
  createdAt: string
  lastAttachedAt: string
  attached: boolean
  pid: number // PTY-leader shell pid, for cross-referencing GET /api/processes
}

export interface SidebarOrder {
  order: string[] // SectionId values, in user-chosen display order
}

// Mirrors internal/terminalprofiles.Profile — Home tab launch presets. Cwd
// and Command are both optional/independent.
export interface TerminalProfile {
  id: string
  label: string
  cwd?: string
  command?: string
}

export interface TerminalProfilesDoc {
  profiles: TerminalProfile[]
}

// Mirrors internal/sessionheartbeat.Entry — GET /api/sessions, a
// visibility-only list of code-server browser tabs currently reporting a
// heartbeat (see webmanager/.claude/qa-request/session-heartbeat-plan-done.md).
export interface OpenSession {
  id: string
  folder: string
  userAgent: string
  lastSeen: string
  closeRequested: boolean
}

// Mirrors internal/devproxy.Expose/Info — GET /api/dev-proxy/exposes.
export interface DevProxyExpose {
  name: string
  target: string
  apiTarget?: string
  requireAuth: boolean
}

export interface DevProxyInfo {
  name: string
  raw: string
  structured?: DevProxyExpose
}

// Mirrors internal/projects' git-status contract (GET /api/projects/git/*).
// status never errors (always 200, isGitRepo: false + zero-valued fields for
// a non-repo path); the rest 400/502 with {error} on failure.
export interface GitStatus {
  isGitRepo: boolean
  branch: string
  staged: number
  changed: number
  untracked: number
  behind: number
  ahead: number
  diverged: number
  stashed: number
  conflicts: number
  clean: boolean
}

export interface GitCommit {
  hash: string
  shortHash: string
  authorName: string
  authorEmail: string
  date: string // ISO string
  subject: string
}

export interface GitLogResponse {
  commits: GitCommit[]
  hasMore: boolean
  nextCursor?: string
}

export interface GitDiffResponse {
  text: string // raw unified diff, "" if nothing to show
}

export interface GitRemote {
  name: string
  fetchUrl: string
  pushUrl: string
}

export interface GitBranch {
  name: string
  current: boolean
  remote: boolean
}

export interface GitTag {
  name: string
  date?: string
  hash?: string
}
