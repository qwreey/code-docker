'use strict'

// code-docker's built-in webmanager extension: webmanager's own pages
// (terminal sessions above all) as editor tabs and bottom-panel views. See
// webmanager/.claude/qa-request/code-server-embed-plan-done.md for the design, and
// config/code/code-extensions.default.sh for how it is installed/synced.
//
// Every view ("host" below) is a webview whose script, media/embed.js,
// loads webmanager in an iframe and relays messages. This file owns what
// only the extension host can do: commands, pickers, the panel serializer,
// the slot bindings, and acting on what a view asks for (open a URL, run a
// mapped VS Code command, ...). It never trusts a view with anything beyond
// that: commands come only from its own passthroughKeys config, URLs must be
// http(s), folders absolute.

const fs = require('fs')
const path = require('path')
const vscode = require('vscode')
const { SECTIONS, sectionLabel } = require('./src/sections')
const S = require('./src/sessions')
const { buildPath, render, passthroughChords, canonicalChord } = require('./src/html')

const VIEW_TYPE = 'webmanager.page'
const SLOT_IDS = ['term1', 'term2', 'term3', 'term4', 'page1', 'page2']
const SLOTS_KEY = 'webmanager.slots'

let ctx
let output
let build = 'dev'
let warnedInsecure = false
const hosts = new Set()
const slotHosts = new Map()
let activePanelHost = null

function log(line) {
  output.appendLine(`[${new Date().toISOString()}] ${line}`)
}

function mediaUri(file) {
  return vscode.Uri.joinPath(ctx.extensionUri, 'media', file)
}

function isTerminalSlot(id) {
  return id.startsWith('term')
}

function retainFor(kind) {
  const r = vscode.workspace.getConfiguration('webmanager').get('retainContextWhenHidden') || {}
  return kind === 'terminal' ? r.terminal !== false : r.other === true
}

// Only the fields a view is identified by. Everything else a `state`
// message carries (href, title, ...) is transient.
function normalizeState(s) {
  s = s || {}
  const out = { section: typeof s.section === 'string' ? s.section : 'terminal' }
  for (const k of ['session', 'cwd', 'command', 'query']) {
    if (typeof s[k] === 'string' && s[k]) out[k] = s[k]
  }
  if (typeof s.pinned === 'boolean') out.pinned = s.pinned
  return out
}

function titleOf(state) {
  if (state.section === 'terminal') return state.session || 'Terminal'
  return sectionLabel(state.section)
}

function updateTitle(host) {
  const title = titleOf(host.state)
  if (host.kind === 'panel') {
    host.panel.title = host.state.pinned ? `📌 ${title}` : title
  } else {
    host.view.title = title
    host.view.description = host.state.section === 'terminal' ? S.folderBase(host.state.cwd) : undefined
  }
}

function attach(host, webview, state) {
  host.state = normalizeState(state)
  host.webview = webview
  webview.options = { enableScripts: true, enableForms: true, localResourceRoots: [mediaUri('')] }
  webview.html = render(webview, ctx.extensionUri, { state: host.state, build })
  host.subscription = webview.onDidReceiveMessage((m) => onMessage(host, m))
  // A webview needs a secure context for its service worker: over plain
  // http on a LAN address it never boots, so nothing inside it can report
  // the problem. Its absence is the only signal there is.
  clearTimeout(host.readyTimer)
  host.readyTimer = setTimeout(() => {
    log(`view ${describe(host)} never reported ready`)
    if (warnedInsecure) return
    warnedInsecure = true
    vscode.window.showWarningMessage(
      'webmanager 뷰가 뜨지 않았습니다. code-server를 HTTPS(또는 localhost)로 열어야 웹뷰가 동작합니다.',
    )
  }, 10000)
  updateTitle(host)
}

function detach(host) {
  clearTimeout(host.readyTimer)
  if (host.subscription) host.subscription.dispose()
  hosts.delete(host)
}

function describe(host) {
  return host.kind === 'panel' ? `panel "${titleOf(host.state)}"` : `slot ${host.id}`
}

