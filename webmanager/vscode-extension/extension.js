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
const os = require('os')
const path = require('path')
const vscode = require('vscode')
const { SECTIONS, sectionLabel } = require('./src/sections')
const S = require('./src/sessions')
const { buildPath, render, passthroughChords, canonicalChord } = require('./src/html')

const VIEW_TYPE = 'webmanager.page'
const SLOT_IDS = ['term1', 'term2', 'term3', 'term4', 'page1', 'page2']
const SLOTS_KEY = 'webmanager.slots'
// VNC targets as a view last reported them ([{ name, label }]) - see
// rememberVncTargets. Global rather than per-workspace: they're router's,
// not this folder's.
const VNC_TARGETS_KEY = 'webmanager.vncTargets'
// [{ id, title }]: which thing each editor tab title has stood for, so a tab
// restored after a reload - which VS Code leaves unresolved, with only its
// title to go on, until it's shown - can be told apart from another kind of
// tab that happens to carry the same title (a terminal session and a VNC
// target with the same name). See unresolvedTabsFor.
const PANEL_TITLES_KEY = 'webmanager.panelTitles'

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

// A VNC view is a live connection like a terminal is, so it is kept alive
// when hidden by default too; a page slot can end up showing one, so those
// follow the VNC setting as well as `other`.
function retainFor(kind) {
  const r = vscode.workspace.getConfiguration('webmanager').get('retainContextWhenHidden') || {}
  if (kind === 'terminal') return r.terminal !== false
  if (kind === 'vnc') return r.vnc !== false
  if (kind === 'page-slot') return r.other === true || r.vnc !== false
  return r.other === true
}

function retainKind(section) {
  return section === 'terminal' ? 'terminal' : section === 'vnc' ? 'vnc' : 'other'
}

// ---- VNC ---------------------------------------------------------------------

// The target a VNC view shows (?target=), or null for the target list.
function vncTarget(state) {
  if (!state || state.section !== 'vnc' || !state.query) return null
  return new URLSearchParams(state.query).get('target')
}

function vncState(name) {
  return { section: 'vnc', query: new URLSearchParams({ target: name }).toString() }
}

function vncTargets() {
  return ctx.globalState.get(VNC_TARGETS_KEY, [])
}

function vncLabel(name) {
  const t = vncTargets().find((x) => x.name === name)
  return (t && t.label) || name
}

