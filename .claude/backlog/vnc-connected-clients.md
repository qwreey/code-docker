# router VNC: list and disconnect connected clients

Raised 2026-08-29 by the user: two browser tabs (or a browser plus a native client)
end up on the same VNC target, the desktop starts fighting over its own size, and
there is no way to find out from the UI who else is attached — let alone to kick them.
Scoped as "check whether this is easy" first; the answer is **yes for router-mediated
clients, no for the rest** (see the limitation section), so it is worth doing but the
UI has to be honest about what it can see.

## Why nothing can be listed today

`router/backend/handlers_vnc.go`'s `handleVncSocket` dials the target's raw RFB port,
wires the browser WebSocket to it with a pair of `io.Copy` goroutines, and keeps **no
handle anywhere**. `upstream`, `sock` and the `context.CancelFunc` are all locals that
go out of scope when the HTTP request returns. The only trace a connection leaves is
two `log.Printf` lines (`vnc: %s -> %s connected` / `... closed`) — logs, not state,
so nothing is queryable at runtime. `internal/vnc`'s `Target`/`Info` carry no
last-connected time, remote address or connection count either.

The frontend already knows concurrent clients are a real problem — `Vnc.tsx`'s
"새 창으로 옮기기" flow tears down its own embed and waits `HANDOFF_DELAY_MS` before
opening the popup, with a comment explaining that two clients fight over the desktop
size in `remote` resize mode. But that only choreographs the two viewers this one page
opened itself; a client from another browser is invisible to it. That gap is exactly
the user's complaint.

## Shape of the fix

1. A small connection registry in `handlers_vnc.go`: `map[string][]*vncConn` keyed by
   target name behind a mutex (the same package-level-mutex idiom `internal/vnc`
   already uses), each entry holding remote address, connect time, and the connection
   itself. Register right after `websocket.Accept`, deregister via `defer`.
2. `GET /api/vnc/targets/{name}/clients` and
   `DELETE /api/vnc/targets/{name}/clients/{id}`, both behind `gate.RequirePassword`
   the way the `/ws` route already is — disconnecting someone is at least as sensitive
   as connecting.
3. Disconnecting is then just `Close()` on the stored connection from another
   goroutine: that unblocks the blocked `io.Copy` and the existing `cancel()`/`<-done`
   teardown path runs itself. No new teardown logic.
4. Frontend: a client-count badge per row in `Vnc.tsx`'s target table (next to the
   existing `routeMissing`/`routeDiverged` badges), expanding to a per-client list with
   a disconnect button using the `ConfirmDialog` already imported there.

Bounded work, but genuinely new state — this is a feature, not a config toggle.

## The limitation the UI has to state

A registry only sees connections that went through router's own bridge. wayvnc accepts
concurrent clients and its RFB port is reachable by other paths (Tailscale forwards, a
direct route), so a native client (TigerVNC and friends) connecting straight to the
target would still be invisible and unkickable. Anything claiming to be a complete
"who is connected" list would be lying.

Ground truth needs wayvnc's own control socket (`wayvncctl`), which nothing in
code-docker or roblox-studio-docker wires up today —
`roblox-studio-docker/config/supervisor/wayvnc-service.sh` passes only
`--output`/bind/port (plus optional `--gpu` and `-C`), no control-socket flag. That is
a separate, less certain piece of work: it needs a live wayvnc to confirm the command
surface for the installed version, and a decision about where to expose the socket so
router can reach it.

Suggested order: ship (1)–(4) with the panel labelled as router-mediated connections
only, and treat the `wayvncctl` integration as its own follow-up.
