# router subsystem — security audit (2026-08-06)

Scope: `router/` (netgate, tailscale, Dev Proxy, tinyauth, router-manager Go
backend, router-frontend), `script/netinit-entrypoint.sh`,
`script/dind-entrypoint.sh`, `script/entrypoint.sh`, `docker-compose.yml`,
`config/nginx.default.conf`. Performed against the local `dev` branch
(commit `a2f0420`) in an isolated worktree — see note at the end on how this
worktree was set up.

Findings are ranked most-severe first.

---

## 1. [CRITICAL] Dev Proxy `target` has no destination allow-list — full SSRF / netgate-bypass gadget

**Files**: `router/backend/internal/devproxy/devproxy.go` (`ValidateTarget`,
line 133-143; `Route.Target`, line 90-95; `renderRoute`, line 199), UI hint
at `router/frontend/src/components/DevProxy/RouteDialog.tsx:11-14`.

`ValidateTarget` only checks that `target` matches
`^[a-zA-Z0-9_.:\[\]-]+$` — a charset check, not a destination check. Any
`host:port` string passes, including RFC1918 addresses
(`192.168.1.1:80`), router's own internal admin services
(`router-manager:8091`/`localhost:8091`), or **Caddy's own admin API**
(`localhost:2019` — `AdminAddr` in the same file, bound by Caddy's stock
default and never restricted otherwise). The rendered fragment is
`reverse_proxy <target>` — Caddy (running inside `router`, which is the one
container dual-homed onto `code-docker-external` and therefore has the same
LAN/internet reach as the Docker host) originates the connection itself,
not code-docker. Connections **Caddy** originates never pass through
netgate's `NETGATE-FORWARD` iptables chain — that chain only filters
traffic *forwarded* from code-docker/dind through router, per
`docs/egress-netgate.md`'s own "같은 서브넷은 게이트웨이를 거치지 않는다"
explanation (which is about connected-route traffic, but the same absence
of self-filtering applies to router's own outbound connections in general —
nothing in `netgate-firewall.default.sh` restricts *router's own* OUTPUT).

Exploit scenario: anyone who can create/edit a Dev Proxy expose (see
Finding 2 for how a compromised code-docker gets this with zero
credentials by default) adds a route with `target: 192.168.1.1:80` (a home
router/NAS on the LAN — precisely the device class
`docs/egress-netgate.md`'s opening line names as the thing netgate exists
to stop reaching) or `target: localhost:2019`. The second case is a full
chain: the attacker's proxied requests reach Caddy's own JSON admin API,
letting them **replace Caddy's entire running configuration** via
`POST /load` — arbitrary listeners, arbitrary `reverse_proxy`/`file_server`
blocks, no `caddy adapt` syntax gate in the way at all (that only applies
to router-manager's own managed-fragment write path, not to what an
already-compromised Caddy admin API lets you do directly). This is a
complete takeover of the one process router uses to broker all Dev-Proxy
traffic, from inside what's supposed to be the lowest-trust container.

Even without the admin-API chain, the plain LAN-SSRF case alone defeats the
entire stated purpose of netgate/router (`docs/egress-netgate.md`:
"프롬프트 인젝션이나 버그로 인해 컨테이너 바깥... 특히 같은 네트워크 위
공유기/NAS 같은 사설망 장비에 임의로 접근하지 못하게 막는 기능").
`docs/egress-netgate.md`'s own "위험한 패턴" section warns against adding a
*new bridging container* to route around the lockdown, but doesn't
recognize that Dev Proxy — a mechanism it names as one of the two blessed
alternatives ("기존 nginx/Dev Proxy 메커니즘을 쓰세요") — already *is* such
a bridge once its target field is unrestricted.

**Fix direction**: give `ValidateTarget` (or a new validation layer above
it) an allow-list mirroring `netgate/config.default.yaml`'s own
`outbound:` block list — reject RFC1918/link-local/loopback targets by
default, with an explicit opt-in (or require the target to resolve to a
compose-known `code-docker-internal` hostname/alias, which is the only
documented use case — every doc example is `code-docker:<port>`). Separately,
bind Caddy's admin API to a UNIX socket or a loopback address that isn't
`localhost` from the proxy's own network namespace's perspective (or disable
remote admin entirely — `caddy run --config ... --adapter caddyfile` still
listens on `2019` by default unless `admin off` is set), so even an
unrestricted `target` can't reach it.

---

## 2. [CRITICAL] router-manager's mutating API is unauthenticated by default AND directly reachable by code-docker/dind — bypasses the "private, nginx-fronted" framing

**Files**: `router/backend/main.go` (route table, `:8091` bind, line 36-39),
`docker-compose.yml` (`code-docker-router` service — no extra network
segmentation between it and `code-docker`/`code-docker-dind` beyond
`code-docker-internal`), `config/nginx.default.conf` (`/dev-proxy/`,
`/tailscale/` locations, comments claiming "private by design... only
reachable through this proxy").

`router-manager` binds `:8091` (all interfaces) inside the router
container. `code-docker`, `code-docker-dind`, `code-docker-router`, and
`code-docker-tinyauth` all share the flat `code-docker-internal` bridge
network. Per this repo's own documentation
(`docs/egress-netgate.md`: "같은 네트워크... 붙어있는 다른 컨테이너로 가는
트래픽은 애초에 netgate 필터링을 거치지 않고 바로 갑니다"), any container on
that subnet can reach any other container's any port directly — there is no
mechanism restricting code-docker from `curl http://router:8091/api/...`
directly. Several code comments describe router-manager as "private-only...
only reachable from other code-docker-internal containers, e.g.
code-docker's nginx via its proxy routes" (`main.go` header comment,
`config/nginx.default.conf`'s `/tailscale/`/`/dev-proxy/` location
comments) — true only in the sense that no *host* port is published; it is
not actually restricted to arriving via nginx, and code-docker itself (the
one container this whole subsystem treats as compromisable) can skip nginx
entirely.

Combined with `ROUTER_MANAGER_AUTH_PASSWORD_HASH` being **unset by
default** (`example-env` ships it commented out, `docker-compose.yml`
defaults it to `""`, and `authgate.Gate.RequirePassword` passes every
request through unconditionally when unconfigured — `router/backend/internal/authgate/gate.go:174-186`),
this means: **out of the box, a compromised code-docker container (exactly
the threat model netgate/router exists to contain) has full read+write
access to every router-manager route** — create/delete Dev Proxy exposes
(chains directly into Finding 1's SSRF), rewrite the tailscale
`socks5_address`/`retry_intervall` global config, add/delete tailscale
forwards and publishes, and trigger `tailscale up`/`tailscale up --login-
server=...` with attacker-supplied login server / hostname flags (the login
server itself still comes from `TAILSCALE_LOGIN_SERVER` env, not the
request body, so this specific call is not itself a full takeover, but it's
still an authenticated-tailnet-identity-affecting action available with zero
credentials).

This is a materially bigger blast radius than the docs let on — `docs/router.md`'s
security framing ("router는 이제 code-docker보다 신뢰 수준이 높은 유일한
국경 컨테이너") is about network topology (routes/firewalling), but
doesn't address that router's own control-plane API has no default
authentication and is reachable by the very container it's meant to
constrain.

**Fix direction**: either (a) make `ROUTER_MANAGER_AUTH_PASSWORD_HASH`
effectively mandatory (fail loud in a way that's hard to ignore, or ship a
generated-per-install default), or (b) actually enforce "reachable only via
nginx" at the network layer — e.g. bind router-manager to a loopback/unix
socket the router container's own Caddy/nginx-equivalent reverse-proxies
from, rather than a bridge-network-wide TCP port, or add an iptables rule on
router's own INPUT chain restricting `:8091`/`:8082` to expected sources.
Given code-docker-internal is explicitly documented as fully mutually
reachable, network ACLs alone won't fully solve this without also
restructuring the subnet, so the auth gate is the more tractable primary
fix.

---

## 3. [HIGH] Dev Proxy "raw" edit mode accepts arbitrary Caddyfile text — escalates Finding 1 to file/data disclosure

**File**: `router/backend/internal/devproxy/devproxy.go`, `UpdateRaw`
(line 440-451).

`UpdateRaw` writes attacker-supplied text as-is into a managed `.caddy`
fragment, gated only by `caddy adapt`'s syntax check (`writeAndValidate`) —
not by `validateExpose`'s host/target/path charset checks that the
structured path enforces. This means any Caddy directive is available, not
just `reverse_proxy` — e.g. a `file_server { root / }` block, or
`respond` with a file read, can be added to the running Caddyfile. If the
matching expose's route doesn't have `requireAuth` set (opt-in, and the
default when creating a new route per `RouteDialog.tsx`'s `requireAuth`
default `false`), the fragment is reachable by anyone who can reach it via
`/exports/` or a published `CADDY_ADAPTER_PORT` — potentially exposing
router's own filesystem (`/var/lib/code-docker-router/tailscale/config.yaml`,
tailscaled state, etc.) to whoever can reach that subdomain externally.

This requires the same write access as Finding 1/2 to exploit, so it's best
read as an escalation of those rather than an independent hole — flagged
separately because the structured-path validation (`ValidateTarget` etc.)
gives a false sense that all expose-writing paths are constrained, when the
raw-edit path bypasses all of it except Caddyfile syntax validity.

**Fix direction**: run `UpdateRaw` content through an allow-list of
permitted directives (`reverse_proxy`, `handle`, `route`, `respond`,
`rewrite`, `uri`, `forward_auth`) and reject anything else (e.g.
`file_server`, `root`, `php_fastcgi`, `exec`-style third-party modules if
ever added), or drop raw-edit entirely and only support the structured
form now that Finding 1's target validation would make it safe.

---

## 4. [MEDIUM] No rate limiting / lockout on router-manager's password gate

**File**: `router/backend/internal/authgate/gate.go` (`TryUnlock`,
line 142-154), `router/backend/handlers_auth.go` (`handleAuthUnlock`).

`POST /api/auth/unlock` has no attempt counter, backoff, or lockout — a
network peer (again, any code-docker-internal container, or anyone who
reaches nginx's `/router-auth/` proxy) can submit unlimited password
guesses. Argon2id's cost (64 MiB / t=3 / p=2, `password.go:31-37`) throttles
each attempt somewhat (particularly against a resource-constrained
attacker), but there's no explicit defense-in-depth (e.g. a per-IP or
global attempt counter with exponential backoff) the way many comparable
gates add. Given this gate is meant to be the actual boundary once
Finding 2 is fixed by requiring it, its brute-force resistance matters more
than the current "off by default" state might suggest.

Note: this is identical to webmanager's own `internal/authgate` design (no
divergence found there either) — not a regression introduced by the router
migration, but worth fixing in both places if fixed at all.

**Fix direction**: add a simple in-memory sliding-window attempt limiter
keyed by source IP (or just a global one, given the single-tenant nature of
this app) with a lockout/backoff on repeated failures.

---

## 5. [LOW / INFORMATIONAL] `docs/router.md` is stale relative to `router/plan.md` — undersells what's implemented

**Files**: `docs/router.md` lines 115-133 ("router-manager (읽기전용 API)"
and "아직 없는 것" sections) vs. `router/plan.md` lines 47-78 ("구현 완료"
table, items 1-2).

`docs/router.md` still states router-manager provides only two read-only
endpoints and explicitly lists both "router 전용 forwards/publish 관리 UI"
and "router-manager 자체 API 인증" under "아직 없는 것" (not yet built).
Per `router/plan.md`, both were completed on 2026-08-06 — full tailscale
CRUD, dev-proxy CRUD, and the `internal/authgate` gate all exist now (this
matches what's actually in `router/backend/main.go`, confirmed above). An
operator reading only `docs/router.md` (the doc explicitly aimed at
end-users, per `CLAUDE.md`'s documentation section) would not learn that
`ROUTER_MANAGER_AUTH_PASSWORD_HASH` exists at all, making it more likely
they never opt into it — directly compounding Finding 2. This is exactly
the "code diverges from what the docs claim" case called out in this
audit's brief.

**Fix direction**: update `docs/router.md`'s router-manager section to
describe the full CRUD surface and the `ROUTER_MANAGER_AUTH_PASSWORD_HASH`
gate (mirroring what `router/CLAUDE.md`/`root CLAUDE.md` already say
correctly), and recommend setting it in the same breath the doc currently
uses to introduce tinyauth's setup.

---

## 6. [LOW] Tailscale forward/publish config fields have no charset validation before being written to YAML consumed by shell `yq`

**Files**: `router/backend/internal/tailscale/config.go` (`AddForward`
line 124-142, `AddPublish` line 176-200 — only presence/mode checks, no
regex like devproxy's `ValidateName`/`ValidateHost`/`ValidateTarget`),
consumed by `router/config/tailscale/tailscale-forward.default.sh` and
`tailscale-publish.default.sh` via `yq`.

Unlike `internal/devproxy`, `internal/tailscale`'s `Forward`/`Publish`
structs accept any string for `Name`/`RemoteHost` with no charset
restriction. Today this isn't directly exploitable: values are written via
Go's `yaml.Marshal` (which quotes as needed) and consumed downstream via
`yq` into individual shell variables that are passed as discrete arguments
to `socat`/`tailscale serve` (not `eval`'d or otherwise re-interpreted as
shell), so classic shell injection doesn't appear reachable. It's flagged
as low/informational because it's an inconsistency with the more careful
`devproxy` package's validation discipline, and because `RemoteHost` being
unrestricted means a forward can be pointed at any string tailscaled's
SOCKS5 proxy will attempt to resolve — including non-tailnet hosts, which
depending on tailscaled's exit-node/subnet-router configuration could be
another (narrower, tailscale-ACL-mediated rather than netgate-mediated)
SSRF-adjacent path. Lower severity than Finding 1 because it's gated by
tailscaled's own routing rather than router's raw network stack.

**Fix direction**: add the same kind of strict regex validation
`devproxy.ValidateName`/`ValidateTarget` already use, for consistency and
defense in depth, even though no concrete injection was found today.

---

## 7. [INFORMATIONAL] `netgate-firewall.default.sh` interpolates YAML-sourced values into `iptables` invocations with no quoting/validation

**File**: `router/config/netgate/firewall.default.sh` (lines 71-103).

`action`, `cidr`, `host_port`, `target_host`, `target_port` are read via
`yq -r` from `config.default.yaml`/`config.override.yaml` and passed
directly as `iptables`/`getent` arguments. This is not exploitable today —
both files are local, git-tracked-or-operator-edited config requiring a
container rebuild/recreate (the override pattern), and there is currently
no HTTP API that writes to this file (confirmed: `router/backend/main.go`
registers no netgate-config routes). Flagged purely so that if a future
change ever exposes `config.default.yaml`/`config.override.yaml` to a
write API (mirroring what happened with `devproxy`/`tailscale` config),
the same destination-validation gap identified in Finding 1 doesn't get
re-introduced here with an even more direct blast radius (this file
controls the firewall itself).

**Fix direction**: no action needed unless/until this file becomes
API-writable; if it ever does, apply the same allow-list discipline
recommended for Finding 1.

---

## Reviewed but no issue found

- **netgate (egress lockdown)**: `firewall.default.sh` rule ordering
  (stateful ACCEPT first, forwards before CIDR blocks, RFC1918/link-local/
  loopback defaults), `script/netinit-entrypoint.sh`/`script/dind-entrypoint.sh`'s
  route-hijack-prevention loops and their moby/moby#50326 self-healing
  behavior, `script/entrypoint.sh`'s route-wait gate, and the DNS
  resolver/blocklist path (`router/config/dns/dns.default.sh`,
  `dnsmasq.default.conf`) were all read in full. No injection, ordering
  bug, or race beyond what's already documented (the non-atomic 30s
  chain-flush window, the passive/best-effort nature of DNS blocking) was
  found. `net.ipv4.ip_forward=1` is set correctly via `sysctls:` rather
  than a runtime `sysctl -w`, matching the documented reasoning.
- **tailscale**: credential/authkey handling (`tailscale-service.default.sh`'s
  one-shot login-attempt marker, `LoginManager`'s detached `tailscale up`),
  forwards/publish CRUD, and MagicDNS avoidance were reviewed —
  `remote_host`/forward targets are only ever tailscale hostnames/IPs by
  convention (not MagicDNS), matching the documented decision; no code path
  resolves or trusts MagicDNS names. `exec.Command`/`exec.CommandContext`
  calls throughout (`login.go`, `status.go`, `state.go`) use argument
  slices, not shell interpolation — no command injection found. See
  Finding 6 for the one validation gap identified.
- **Dev Proxy**: full read of `router/backend/internal/devproxy/devproxy.go`,
  the caddy-adapter shell script, and the nginx `/exports/` wiring. Name/Host
  validation (`ValidateName`/`ValidateHost`) is solid (strict regexes,
  correctly scoped to their respective injection risks — Caddyfile matcher
  token vs. host-matcher argument). The `/exports/` vs `/dev-proxy/` split
  (end-user traffic vs. admin API) is implemented as documented, with no
  route confusion found. See Findings 1 and 3 for the target-validation and
  raw-edit issues.
- **tinyauth + router-manager authgate**: `router/backend/internal/authgate`
  was compared line-by-line against `webmanager/backend/internal/authgate`
  — same argon2id parameters, same HMAC-signed-cookie design, no meaningful
  divergence found (router's version correctly simplifies to a single TTL
  and no configurable cookie Domain, matching its narrower same-origin
  deployment, as intended). Cookie is `HttpOnly` + `SameSite=Strict`, which
  is an effective CSRF mitigation for this design (no separate CSRF token
  needed given SameSite=Strict blocks the cookie from being sent on
  cross-site requests entirely) — reviewed and found adequate. Route gating
  (`main.go`'s route table) was checked against the documented
  reads-open/writes-gated convention for every registered route, including
  the newer tailscale CRUD and dev-proxy CRUD routes — all consistent with
  the convention. See Finding 4 for the one gap (no brute-force protection).
- **Go backend generally**: no other `os/exec` call sites take
  attacker-controlled arguments unsafely (`supervisor/client.go`'s XML-RPC
  client properly `xml.EscapeText`s string params, though in practice only
  ever called with hardcoded program names). No path traversal found in
  `devproxy.path()` (name is regex-validated before use in
  `filepath.Join`). No secrets found logged in plaintext. No CORS headers
  are set at all by router-manager (same-origin-only via nginx by design),
  so no overly-permissive CORS issue exists.
- **Frontend**: grepped `router/frontend/src` for
  `dangerouslySetInnerHTML`/`innerHTML`/`document.write`/`eval(` — no
  matches. `RouteDialog.tsx`'s target-unreachable hint and `Forwards.tsx`'s
  placeholder text were read; no XSS-relevant unescaped rendering of
  user-controlled forward/publish/dev-proxy names was found (React's
  default JSX escaping applies throughout).

## Note on worktree setup

This audit's assigned worktree (`agent-a202d485f284550f3`) was initially
checked out at a stale commit (`6effec1`, pre-dating the entire `router/`
subsystem) on a branch with no unique commits of its own. It was reset
(`git reset --hard`) to the main repo's local `dev` branch (`a2f0420`,
25 commits ahead of `origin/dev`) before this audit began, since no
`router/` files existed otherwise. No other changes were made to the
worktree.