// The extension host can't reach router's API (router refuses its own
// admin API to the internal network code-docker sits on), so the list comes
// from a view: router reports it to webmanager, webmanager to its view.
async function rememberVncTargets(list) {
  if (!Array.isArray(list)) return
  const clean = list
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((t) => ({ name: t.name, label: typeof t.label === 'string' ? t.label : '' }))
  await ctx.globalState.update(VNC_TARGETS_KEY, clean)
  for (const h of hosts) if (h.state && h.state.section === 'vnc') updateTitle(h)
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

// "새 창" from a VNC view: a webview can't open windows (no allow-popups),
// so it asks. When the target is open in a view here, that view is closed
// first and the window opens once its connection is gone - two clients on
// one target fight over the desktop size, same handoff router's own page
// does (HANDOFF_DELAY_MS there).
async function openVncWindow(m) {
  if (typeof m.name !== 'string' || typeof m.url !== 'string' || !isHttpUrl(m.url)) return
  const state = vncState(m.name)
  const existing = findHostFor(state)
  if (existing) {
    if (existing.kind === 'panel') existing.panel.dispose()
    else await closeSlot(existing.id)
    await new Promise((r) => setTimeout(r, 250))
  } else {
    // Not connected, but would connect as a second client once shown.
    const stale = unresolvedTabsFor(state)
    if (stale.length) await vscode.window.tabGroups.close(stale)
  }
  await vscode.env.openExternal(vscode.Uri.parse(m.url))
}

function titleOf(state) {
  if (state.section === 'terminal') return state.session || 'Terminal'
  const target = vncTarget(state)
  if (target) return vncLabel(target)
  return sectionLabel(state.section)
}

// Menu `when` clauses read these: session actions (rename, pin) only where
// a session is shown, Change Session only on a terminal. Slots go in a list
// (`view in webmanager.sessionSlots`) since one context key per slot would
// still need the view id to pick the right one.
let lastContexts = ''
function refreshContexts() {
  const p = activePanelHost && activePanelHost.state
  const sessionSlots = []
  for (const [id, h] of slotHosts) {
    if (h.state && h.state.section === 'terminal' && h.state.session) sessionSlots.push(`webmanager.${id}`)
  }
  const next = {
    'webmanager.activePanelTerminal': !!p && p.section === 'terminal',
    'webmanager.activePanelSession': !!p && p.section === 'terminal' && !!p.session,
    'webmanager.sessionSlots': sessionSlots,
  }
  const key = JSON.stringify(next)
  if (key === lastContexts) return
  lastContexts = key
  for (const [k, v] of Object.entries(next)) vscode.commands.executeCommand('setContext', k, v)
}

function setActivePanel(host) {
  activePanelHost = host
  refreshContexts()
}

function panelTitles() {
  return ctx.workspaceState.get(PANEL_TITLES_KEY, [])
}

// Anything without an identity (Files, Logs, the VNC list, ...) is recorded
// by section, which is enough to count as "something else" in a collision.
function recordId(state) {
  return identityOf(state) || `page:${state.section}`
}

function recordTitle(host) {
  const entry = { id: recordId(host.state), title: host.panel.title }
  const list = panelTitles()
  if (list.some((e) => e.id === entry.id && e.title === entry.title)) return
  ctx.workspaceState.update(PANEL_TITLES_KEY, [...list, entry])
}

// Only drops the pair once no open panel shows it any more; a pair left
// behind by a tab closed while unresolved just makes matching more
// cautious, and activate() prunes pairs no tab carries.
function forgetTitle(host) {
  const id = recordId(host.state)
  const title = host.panel.title
  for (const h of hosts) {
    if (h !== host && h.kind === 'panel' && recordId(h.state) === id && h.panel.title === title) return
  }
  ctx.workspaceState.update(
    PANEL_TITLES_KEY,
    panelTitles().filter((e) => !(e.id === id && e.title === title)),
  )
}

function updateTitle(host) {
  refreshContexts()
  const title = titleOf(host.state)
  if (host.kind === 'panel') {
    if (host.panel.title !== (host.state.pinned ? `📌 ${title}` : title)) forgetTitle(host)
    host.panel.title = host.state.pinned ? `📌 ${title}` : title
    recordTitle(host)
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

// What makes two views "the same thing" - a terminal session or a VNC
// target - so it is shown once per window. null for anything else.
function identityOf(state) {
  if (!state) return null
  if (state.section === 'terminal' && state.session) return `terminal:${state.session}`
  const target = vncTarget(state)
  return target ? `vnc:${target}` : null
}

// Where a session or VNC target is already shown in this window: a live
// view, or a panel slot bound to it that simply hasn't been expanded since
// the last reload (its view isn't resolved yet, so it isn't in `hosts` - but
// opening it elsewhere would still end up with two clients once it is).
function findHostFor(state, except) {
  const id = identityOf(state)
  if (!id) return null
  for (const h of hosts) {
    if (h !== except && identityOf(h.state) === id) return h
  }
  const bindings = slotBindings()
  for (const slot of SLOT_IDS) {
    if (slotHosts.has(slot) || (except && except.kind === 'slot' && except.id === slot)) continue
    if (identityOf(bindings[slot]) === id) return { kind: 'slot', id: slot }
  }
  return null
}

// Editor tabs restored after a reload that were never shown since: VS Code
// only resolves a webview panel when it becomes visible, so these have no
// host yet and findHostFor can't see them - but showing one later would
// connect a second client. All there is to go on is the title, so a tab is
// only matched when that title is known (PANEL_TITLES_KEY) to have stood
// for this thing and nothing else, and no resolved panel carries it;
// anything ambiguous is left alone.
function unresolvedTabsFor(state) {
  state = normalizeState(state)
  const title = titleOf(state)
  const titles = [title, `📌 ${title}`]
  for (const h of hosts) {
    if (h.kind === 'panel' && titles.includes(h.panel.title)) return []
  }
  const ids = new Set(panelTitles().filter((e) => titles.includes(e.title)).map((e) => e.id))
  if (ids.size !== 1 || !ids.has(recordId(state))) return []
  const out = []
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input
      if (!(input instanceof vscode.TabInputWebview) || !input.viewType.endsWith(VIEW_TYPE)) continue
      if (titles.includes(tab.label)) out.push(tab)
    }
  }
  return out
}

function findSessionHost(name, except) {
  return findHostFor({ section: 'terminal', session: name }, except)
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
  if (panel.active) setActivePanel(host)
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) setActivePanel(host)
    else if (activePanelHost === host) setActivePanel(null)
  })
  panel.onDidDispose(() => {
    forgetTitle(host)
    detach(host)
    if (activePanelHost === host) setActivePanel(null)
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
      retainContextWhenHidden: retainFor(retainKind(state.section)),
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
        refreshContexts()
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
  const folders = S.fileFolders()
  if (folders.length > 1) {
    const active = S.activeFolder()
    for (const f of folders) {
      items.push({ label: '$(add) 새 세션', description: f, detail: f === active ? '현재 에디터의 폴더' : undefined, cwd: f, isNew: true })
    }
  } else {
    const cwd = folders[0]
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

async function pickVnc() {
  const targets = vncTargets()
  const items = targets.map((t) => ({
    label: `$(vm) ${t.label || t.name}`,
    description: [t.label && t.label !== t.name ? t.name : '', findHostFor(vncState(t.name)) || unresolvedTabsFor(vncState(t.name)).length ? '열려 있음' : '']
      .filter(Boolean)
      .join(' · '),
    name: t.name,
  }))
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator })
  items.push({ label: '$(list-unordered) 대상 목록', description: '추가·편집·접속자 관리', list: true })
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: targets.length
      ? 'VNC 대상'
      : 'VNC 대상을 아직 모릅니다 — 대상 목록을 한 번 열면 여기에 나옵니다',
  })
  if (!pick) return undefined
  return pick.list ? { section: 'vnc' } : vncState(pick.name)
}

