// The Tailscale tab's own bound API client - router-manager's /tailscale/
// nginx location (see config/nginx.default.conf, proxied to
// router-manager's /api/tailscale/), a separate prefix from Dev Proxy's
// (../../api/client's default export).
import { createApiClient, errorMessage } from '../../api/client'

export const { api } = createApiClient('tailscale')
export { errorMessage }
