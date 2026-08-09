import { useEffect } from 'react'

// When webmanager is opened as code-server's overlay widget
// (config/code/code-patch/webmanager-launcher.default.js embeds /manager/ in
// an <iframe>), Escape has nowhere to go: keydown events inside an <iframe>
// never bubble into the parent document, so the launcher script's own
// Escape listener (bound to the code-server document) never sees them. This
// asks the parent to close instead, via postMessage - but only when none of
// our own dialogs are open, since those already own Escape to close
// themselves first (ConfirmDialog/Sheet/UnlockModal/ToolSearchDialog/
// JobDialog/ClaudeCode's install overlay all carry role="dialog" or
// role="alertdialog" for exactly this detection). Standalone visits
// (window.parent === window, e.g. opening /manager/ directly) never post -
// there's nothing embedding us to ask.
const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]'

export function useEmbedEscapeClose() {
  useEffect(() => {
    if (window.parent === window) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (document.querySelector(DIALOG_SELECTOR)) return
      window.parent.postMessage({ type: 'cd-webmanager-close-request' }, window.location.origin)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])
}
