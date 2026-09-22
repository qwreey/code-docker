# Backlog: VNC tab rework — full-bleed, multi-tab, extension-ready

Status: idea/plan only, nothing implemented. Written 2026-09-22.

## Current state

VNC is owned by router, not webmanager (`router/CLAUDE.md`'s VNC bullet).

- **Backend**: `router/backend/internal/vnc` + `handlers_vnc.go` —
  `GET/POST/PUT/DELETE /api/vnc/targets[/{name}]`, `GET
  /api/vnc/targets/{name}/ws` (RFB↔WebSocket bridge), connected-client
  list/kick. Two backends: `rfb` (router serves noVNC itself, same-origin,
  default) and `novnc` (target's own web VNC front end via an App Route).
- **router frontend**: `router/frontend/src/components/Vnc/Vnc.tsx` (597
  lines) — one flat target table, a single `openName: string | null`
  controlling at most **one** open `<Viewer>`; opening a second target
  replaces the first. `Viewer` iframes `origin + info.viewerPath`, with
  its own fullscreen/"move to new window"/close header buttons.
  `TargetDialog.tsx` is where an admin sets a target's `name` (path
  segment/stable id) and `label` (display name) — both admin-configured,
  never end-user-renamable from the viewer.
- **webmanager**: no VNC-specific code. `RouterEmbed/RouterFrame.tsx`
  iframes router's whole `/router/?tab=vnc` page, so webmanager's "VNC"
  sidebar tab is router's `Vnc.tsx` nested one iframe deeper — zero
  webmanager-side visibility into which target is open.
- **Types** (`router/frontend/src/api/types.ts:60-93`): `VncTarget {
  name, label, target, backend, requireAuth, resizeMode }`, plus
  `VncTargetInfo`'s `viewerPath`/`viewerOrigin`/route-drift fields.

Compare with **Terminal**, which already has what VNC should grow into:
`webmanager/frontend/src/components/Terminal/TerminalTabs.tsx` (tab bar:
add/close/pin/rename/drag-reorder, synthetic Home tab) + `Terminal.css`'s
`.terminal-section` full-bleed layout (negative-margin escape from
`.app-content`'s padding, valid because Terminal is always the sole child
of `.app-content` while active) + `internal/termsession`'s name-keyed
session registry (opening an existing name reveals it instead of spawning
a second PTY — webmanager's own dedup precedent).

## Goal (user's wording, translated)

1. VNC tab fills the whole screen like Terminal (full-bleed, not boxed in
   normal padded layout).
2. Tab structure: multiple VNC viewers open at once, switchable via a tab
   bar — not router's current "at most one viewer, opening a new one
   replaces the old" model.
3. VNC tab names are **always** the configured app name (`label || name`)
   — never user-renamable, unlike a Terminal tab's double-click rename.
4. Later: the VS Code extension (`code-server-embed-plan.md`) gets its
   own VNC entry point — an "Open VNC…" QuickPick, one view per target,
   dedup so an already-open target is revealed rather than opened twice.

## Reuse analysis

Reusable **pattern**, not reusable component:

- `TerminalTabs.tsx` is written against `TerminalSessionInfo` and
  session-lifecycle callbacks that don't fit VNC's fixed, admin-managed
  target list. Build a sibling `VncTabs` with the same interaction shape
  (drag-reorder, close, scroll-into-view, add button) but drop
  `onRename`/`homeLabel` entirely (requirement 3).
- The **full-bleed CSS trick** (`.terminal-section`'s negative-margin
  escape) applies verbatim to a `.vnc-section` — same precondition holds.
- The **dedup-by-name** idea Terminal embodies via `termsession`'s
  registry maps onto "target name is the dedup key" — no backend session
  registry needed, since targets are already a stable, uniquely-named
  list; dedup is pure frontend state (open-names set + active name).
- Cross-repo caveat: Terminal is a **webmanager** component; VNC's
  table/viewer lives in **router**'s frontend, reached only via
  `RouterFrame` — a reworked tab bar must decide which repo owns it.

## Design sketch

**(a) Keep it inside router's `/router/` page.** Give `Vnc.tsx` its own
`openNames: string[]` + tab bar + full-bleed CSS; `RouterFrame` embed is
unchanged. Simple, but the tab bar renders one iframe layer removed from
webmanager's own chrome.

**(b) (recommended) Move the tab shell into webmanager**, keep the
per-target `<Viewer>` iframe as the only router-origin surface.
webmanager gets `components/Vnc/VncTabs.tsx` (visual clone of
`TerminalTabs.tsx`, name-only, no rename) driving which target(s) are
open; each tab iframes router's existing per-target viewer URL directly
(same `origin + viewerPath` `Vnc.tsx`'s `<Viewer>` already computes —
`useViewerOrigin`'s logic needs to become reachable from webmanager, e.g.
a small read-only proxy call). router's own `/router/` VNC tab keeps its
current single-viewer shape for standalone use; webmanager stops
embedding it for *viewing* but still embeds it for target CRUD. Matches
"VNC is a protocol, not an app" (`router/CLAUDE.md`) — the socket bridge
is router's job, the multi-tab shell is a webmanager concern like
Terminal's. Recommended because full-bleed/tabs are webmanager-shell
concerns, and the extension goal needs webmanager (or the extension) to
enumerate/dedup open views, which needs that state outside a
same-origin-only nested iframe.

Either way, client-kick UX (`VncClientsPanel.tsx`) and target CRUD
(`TargetDialog.tsx`) stay in router's own page — admin/management, not
the "open and look at it" hot path this rework targets.

## Extension integration sketch

`code-server-embed-plan.md` §9 Q9 currently punts: "VNC: through
webmanager's VNC tab for v1". This rework is the prerequisite for a real
extension-side VNC path, parallel to that plan's terminal design:

- **Deep-link URL per target**: once webmanager owns the tab shell (b),
  add `?target=<name>` the same way Terminal has `?session=` — the
  extension's `webviewPanel` loads `.../manager/vnc?target=<name>
  &embed=vscode`, parallel to `.../manager/terminal?session=<n>
  &embed=vscode`.
- **Dedup key = target name**: extension host keeps a registry of open
  views keyed by target name (same shape as the embed plan's
  `webmanager.terminal.duplicate` policy) — an "Open VNC…" QuickPick lists
  targets from `GET /api/vnc/targets`; picking an open one reveals it
  instead of creating a second view.
- **No new server-side state**: unlike terminals, a VNC view has nothing
  to persist/recreate — the serializer only needs the target name.
- Fullscreen/pointer-lock nesting gets one iframe hop deeper here, same
  risk the embed plan's §7 flags — re-test once this rework changes which
  origin owns the outer VNC shell.

## Open questions

1. (a) vs (b) — whose repo owns the tab shell; affects router's
   "standalone-usable" story for multi-target viewing.
2. Does full-bleed replace webmanager's sidebar too (like Terminal), or
   keep the sidebar and only the viewer goes edge-to-edge? Assume
   Terminal's behavior (sidebar stays) unless told otherwise.
3. Closing a tab: disconnect the WebSocket bridge immediately, or keep it
   alive like a pinned Terminal session? Recommend real disconnect — no
   "keep running for later" concept for a live screen.
4. Does the new shell handle both backends (`rfb` and `novnc`), or only
   `rfb`? `novnc` carries extra origin-sensitivity (`useViewerOrigin.ts`,
   `ROUTER_APP_ORIGIN`) a webmanager-side shell would need to replicate.
5. Do open tabs persist across a reload, or is the set purely in-session
   (Terminal only persists the *active* session via query param)? Does the
   client-kick panel move alongside the viewer, or stay admin-only in
   router's own target table?

## Rough effort

- Full-bleed CSS + tab-bar shell (Terminal-pattern reuse, no rename):
  small–medium, frontend-only.
- Multi-viewer state + origin resolution reachable from webmanager:
  medium — needs duplicating or exposing router's origin logic (dropped
  as a dependency in the 2026-08-08 decoupling).
- router's own `/router/` VNC tab: unchanged if (b); nontrivial if (a).
- Extension "Open VNC…" + dedup: small once the deep-link URL/dedup key
  exist; sequence after the embed plan's editor-tabs phase.
- Total: a few days for the webmanager-side rework; the extension piece
  rides on the larger embed-plan effort, not sized separately.
