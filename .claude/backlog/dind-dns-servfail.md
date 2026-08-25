# code-docker-dind: possible getaddrinfo ESERVFAIL exposure (unconfirmed)

Split out from `.claude/archive/dns-local-servfail-fix-done.md`, which fixed the
equivalent bug for `code-docker` itself via the `dns-local` local resolver. This is the
one part of that investigation that was deliberately deferred rather than fixed — see
that archived doc for the full root-cause writeup (`dig`/Node-class resolvers not failing
over past `127.0.0.11`'s immediate SERVFAIL on an `internal: true` network, the way
`getent`-class resolvers do).

## Why dind wasn't fixed alongside code-docker

`code-docker-dind` manages its own `/etc/resolv.conf` the same way this bug came from:
`code-dind/script/dind-entrypoint.sh` calls `apply_nameserver` directly (synchronously
once before `dockerd` starts, per its own doc comment about `dockerd` snapshotting
`/etc/resolv.conf` at startup — see root `CLAUDE.md`'s "docker-compose topology"
section), then keeps a background loop running for upkeep, both using the vendored copy
of `netshare/apply-nameserver.sh` at `code-dind/script/netshare/apply-nameserver.sh`.
Same `127.0.0.11`-then-router shape, so it's very likely exposed to the identical class
of bug (any `dig`-class resolver running *inside* dind, or inside a container `docker
run` from within dind, could hit the same spurious SERVFAIL) — just not
confirmed/reported yet.

Not a mechanical port of `dns-local` because dind's constraints differ:

- dind is `privileged: true` and manages `/etc/resolv.conf` **synchronously, before
  `dockerd` starts** — `dockerd` snapshots it once at its own startup to seed every
  nested `docker run` container's DNS for the rest of the daemon's life. A
  `dns-local`-style approach needs its local dnsmasq up and `/etc/resolv.conf` pointed at
  it *before* that snapshot, not as a supervisord program that starts after — dind has no
  supervisord managing programs the way code-docker/router do, it's a single entrypoint
  script.
- Nested containers created *inside* dind get their own resolv.conf from whatever
  `dockerd`'s own snapshot was — if dind's host-level `/etc/resolv.conf` points at a
  local dnsmasq (`127.0.0.1`), does that address even mean anything from inside a nested
  container's own network namespace? Almost certainly not (loopback doesn't cross network
  namespaces) — nested containers may need their own resolution path entirely (e.g.
  `dockerd --dns=<dind's real internal-network IP>` instead of relying on
  `/etc/resolv.conf` inheritance), which is a materially different problem from "make
  dind's own host-level resolution correct."
- Whether this is even worth fixing depends on whether anything running *inside* dind (or
  inside containers built by it) is actually sensitive to the SERVFAIL-vs-timeout
  failover distinction the way Claude Code's Node runtime is — unconfirmed either way.

## Suggested next steps

1. Reproduce first — confirm whether the same `dig`-class SERVFAIL-no-failover bug is
   actually observable from inside `code-docker-dind` itself (its own shell), and
   separately from inside a container `docker run` from within it, before designing a
   fix.
2. If confirmed from dind's own shell: adapt `dns-local`'s approach, but solve the
   before-dockerd-starts ordering constraint — e.g. run the local dnsmasq synchronously
   as part of `dind-entrypoint.sh`'s own existing pre-dockerd network setup step, not a
   separate supervised program.
3. If confirmed from *nested* containers too: research what DNS config nested `docker
   run` containers actually inherit (`dockerd`'s own `--dns`/`--dns-search` flags vs. its
   resolv.conf snapshot) and whether pointing them at dind's own real IP instead of
   `127.0.0.1` is the right fix — this is genuinely new design work, not a mechanical
   port of code-docker's fix.
