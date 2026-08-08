// The DNS tab's own bound API client - same pattern as Tailscale/client.ts,
// bound to router-manager's /api/dns/* routes.
import { createApiClient, errorMessage } from '../../api/client'

export const { api } = createApiClient('router/api/dns')
export { errorMessage }