function navigateHost(host, state) {
  host.state = normalizeState(state)
  host.webview.postMessage({ type: 'navigate', path: buildPath(host.state), state: host.state })
  updateTitle(host)
}

// Where a session is already shown in this window: a live view, or a panel
// slot bound to it that simply hasn't been expanded since the last reload
// (its view isn't resolved yet, so it isn't in `hosts` - but opening the
// session elsewhere would still end up with two clients once it is).
function findSessionHost(name, except) {
  for (const h of hosts) {
    if (h !== except && h.state && h.state.section === 'terminal' && h.state.session === name) return h
  }
  const bindings = slotBindings()
  for (const id of SLOT_IDS) {
    if (slotHosts.has(id) || (except && except.kind === 'slot' && except.id === id)) continue
    const b = bindings[id]
    if (b && b.section === 'terminal' && b.session === name) return { kind: 'slot', id }
  }
  return null
}

function revealHost(host) {
  if (host.kind === 'panel') host.panel.reveal()
  else vscode.commands.executeCommand(`webmanager.${host.id}.focus`)
}

// ---- editor panels ---------------------------------------------------------

function setupPanel(panel, state) {
  const host = { kind: 'panel', panel }
  hosts.add(host)
  panel.iconPath = mediaUri('icon.svg')
  attach(host, panel.webview, state)
  if (panel.active) activePanelHost = host
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) activePanelHost = host
  })
  panel.onDidDispose(() => {
    detach(host)
    if (activePanelHost === host) activePanelHost = null
  })
  return host
}

function createPanel(state, column) {
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    titleOf(normalizeState(state)),
    { viewColumn: column || vscode.ViewColumn.Active, preserveFocus: false },
    {
      enableScripts: true,
      enableForms: true,
      retainContextWhenHidden: retainFor(state.section === 'terminal' ? 'terminal' : 'other'),
      localResourceRoots: [mediaUri('')],
    },
  )
  return setupPanel(panel, state)
}

// ---- panel slots -----------------------------------------------------------

function slotBindings() {
  return ctx.workspaceState.get(SLOTS_KEY, {})
}

async function saveBinding(id, state) {
  const b = { ...slotBindings() }
  if (state) b[id] = state
  else delete b[id]
  await ctx.workspaceState.update(SLOTS_KEY, b)
}

function setSlotContext(id, on) {
  // term1 has no `when` clause: it is always there, showing the terminal
  // Home while unbound, so the panel tab never disappears.
  if (id === 'term1') return Promise.resolve()
  return vscode.commands.executeCommand('setContext', `webmanager.slot.${id}`, on)
}

function defaultSlotState(id) {
  return isTerminalSlot(id) ? { section: 'terminal', cwd: S.defaultCwd() } : { section: 'supervisor' }
}

function slotProvider(id) {
  return {
    resolveWebviewView(view) {
      const host = { kind: 'slot', id, view }
      hosts.add(host)
      slotHosts.set(id, host)
      attach(host, view.webview, slotBindings()[id] || defaultSlotState(id))
      view.onDidDispose(() => {
        detach(host)
        if (slotHosts.get(id) === host) slotHosts.delete(id)
      })
    },
  }
}

async function bindSlot(id, state) {
  state = normalizeState(state)
  await saveBinding(id, state)
  await setSlotContext(id, true)
  const host = slotHosts.get(id)
  if (host) {
    host.closedState = null
    navigateHost(host, state)
  }
  await vscode.commands.executeCommand(`webmanager.${id}.focus`)
}

async function closeSlot(id) {
  const host = slotHosts.get(id)
  // A `state` report already in flight from the view being closed would
  // otherwise re-save the binding just removed, and the slot would come back
  // on the next reload. Anything that names a different page still counts
  // (term1 goes on to show Home, where the user may pick a new session).
  if (host) host.closedState = host.state
  await saveBinding(id, null)
  if (id === 'term1') {
    if (host) navigateHost(host, defaultSlotState(id))
  } else {
    setSlotContext(id, false)
  }
}

