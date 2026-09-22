// Embed mode: webmanager shown inside code-server by code-docker's built-in
// extension (webmanager/vscode-extension/), one view per page - an editor
// tab or a bottom-panel slot. The extension's webview loads us as
// `/manager/<section>?embed=vscode&theme=...` and relays messages between us
// and the extension host; see webmanager/.claude/qa-request/code-server-embed-plan-done.md.
//
// What changes here: no app chrome (sidebar, banners), the Terminal shows a
// single session, and anything that would open a new browsing context
// (window.open, target=_blank/_top links) is handed to the extension
// instead - the webview's sandbox has no allow-popups/allow-top-navigation,
// so those fail silently otherwise.
//
// Everything is same-origin (webviews and /manager/ are both served from
// code-server's origin), so the parent isn't a trust boundary; messages are
// still checked for origin, source window and our own `source` tag.

export const EMBED_SOURCE = 'cd-webmanager-embed'

const params = new URLSearchParams(window.location.search)

export const EMBED = params.get('embed') === 'vscode' && window.parent !== window

// Read once at load: these describe what the view was opened with, and later
// URL rewrites (writeQuery) don't change that.
export const embedParams = {
  session: params.get('session'),
  cwd: params.get('cwd') || undefined,
  command: params.get('cmd') || undefined,
  theme: params.get('theme') === 'light' ? 'light' : params.get('theme') === 'dark' ? 'dark' : null,
} as const

export type HostMessage =
  | { type: 'focus' }
  | { type: 'theme'; theme: 'light' | 'dark' }
  | { type: 'pin'; pinned: boolean }
  | { type: 'rename'; name: string }
  | { type: 'open-webauthn' }
  | { type: 'lock' }
  | { type: 'open-vnc'; name: string }

export function postToHost(msg: Record<string, unknown>) {
  if (!EMBED) return
  window.parent.postMessage({ source: EMBED_SOURCE, v: 1, ...msg }, window.location.origin)
}

const hostListeners = new Set<(msg: HostMessage) => void>()

export function onHostMessage(listener: (msg: HostMessage) => void) {
  hostListeners.add(listener)
  return () => {
    hostListeners.delete(listener)
  }
}

// Query keys that only mean something to the embed itself, and so never
// belong in the path reported back (which is also what "Open in Browser"
// opens).
const EMBED_ONLY_KEYS = ['embed', 'theme', 'cwd', 'cmd']

type EmbedState = { session?: string | null; cwd?: string; pinned?: boolean }
let extraState: EmbedState = {}
let lastSent = ''

// Tells the extension what this view currently shows: which section, the
// in-tab query (?session=/?path=/?project=) and, for a terminal, the live
// session name/cwd/pin. It saves this to restore the view after a browser
// refresh and to title the tab. Safe to call often - identical reports are
// dropped.
export function reportEmbedState(extra?: EmbedState) {
  if (!EMBED) return
  if (extra) extraState = { ...extraState, ...extra }
  const segments = window.location.pathname.split('/')
  const section = segments[segments.length - 1] || 'supervisor'
  const query = new URLSearchParams(window.location.search)
  for (const k of EMBED_ONLY_KEYS) query.delete(k)
  const qs = query.toString()
  const msg = {
    type: 'state',
    section,
    query: qs,
    path: section + (qs ? `?${qs}` : ''),
    session: extraState.session ?? undefined,
    cwd: extraState.cwd,
    pinned: extraState.pinned,
  }
  const key = JSON.stringify(msg)
  if (key === lastSent) return
  lastSent = key
  postToHost(msg)
}

function onLinkClick(e: MouseEvent) {
  const target = e.target instanceof Element ? e.target : null
  const a = target?.closest('a[href]') as HTMLAnchorElement | null
  if (!a || a.hasAttribute('download')) return
  const newContext = a.target === '_blank' || e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey
  const leavesFrame = a.target === '_top' || a.target === '_parent'
  if (!newContext && !leavesFrame) return
  let url: URL
  try {
    url = new URL(a.href, window.location.href)
  } catch {
    return
  }
  e.preventDefault()
  e.stopPropagation()
  // code-server's own "open this folder" link (Terminal/Projects/Files'
  // "code로 열기") becomes a new code-server window rather than a browser tab.
  const folder = url.origin === window.location.origin && url.pathname === '/' ? url.searchParams.get('folder') : null
  if (folder) postToHost({ type: 'open-folder', path: folder })
  else postToHost({ type: 'open-external', url: url.toString() })
}

// Call once, before the first render (see main.tsx).
export function installEmbedBridges() {
  if (!EMBED) return
  document.documentElement.dataset.embed = 'vscode'
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== window.location.origin) return
    const data = e.data
    if (!data || typeof data !== 'object' || data.source !== EMBED_SOURCE) return
    hostListeners.forEach((listener) => listener(data as HostMessage))
  })
  document.addEventListener('click', onLinkClick, true)
  document.addEventListener('auxclick', onLinkClick, true)
  window.open = ((url?: string | URL) => {
    if (url) {
      try {
        postToHost({ type: 'open-external', url: new URL(String(url), window.location.href).toString() })
      } catch {
        // not a URL - nothing to open
      }
    }
    return null
  }) as typeof window.open
  postToHost({ type: 'ready', section: window.location.pathname.split('/').pop() || 'supervisor' })
}
