import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initEmbedTheme } from './embedTheme.ts'
import { initTheme } from './theme.ts'

// Applied synchronously before the first render, same reasoning as
// webmanager's own initTheme() - see embedTheme.ts/theme.ts. Exactly one of
// the two runs: an embedded visit (?embed=1) is theme-driven by the parent
// frame (embedTheme.ts, postMessage-only - it can't read this page's own
// localStorage across origins), a standalone visit uses this page's own
// persisted choice (theme.ts) instead, same as webmanager's sidebar footer
// toggle. Running both would just have the second call silently win the
// initial paint, so this picks the one that actually applies up front.
if (new URLSearchParams(window.location.search).get('embed') === '1') {
  initEmbedTheme()
} else {
  initTheme()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
