import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initEmbedTheme } from './embedTheme.ts'

// Applied synchronously before the first render, same reasoning as
// webmanager's own initTheme() - see embedTheme.ts.
initEmbedTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
