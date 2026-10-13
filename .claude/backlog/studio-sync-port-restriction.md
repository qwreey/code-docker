# studio-sync: accept only the Studio front on its two ports

Deferred on purpose (owner, 2026-10-13): low risk as things stand. Do it if a review finds
a reason this is worse than described below, or once a container that isn't trusted is
attached to `code-docker-internal` directly.

The code is roblox-studio-docker's `config/studio-sync/studio-sync` (the CLI that runs
inside code-docker). The note lives here because the exposure is on
`code-docker-internal`.

## What is open

For the length of one sync (seconds to a few minutes) the CLI listens in code-docker on:

- `0.0.0.0:34880` - `rojo serve` (or, for `release`, the CLI's own `/api/rojo` answer).
- `0.0.0.0:34881` - the CLI's reply server, where the Studio plugin posts its offer to
  take the sync and its result.

The only callers that should reach them are `roblox-studio-front` (which forwards the
plugin's requests from Studio's isolated network) and code-docker itself.

## Who else can reach them, and what they get

Anything attached to `code-docker-internal`: router, dind and - through dind's NAT - a
container started inside dind, and the other providers' front containers. Chrome,
firecrawl and Studio themselves sit behind their fronts on their own networks and can't.

Such a caller could, while a sync is running:

- read the project's source through Rojo's API;
- read the request (`/api/rojo`'s project name carries the owner and the reply port) and
  post an offer or a result of its own to 34881 - the CLI then reports a success or a
  failure that didn't happen, or hands the sync to a Studio that doesn't exist.

It could not put its own code into Studio: the plugin only ever asks
`roblox-studio-front:34880`, which forwards to code-docker's own listener.

A container inside dind is started by a user or agent who already has the source, which
is why this was left alone.

## How to close it

Filter by peer address; both ports have exactly one legitimate remote caller.

- **34881** is the CLI's own `http.server`: refuse a request whose `client_address` isn't
  loopback or the front's address.
- **34880** is `rojo serve`, which has no such filter. Bind it to `127.0.0.1` and have the
  CLI listen on `0.0.0.0:34880` itself, accepting only the front's address and relaying
  the bytes to loopback (plain TCP, so Rojo's WebSocket passes). The `release` path
  already answers 34880 from the CLI and needs only the same check as 34881.
- Resolve `roblox-studio-front` once at start. If it doesn't resolve, say so and exit
  rather than fall back to accepting everyone.

Ruled out:

- A shared token: the request rides in `/api/rojo`'s project name, which anyone who can
  reach the port can read, and the plugin has no way to be given a secret (it can't read
  the environment).
- iptables in code-docker: no `NET_ADMIN` there, by design.

Not checked when this was written: whether the front's source address as seen from
code-docker is always its `code-docker-internal` address (it should be - the front is a
plain TCP forwarder on that network), and whether anything else legitimately polls 34880.
Measure both on a running stack before relying on the filter.
