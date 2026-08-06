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

// Mirrors router/backend's GET /api/tailscale/state.
export interface TailscaleState {
  backendState: string
  authUrl?: string | null
}
