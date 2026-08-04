import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DevAuth } from './components/DevAuth/DevAuth.tsx'
import { initTheme } from './theme.ts'

// Applied synchronously before the first render so the stored theme choice
// (if any) is already on <html> before anything paints - see theme.ts.
initTheme()

// This SPA has no router (App.tsx switches tabs via useState, the URL never
// changes) - /dev-auth is the one exception, a standalone page (no Sidebar/
// app shell) that Caddy's forward_auth redirects browsers to for dev-proxy
// exposes (see DevAuth.tsx, GET /api/auth/verify). Checked before <App/>
// mounts rather than via a real route, since backend/static.go already
// falls back any unmatched GET to index.html - no router needed for one path.
const isDevAuth = window.location.pathname === `${import.meta.env.BASE_URL}dev-auth`

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isDevAuth ? <DevAuth /> : <App />}</StrictMode>,
)
