# Plan: webmanager inside code-server (VS Code extension + `?embed=vscode` mode)

Status: **implemented 2026-09-22**, verified in the test stack through the
real code-server UI (Chrome on `http://localhost/`, which counts as a secure
context). **Still needs the repo owner on a real HTTPS host:**
- clipboard copy out of an embedded terminal;
- mobile/tablet;
- (later) WebAuthn inside a view.

Builds on `../research/code-server-embed-research.md`.

## What shipped vs. this plan

1. **The "session ended" signal had to be fixed server-side.**
   - §3.5 assumed the server closes with 1000 when a shell exits. It didn't. `relayTerminalSession` only cancelled its context, and coder/websocket then drops the TCP connection with no close frame, so the client saw 1006 — the same as a webmanager restart.
   - It now sends `1000 "session ended"` first (`handlers_terminal.go`).
   - `webmanager --attach` benefits too: it already read 1000 as "session ended".
2. **Every slot has its own copy of each view action** (`webmanager.slot.<id>.<action>`, generated in package.json). VS Code doesn't tell a `view/title` command which view invoked it.
3. **Pin and zoom live in the embedded terminal's top bar**, since the tab bar that normally carries them is hidden (zoom only while the control bar is off). Added after the owner's first use, together with even top/bottom padding on that bar. **Rename and pin are also view actions** (slot "…" menu, and the editor tab's title menu/palette) as well as in-page, so they work without the tab bar. The extension posts `rename`/`pin` to the page, and the page does the gated PATCH itself because it holds the unlock cookie.
4. **Duplicates always reveal the existing view.** There is no `terminal.duplicate` setting (owner: "겹치지 않게").
5. **A pending unlock modal now resolves when another page unlocks** (`UnlockModal.tsx` listens to the auth `BroadcastChannel`). Found while testing: a Projects view kept its modal up after a terminal view unlocked.
6. **Known quirk:** the first "Open in Browser" right after a page reload once did nothing, and a second try worked. Probably the browser's popup blocker (no user activation reaches `openExternal` from the palette) or `href` not reported yet. Not investigated.
7. Not done (deferred): `terminal.pinNewSessions`, measuring retain memory, and the direct VNC embed. For the VNC rework see `../../../.claude/backlog/vnc-tab-rework.md`.

**Code review follow-ups (2026-09-22, two review agents, each finding re-checked by hand).** Fixed:
- **Focus behind the ended card.** A focus used to reconnect behind the "세션이 종료되었습니다" card, quietly starting a new shell. The focus handler now skips a reconnect while the card is up.
- **Ended vs. retry.** A 1000 close with the session list unavailable, or a 1008 (the server refused the name), shows the card instead of retrying forever.
- **Host impersonation.** `embed.js` accepted any non-webmanager message as coming from the host. It now refuses anything posted from inside webmanager's frame tree, walking `parent`, which works cross-origin. Requiring `e.source === window.parent` was tried first and dropped the real host's messages: VS Code's frame layout doesn't make the host the parent. Verified live that both a direct and a nested impersonation are refused and that Change Session still works.
- **Initial command.** It was never persisted in the webview state, so a refresh no longer re-runs it.
- **Saved paths.** A saved path is reused only under the same render's binding nonce, so a rebound slot doesn't resurrect its old page. A re-shown terminal rebuilds its path from the saved session and cwd, so it doesn't reconnect under a stale name.
- **Key chords are canonicalized.** The default `meta+shift+p` could never match `chordOf`'s `shift+meta+p`.
- **Move to Panel** picks the slot before closing the tab.
- **Open in Browser** closes a terminal view only if `openExternal` returned true.
- **Dedup** also sees slot bindings whose views haven't been resolved since a reload.
- **Closing a slot** ignores a `state` report still in flight from the view being closed.
- **Config scope.** `passthroughKeys`, `basePath` and `internalUrl` are `machine`-scoped, so workspace settings can't remap keys to commands.
- **Registration** is limited to the actions each slot actually exposes.

Verified live:
- sync matrix: first install; fast path (8 ms); reinstall after uninstall; opt-out removes it, and unsetting reinstalls;
- terminal editor tab: typing, Ctrl+Shift+P/F1 passthrough and focus return;
- restore after reload, with scrollback;
- recreate in the last cwd after a webmanager restart and after a container recreate;
- `exit` shows the ended card, and 다시 시작 restarts it;
- two and three slots side by side in the bottom panel, restored after reload;
- close slot; rename and pin from the slot menu;
- "code로 열기" opens a new window;
- Projects "open terminal" opens a beside tab in the project cwd;
- duplicate session reveals the existing tab;
- theme follows VS Code both ways;
- password gate: the unlock form submits inside the webview, and unlocking one view unlocks the rest, modal included;
- Open in Browser moves a terminal to a browser tab;
- Move to Panel.

## 0. Verified against the live stack (code-server 4.138 / VS Code 1.138) + two corrections to the research

1. **Key forwarding via synthetic events does NOT work.**
   - The workbench's `shouldForwardKeyEvent` drops untrusted events unless the internal `forwardUntrustedKeypressEvents` option is set.
   - Decision: the webview script catches chords and posts `{type:'key', chord}` to the extension host.
   - The extension host maps the chord → command ID from its own settings and calls `vscode.commands.executeCommand`.
2. **`enableForms: true` must be set explicitly.**
   - Without it the sandbox lacks `allow-forms`, which nested frames inherit.
   - `<form onSubmit>` would never fire, breaking the unlock form and every other form.

Other facts confirmed:
- **Webview sandbox:**
  - Contains only `allow-same-origin allow-pointer-lock allow-scripts allow-downloads allow-forms`.
  - So there is no `window.open`/`target=_blank`, no `target="_top"`, and no `alert`/`confirm`.
  - Downloads work.
- **Several views in one panel container:**
  - Laid out HORIZONTALLY (side by side) while the panel is at the bottom or top.
  - VERTICAL when the panel is left/right or the views are in a sidebar.
- **Extension host → webmanager:**
  - The extension host inherits `.env.webmanager`, so it knows `WEBMANAGER_ADDR` (default `private:81`).
  - Must NOT go through nginx on loopback: `NGINX_BLOCK_LOOPBACK` 403s it.
- **Idle GC only reaps sessions with no attached sink.**
  - A retained view keeps its session alive.
- **WebSocket close codes:**
  - 1000 = the shell exited.
  - 1006 = webmanager restarted.
- **Recreating a session:** `GET /api/terminal?session=<n>&cwd=<dir>` recreates with that cwd, so recreate-on-restore needs no backend change.
- **Paths:**
  - Extensions dir: `/code/.local/share/code-docker/code/extensions`, with a minified `extensions.json`.
  - User-data dir: `…/code/user-data`.
  - CLI: `…/code/code-server/bin/code-server`.
  - No `jq` in the image.

## 1. Architecture

```
workbench (origin O, nginx "/")
 ├ WebviewPanel "webmanager.page" (editor tabs, any group/split)       ┐ extension host (EH): extension.js
 └ panel viewsContainer "webmanager": term1..term4, page1..page2        ┘ extensionKind: workspace
     └ iframe.webview (pre/index.html, O)
        └ active-frame (our HTML + media/embed.js = "WV", O)
           └ <iframe src="O/manager/<section>?embed=vscode&...">  (webmanager SPA = "EP", O)
```

- **EH** (extension host):
  - Owns the commands, QuickPicks, serializer and slot bindings (workspaceState).
  - Validates and executes host actions.
  - Fetches session names over `http://$WEBMANAGER_ADDR`.
- **WV** (the webview script):
  - Builds the iframe URL from `location.origin` + the path the EH passes in.
  - Relays messages in both directions and syncs the theme.
  - Catches passthrough chords on `iframe.contentWindow`, capture phase.
  - Restores focus.
- **EP** (webmanager in embed mode):
  - Hides its own chrome.
  - Reports URL state.
  - Routes popups, `_top` links and "open in terminal" to the host.
  - Uses a non-persisted theme override.
  - Terminal runs in single-session mode.
- **URL:** the EH sends a path (setting `webmanager.basePath`, default `/manager/`); WV resolves it against `location.origin`.
  - Webview CSP: `frame-src 'self'`.
- The titlebar overlay (`webmanager-launcher.default.js`) is left untouched.

## 2. postMessage protocol (v1)

EP↔WV messages are `{source:'cd-webmanager-embed', v:1, type, ...}`.
- Every receiver checks `origin`.
- WV also checks `source === iframe.contentWindow`, and EP checks `source === window.parent`.
- The EH validates everything:
  - URLs must be http(s), and folders absolute paths.
  - Commands come only from its own chord map.

**EP → WV:**
- `ready {section}`
- `state {path, section, session?, cwd?, title}`
- `open-external {url}`
- `open-folder {path}`
- `open-terminal {cwd?, label?, command?, session?}`
- `session-ended {session}`
- `close-request {}`

**WV → EP:** `theme {theme}`, `focus {}`.

**WV → EH:**
- `wv-ready {secure}`
- `ready` and `state` (WV adds `href`)
- the EP actions above (`open-external`, `open-folder`, `open-terminal`, `session-ended`, `close-request`)
- `key {chord}`
- `embed-timeout {}` (no EP `ready` within 15 s)

**EH → WV:** `navigate {path}`, `focus {}`, `keys {chords}`.

Initial config goes in `<script id="cd-config" type="application/json">{path, chords, build}`.
- The EH is the source of truth for the URL: serializer state for editor tabs, workspaceState for slots.

## 3. Behavior

### 3.1 Editor tabs

**View type.** A single viewType, `webmanager.page`, for every section.

**Commands:**
- `webmanager.openTerminal` opens in the active column.
- `webmanager.openTerminalToSide` opens beside, so splits give terminals side by side.
- `webmanager.openTab` is a QuickPick of the 23 sections. Terminal chains into the session picker.

**Session picker:**
- Entries:
  - "New session" (one entry per workspace folder if there are several)
  - the live sessions from `/api/terminal/session-names`, with a 2 s timeout
  - sessions already open in this window, marked as such
- New-session name:
  - The InputBox defaults to the folder basename, sanitized.
  - If that name is taken, it becomes `<base> 2`, `<base> 3`…
  - It is validated against `^[\p{L}\p{N} _.-]{1,64}$`.
- Default cwd: the active editor's workspace folder, else the first folder.

**Restore after refresh:**
- `registerWebviewPanelSerializer` restores from `setState {path, section, session, cwd}`.
- A terminal path always carries `cwd=<last live cwd>`, so a gone session is recreated under the same name in that cwd.

**Editor title actions:** Open in Browser, Reload, Move to Panel.

### 3.2 Bottom panel slots

**Declaration:**
- `viewsContainers.panel` "webmanager".
- Views:
  - `term1`, always visible;
  - `term2..4`, shown when `webmanager.slot.termN`;
  - `page1..2`, generic, for any section (VNC, Logs…).

**Unbound term1** shows the webmanager Terminal Home (`/manager/terminal?embed=vscode&cwd=<folder>`).
- Picking or creating a session there binds it.
- This is how launch profiles (e.g. antigravity, claude) get into slots with no extra UI.

**`openTerminalInPanel` / `openTabInPanel`:**
1. Pick a session or section.
2. Take the first free slot, or ask which slot to replace.
3. Save the binding in workspaceState.
4. Call `setContext`.
5. Call `<id>.focus`.

**Activation.** `onStartupFinished` restores the slot contexts. The view title is the session name; the description is the cwd basename.

**View title actions:** Change Session…, Open in Browser, Reload, Move to Editor, Close Slot. Close Slot unbinds only; the session keeps running.

**Bindings follow `state` messages**, so a rename made elsewhere is followed too (EP follows renames by pid).

### 3.3 Retain vs memory

- Setting `webmanager.retainContextWhenHidden`: default `{terminal: true, other: false}`.
- Retained terminals keep their socket and scroll position, and their session never gets GC'd.
- Each retained view is a full webmanager SPA (tens of MB). Document this.

### 3.4 Caveats of multiple views in one panel container

- **Layout:** side by side only while the panel is at the bottom or top.
- **Headers:** a single visible view merges its header into the container; with 2+ views each pane gets a ~22 px header.
- **Pane sizes** of `when`-gated views may reset after a reload.
  - Test this; the fallback is always-visible term slots.
- **Hidden views:** a view the user hides by hand stays hidden until `.focus`.
- **Dragging:** a slot can be dragged to another container. The binding is keyed by view ID, so it follows the view.

### 3.5 Terminal single-session mode (EP, `embed=vscode` + `session=`)

- **Session:** set `activeSession` directly and always send `cwd`.
- **Chrome:** hide the tab bar, hamburger and h1; use a compact topbar.
- **Close 1000 + session confirmed gone:**
  - show a "세션이 종료되었습니다" overlay;
  - 다시 시작 recreates the session under the same name and cwd;
  - 닫기 sends `close-request`;
  - never fall back to Home.
- **Close 1006 or any other abnormal close:** the existing auto-reconnect runs, and it recreates the session.
- **`embed=vscode` without `session=`:** normal Home, with `cwd=` used as the default cwd for "+" and for profiles without their own cwd.

### 3.6 Known limits, handled

**Popups:**
- Capture-phase click/auxclick on `<a target=_blank|_top|_parent>` or a middle/ctrl click → `open-external` / `open-folder` (`/?folder=`).
- `window.open` is wrapped to post the same message.
- The EH calls `vscode.env.openExternal` (http(s) only) or `vscode.openFolder` with `forceNewWindow`.
- This covers the Claude login, the Extensions links and "code로 열기" with no per-component edits.

**Shortcut passthrough:**
- WV listens for `keydown` in the capture phase on the iframe window.
- The chord is normalized from `e.code` (modifier order `ctrl+shift+alt+meta`).
- Setting: `webmanager.passthroughKeys: [{key, command, args?}]`.
- Defaults:

  | Keys | Command |
  |---|---|
  | `ctrl+shift+p`, `f1`, `meta+shift+p` | `workbench.action.showCommands` |
  | `` ctrl+` `` | `workbench.action.togglePanel` |
  | `ctrl+pageup` / `ctrl+pagedown` | `workbench.action.previousEditor` / `nextEditor` |
  | `ctrl+1`..`3` | focus editor group 1–3 |
  | `ctrl+shift+e` | `workbench.view.explorer` |

- Not in the defaults: `ctrl+p`, `ctrl+j`, `ctrl+b`, `ctrl+w`, `ctrl+c`, `ctrl+v`, and `ctrl+k …` chords.
- Focus returns to the terminal after a quick pick closes.

**Theme:**
- WV watches the webview body class (`vscode-dark` / `vscode-high-contrast` → dark, else light).
- It sends the initial theme as `?theme=`, then changes as `theme` messages.
- EP applies a **non-persisted** override in `theme.ts`, because localStorage is shared with standalone `/manager/`.

**Same session opened twice:**
- Within one window: the EH registry applies `webmanager.terminal.duplicate` = reveal (default) | move | allow.
- Across windows or devices: tolerated, since focus re-claims the size.
- Open in Browser on a terminal view unbinds or closes that view first.

**Session loss (GC after 30 min idle, webmanager restart):**
- Retained views mean no GC while the tab is open.
- Otherwise a restore recreates a fresh shell under the same name.
- Optional `terminal.pinNewSessions` setting, off by default.

**HTTPS:**
- No `wv-ready` within 10 s → a notification saying HTTPS (or localhost) is needed.

**WebAuthn:**
- The frame chain is same-origin.
- Our iframe gets `allow="clipboard-read; clipboard-write; fullscreen; publickey-credentials-get; publickey-credentials-create"`.
- Verify on HTTPS in the WebAuthn track.
- `client.ts` broadcasts auth changes on `BroadcastChannel('webmanager-auth')`, so unlocking once unlocks every view.

## 4. Shipping: built in, synced to the image's build on every boot

**Dockerfile stage:**

```dockerfile
FROM node:24-alpine AS code-extension
RUN npm install -g @vscode/vsce@3
WORKDIR /src
COPY webmanager/vscode-extension/ ./
RUN STAMP="$(find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)" \
 && VER="$(node -p 'require("./package.json").version')" \
 && printf '{"build":"%s"}\n' "$STAMP" > build.json \
 && mkdir /out && vsce package --no-dependencies --skip-license --allow-missing-repository -o /out/code-docker-webmanager.vsix \
 && printf '%s %s\n' "$VER" "$STAMP" > /out/code-docker-webmanager.stamp
```

The main stage does `COPY --from=code-extension /out/ /etc/code-docker/code/extensions/`.
- The stamp is a hash of the source tree.
- The vsix has no dependencies, so installing it never needs the marketplace.

**`config/code/code-extensions.default.sh`** (override supported):
- Called from `code-service.default.sh` right after `code-settings`, before code-server starts.
- Warn-and-continue on failure.
- **Opt-out** (`CODE_WEBMANAGER_EXTENSION=false`): uninstall the extension if present, remove the local stamp, exit.
- **Fast path** (pure bash, no CLI call) when all of these hold:
  - the image stamp equals the local stamp (`$SPATH/.code-extension-webmanager.stamp`);
  - `extensions.json` lists `code-docker.webmanager` at that version;
  - the extension directory exists;
  - `.obsolete` doesn't name it.
- **Otherwise:**
  1. `--uninstall-extension` (ignore failure)
  2. `--install-extension <vsix> --force`
  3. write the local stamp
  4. log one line
- So a user uninstall gets reinstalled on the next boot; the documented off switch is the env var.
- A *disabled* state is left alone.

**Env:** `CODE_WEBMANAGER_EXTENSION` goes in the root `example-env` (code-server tier) and is passed through by `docker-compose.yml`.

## 5. Files

**New `webmanager/vscode-extension/`** (plain CommonJS, no build step):
- `package.json`: publisher `code-docker`, name `webmanager`, version `0.1.0`, `engines.vscode ^1.95.0`, `extensionKind: ["workspace"]`, `activationEvents: ["onStartupFinished"]`.
  - `contributes`: the panel container, 6 webview views, commands, menus, configuration.
- `extension.js`
- `src/sessions.js`, `src/html.js`, `src/sections.js`, `src/slots.js`
- `media/embed.js`, `media/embed.css`, icons
- `README.md`, `.vscodeignore`

**webmanager frontend:**
- new `embed.ts`
- `main.tsx`, `theme.ts`, `useTheme.ts`
- `App.tsx` and `App.css`: in embed mode, no sidebar, top bar or banners; skip `useEmbedEscapeClose`; state reporting; `open-terminal` bridge
- `utils/embedEscape.ts`: early return when in embed mode
- `Terminal.tsx` and `Terminal.css`: single-session mode, ended overlay, cwd reporting
- `api/client.ts`: the BroadcastChannel

**Backend:** no changes.

**Root:**
- `Dockerfile`
- `config/code/code-extensions.default.sh`
- `config/code/code-service.default.sh`
- `docker-compose.yml`, `example-env`
- docs: root `CLAUDE.md`, `webmanager/CLAUDE.md`, `webmanager/plan.md`, `docs/webmanager.md`

## 6. Phases (each can be tested on its own)

0. **Probe:** Simple Browser on `/manager/terminal?session=probe`, using the test chrome with `--unsafely-treat-insecure-origin-as-secure=http://code-docker`.
1. **Shipping skeleton:**
   - `openTab` opening a full-UI iframe, plus a Show Build Info command.
   - The Dockerfile stage, sync script and env var.
   - Run the sync matrix (§8.1).
2. **webmanager embed shell:** chrome hiding, theme override, state reporting, link / `window.open` bridge, escape disabled, auth broadcast.
3. **Terminal single-session mode.**
4. **Editor tabs:** picker, naming, serializer restore, bridges, theme, duplicate policy, watchdog, retain.
5. **Panel slots.**
6. **Key passthrough and focus return.**
7. **Wrap-up:** docs, CLAUDE.md, plan.md, QA request.

## 7. Risks

- **Not yet seen in a real webview:** CSP `frame-src 'self'`, forms, downloads, VNC fullscreen and pointer lock 5 frames deep.
- **`when`-gated slot restore** after a reload.
- **Uninstall/reinstall semantics** for same-version rebuilds and downgrades.
- **Prompts on `openExternal`:** the trusted-domain prompt, or the "popup blocked" fallback dialog.
- **Cost with many views:** memory, and every view polling `/api/terminal/sessions`.
- **COOP/COEP:** if code-server ever enables it, `/manager/` would need CORP headers.
- **Browser coverage:**
  - Firefox's clipboard delegation is limited; this is Chromium-first.
  - Mobile has not been tested inside a webview.

## 8. Verification

**8.1 Sync matrix** (after `build && up`):
- The extension is listed after install.
- The "synced" log line appears on the first boot.
- `restart` takes the fast path.
- Editing `media/embed.js` → resync, and Build Info shows the new stamp.
- A version downgrade → resync.
- Uninstall from the UI → reinstalled on the next boot.
- `CODE_WEBMANAGER_EXTENSION=false` → removed; unsetting it → reinstalled.

**8.2 Browser** (test chrome via CDP, or claude-in-chrome on HTTPS):
- Frame tree and origins.
- Terminal restore after reload, and after `supervisorctl restart webmanager` (same name, saved cwd).
- Open to the Side ×2.
- Slots:
  - side by side at the bottom (screenshot);
  - stacked when the panel is on the right;
  - still there after a reload.
- Keys:
  - trusted Ctrl+Shift+P opens the quick input and doesn't reach the shell;
  - Ctrl+P does reach the shell.
- Popups: an open-vsx link, and "code로 열기".
- Theme flips, and standalone localStorage is untouched.
- Opening an already-open session reveals the existing view.
- With the gate on, unlocking one view unlocks the others.
- HTTPS watchdog.
- Memory numbers with 1 vs 4 views.

**8.3 Static checks:**
- Frontend build and lint.
- `node --check` on the extension.
- The launcher overlay still works.

## 9. Open questions (recommended default in bold)

1. Slots: **4 terminal + 2 generic**, with term1 always shown (Home while unbound).
2. Passthrough keys: **the list above**.
3. Pin sessions created from the extension: **no** (setting available).
4. Open in Browser on a terminal view: **unbind/close the view first**.
5. "code로 열기": **new window**.
6. Duplicate session in one window: **reveal**.
7. Retain: **terminal on, everything else off**.
8. Extension ID and env var: **`code-docker.webmanager`, `CODE_WEBMANAGER_EXTENSION`**.
9. VNC: **through webmanager's VNC tab** for v1.
10. xterm colors following the VS Code theme: **defer**.
11. Browsers: **Chromium first**.
12. cwd used for recreate: **last live cwd**, falling back to the creation cwd.
