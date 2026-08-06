// The Tailscale tab's own bound API client - router's single /router/
// nginx location (see router/config/nginx/nginx.default.conf), proxied to
// router-manager's /api/tailscale/*, a separate prefix from Dev Proxy's
// (../../api/client's default export).
import { createApiClient, errorMessage } from '../../api/client'

export const { api } = createApiClient('router/api/tailscale')
export { errorMessage }