// The slot a state should go into: the first free one of its kind, or the
// one the user picks to replace. undefined when they dismiss the picker.
async function pickSlot(state) {
  const kind = state.section === 'terminal' ? 'term' : 'page'
  const ids = SLOT_IDS.filter((i) => i.startsWith(kind))
  const bindings = slotBindings()
  const free = ids.find((i) => !bindings[i])
  if (free) return free
  const pick = await vscode.window.showQuickPick(
    ids.map((i) => ({ label: titleOf(normalizeState(bindings[i])), description: i, id: i })),
    { placeHolder: '빈 슬롯이 없습니다 — 바꿀 슬롯을 고르세요' },
  )
  return pick ? pick.id : undefined
}

async function openInPanel(state) {
  state = normalizeState(state)
  const id = await pickSlot(state)
  if (id) await bindSlot(id, state)
}

// ---- pickers ---------------------------------------------------------------

async function pickSession(placeHolder) {
  let names = []
  let error
  try {
    names = await S.fetchSessionNames()
  } catch (e) {
    error = e
  }
  const items = []
  const folders = (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file')
  if (folders.length > 1) {
    for (const f of folders) items.push({ label: '$(add) 새 세션', description: f.uri.fsPath, cwd: f.uri.fsPath, isNew: true })
  } else {
    const cwd = S.defaultCwd()
    items.push({ label: '$(add) 새 세션', description: cwd || '', cwd, isNew: true })
  }
  if (error) {
    items.push({ label: `세션 목록을 불러오지 못했습니다 (${error.message})`, kind: vscode.QuickPickItemKind.Separator })
  } else if (names.length) {
    items.push({ label: '열린 세션', kind: vscode.QuickPickItemKind.Separator })
    for (const n of names) items.push({ label: n, description: findSessionHost(n) ? '열려 있음' : '', session: n })
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: placeHolder || 'webmanager 터미널 세션' })
  if (!pick) return undefined
  if (pick.session) return { section: 'terminal', session: pick.session }
  const name = await vscode.window.showInputBox({
    prompt: '새 세션 이름',
    value: S.uniqueName(S.folderBase(pick.cwd) || '세션', names),
    validateInput: (v) => S.validateName(v.trim(), names),
  })
  if (!name) return undefined
  return { section: 'terminal', session: name.trim(), cwd: pick.cwd }
}

async function pickSection() {
  const pick = await vscode.window.showQuickPick(
    SECTIONS.map((s) => ({ label: `$(${s.icon}) ${s.label}`, description: s.id, id: s.id })),
    { placeHolder: 'webmanager 탭' },
  )
  if (!pick) return undefined
  if (pick.id === 'terminal') return pickSession()
  return { section: pick.id }
}

// ---- opening ---------------------------------------------------------------

// One place a given session is shown per window: asking for it again
// brings the existing view forward instead of opening a second copy that
// would fight the first over the terminal size.
function openState(state, column) {
  if (state.section === 'terminal' && state.session) {
    const existing = findSessionHost(state.session)
    if (existing) {
      revealHost(existing)
      return
    }
  }
  createPanel(state, column)
}

async function openStateInPanel(state) {
  if (state.section === 'terminal' && state.session) {
    const existing = findSessionHost(state.session)
    if (existing) {
      revealHost(existing)
      return
    }
  }
  await openInPanel(state)
}

// "Open in terminal" asked for from inside a view (Projects, Files, the
// Claude session log's resume, ...). The embed has no terminal tab of its
// own to switch to, so it becomes a new editor tab beside the current one.
async function openTerminalFromEmbed(m) {
  if (typeof m.session === 'string' && m.session) {
    openState({ section: 'terminal', session: m.session }, vscode.ViewColumn.Beside)
    return
  }
  let names = []
  try {
    names = await S.fetchSessionNames()
  } catch {
    // name collision just becomes a join instead of a new session - the
    // cwd/command are then ignored, same as the Terminal tab's own "+"
  }
  const cwd = typeof m.cwd === 'string' && m.cwd.startsWith('/') ? m.cwd : undefined
  const base = (typeof m.label === 'string' && m.label) || S.folderBase(cwd) || '세션'
  openState(
    {
      section: 'terminal',
      session: S.uniqueName(base, names),
      cwd,
      command: typeof m.command === 'string' ? m.command : undefined,
    },
    vscode.ViewColumn.Beside,
  )
}

