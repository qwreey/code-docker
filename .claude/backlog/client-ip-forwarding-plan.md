# Real client IP for webmanager's lockout (audit A-03, open)

Status: **design needed, owner decision pending.** Nothing implemented. The
2026-10-06 audit (`~/Desktop/code-docker-audit-2026-10-06.md`, A-03) found that
the F11 fix (`d1f747e`) doesn't separate external clients.

## What happens today

- webmanager keys its password lockout (`authgate.ClientKey`) on `X-Real-IP`,
  trusted only from a loopback peer. code-docker's nginx sets that header to its
  own `$remote_addr`.
- The browser path is browser → router nginx → Caddy (unix socket) →
  `code-docker:80`. code-docker's nginx therefore always sees **router's
  address**. Every external client lands in one lockout bucket. On the vhost
  path (`code-docker:82`, WebDAV) router does send `X-Real-IP`, but code-docker's
  nginx overwrites it.
- Effect: five wrong WebDAV passwords from anyone lock out everyone, owner
  included. One request every five minutes keeps it that way (`lockoutMax`).
  WebDAV is outside forward-auth by design, so it's internet-facing.
  `/api/auth/unlock` and the WebAuthn unlock share the same key.
- router-manager itself is fine: router's nginx sees the real peer and its
  `rateLimitKey` uses that.

## Owner constraints (2026-10-08)

- Forwarding the client IP isn't free. Something running inside the container
  (a Caddy, say) can't know the real IP, and a forwarded header brings its own
  trust problems.
- It probably has to be **opt-in**. Some deployments can't forward it at all
  (the outer proxy may not provide it).
- The owner's own production would be fine with it.

## Options

1. **Opt-in forwarding** (both repos, one switch):
   - router sends `X-Real-IP` on the `location /` → Caddy → code-docker hop. That
     is `$remote_addr` after router's own `TRUSTED_PROXIES` realip, so an outer
     proxy's client IP survives.
   - code-docker's nginx, when enabled, adds `set_real_ip_from <router>` +
     `real_ip_header X-Real-IP`, so `$remote_addr` (and the header it passes to
     webmanager) becomes the client. `<router>` is the address
     `NGINX_ALLOWED_PEERS` already resolves and refreshes.
   - Off: today's behavior.
   - Also fixes A-12 (`X-Forwarded-Proto`) and A-13 (`TRUSTED_PROXIES` docs) if
     the same hop is touched.
2. **Make the lockout less of a weapon, independent of the IP:**
   - Per-(key, username) buckets for WebDAV: a wrong username doesn't lock the
     real one. It doesn't help when the attacker knows the username (default
     `webdav`).
   - Replace the escalating lockout with a global rate limit (N attempts/min,
     no 5-minute lock). Brute force stays slow, and the owner gets through
     between attacker attempts.
   - Let a cached-valid WebDAV credential keep working while locked: the 5-min
     success cache already exists. Extending it for an already-authenticated
     client means a lockout only blocks new logins.
3. Both: 2 as the always-on floor, 1 as the opt-in upgrade.

Recommendation: 3. Option 2's "cached credential keeps working" plus a softer
global limit removes the owner-lockout without touching any trust boundary.
Option 1 can follow as an opt-in.

## Interim (done)

`docs/tips/webdav.md`, `TODO.md` and
`.claude/archive/authgate-client-ip-blind-spot-done.md` no longer claim the
lockout is per-IP or that this is solved.
