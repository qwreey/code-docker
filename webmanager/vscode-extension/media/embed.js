// Runs inside the webview (the VS Code-owned frame that hosts webmanager's
// iframe). It sits between two message channels and translates:
//   webmanager (EP, the iframe) <-> this frame (WV) <-> extension host (EH)
// EP and WV share an origin (see src/html.js), so EP's messages are checked
// by origin + source window; EH's messages arrive through VS Code's own
// channel and carry no `source` field.
;(function () {
  'use strict'

  const SOURCE = 'cd-webmanager-embed'
  const vscode = acquireVsCodeApi()
  const cfg = JSON.parse(document.getElementById('cd-config').textContent)
  const frame = document.getElementById('cd-frame')
  const banner = document.getElementById('cd-banner')

  let chords = new Set(cfg.chords || [])
  let readyTimer = null

  // What gets saved (setState): everything the extension needs to restore
  // this view, stamped with this render's binding nonce - but never the
  // initial command. That one ran when the session was created, and a saved
  // copy would re-run it whenever a refresh has to recreate the session
  // (a finished `claude --resume` coming back as a fresh resume).
  function persist(state) {
    const { command, source, v, ...rest } = state
    void command
    void source
    void v
    vscode.setState({ ...rest, bind: cfg.bind })
  }

  // Where to start. A view that isn't kept alive while hidden is rebuilt from
  // this same HTML when shown again, so it resumes where it last was - the
  // Files folder browsed to, the session a terminal was switched or renamed
  // to - rather than where it was first opened. Only state saved under this
  // render's own binding counts: a slot rebound to another page renders new
  // HTML (new nonce), and must not resurrect what the slot showed before.
  function terminalPath(state) {
    const q = new URLSearchParams()
    if (state.session) q.set('session', state.session)
    if (state.cwd) q.set('cwd', state.cwd)
    const qs = q.toString()
    return 'terminal' + (qs ? `?${qs}` : '')
  }
  const saved = vscode.getState()
  let startPath = cfg.path
  if (saved && saved.bind === cfg.bind && typeof saved.section === 'string') {
    if (saved.section === 'terminal') startPath = terminalPath(saved)
    else if (typeof saved.path === 'string') startPath = saved.path
  }
  persist({ ...cfg.state, ...(saved && saved.bind === cfg.bind ? saved : {}), path: startPath })
  vscode.postMessage({ type: 'wv-ready', secure: window.isSecureContext })

  function currentTheme() {
    const c = document.body.classList
    return c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? 'light' : 'dark'
  }

  function baseUrl() {
    return new URL(cfg.basePath, location.origin)
  }

  function frameUrl(path) {
    const u = new URL(path, baseUrl())
    u.searchParams.set('embed', 'vscode')
    u.searchParams.set('theme', currentTheme())
    return u.toString()
  }

  function showBanner(text) {
    banner.textContent = text
    banner.hidden = !text
  }

  function navigate(path) {
    showBanner('')
    clearTimeout(readyTimer)
    // No `ready` from webmanager in time means the page never came up as
    // an embed: an older webmanager without embed mode, a wrong basePath,
    // or a load error. Say so instead of leaving an empty pane.
    readyTimer = setTimeout(() => {
      showBanner('webmanager가 응답하지 않습니다 — 새로고침하거나 webmanager 상태를 확인하세요.')
      vscode.postMessage({ type: 'embed-timeout' })
    }, 15000)
    frame.src = frameUrl(path)
  }

  function toEmbed(msg) {
    try {
      frame.contentWindow.postMessage({ source: SOURCE, v: 1, ...msg }, location.origin)
    } catch {
      // frame not loaded yet - nothing to tell
    }
  }

  // Key chords normalized from the physical key (e.code), so a layout
  // change doesn't change what matches. Modifier order is fixed.
  function chordOf(e) {
    const code = e.code || ''
    if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code)) return null
    let key
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase()
    else if (/^Digit\d$/.test(code)) key = code.slice(5)
    else if (/^Numpad\d$/.test(code)) key = code.slice(6)
    else if (code === 'Backquote') key = '`'
    else if (/^F\d{1,2}$/.test(code)) key = code.toLowerCase()
    else key = code.toLowerCase()
    const mods = []
    if (e.ctrlKey) mods.push('ctrl')
    if (e.shiftKey) mods.push('shift')
    if (e.altKey) mods.push('alt')
    if (e.metaKey) mods.push('meta')
    return [...mods, key].join('+')
  }

  // Capture phase on the iframe's window, so this runs before xterm's own
  // textarea handler swallows the key. VS Code only acts on *trusted* key
  // events forwarded out of a webview, so re-dispatching the key can't work;
  // the extension host runs the mapped command itself instead.
  function onKeyDown(e) {
    const chord = chordOf(e)
    if (!chord || !chords.has(chord)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    vscode.postMessage({ type: 'key', chord })
  }
  window.addEventListener('keydown', onKeyDown, true)

  frame.addEventListener('load', () => {
    try {
      frame.contentWindow.addEventListener('keydown', onKeyDown, true)
    } catch {
      // cross-origin (misconfigured basePath) - passthrough just won't work
    }
  })

  // VS Code focuses the webview (e.g. after a quick pick closes); hand that
  // on to webmanager so typing lands in the terminal again.
  window.addEventListener('focus', () => {
    try {
      frame.contentWindow.focus()
    } catch {
      // ignore
    }
    toEmbed({ type: 'focus' })
  })

  new MutationObserver(() => toEmbed({ type: 'theme', theme: currentTheme() })).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  })

  // Whether win is the webmanager frame or nested anywhere inside it.
  // `parent` is readable even on a cross-origin window, so this also covers
  // a cross-origin frame (router on its own host) and its children.
  function fromEmbedTree(win) {
    for (let w = win; w; ) {
      if (w === frame.contentWindow) return true
      let up
      try {
        up = w.parent
      } catch {
        return false
      }
      if (!up || up === w) return false
      w = up
    }
    return false
  }

  window.addEventListener('message', (e) => {
    const data = e.data
    if (!data || typeof data !== 'object') return

    if (e.source === frame.contentWindow) {
      if (e.origin !== location.origin || data.source !== SOURCE) return
      if (data.type === 'ready') {
        clearTimeout(readyTimer)
        showBanner('')
      }
      if (data.type === 'state') {
        const href = new URL(data.path || '', baseUrl()).toString()
        persist({ ...cfg.state, ...data })
        vscode.postMessage({ ...data, source: undefined, v: undefined, href })
        return
      }
      vscode.postMessage({ ...data, source: undefined, v: undefined })
      return
    }

    // From the extension host. Anything posted from inside webmanager's own
    // frame tree - a router page or whatever it embeds, nested any depth -
    // is refused, so nothing there can impersonate the host: `navigate` to
    // terminal?cmd=... would otherwise run a command. (Not "must equal
    // window.parent": VS Code's own frame layout around this document isn't
    // something to pin down, and that check dropped the real host's messages.)
    if (data.source || (e.source && fromEmbedTree(e.source))) return
    switch (data.type) {
      case 'navigate':
        if (data.state) cfg.state = data.state
        persist({ ...cfg.state, path: data.path })
        navigate(data.path)
        break
      case 'focus':
        try {
          frame.contentWindow.focus()
        } catch {
          // ignore
        }
        toEmbed({ type: 'focus' })
        break
      case 'keys':
        chords = new Set(data.chords || [])
        break
      case 'pin':
      case 'rename':
        toEmbed(data)
        break
    }
  })

  navigate(startPath)
})()