// ---- messages from views ---------------------------------------------------

function isHttpUrl(u) {
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:'
  } catch {
    return false
  }
}

async function onMessage(host, m) {
  if (!m || typeof m.type !== 'string') return
  switch (m.type) {
    case 'wv-ready':
      clearTimeout(host.readyTimer)
      if (!m.secure) log(`view ${describe(host)} is not in a secure context`)
      break
    case 'embed-timeout':
      log(`view ${describe(host)}: webmanager never reported ready`)
      break
    case 'state': {
      host.state = normalizeState({ ...host.state, ...m })
      // The initial command ran when the session was created. Keeping it
      // would re-run it on a later recreate (the backend only uses it on
      // creation) - a resumed `claude --resume` that ended would come back
      // as a fresh resume on the next refresh.
      if (host.state.session) delete host.state.command
      if (typeof m.href === 'string') host.href = m.href
      updateTitle(host)
      // A slot remembers what it shows so a refresh restores it - but only
      // something worth restoring: the terminal Home (no session) isn't.
      if (host.kind === 'slot' && (host.state.section !== 'terminal' || host.state.session)) {
        const closed = host.closedState
        const sameAsClosed =
          closed && closed.section === host.state.section && closed.session === host.state.session && closed.query === host.state.query
        if (!sameAsClosed) {
          host.closedState = null
          await saveBinding(host.id, host.state)
        }
      }
      break
    }
    case 'open-external':
      if (typeof m.url === 'string' && isHttpUrl(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url))
      break
    case 'open-folder':
      if (typeof m.path === 'string' && m.path.startsWith('/')) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(m.path), { forceNewWindow: true })
      }
      break
    case 'open-terminal':
      await openTerminalFromEmbed(m)
      break
    case 'close-request':
      if (host.kind === 'panel') host.panel.dispose()
      else await closeSlot(host.id)
      break
    case 'session-ended':
      log(`view ${describe(host)}: session "${m.session}" ended`)
      break
    case 'key': {
      const entries = vscode.workspace.getConfiguration('webmanager').get('passthroughKeys') || []
      const entry = entries.find((e) => e && typeof e.key === 'string' && canonicalChord(e.key) === m.chord)
      if (entry && typeof entry.command === 'string') {
        await vscode.commands.executeCommand(entry.command, ...(entry.args === undefined ? [] : [entry.args]))
      }
      break
    }
  }
}

// ---- view actions ------------------------------------------------------------

async function changeSession(host) {
  const state = await pickSession('이 뷰에 띄울 세션')
  if (!state) return
  const existing = findSessionHost(state.session, host)
  if (existing) {
    revealHost(existing)
    return
  }
  if (host.kind === 'slot') await bindSlot(host.id, state)
  else navigateHost(host, state)
}

async function renameSession(host) {
  if (!host || host.state.section !== 'terminal' || !host.state.session) return
  let names = []
  try {
    names = await S.fetchSessionNames()
  } catch {
    // the backend still refuses a taken name
  }
  const others = names.filter((n) => n !== host.state.session)
  const name = await vscode.window.showInputBox({
    prompt: '세션 이름 변경',
    value: host.state.session,
    validateInput: (v) => S.validateName(v.trim(), others),
  })
  if (!name || name.trim() === host.state.session) return
  // webmanager itself makes the change (it holds the unlock cookie the
  // PATCH needs) and reports the new name back as a `state` message.
  host.webview.postMessage({ type: 'rename', name: name.trim() })
}

function togglePin(host) {
  if (!host || host.state.section !== 'terminal' || !host.state.session) return
  host.webview.postMessage({ type: 'pin', pinned: !host.state.pinned })
}

async function openInBrowser(host) {
  if (!host) return
  if (!host.href) {
    vscode.window.showInformationMessage('아직 페이지 주소를 모릅니다 — 뷰가 뜬 뒤 다시 시도하세요.')
    return
  }
  // A terminal moves rather than duplicates, same as the titlebar widget's
  // pop-out: two clients on one session fight over its size. But only once
  // the browser tab really opened - a blocked popup must not cost the view.
  const opened = await vscode.env.openExternal(vscode.Uri.parse(host.href))
  if (opened && host.state.section === 'terminal') {
    if (host.kind === 'panel') host.panel.dispose()
    else await closeSlot(host.id)
  }
}

