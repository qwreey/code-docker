import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Standalone dev-server config, used when running `npm run dev` directly
// inside router/frontend to preview components in isolation. When webmanager
// imports this package's components instead (see src/index.ts), this file
// isn't involved at all - webmanager's own Vite config builds them as part
// of its own bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_ROUTER_MANAGER_PROXY_TARGET || 'http://localhost:8091'

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  }
})
