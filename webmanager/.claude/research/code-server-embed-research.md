# Embedding webmanager inside code-server as editor tabs / panel views — research

Status: research only, nothing implemented. 2026-09-22.
Target: code-server **4.138.0**, bundled VS Code **1.138.0** (read from the running
test container: `/code/.local/share/code-docker/code/code-server/package.json` and
`lib/vscode/package.json`).

## The request

1. A command-palette command that opens a webmanager view as an **editor tab**:
   can go anywhere in the editor grid, can be split (two terminals side by side).
2. A **panel view** like the bottom Terminal panel, which the user can keep at the
   bottom or drag to a side bar.
3. Available for **every webmanager tab**. Example layouts: Terminal in the bottom
   panel with VNC as an editor tab next to files, or Terminal and VNC both in the
   bottom panel.
4. After the browser running code-server **refreshes**, each view reconnects to the
   same terminal session.

Why: `attach` run inside code-server's own integrated terminal was unusable
(copy didn't work, scrolling was slow), so the user wants webmanager's own terminal
UI inside code-server.

## TL;DR

- **Feasible with a small VS Code extension that hosts webmanager in webviews.**
  The main risk goes away because **code-server serves webviews from the same
  origin as the workbench.** The live workbench config has
  `webviewEndpoint = "stable-<commit>/static/out/vs/workbench/contrib/webview/browser/pre"`,
  a relative URL. A nested `<iframe src="/manager/...">` inside a webview is
  therefore **same-origin all the way up**. That means:
  - `X-Frame-Options: SAMEORIGIN` passes.
  - The `SameSite=Strict` authgate cookie is sent.
  - Clipboard, WebAuthn and fullscreen permissions pass through.
- **The code-patch route can't give real editor tabs, splits, a movable panel or
  layout restore.** No public workbench API is reachable from injected JS. It stays
  what it is today: a floating overlay.
- **webmanager needs one real change: an embed ("chromeless") mode.** Today it has
  none, and it would render its full sidebar, top bar and banners inside every view.
- **Two limits are inherited from the webview sandbox.** They are solvable, but
  they are real work:
  - No popups: `window.open` and `target=_blank` fail silently.
  - VS Code keybindings don't fire while focus is inside the nested webmanager frame.

## 1. What exists today

### `config/code/code-patch/webmanager-launcher.default.js`

- Makes the titlebar `.window-appicon` clickable. A click toggles a full-screen
  **overlay modal** containing `<iframe src="${location.origin}/manager/">`.
  Ctrl, Shift, Cmd or middle click opens `/manager/` in a new browser tab.
- Header buttons:
  - **Pop out (↗).** Reads the iframe's live `contentWindow.location` (possible
    because it is same-origin) and opens that URL in a new tab. For a terminal it
    first *releases* the session: it navigates the widget to the same URL minus
    `?session=` and waits for the load, so the two clients don't fight over the PTY
    size. Commit d191619.
  - **Maximize (⛶).** Stored in localStorage.
  - **Close (✕).**
- Escape: keydown doesn't cross iframe boundaries. webmanager's
  `src/utils/embedEscape.ts` therefore posts `{type:'cd-webmanager-close-request'}`
  to the parent whenever `window.parent !== window`, no dialog is open, and the key
  wasn't typed into `.xterm`. Commits 0105913 and e5f169f.
- It is one global overlay: one instance, no placement, no split, no restore.

### How webmanager is exposed (`config/nginx/nginx.default.conf`)

- Port 80: `/manager/` is proxied to webmanager, with the prefix stripped.
  `/manager` returns a 301 to `/manager/`. The rest (`/`) goes to code-server.
- The `/manager/` location sends `X-Frame-Options: SAMEORIGIN`, confirmed live with
  `curl -sI http://172.21.0.5/manager/`. Port 81 is webmanager's private listener,
  not something a browser should load.
- **An extension should load `${location.origin}/manager/<section>?...`**, computed
  inside the webview. `location.origin` there is the code-server origin (see §3).
  It can't be computed in the extension host, which doesn't know the browser-facing
  origin.

### Deep links (`webmanager/frontend/src/App.tsx`)

- The last path segment picks the tab: `/manager/terminal`, `/manager/vnc`,
  `/manager/files`, and so on (`splitPath`). There are 23 `SectionId`s in
  `components/Layout/sections.ts`.