async function pickSection() {
  const pick = await vscode.window.showQuickPick(
    SECTIONS.map((s) => ({ label: `$(${s.icon}) ${s.label}`, description: s.id, id: s.id })),
    { placeHolder: 'webmanager 탭' },
  )
  if (!pick) return undefined
  if (pick.id === 'terminal') return pickSession()
  if (pick.id === 'vnc') return pickVnc()
  return { section: pick.id }
}

// ---- opening ---------------------------------------------------------------

// One place a given session or VNC target is shown per window: asking for
// it again brings the existing view forward instead of opening a second
// copy that would fight the first over the terminal or desktop size.
async function openState(state, column) {
  const existing = findHostFor(state)
  if (existing) {
    revealHost(existing)
    return
  }
  // An unresolved tab can't be revealed through the API, so it is replaced.
  const stale = identityOf(state) ? unresolvedTabsFor(state) : []
  if (stale.length) {
    column = stale[0].group.viewColumn
    await vscode.window.tabGroups.close(stale)
  }
  createPanel(state, column)
}

async function openStateInPanel(state) {
  const existing = findHostFor(state)
  if (existing) {
    revealHost(existing)
    return
  }
  await openInPanel(state)
}

// "Open in terminal" asked for from inside a view (Projects, Files, the
// Claude session log's resume, ...). The embed has no terminal tab of its
// own to switch to, so it becomes a new editor tab beside the current one.
async function openTerminalFromEmbed(m) {
  if (typeof m.session === 'string' && m.session) {
    await openState({ section: 'terminal', session: m.session }, vscode.ViewColumn.Beside)
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
  await openState(
    {
      section: 'terminal',
      session: S.uniqueName(base, names),
      cwd,
      command: typeof m.command === 'string' ? m.command : undefined,
    },
    vscode.ViewColumn.Beside,
  )
}

// The Terminal Home's "+" (or a profile without a cwd) inside a view: the
// view itself becomes the new session. Where it starts is decided here, the
// way VS Code's own new terminal does - the one workspace folder, or with
// several, a pick with the active editor's folder first.
async function newSessionInView(host, m) {
  const folders = S.fileFolders()
  let cwd = folders[0]
  if (folders.length > 1) {
    const active = S.activeFolder()
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: S.folderBase(f), description: f, detail: f === active ? '현재 에디터의 폴더' : undefined, cwd: f })),
      { placeHolder: '새 세션을 열 폴더' },
    )
    if (!pick) return
    cwd = pick.cwd
  }
  let names = []
  try {
    names = await S.fetchSessionNames()
  } catch {
    // a collision just joins that session instead
  }
  const base = (typeof m.label === 'string' && m.label) || S.folderBase(cwd) || '세션'
  navigateHost(host, {
    section: 'terminal',
    session: S.uniqueName(base, names),
    cwd,
    command: typeof m.command === 'string' ? m.command : undefined,
  })
}

