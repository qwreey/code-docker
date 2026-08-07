// Theme control for when this SPA is embedded in a cross-origin iframe
// (webmanager's Dev Proxy/App Routes/Tailscale tabs, once ROUTER_MANAGER_HOSTS
// is configured - see RouterFrame.tsx on the webmanager side). A cross-origin
// parent can't touch this document's DOM/localStorage directly (Same-Origin
// Policy), so there's no way to just "read webmanager's theme choice" - the
// parent has to tell us, via the initial page URL (first paint, before any JS
// message can possibly arrive) and postMessage (live updates after that).
// Same data-theme attribute + three-way light/dark/system idiom as
// webmanager's own theme.ts, so the [data-theme] CSS blocks in index.css line
// up with it exactly - 'system' just means "no override", deferring to the
// existing prefers-color-scheme media query.
export type EmbedTheme = 'light' | 'dark' | 'system'

// Messages from an unexpected origin are ignored by shape, not by
// event.origin allow-listing - the parent's own hostname isn't known to this
// bundle ahead of time (it's whatever ROUTER_MANAGER_HOSTS ends up being,
// operator-configured), and the only thing a forged message could do is
// flip the color scheme, which isn't worth the extra plumbing to fully lock
// down. The distinguishing `source` marker just keeps this from misfiring on
// unrelated postMessage traffic (browser extensions, devtools bridges, etc).
const MESSAGE_SOURCE = 'code-docker-router-embed'

function isEmbedTheme(v: unknown): v is EmbedTheme {
  return v === 'light' || v === 'dark' || v === 'system'
}

function applyEmbedTheme(theme: EmbedTheme) {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
}

// Call once, synchronously, before React renders anything (see main.tsx) -
// same reasoning as webmanager's own initTheme(): applying this later, from
// a useEffect, would flash the wrong theme for a frame. Only meaningful in
// embed mode (?embed=1&theme=...) - a direct/standalone visit has no
// ?theme= param and this is a silent no-op (system, unchanged).
export function initEmbedTheme(): EmbedTheme {
  const theme = new URLSearchParams(window.location.search).get('theme')
  const choice = isEmbedTheme(theme) ? theme : 'system'
  applyEmbedTheme(choice)
  return choice
}

// Live updates after first paint - e.g. the user toggles webmanager's own
// theme while a tab is already embedded. Returns a cleanup function.
export function listenForEmbedThemeMessages(): () => void {
  function onMessage(event: MessageEvent) {
    const data = event.data
    if (!data || typeof data !== 'object' || data.source !== MESSAGE_SOURCE || data.type !== 'theme') return
    if (isEmbedTheme(data.theme)) applyEmbedTheme(data.theme)
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

// Tells the embedding parent (RouterFrame.tsx) this page has actually
// mounted and painted, so it can drop its skeleton overlay immediately
// instead of waiting on the onLoad+200ms/3s-hard-cap timers alone - onLoad
// only means "the iframe's own HTML/JS/CSS finished loading", not "the
// React app inside rendered anything yet". Target '*' rather than a fixed
// origin, same reasoning as the incoming-message check above: this bundle
// doesn't know webmanager's origin ahead of time (operator-configured via
// ROUTER_MANAGER_HOSTS on the *other* side), and the only thing riding on
// this message is a UI-timing signal, not anything sensitive. No-op outside
// an iframe (window.parent === window), so this is safe to call
// unconditionally.
export function notifyEmbedReady() {
  if (window.parent === window) return
  window.parent.postMessage({ source: MESSAGE_SOURCE, type: 'ready' }, '*')
}