function reload(host) {
  if (host) navigateHost(host, host.state)
}

async function moveToEditor(host) {
  if (!host) return
  const state = host.state
  await closeSlot(host.id)
  createPanel(state, vscode.ViewColumn.Active)
}

async function moveToPanel(host) {
  if (!host) return
  const state = host.state
  // Slot first, then close the tab: dismissing the "which slot?" picker must
  // leave the tab where it was.
  const id = await pickSlot(state)
  if (!id) return
  host.panel.dispose()
  await bindSlot(id, state)
}

// ---- activation --------------------------------------------------------------

function readBuild() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ctx.extensionPath, 'build.json'), 'utf8')).build || 'dev'
  } catch {
    return 'dev'
  }
}

function activate(context) {
  ctx = context
  output = vscode.window.createOutputChannel('webmanager')
  context.subscriptions.push(output)
  build = readBuild()
  log(`activated: version ${context.extension.packageJSON.version}, build ${build}`)

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))

  reg('webmanager.openTerminal', async () => {
    const s = await pickSession()
    if (s) openState(s, vscode.ViewColumn.Active)
  })
  reg('webmanager.openTerminalToSide', async () => {
    const s = await pickSession()
    if (s) openState(s, vscode.ViewColumn.Beside)
  })
  reg('webmanager.openTab', async () => {
    const s = await pickSection()
    if (s) openState(s, vscode.ViewColumn.Active)
  })
  reg('webmanager.openTerminalInPanel', async () => {
    const s = await pickSession()
    if (s) await openStateInPanel(s)
  })
  reg('webmanager.openTabInPanel', async () => {
    const s = await pickSection()
    if (s) await openStateInPanel(s)
  })
  reg('webmanager.showBuildInfo', () => {
    vscode.window.showInformationMessage(
      `webmanager extension ${context.extension.packageJSON.version} (build ${build}) — session list via ${S.internalBaseUrl()}`,
    )
  })

  // Editor-tab actions act on the active webmanager tab.
  reg('webmanager.view.renameSession', () => renameSession(activePanelHost))
  reg('webmanager.view.togglePin', () => togglePin(activePanelHost))
  reg('webmanager.view.openInBrowser', () => openInBrowser(activePanelHost))
  reg('webmanager.view.reload', () => reload(activePanelHost))
  reg('webmanager.view.moveToPanel', () => moveToPanel(activePanelHost))

  // A view's title-bar action doesn't say which view it came from, so each
  // slot gets its own copy of every action (see package.json).
  const slotActions = { moveToEditor, openInBrowser, reload }
  const terminalSlotActions = { changeSession, renameSession, togglePin }
  for (const id of SLOT_IDS) {
    const actions = isTerminalSlot(id) ? { ...slotActions, ...terminalSlotActions } : slotActions
    for (const [name, fn] of Object.entries(actions)) {
      reg(`webmanager.slot.${id}.${name}`, () => {
        const host = slotHosts.get(id)
        if (host) return fn(host)
      })
    }
    reg(`webmanager.slot.${id}.closeSlot`, () => closeSlot(id))

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(`webmanager.${id}`, slotProvider(id), {
        webviewOptions: { retainContextWhenHidden: retainFor(isTerminalSlot(id) ? 'terminal' : 'other') },
      }),
    )
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel, saved) {
        setupPanel(panel, saved && saved.section ? saved : { section: 'terminal' })
      },
    }),
  )

  for (const id of Object.keys(slotBindings())) {
    if (SLOT_IDS.includes(id)) setSlotContext(id, true)
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('webmanager.passthroughKeys')) return
      const chords = passthroughChords()
      for (const h of hosts) h.webview.postMessage({ type: 'keys', chords })
    }),
  )
}

function deactivate() {}

module.exports = { activate, deactivate }
