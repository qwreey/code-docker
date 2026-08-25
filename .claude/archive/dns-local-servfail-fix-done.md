# dns-local: fixing getaddrinfo ESERVFAIL for platform.claude.com

> Archived as done — the code-docker fix below shipped in commit `67757ee` and is live
> architecture (see root `CLAUDE.md`'s "Process model"/"netshare" sections). The
> `code-docker-dind` follow-up this doc deferred was split out to
> `.claude/backlog/dind-dns-servfail.md`, which is still open.

## The bug

Reported symptom: `claude auth login` (both via webmanager's `internal/claudecode.LoginManager`
and run directly in a code-docker shell) reliably fails with `getaddrinfo ESERVFAIL
platform.claude.com` after ~38s of retries, even though the same container's `claude
--settings '...' /login` REPL flow reaches `platform.claude.com` fine, and `getent hosts
platform.claude.com` run repeatedly (15x back to back) always succeeds.

Root cause, confirmed empirically on a live deployment (2026-08-10):

- `code-docker`'s `/etc/resolv.conf` (written by the old `resolv-writer` program +
  `netshare/apply-nameserver.sh`'s `apply_nameserver`) listed two nameservers:
  `127.0.0.11` (Docker's own embedded DNS) first, router's IP second as a plain fallback.
- `code-docker-internal` is `internal: true`, so `127.0.0.11` refuses to forward any name
  it doesn't already own (local compose aliases like `router`/`dind`) - for everything else
  it answers with an immediate (0ms), *definitive* SERVFAIL, not a timeout.
- `getent hosts` (glibc's full NSS resolver stack) correctly treats that SERVFAIL as
  "try the next nameserver" and falls through to router, every time - confirmed with 15
  back-to-back queries, 15/15 clean.
- `dig` (which manages its own resolver logic, bypassing NSS) does **not** fail over past
  that SERVFAIL - it just returns it to the caller. Confirmed with 15 back-to-back plain
  `dig +short platform.claude.com` queries (no `@server` pinned): 15/15 empty.
- Claude Code's own Node runtime behaves like `dig` here, not like `getent` - the exact
  same class of failure (`getaddrinfo ESERVFAIL`, first-nameserver-only, no failover).

Reordering the two nameservers doesn't fix this on its own: router's dnsmasq doesn't know
`router`/`dind` either, so a `dig`-class client would then fail to resolve *those* names
the same way, for the same underlying reason (a receiving a definitive negative it doesn't
retry past - NXDOMAIN in that direction instead of SERVFAIL, but the same failure to fail
over).

## The fix (implemented, code-docker only)

`config/dns-local/dns-local.default.sh`, wired up as a new `dns-local` supervisord program
(`config/supervisord.d/dns-local.conf`), replacing the old `resolv-writer` program:

- Runs a local `dnsmasq --strict-order --server=127.0.0.11 --server=<router-ip>`, bound to
  `127.0.0.1` only.
- `/etc/resolv.conf` is rewritten to a single `nameserver 127.0.0.1` once dnsmasq is
  confirmed up.
- `--strict-order` makes dnsmasq itself retry the next `--server=` entry on SERVFAIL -
  confirmed empirically against this *exact* 127.0.0.11-then-router setup (10/10 clean
  resolutions of `platform.claude.com`, `router` alias resolution unaffected) before
  building this. Without `--strict-order`, dnsmasq's default "fastest responder wins"
  server-selection is actually *worse* than doing nothing: `127.0.0.11` always answers
  faster (no network hop) even when its answer is a bogus SERVFAIL, so dnsmasq would pick
  that every time (also confirmed empirically - 10/10 SERVFAIL without the flag, on the
  same setup that got 10/10 success with it).
- router's own IP isn't static across recreates, so a background loop re-resolves it every
  5s and restarts the local dnsmasq if it changed (same "IP can move" concern
  `resolv-writer`/`apply_nameserver` already handled, just now driving a dnsmasq restart
  instead of a resolv.conf rewrite).
- `script/entrypoint.sh`'s early, synchronous `apply_nameserver` call (before supervisord
  starts, so `user-init.sh`'s own qwreey-fish curl has *some* working DNS) is unchanged -
  it's a short-lived bootstrap window using the same "two nameservers, no client failover
  guarantee" shape this fix replaces, but `curl` (glibc-based) is in the same "fails over
  correctly" class as `getent`, so it isn't affected in practice. `dns-local` supersedes it
  moments later once supervisord starts.

## code-docker-dind (deferred - not fixed by this)

`code-docker-dind` manages its own `/etc/resolv.conf` the same way this bug came from:
`code-dind/script/dind-entrypoint.sh` calls `apply_nameserver` directly (synchronously once
before `dockerd` starts, per its own doc comment about `dockerd` snapshotting
`/etc/resolv.conf` at startup - see root `CLAUDE.md`'s "docker-compose topology" section),
then keeps a background loop running for upkeep, both using the vendored copy of
`netshare/apply-nameserver.sh` at `code-dind/script/netshare/apply-nameserver.sh`. Same
`127.0.0.11`-then-router shape, so it's very likely exposed to the identical class of bug
(any `dig`-class resolver running *inside* dind, or inside a container `docker run` from
within dind, could hit the same spurious SERVFAIL) - just not confirmed/reported yet.

Not fixed as part of this change because dind's constraints are different enough to need
its own design pass, not a copy-paste of `dns-local`:

- dind is `privileged: true` and manages `/etc/resolv.conf` **synchronously, before
  `dockerd` starts** - `dockerd` snapshots it once at its own startup to seed every nested
  `docker run` container's DNS for the rest of the daemon's life (see the "docker-compose
  topology" section's dind paragraph). A `dns-local`-style approach needs to have its local
  dnsmasq up and `/etc/resolv.conf` pointed at it *before* that snapshot, not as a
  supervisord program that starts after - dind has no supervisord managing programs the way
  code-docker/router do, it's a single entrypoint script.
- Nested containers created *inside* dind get their own resolv.conf from whatever
  `dockerd`'s own snapshot was - if dind's host-level `/etc/resolv.conf` points at a local
  dnsmasq (`127.0.0.1`), does that address even mean anything from inside a nested
  container's own network namespace? Almost certainly not (loopback doesn't cross network
  namespaces) - nested containers may need their own resolution path entirely (e.g.
  `dockerd --dns=<dind's real internal-network IP>` instead of relying on
  `/etc/resolv.conf` inheritance), which is a materially different problem from "make
  dind's own host-level resolution correct."
- Whether this is even worth fixing depends on whether anything running *inside* dind
  (or inside containers built by it) is actually sensitive to the SERVFAIL-vs-timeout
  failover distinction the way Claude Code's Node runtime is - unconfirmed either way.

Suggested next steps for whoever picks this up:
1. Reproduce first - confirm whether the same `dig`-class SERVFAIL-no-failover bug is
   actually observable from inside `code-docker-dind` itself (its own shell), and
   separately from inside a container `docker run` from within it, before designing a fix.
2. If confirmed from dind's own shell: adapt `dns-local`'s approach, but solve the
   before-dockerd-starts ordering constraint - e.g. run the local dnsmasq synchronously as
   part of `dind-entrypoint.sh`'s own existing pre-dockerd network setup step, not a
   separate supervised program.
3. If confirmed from *nested* containers too: research what DNS config nested `docker run`
   containers actually inherit (`dockerd`'s own `--dns`/`--dns-search` flags vs. its
   resolv.conf snapshot) and whether pointing them at dind's own real IP instead of
   `127.0.0.1` is the right fix - this is genuinely new design work, not a mechanical port
   of code-docker's fix.
