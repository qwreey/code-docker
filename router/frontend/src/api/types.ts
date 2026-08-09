// Mirrors router/backend/internal/devproxy.Route — one path-matched
// reverse-proxy rule inside a subdomain. path empty = catch-all (no
// matcher). mode is the wrapping Caddy directive ("route" = unconditional,
// "handle" = mutually exclusive first-match-wins).
export interface DevProxyRoute {
  path?: string
  target: string
  stripPrefix?: string
  rewritePrefix?: string
  mode: 'route' | 'handle'
  requireAuth: boolean
}

// Mirrors router/backend/internal/devproxy.Expose/Info — GET
// /api/dev-proxy/exposes. name is only an internal identifier (filename +
// Caddyfile @matcher token, no dots allowed); host is the actual external
// hostname this expose answers for (e.g. "dev.example.com" or
// "*.staging.example.com") — there's no shared base domain, each expose's
// host is fully independent.
export interface DevProxyExpose {
  name: string
  host: string
  routes: DevProxyRoute[]
}

export interface DevProxyInfo {
  name: string
  raw: string
  structured?: DevProxyExpose
}

// Mirrors router/backend/internal/approutes.App — a path-based,
// Host-header-agnostic reverse-proxy entry (GET /api/app-routes/apps). name
// is both the filename and the `/app/<name>/*` path segment it answers for
// — there's no separate host concept here at all, unlike DevProxyExpose.
export interface AppRoute {
  name: string
  target: string
  requireAuth: boolean
}

export interface AppRouteInfo {
  name: string
  raw: string
  structured?: AppRoute
}

// Mirrors router/backend's GET /api/tailscale/state.
export interface TailscaleState {
  backendState: string
  authUrl?: string | null
}

// Mirrors router/backend/internal/tailscale.GlobalConfig.
export interface TailscaleGlobalConfig {
  socksAddress: string
  retryInterval: number
}

// Mirrors router/backend/internal/tailscale.Forward.
export interface TailscaleForward {
  name: string
  localPort: number
  remoteHost: string
  remotePort: number
  retryInterval: number
}

// Mirrors router/backend/internal/tailscale.PeerInfo.
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

// Mirrors router/backend/internal/tailscale.Status.
export interface TailscaleStatus {
  backendState: string
  authUrl: string
  tailnetName: string
  self: TailscalePeerInfo | null
  peers: TailscalePeerInfo[]
}

// Mirrors GET /api/tailscale/status's response body.
export interface TailscaleStatusResponse {
  available: boolean
  status?: TailscaleStatus
}

export type TailscalePublishMode = 'tcp' | 'tls-terminated-tcp'

// Mirrors router/backend/internal/tailscale.Publish.
export interface TailscalePublish {
  name: string
  tailscalePort: number
  targetHost: string
  localPort: number
  mode: TailscalePublishMode
}

// Mirrors router/backend/internal/dns.SourceInfo. Hosts is only present for
// custom (non-builtin) sources - the builtin source can be a
// StevenBlack-sized list, so only its EntryCount is shipped.
export interface DnsBlocklistSource {
  name: string
  builtin: boolean
  entryCount: number
  hosts?: string[]
}

// Mirrors router/backend/internal/dns.ListResult, GET /api/dns/blocklist-sources.
export interface DnsBlocklistSourcesResponse {
  sources: DnsBlocklistSource[]
  duplicateHosts: string[]
  builtinUpdateAvailable: boolean
}

// Mirrors router/backend/internal/dns.BuiltinStatus, GET
// /api/dns/blocklist-sources/builtin/status.
export interface DnsBuiltinBlocklistStatus {
  updateAvailable: boolean
  liveDiverged: boolean
  addedCount: number
  removedCount: number
  addedSample: string[]
  removedSample: string[]
}

// Mirrors router/backend/internal/dns.HostEntry - a MagicDNS-style custom
// hostname->real-IP mapping.
export interface DnsHostEntry {
  host: string
  ip: string
}

export type DnsResolverMode = 'auto' | 'custom'

// Mirrors router/backend/internal/dns.ResolverConfig.
export interface DnsResolverConfig {
  mode: DnsResolverMode
  servers: string[]
}

// Mirrors router/backend/internal/dns.QueryResult, GET /api/dns/query.
export interface DnsQueryResult {
  domain: string
  type: string
  durationMs: number
  output: string
}

export type NetgateOutboundAction = 'allow' | 'block'

// Mirrors router/backend/internal/netgate.OutboundRule - order matters
// (iptables FORWARD chain is first-match-wins), so the list itself IS the
// data, not just display order.
export interface NetgateOutboundRule {
  action: NetgateOutboundAction
  cidr: string
}

// Mirrors router/backend/internal/netgate.Forward. hostPort is the unique
// key (GET/DELETE /api/netgate/forwards/{hostPort}).
export interface NetgateForward {
  hostPort: number
  targetHost: string
  targetPort: number
}

// Mirrors router/backend/handlers_auth.go's authStatusResponse, GET
// /api/auth/status. RouterAuthPanel.tsx keeps its own narrower local
// interface (it never needs unlocked/unlockedUntil) - this full shape is for
// the sidebar footer's lock-status indicator instead.
export interface AuthStatus {
  required: boolean
  source: 'env' | 'file' | 'unset'
  unlocked: boolean
  unlockedUntil?: string | null // RFC3339, only set when unlocked
  trustedHosts: string[]
  requestHost: string
}
