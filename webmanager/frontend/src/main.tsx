import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTheme, setEmbedTheme } from './theme.ts'
import { EMBED, embedParams, installEmbedBridges, onHostMessage } from './embed.ts'

// Applied synchronously before the first render so the stored theme choice
// (if any) is already on <html> before anything paints - see theme.ts.
initTheme()
installEmbedBridges()
if (EMBED) {
  if (embedParams.theme) setEmbedTheme(embedParams.theme)
  onHostMessage((msg) => {
    if (msg.type === 'theme') setEmbedTheme(msg.theme)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