- In-tab state lives in the query string and is written with `replaceState`:
  - Terminal: `?session=<name>`. It is verified against the live session list
    before being selected; an unknown name falls back to the terminal home
    (`Terminal.tsx` ~2857).
  - Files: `?path=`.
  - Projects: `?project=`.
- **There is no embed/chromeless mode in webmanager.** The only `embed=1` is
  webmanager asking *router* for one: `RouterFrame` loads
  `/router/?embed=1&tab=<t>&theme=<t>&origin=<o>`, and router's SPA uses
  postMessage `ready` and `theme` handshakes. That is the pattern to copy.
- The VNC tab is itself a `RouterFrame`, an iframe into router's `/router/`. That
  is cross-origin if `ROUTER_MANAGER_HOSTS` is set, and it nests the noVNC viewer
  as another iframe. The RouterFrame iframe already carries
  `allow="fullscreen; clipboard-read; clipboard-write"`.

### Terminal sessions (backend)

- `termsession.Registry.GetOrCreate(name, opts)` means a WebSocket to a named
  session creates it if missing. Sessions live in webmanager's process memory, with
  an idle GC timeout (`WEBMANAGER_TERMINAL_SESSION_IDLE_TIMEOUT`, default 30m).
  **Sessions do not survive a webmanager restart or container recreate.**
- `Session.Attach` allows **many concurrent sinks**, so a browser tab, `attach`
  and a view can all attach at once. `Resize` is last-writer-wins on the PTY,
  which is the size fight the pop-out code avoids.
- `GET /api/terminal/session-names` is outside the password gate. This is
  uncommitted work in the tree: `listsessionscmd.go` and `webmanager --list-sessions`.
  It is a cheap source for a "pick a session" QuickPick.

## 2. VS Code extension API options (1.138)

| Need | API | Notes |
|---|---|---|
| Editor tab anywhere, splittable | `window.createWebviewPanel(viewType, title, {viewColumn: Beside/Active}, {enableScripts, retainContextWhenHidden})` | Any number of instances. The user can drag it into any editor group, including a group *below* (a bottom split inside the editor area). |
| Restore editor tabs after refresh | `window.registerWebviewPanelSerializer(viewType, {deserializeWebviewPanel(panel, state)})` + in-webview `acquireVsCodeApi().setState({...})` | The layout restores the tab and calls the serializer with the last `setState` value. Activation event `onWebviewPanel:<viewType>` (implicit since 1.74). |
| Bottom-panel view movable to a side bar | `contributes.viewsContainers.panel` + `contributes.views` (type `webview`) + `window.registerWebviewViewProvider(id, provider, {webviewOptions:{retainContextWhenHidden:true}})` | The user can drag the view or container between the panel, the primary sidebar and the secondary sidebar. `resolveWebviewView(view, context)` gets `context.state` (the last `setState`). The workbench view memento keeps it across reloads. **Verify on a real reload before relying on it.** |
| Several views of the same kind | Not possible dynamically | Views are static in `package.json`, one instance per view id. Options: (a) declare N slots (`cd.term1..4`) gated by `when` context keys and `setContext`; (b) one panel view whose content uses webmanager's own in-page session tabs (`TerminalTabs.tsx` already exists); (c) extra ones as editor tabs. |
| Keeping content alive while hidden | `retainContextWhenHidden` | Without it, hiding a view or switching an editor tab away **destroys the webview**. The nested webmanager reloads, and the terminal WebSocket drops and replays scrollback on show, losing local scroll position and selection. With it, each hidden view keeps a full webmanager SPA and WebSocket in memory (tens of MB each). **For terminals: use it.** Moving a webview between editor groups or panes does not reload it, because VS Code positions webviews as an overlay layer ("claimed" by their container). |

The extension needs no Node APIs. It can be plain JS with a `main` entry, running
in the remote extension host. An optional `browser` entry would let it run in the
web worker host too. It can list sessions either through the webview (a same-origin
fetch of `/manager/api/terminal/session-names`) or by running
`webmanager --list-sessions` from the extension host, which runs inside the
container.

## 3. Technical risks of iframe-in-webview in code-server (verified)

### 3.1 Webview origin: same origin (the key finding)

