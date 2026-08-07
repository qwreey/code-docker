import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Standalone dev-server config, used when running `npm run dev` directly
// inside router/frontend to preview components in isolation. When webmanager
// imports this package's components instead (see src/index.ts), this file
// isn't involved at all - webmanager's own Vite config builds them as part
// of its own bundle.
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_ROUTER_MANAGER_PROXY_TARGET || 'http://localhost:8091'

  return {
    // Relative (not an absolute prefix like webmanager's own '/manager/' -
    // see webmanager/frontend/vite.config.ts) because this SPA is served
    // from two different path depths depending on deployment: the shared
    // hostname's /router/ path (router/config/nginx/nginx.default.conf),
    // or the root of a dedicated ROUTER_MANAGER_HOSTS domain (see that same
    // file's NGINX_ROUTER_MANAGER_SERVER_BLOCK). A relative base resolves
    // correctly under either, as long as the page itself is always reached
    // with a trailing slash (bare "/router" with no slash would resolve
    // "./assets/x.js" against the wrong directory - every internal link
    // here already uses the trailing-slash form). Confirmed live: an
    // absolute '/' base (the previous default) 404s every asset under
    // /router/, since the browser resolves a root-absolute src against the
    // origin root, bypassing the /router/ prefix entirely.
    base: command === 'build' ? './' : '/',
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
