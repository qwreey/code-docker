import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_BACKEND_PROXY_TARGET || 'http://localhost:8081'

  return {
    // Only the production build is served under /manager (nginx strips the
    // prefix, see config/nginx.default.conf) - dev keeps hitting webmanager
    // directly at root, so the dev proxy's '/api' key doesn't need rewriting.
    base: command === 'build' ? '/manager/' : '/',
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