- The workbench config served by the live code-server contains
  `webviewEndpoint":"stable-59c988c7.../static/out/vs/workbench/contrib/webview/browser/pre"`,
  a relative URL resolved against the page. So it lives on the code-server origin,
  not `*.vscode-cdn.net`.
- `pre/index.html`'s `signalReady()` explicitly allows this: `if (parent.hostname === hostname) return start(parentOrigin)`.
- The frame chain would be:

  ```
  workbench (origin O)
   └ iframe.webview        (pre/index.html, O, sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads",
                            allow="cross-origin-isolated; autoplay; local-network-access; clipboard-read; clipboard-write" — clipboard omitted on Firefox)
      └ iframe#active-frame (extension HTML, O, same sandbox set, allow adds clipboard-read/write when allowScripts && !Firefox)
         └ iframe src=/manager/<tab>   (O)  ← ours
            └ (VNC only) router iframe → noVNC iframe
  ```

  Sources: `workbench.web.main.internal.js` `_createElement` and `pre/index.html`
  lines ~1025–1044.
- Consequence: embedding in a webview adds no cross-origin hop. The frames are
  exactly as same-origin as today's overlay widget.

### 3.2 Empirical check

I ran the same frame structure in the test stack's Chromium 151
(`code-docker-chrome`, over CDP from inside `code-docker`). It had the same sandbox
and `allow` attributes as the two webview frames, with `/manager/terminal` nested
under them. Scripts: `cdp.mjs` and `t1.js` in the session scratchpad.

| Check | Result |
|---|---|
| Nested frame origin | `http://code-docker` (same as top) |
| Page loaded under `X-Frame-Options: SAMEORIGIN` | yes (title `webmanager`) |
| `featurePolicy.allowsFeature('clipboard-write' / 'clipboard-read')` | **true / true** |
| `publickey-credentials-get` / `-create` | **true / true**, even though neither webview frame lists them. The default allowlist is `'self'` and every hop is same-origin. |
| `fullscreen` | true |
| `window.open()` from the nested frame | **null**: blocked by the inherited sandbox (no `allow-popups`) |
| cookies readable | yes |

Caveats:

- This is a structural reproduction, not a real extension webview.
- The test origin was plain http (not a secure context), so `navigator.clipboard`
  and WebAuthn could not actually be *exercised*. Only the permission-policy layer
  was checked.
- **Cheap real-world probe the user can run now:** built-in *Simple Browser: Show*
  with `https://<host>/manager/terminal?session=<name>`. It is a real webview
  hosting an iframe (`sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"`,
  CSP `frame-src *`). It shows the copy, scroll and keyboard experience with zero
  code.

### 3.3 Each risk

- **X-Frame-Options / frame-ancestors.** Passes: every ancestor is the same origin.
  Router sends no XFO or frame-ancestors (grep plus live check), so the VNC
  sub-iframe is unaffected.
- **Cookies.** The authgate cookie is `HttpOnly; SameSite=Strict`
  (`internal/authgate/gate.go:299`). The whole chain is same-site, so it is sent;
  no third-party-cookie problem. One unlock is shared by all views, since they
  share the cookie jar.