// The view a palette command acts on: the focused editor tab, else a
// visible panel slot, else any open view.
function withTargetHost(fn) {
  const visibleSlot = [...slotHosts.values()].find((h) => h.view.visible)
  const host = activePanelHost || visibleSlot || [...hosts][0]
  if (!host) {
    vscode.window.showInformationMessage('webmanager 뷰를 먼저 여세요 (webmanager: Open Terminal Session… 등).')
    return
  }
  revealHost(host)
  fn(host)
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

// Ctrl+click on a path in an embedded terminal (webmanager's fileLinks.ts).
// A relative path resolves against the session's cwd; one that doesn't
// exist becomes a Quick Open search for its text - what the user would
// have typed into Ctrl+P anyway.
async function openFileFromEmbed(m) {
  if (typeof m.path !== 'string' || !m.path) return
  let p = m.path
  if (p.startsWith('~/')) p = path.posix.join(os.homedir(), p.slice(2))
  else if (!p.startsWith('/') && typeof m.cwd === 'string' && m.cwd.startsWith('/')) p = path.posix.join(m.cwd, p)
  let stat
  if (p.startsWith('/')) {
    try {
      stat = await vscode.workspace.fs.stat(vscode.Uri.file(p))
    } catch {
      // doesn't exist - Quick Open below
    }
  }
  if (!stat) {
    const query = m.path.replace(/^(\.{1,2}\/)+/, '') + (Number.isInteger(m.line) ? `:${m.line}` : '')
    await vscode.commands.executeCommand('workbench.action.quickOpen', query)
    return
  }
  const uri = vscode.Uri.file(p)
  if (stat.type & vscode.FileType.Directory) {
    await vscode.commands.executeCommand('revealInExplorer', uri)
    return
  }
  const line = Number.isInteger(m.line) && m.line > 0 ? m.line - 1 : undefined
  const col = Number.isInteger(m.col) && m.col > 0 ? m.col - 1 : 0
  const selection = line === undefined ? undefined : new vscode.Range(line, col, line, col)
  await vscode.window.showTextDocument(uri, { selection })
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
    case 'open-file':
      await openFileFromEmbed(m)
      break
    case 'new-session':
      await newSessionInView(host, m)
      break
    case 'open-terminal':
      await openTerminalFromEmbed(m)
      break
    // "열기" in a VNC target list: each target is its own editor tab.
    case 'open-vnc':
      if (typeof m.name === 'string' && m.name) await openState(vncState(m.name), vscode.ViewColumn.Active)
      break
    case 'open-vnc-window':
      await openVncWindow(m)
      break
    case 'vnc-targets':
      await rememberVncTargets(m.targets)
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

// Another webmanager tab in the same view. A page slot stays a page (the
// terminal has its own slots); an editor tab can become anything, a
// terminal session included.
async function switchTab(host) {
  if (!host) return
  const pageOnly = host.kind === 'slot'
  const pick = await vscode.window.showQuickPick(
    SECTIONS.filter((x) => !(pageOnly && x.id === 'terminal')).map((x) => ({
      label: `$(${x.icon}) ${x.label}`,
      description: x.id === host.state.section ? '지금 이 뷰' : x.id,
      id: x.id,
    })),
    { placeHolder: '이 뷰에 띄울 webmanager 탭' },
  )
  if (!pick) return
  if (pick.id === 'terminal') return changeSession(host)
  let state = { section: pick.id }
  if (pick.id === 'vnc') {
    state = await pickVnc()
    if (!state) return
    const existing = findHostFor(state, host)
    if (existing) {
      revealHost(existing)
      return
    }
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
  S.trackActiveEditor(context)
  log(`activated: version ${context.extension.packageJSON.version}, build ${build}`)

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))

  reg('webmanager.openTerminal', async () => {
    const s = await pickSession()
    if (s) await openState(s, vscode.ViewColumn.Active)
  })
  reg('webmanager.openTerminalToSide', async () => {
    const s = await pickSession()
    if (s) await openState(s, vscode.ViewColumn.Beside)
  })
  reg('webmanager.openVnc', async () => {
    const s = await pickVnc()
    if (s) await openState(s, vscode.ViewColumn.Active)
  })
  reg('webmanager.openVncInPanel', async () => {
    const s = await pickVnc()
    if (s) await openStateInPanel(s)
  })
  reg('webmanager.openTab', async () => {
    const s = await pickSection()
    if (s) await openState(s, vscode.ViewColumn.Active)
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
  // Fingerprint devices, lock and theme live in webmanager's sidebar, which a
  // view doesn't show. Lock reaches every view (webmanager broadcasts it);
  // the device list opens in the view the action came from.
  reg('webmanager.manageFingerprint', () => withTargetHost((h) => h.webview.postMessage({ type: 'open-webauthn' })))
  reg('webmanager.lockNow', () => withTargetHost((h) => h.webview.postMessage({ type: 'lock' })))
  reg('webmanager.view.manageFingerprint', () => activePanelHost && activePanelHost.webview.postMessage({ type: 'open-webauthn' }))
  reg('webmanager.view.lockNow', () => activePanelHost && activePanelHost.webview.postMessage({ type: 'lock' }))
  reg('webmanager.setTheme', async () => {
    const cfg = vscode.workspace.getConfiguration('webmanager')
    const current = cfg.get('theme') || 'auto'
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'VS Code 따라가기', value: 'auto' },
        { label: '라이트', value: 'light' },
        { label: '다크', value: 'dark' },
      ].map((i) => ({ ...i, description: i.value === current ? '현재' : undefined })),
      { placeHolder: 'webmanager 뷰의 테마' },
    )
    if (pick) await cfg.update('theme', pick.value, vscode.ConfigurationTarget.Global)
  })
  reg('webmanager.view.changeSession', () => activePanelHost && changeSession(activePanelHost))
  reg('webmanager.view.switchTab', () => switchTab(activePanelHost))

  // A view's title-bar action doesn't say which view it came from, so each
  // slot gets its own copy of every action (see package.json).
  const slotActions = {
    moveToEditor,
    openInBrowser,
    reload,
    manageFingerprint: (h) => h.webview.postMessage({ type: 'open-webauthn' }),
    lockNow: (h) => h.webview.postMessage({ type: 'lock' }),
  }
  const terminalSlotActions = { changeSession, renameSession, togglePin }
  for (const id of SLOT_IDS) {
    const actions = isTerminalSlot(id) ? { ...slotActions, ...terminalSlotActions } : { ...slotActions, switchTab }
    for (const [name, fn] of Object.entries(actions)) {
      reg(`webmanager.slot.${id}.${name}`, () => {
        const host = slotHosts.get(id)
        if (host) return fn(host)
      })
    }
    reg(`webmanager.slot.${id}.closeSlot`, () => closeSlot(id))

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(`webmanager.${id}`, slotProvider(id), {
        webviewOptions: { retainContextWhenHidden: retainFor(isTerminalSlot(id) ? 'terminal' : 'page-slot') },
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

  // Drop title records no open webmanager tab carries any more.
  const labels = new Set()
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE)) labels.add(tab.label)
    }
  }
  context.workspaceState.update(
    PANEL_TITLES_KEY,
    panelTitles().filter((e) => labels.has(e.title)),
  )

  for (const id of Object.keys(slotBindings())) {
    if (SLOT_IDS.includes(id)) setSlotContext(id, true)
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('webmanager.theme')) {
        const theme = vscode.workspace.getConfiguration('webmanager').get('theme') || 'auto'
        for (const h of hosts) h.webview.postMessage({ type: 'theme-pref', theme })
      }
      if (!e.affectsConfiguration('webmanager.passthroughKeys')) return
      const chords = passthroughChords()
      for (const h of hosts) h.webview.postMessage({ type: 'keys', chords })
    }),
  )
}

function deactivate() {}

module.exports = { activate, deactivate }
