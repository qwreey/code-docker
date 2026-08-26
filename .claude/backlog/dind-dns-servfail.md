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

## 2026-08-26: step 1 partially done — reproduced from dind's own shell, and it's worse than expected

Confirmed from `code-docker-dind`'s own shell, on the live test stack. The observed failure
isn't the SERVFAIL-failover shape this doc was written around, though — it's a distinct and
strictly worse one on the same `/etc/resolv.conf`:

```
# /etc/resolv.conf inside dind, exactly what apply_nameserver writes:
#   nameserver 127.0.0.11
#   nameserver 172.18.0.5      <- router
$ getent hosts router          ; echo $?      # -> 2, every single time
$ nslookup router 127.0.0.11   # -> 172.18.0.5, correct
$ nslookup router 172.18.0.5   # -> NXDOMAIN
```

Each nameserver alone behaves correctly. Together they don't: musl queries every nameserver
in `resolv.conf` **in parallel** and takes the first answer, and router's own dnsmasq answers
`NXDOMAIN` for `router` (a Docker-internal-only name it has no business knowing) faster than
127.0.0.11 answers `A`. So adding router as a *fallback* nameserver doesn't just fail to help
for internal names — it actively breaks them, deterministically.

Consequences worth noting for whoever picks this up:

- This is not "fallback ordering that some resolvers don't honor". musl has no ordering to
  honor; `options ndots:0` doesn't change it either. Any fix that leaves two nameservers with
  disjoint knowledge in one `resolv.conf` is wrong for dind regardless of resolver quirks,
  which strengthens the case for step 2's local-resolver approach over any reordering tweak.
- It means `dind-entrypoint.sh`'s upkeep loop can never trust `getent hosts "$ROUTER_HOSTNAME"`
  after its own first successful `apply_nameserver` — the loop's health reporting was
  deliberately moved off per-tick resolution and onto observable state (a default route + a
  non-127.0.0.11 nameserver present) on 2026-08-26 for exactly this reason; see that script's
  own comment. Whoever fixes the DNS here should revisit that, since a local resolver would
  make per-tick resolution trustworthy again.
- Not yet checked: the same reproduction from inside a container `docker run` from within dind
  (step 3's question). Still open.

### Consequence found the same day: dind can't re-plant its own default route after a router restart

Observed end-to-end on the live stack: stop router, recreate dind (so it boots with no
route), then start router again. dind does *not* recover on its own. Final state, minutes
after router is back and healthy:

```
$ cat /etc/resolv.conf     # nameserver 127.0.0.11 + nameserver 172.18.0.5, i.e. poisoned
$ ip -4 route show default # (empty - never planted)
$ getent ahostsv4 router   # 2
$ getent hosts   router    # 2
```

The two `apply_*` helpers don't use the same lookup: `apply_default_route` uses `getent
ahostsv4` (A only, deliberately - see its own comment about not clobbering the v4 default
route with an AAAA answer), while `apply_nameserver` uses `getent hosts` (AF_UNSPEC). Under
the parallel-query race above those behave differently, and on the recovery tick the
AF_UNSPEC one won while the v4-only one lost. So `apply_nameserver` succeeded, wrote router
into resolv.conf - poisoning it - and from that point `apply_default_route` could never
resolve again. The loop was left running correctly against a resolver that had been broken
by its own sibling one tick earlier.

Confirmed by clearing the second nameserver by hand: the very next tick planted the route,
logged its recovery line, and the container went healthy. So the upkeep loop is fine; the
resolver underneath it isn't.

Note this is not a regression from the 2026-08-26 work - before it, the loop was already
dead (via `set -e`) after its first failing tick, so recovery was impossible rather than
unreliable. What changed is only that the state is now visible instead of silent.

Anything that fixes the top-level bug fixes this too. A narrower workaround (pin the
router's address into dind's `/etc/hosts` so the name never goes through the poisoned
resolver at all) was considered and deliberately not taken: it needs its own lookup path to
stay fresh across a router IP change, which is the same problem again.