- **Clipboard (the user's main reason).** Delegation is allowed at every hop
  (Chromium, non-Firefox). The extension's own iframe should still set
  `allow="clipboard-read; clipboard-write; fullscreen"` explicitly. webmanager's
  `utils/clipboard.ts` and the Terminal's OSC 52 path use `navigator.clipboard`,
  which requires a secure context (HTTPS). Firefox: VS Code omits the clipboard
  `allow` entries because Firefox gates on user activation instead. OSC 52 copies
  without a gesture fail there, standalone too.
- **WebAuthn / PRF (parallel track).** The policy allows it (same-origin default
  `'self'`, measured). The RP ID stays code-server's host, the same as standalone
  `/manager/`, so credentials registered standalone should work embedded. Still
  needs a real HTTPS test: Chromium's WebAuthn also wants the frame focused, which
  it will be after the user clicks it.
- **Fullscreen.** Allowed at the policy level (measured). VS Code's webview frames
  have no `allowfullscreen` attribute. Measured `true` anyway, but VNC fullscreen
  should be tested for real.
- **Popups / new tabs.** **Broken.** The sandbox (no `allow-popups`) is inherited
  by our nested frame. Affected: the Claude login link (`LoginPanel.tsx`
  `target=_blank`), Extensions links, `RouterAuthSetupBanner`'s `/router/` link,
  and any pop-out. Fix: in embed mode webmanager posts
  `{type:'cd-webmanager-open-external', url}` to the parent, and the extension
  calls `vscode.env.openExternal`. Alternatively, because the extension's webview
  document is same-origin, its script can catch anchor clicks inside the nested
  frame directly. `alert`/`confirm` are also blocked (no `allow-modals`), but
  webmanager already avoids them by convention.
- **Keyboard and shortcuts.**
  - Keys typed into the nested webmanager frame never reach VS Code:
    `pre/index.html` forwards `did-keydown` only from its own active-frame, and
    keydown doesn't bubble across iframes. Ctrl+Shift+P, Ctrl+P, Ctrl+`,
    Ctrl+PgUp/PgDn and similar go to xterm/the shell. This matches VS Code's own
    terminal minus its `commandsToSkipShell` list.
  - Fix: a small whitelist of chords re-dispatched to the webview document, where
    `handleInnerKeydown` forwards them to the workbench. This can live in
    webmanager's embed mode, or in the extension's webview script as a
    capture-phase listener on `iframe.contentWindow`, which works because it is
    same-origin.
  - Focus tracking works: `pre` polls `document.hasFocus()`, which is true when a
    descendant frame has focus. So clicking the terminal makes that editor or view
    the active one.
- **Secure context required.** VS Code webviews register a service worker. Over
  plain `http://<LAN-IP>` (not localhost), webviews in code-server don't work at
  all. That is normal behind the HTTPS reverse proxy, but it rules out raw-http
  access paths.
- **Nesting depth for VNC.** Webview → webview → `/manager/vnc` → router → noVNC is
  five frames. It works, but an embed can skip webmanager and load
  `/router/?embed=1&tab=vnc&origin=...` directly, or skip router's UI and load a
  target's viewer. Needs a decision (Q9).
- **Same-origin power.** Because webviews are same-origin in code-server, the
  extension's webview script (and anything in webmanager) can reach `window.top`
  (the workbench DOM). Nothing new here: code-patch scripts and `/manager/` already
  share that origin. It does mean the extension doesn't widen trust.

## 4. Extension vs extending the code-patch (and a hybrid)

| Want | Extension + webview | code-patch only |
|---|---|---|
| Command palette entry | ✅ `contributes.commands` | ❌ (no command registry access; only DOM hacks) |
| Editor-area tab, placed anywhere | ✅ WebviewPanel | ❌ at best a floating/overlay div; can't join editor groups |
| Split side by side (2 terminals) | ✅ `ViewColumn.Beside`, drag to split | ❌ (would mean re-implementing a tiling layout outside VS Code's) |
| Bottom panel tab, movable to side | ✅ WebviewView in a `panel` viewsContainer | ❌ |
| Restore layout + session after refresh | ✅ serializer + `setState`; view memento | Partial: overlay can remember URL in localStorage, but no layout |
| No sandbox limits (popups, modals) | ❌ inherited sandbox, needs bridging | ✅ top-level child iframe |
| VS Code keybindings while focused | needs chord forwarding | same problem (iframe boundary) |
| Ship/maintenance cost | new extension + vsix install step | none new |

**Verdict:** only an extension delivers the user's layout wants. The code-patch
overlay stays as the quick "whole manager" popup.

- **Hybrid A (recommended):** extension for layout and restore, webview loading
  `/manager/<section>?embed=vscode...`, webmanager embed mode for chrome and
  bridging. No code-patch involvement.
- **Hybrid B (fallback only):** the extension creates an empty placeholder webview,
  and a code-patch script positions a real top-level `<iframe>` over the
  placeholder's rect, like VS Code's own overlay trick. This gets rid of the
  sandbox limits, but it is fragile (resize/drag/visibility sync, z-order with
  menus and quick input). Consider it only if popup/modal bridging proves
  insufficient.

## 5. Shipping the extension in this repo

- Source: a small plain-JS extension (no TypeScript build needed):
  `package.json`, `extension.js`, `media/embed.js`. Location suggestion:
  `code-extension/` or `webmanager/vscode-extension/`.
- Build a `.vsix` in a Dockerfile stage. The `node:24-alpine` stage already exists
  for the frontend; run `npx @vscode/vsce package` there, or zip the vsix layout by
  hand. `COPY` it to `/etc/code-docker/code/`.
- Install: code-server runs with `--extensions-dir=/code/.local/share/code-docker/code/extensions`
  (`code-server-autoinstall/start.sh:137`), which is on the volume. Add a step to
  `code-service.default.sh` after `install.sh`:
  `code-server --extensions-dir ... --install-extension <vsix> --force`.
  - Gate it on a version check (`--list-extensions --show-versions`) so every boot
    doesn't pay the CLI start-up cost.
  - Follow the override pattern (`code-extensions.default.sh` / `.override.sh`),
    and warn and skip on failure (non-essential step; see the graceful-degradation
    rule).
  - It then also shows up in webmanager's Code Extensions tab.
- Alternative: seed it as a builtin extension into
  `code-server/lib/vscode/extensions/` every start, like code-patch seeding. The
  user can't uninstall it and there is no `extensions.json` bookkeeping, but it
  writes into the vendored install tree that autoinstall replaces on update.
- State restore needs nothing server-side. VS Code persists editor/view layout and
  webview `setState` in its workbench storage.

## 6. Required webmanager changes (embed mode)

- A `?embed=vscode` flag (or similar), read once at load:
  - Hide the sidebar, sidebar rail, mobile top bar, `EnvVersionBanner` and
    `RouterAuthSetupBanner`.
  - Disable `useEmbedEscapeClose`.
  - Keep the `RequiresUnlock` modal.
- Terminal-specific: a "single-session" presentation (hide `TerminalTabs` and the
  home) when the view is bound to one session. With the flag off, the view keeps
  in-page tabs; that is the "one panel view, many sessions" option.
- A postMessage to the parent whenever the URL-state changes (`writeQuery` /
  `setActive`). The webview then does `setState({url})`, avoiding polling.
  Same-origin reading of `contentWindow.location.href` works too, as the launcher
  already does.
- Open-external bridge for links and popups; chord forwarding for a VS Code
  keybinding whitelist.
- Theme: accept `?theme=` plus a postMessage `theme`, as router's `embedTheme.ts`
  does. The extension maps VS Code's `vscode-dark`/`vscode-light` body class.

## 7. Which tabs make sense standalone

- **Strong fit:** Terminal (the headline), VNC, Logs (live tail), Files (file
  manager next to the editor), Task Manager/Processes, Docker (dind), Sessions
  (Claude session log viewer).
- **Fine but rarely wanted docked:** Supervisor, Projects, Claude Code, mise, Code
  Extensions, Fonts, SSH Keys, Git Config, File share, and the router-embedded
  tabs (Dev Proxy, App Routes, Tailscale, DNS, Net, tinyauth, Router settings).
- Recommendation: one generic command, "webmanager: Open tab…", with a QuickPick
  of all 23 sections, opening as an editor tab. Add dedicated commands and panel
  view slots only for Terminal (and maybe VNC and Logs). Supporting all tabs is
  nearly free once embed mode exists, since every section is already addressable by
  path.

## 8. Feasibility per user want

| Want | Verdict |
|---|---|
| (a) Command palette → editor tab anywhere | ✅ WebviewPanel |
| (a) Split, two terminals side by side | ✅ (two panels, each bound to a different session) |
| (b) Bottom-panel tab movable to a side | ✅ WebviewView in a panel container; one instance per declared view id |
| Terminal and VNC both in the bottom panel | ✅ two declared views (they show as tabs, or as split panes in one tab) |
| Terminal in the panel + VNC as an editor tab | ✅ |
| All webmanager tabs | ✅ once webmanager has an embed mode; best as editor tabs via one QuickPick command |
| Session persists across a code-server refresh | ✅ via `setState({url/session})` + serializer or view state. ⚠ Only as long as the session still exists in webmanager: sessions are in memory, GC'd after the idle timeout and lost on a webmanager restart. Q2 decides the fallback. |
| Copy works (the motivating issue) | ✅ at the permission level (measured). Needs a real HTTPS check; Firefox caveat. |
| WebAuthn/PRF inside the embed | ✅ at the permission level (measured, same-origin chain). Needs a real HTTPS test. |

## 9. Blocking risks (ranked)

1. **Popups and `target=_blank` silently fail** inside webviews. Needs the
   open-external bridge before any flow that opens a URL (Claude login!) is usable
   embedded.
2. **VS Code shortcuts are eaten** while the terminal is focused. Needs a chord
   whitelist, and the user has to pick which chords.
3. **Session lifetime.** "Reconnect after refresh" only holds within webmanager's
   process lifetime and idle timeout.
4. **Resize fight** when the same session is open in two views or tabs
   (last-writer-wins `Resize`).
5. **Memory:** one full webmanager SPA and WebSocket per retained view.
6. **Unverified in a real webview:** the empirical test reproduced the frame
   structure, not VS Code's real webview. Run the Simple Browser probe or a first
   prototype before committing to the design.
7. **Requires HTTPS** (webview service worker); plain-http LAN access has no
   webviews at all.

## 10. Recommended approach

1. The user runs **Simple Browser: Show** →
   `https://<host>/manager/terminal?session=<x>` for five minutes. This validates
   copy, scroll, IME and keys in a real webview with zero code.
2. Add an embed mode to webmanager (§6).
3. Build a minimal extension:
   - Commands: `webmanager: Open Terminal (editor)`, `… Open Terminal to the Side`,
     `… Open Tab…` (QuickPick of sections; for Terminal, a QuickPick of sessions
     from `/api/terminal/session-names` plus "New session").
   - One `panel` viewsContainer "webmanager" with a `Terminal` view and optionally
     `VNC`.
   - `WebviewPanelSerializer`. `retainContextWhenHidden` on terminal and VNC.
   - A shared `media/embed.js`: builds the iframe from `location.origin + '/manager/…'`,
     persists the URL with `setState`, and bridges open-external, chords and theme.
4. Ship it as a vsix built in the Dockerfile, installed by an override-pattern
   script in `code-service.default.sh`.
5. Keep the titlebar overlay launcher as is. Later its pop-out could offer
   "open as editor tab" by calling the extension (e.g. through a `vscode://`
   command URI or a postMessage), which is optional.

## 11. Open questions for the user (answers change the design)

1. **One view = one session, or one view = webmanager's own session tabs?** Panel
   views can't be created dynamically. "Several terminals in the bottom panel"
   means either N pre-declared slots or webmanager's in-page tabs inside one view.
   Editor tabs have no such limit.
2. **What should a restored view do if its session is gone** (idle GC, webmanager
   restart)? Options: silently recreate a session with the *same name* (GetOrCreate
   makes this trivial, but it is a fresh shell); fall back to the terminal home and
   pick; or show "session ended" with a button.
3. **Should a view get an auto-generated stable session name** (e.g.
   `vscode-<n>`), or always attach to a name the user picks?
4. **Same session open in two places** (standalone tab plus view, or two views):
   accept last-writer-wins resizing, or should a view take the session over the
   way pop-out does, or open read-only/no-resize?
5. **Which VS Code shortcuts must escape the embedded terminal?** For example
   Ctrl+Shift+P/F1, Ctrl+P, Ctrl+`, Ctrl+PgUp/PgDn, Ctrl+B, Ctrl+J. Everything
   else stays with the shell.
6. **Scope of "all tabs":** is a generic "Open tab…" QuickPick (editor tabs) plus
   dedicated panel views for only Terminal/VNC enough, or do you want panel-view
   slots for more tabs (Logs? Files?)?
7. **VNC embed target:** go through webmanager's VNC tab (full UI, five nested
   frames), router's `/router/?embed=1&tab=vnc`, or straight to one target's viewer
   (least chrome, needs the target chosen per view)?
8. **Browsers and devices:** Chromium only, or must Firefox work (its clipboard
   delegation differs)? Is phone/tablet use inside code-server a goal (webmanager's
   mobile terminal input path inside a webview is untested)?
9. **Install policy:** always installed (builtin-style, can't be removed) or a
   normal user extension installed at boot (removable, shows in Extensions tab)?
   Opt-out env var?
10. **Is any access path plain HTTP** (not localhost, not HTTPS)? Webviews don't
    work there at all.
