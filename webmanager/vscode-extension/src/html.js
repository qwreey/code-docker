'use strict'

const crypto = require('crypto')
const vscode = require('vscode')

// The path (relative to webmanager's base) a view shows. Kept without
// `embed`/`theme` - media/embed.js adds those - so it's the same string the
// view reports back in its `state` messages and the serializer stores.
//
// A terminal always carries its cwd: the backend only honors it when the
// session doesn't exist yet, so that is exactly what turns "restore after
// refresh" into "recreate under the same name in the same place" when the
// session died in the meantime (idle GC, webmanager restart).
function buildPath(state) {
  const section = state.section || 'terminal'
  const params = new URLSearchParams()
  if (section === 'terminal') {
    if (state.session) params.set('session', state.session)
    if (state.cwd) params.set('cwd', state.cwd)
    if (state.command) params.set('cmd', state.command)
  } else if (state.query) {
    for (const [k, v] of new URLSearchParams(state.query)) params.set(k, v)
  }
  const qs = params.toString()
  return section + (qs ? `?${qs}` : '')
}

const MODIFIER_ORDER = ['ctrl', 'shift', 'alt', 'meta']

// A chord in the one spelling media/embed.js produces: modifiers in the
// order ctrl, shift, alt, meta, then the key. Configured chords go through
// this too, so "meta+shift+p" and "shift+meta+p" mean the same thing.
function canonicalChord(chord) {
  const parts = String(chord).toLowerCase().split('+').filter(Boolean)
  const mods = MODIFIER_ORDER.filter((m) => parts.includes(m))
  const keys = parts.filter((p) => !MODIFIER_ORDER.includes(p))
  return [...mods, ...keys].join('+')
}

function passthroughChords() {
  const entries = vscode.workspace.getConfiguration('webmanager').get('passthroughKeys') || []
  return entries.filter((e) => e && typeof e.key === 'string').map((e) => canonicalChord(e.key))
}

// The webview document. Everything real happens in media/embed.js; this only
// hands it the initial configuration. The CSP's frame-src 'self' is
// code-server's own origin: webviews are served from it (relative
// webviewEndpoint), and so is webmanager (nginx /manager/), so the nested
// frame is same-origin all the way up - which is what makes webmanager's
// cookie, clipboard and fullscreen work inside it at all.
function render(webview, extensionUri, { state, build }) {
  const nonce = crypto.randomBytes(16).toString('base64')
  const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f))
  const basePath = vscode.workspace.getConfiguration('webmanager').get('basePath') || '/manager/'
  const config = {
    // Identifies this render; see media/embed.js's startPath.
    bind: crypto.randomBytes(9).toString('base64'),
    basePath,
    path: buildPath(state),
    state,
    chords: passthroughChords(),
    build,
  }
  const json = JSON.stringify(config).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('embed.css')}">
</head>
<body>
<div id="cd-banner" hidden></div>
<iframe id="cd-frame" allow="clipboard-read; clipboard-write; fullscreen; publickey-credentials-get; publickey-credentials-create"></iframe>
<script id="cd-config" type="application/json">${json}</script>
<script nonce="${nonce}" src="${media('embed.js')}"></script>
</body>
</html>`
}

module.exports = { buildPath, render, passthroughChords, canonicalChord }
