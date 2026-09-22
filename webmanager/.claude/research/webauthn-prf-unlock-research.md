# Research: fingerprint (WebAuthn) unlock for the webmanager password gate

Status: RESEARCH ONLY (2026-09-22). Nothing implemented. Written for the request
"remember the password, lock/unlock it via WebAuthn PRF, fall back to the password
prompt on cancel, keep WebAuthn retryable; laptop via passkeyd → fprintd".

## TL;DR

- **PRF is broadly usable now** on phones/tablets/Macs (Android Chrome + Google Password
  Manager, Samsung Internet, Safari/iCloud Keychain 18+, Chrome/Firefox on macOS) and on
  Windows Hello only since the Feb-2026 update. It is still **not universal** and has
  create-vs-get splits, so any design must treat "no PRF result" as normal.
- **passkeyd does NOT implement hmac-secret, so PRF will not work on the Linux laptop with
  passkeyd** (verified in source at bjn7/passkeyd@477b5e2, 2026-09-21 — details below).
  Plain WebAuthn assertions with UV (fingerprint via fprintd) *do* work with it.
- That single fact flips the recommendation: **Option B (server-side WebAuthn as a second
  unlock method, no secret stored on the client) works on every target including passkeyd,
  and is also the more secure design.** Option A (PRF-wrapped password in localStorage) is
  feasible but would leave out exactly the laptop the user named, unless passkeyd is swapped
  for an hmac-secret-capable authenticator (e.g. `tpm-fido2-thinkpad-linux`) or passkeyd
  gains hmac-secret upstream.
- Recommendation: **implement B**. Keep A only as a fallback idea if server-side state is
  unacceptable. Details and open questions at the end.

---

## 1. How the gate works today (what we would plug into)

- `webmanager/backend/internal/authgate/gate.go`: argon2id hash from
  `WEBMANAGER_AUTH_PASSWORD_HASH`; stateless HMAC-signed token in the `webmanager_unlock`
  cookie (HttpOnly, SameSite=Strict, Secure only when the request came over TLS,
  Path=/). HMAC secret is random per process → a restart re-locks everything. Idle TTL
  10 min sliding, hard cap 12 h measured from the unlock the user actually performed
  (`mintToken(origin, refreshed)`), per-client-IP backoff after 5 failures (5 s doubling,
  max 5 min), keyed on the TCP peer, not XFF.
- `webmanager/backend/handlers_auth.go`: `POST /api/auth/unlock {password}` →
  `TryUnlock` → `SetCookie`; `GET /api/auth/status` → `{required, unlocked, unlockedUntil}`.
- Frontend: `frontend/src/components/common/UnlockModal.tsx` is the single global prompt;
  `api/client.ts` calls it on any 401 (`setUnlockPrompter`), concurrent 401s share one
  prompt, success re-issues the original request. `useUnlockGate.ts`'s `ensureUnlocked`
  pre-prompts before opening dialogs. `RequiresUnlock.tsx` / `SidebarFooter.tsx` also
  consume status.
- A new unlock method only has to end in the same `SetCookie(w, r, g.issueToken())` —
  nothing downstream (RequirePassword, sliding refresh, 12 h cap, sidebar countdown)
  needs to know how the unlock happened.
- router-manager has its **own copy** of `internal/authgate` (`router/backend/internal/authgate`,
  `ROUTER_MANAGER_AUTH_PASSWORD_HASH`), on its own origin when `ROUTER_MANAGER_HOSTS` is set
  and iframed cross-origin into webmanager. See §5.

### How webmanager is served (drives RP ID)

- Public path: `https://<code-server-host>/manager/` via the in-container nginx
  (`config/nginx/nginx.default.conf`, `location /manager/`, `X-Frame-Options SAMEORIGIN`),
  behind the user's reverse proxy + forward-auth. So **webmanager's origin == code-server's
  origin**. The upstream `WEBMANAGER_ADDR` (`private:81`) is not a public origin.
- Embedded same-origin by code-server's `webmanager-launcher` code-patch
  (`MANAGER_URL = ${location.origin}/manager/`).
- router pages (`/router/` on `ROUTER_MANAGER_HOSTS` or the shared host) are iframed into
  webmanager by `RouterFrame.tsx` with `allow="fullscreen; clipboard-read; clipboard-write"`.
- nginx sets no `Permissions-Policy` header anywhere today (checked), so browser defaults
  apply.

---

## 2. PRF / hmac-secret support matrix (as of Sept 2026)

PRF (WebAuthn L3 `prf` extension) is the browser-facing wrapper over CTAP2 `hmac-secret`
(and over platform-native equivalents for iCloud Keychain / GPM / Windows Hello). The
browser hashes each input as `SHA-256("WebAuthn PRF" || 0x00 || input)` before handing it
to the authenticator, so a site can't request raw hmac-secret values usable by other
protocols. Note PRF output is bound to **credential + input**, not to origin beyond the RP ID.

`create()` returns `prf.enabled` and *sometimes* `prf.results`; `get()` returns
`prf.results` or nothing. A result-less `create()` is normal and must be followed by a
`get()` (second biometric prompt) to derive the key.

| Platform / browser | Platform authenticator PRF | Security key (USB/NFC) PRF | Notes |
|---|---|---|---|
| Android – Chrome / Edge | Yes (GPM passkeys: "PRF by default"; ~91–100 % on create, 100 % on get) | Yes | Broadest support |
| Android – Samsung Internet | Yes | Yes | Samsung Pass as provider: nothing on create, value on get |
| Android – Firefox 149+ | Yes | Not measured | |
| iOS/iPadOS 18+ – Safari (and every iOS browser, all WebKit) | Yes (iCloud Keychain; ~100 %) | 26.4+ only, with bugs | iOS 18.0–18.3 had PRF data-loss bugs as a cross-device source; fixed 18.4+. WebKit bugs 311099 (returns undecrypted hmac-secret on USB/NFC keys) and 314934 (null results for YubiKey Bio) |
| macOS 15+ – Safari 18+ | Yes | 26.4+, same WebKit bugs | |
| macOS – Chrome 132+ / Firefox 139+ | Yes | Yes | |
| Windows 11 – Windows Hello | Only after KB5077181 (Feb 2026, 24H2/25H2 build 26200.7840+) **and** Chrome/Edge 147+ (146 = get only) or Firefox 148+ (147 backported create) | Yes | Windows 10: no PRF at all. Before Feb 2026 Windows Hello lacked hmac-secret entirely |
| Linux – Chrome / Firefox | **No platform authenticator.** GPM desktop passkeys exist on Linux (beta) and GPM includes PRF, but UV there is the GPM PIN, not a fingerprint | Yes for real CTAP2 keys with hmac-secret; for virtual uhid authenticators it depends entirely on the daemon (see §3) | |
| Any desktop – hybrid (phone via QR/BLE) | n/a | Yes | Works, but is not "fingerprint on the laptop" |
| Third-party managers | 1Password yes; Bitwarden partial (100 % get on Linux/Firefox, 29 % Android, 0 % iOS); Dashlane no; Microsoft Password Manager create-only (get fails) | | `getClientCapabilities()`' `extension:prf` is unreliable — Chrome reported it true with managers that then returned nothing |

Sources: [Corbado PRF matrix (2026)](https://www.corbado.com/blog/passkeys-prf-webauthn),
[MDN WebAuthn extensions – prf](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions),
[Chrome Status: WebAuthn PRF](https://chromestatus.com/feature/5138422207348736),
[Intent to Ship: WebAuthn PRF](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI),
[Yubico: Developer's guide to PRF](https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html),
[Google: passkey support on Android and Chrome](https://developers.google.com/identity/passkeys/supported-environments),
[Chrome blog: GPM passkeys on desktop](https://developer.chrome.com/blog/passkeys-gpm-desktop),
[Bugzilla 1593571 (Firefox hmac-secret)](https://bugzilla.mozilla.org/show_bug.cgi?id=1593571),
[Apple forum: PRF reports true without hmac-secret](https://developer.apple.com/forums/thread/782466).
The per-provider percentages come from Corbado's own demo telemetry — indicative, not
authoritative; I could not find a vendor-neutral matrix of equal detail.

**Verdict on PRF in general:** usable as an *enhancement* for phone/tablet/Mac, and for
Windows only on fully updated machines. It is not something the unlock flow can depend on.

---

## 3. passkeyd + fprintd on Linux

**What it is.** [bjn7/passkeyd](https://github.com/bjn7/passkeyd) ("An Opinionated WebAuthn
Authenticator", Rust, GPL-3.0, AUR `passkeyd`, ~67 stars, created 2026-02, last push
2026-09-21). A root systemd daemon that emulates a **roaming CTAP2 USB-HID authenticator**
via `/dev/uhid` (`passkeyd/src/ctaphid/hid/vhid.rs`, a modified `uhid_virt`). Keys are
TPM2-backed (`USE_TPM_CRYPTOGRAPHY=yes`) or stored plain as root-only files. User
verification is done by passkeyd itself via fprintd over D-Bus
(`src/auth/fprintd.rs`, `cerds/get.rs::authorization_fprint`) with PAM/password fallback;
a GTK/KDE/Ice popup handles selection/enrollment UI.

**How browsers talk to it.** No portal, no browser integration: Chrome and Firefox on
Linux simply see a new FIDO HID device (usage page 0xF1D0), exactly like a plugged-in
YubiKey (needs the usual hidraw `uaccess` udev rule). Consequences for us:

- It shows up as a **security key / cross-platform** authenticator, not a "platform"
  authenticator. So we must **not** set `authenticatorAttachment: "platform"` or
  `hints: ["client-device"]`, or Chrome will hide it and offer only GPM/hybrid.
- Chrome's UI will first show its own sheet ("use a security key / phone / GPM") before the
  passkeyd popup appears. That's one extra click on the laptop, unavoidable from the site.

**Does it implement hmac-secret / PRF? No.** Source evidence at commit `477b5e2`:

- `handlers/get_info.rs` builds the getInfo response with `versions: [FIDO_2_0]`, zero
  AAGUID, options `up/uv/rk/plat` — and **no `extensions` list at all** (so no
  `hmac-secret`), and `client_pin`/`pin_uv_auth_token` = None.
- `cerds/make.rs` and `cerds/get.rs` both emit authenticator data with `extensions: None`.
- `handlers/client_pin.rs` is explicitly `// THIS IS CURRENTLY "TODO" AND UNREACHABLE`.
  hmac-secret needs the clientPin `getKeyAgreement` ECDH channel to carry the salt
  encrypted, so it can't exist without that work first.

Result: with passkeyd, `create()` returns `prf.enabled: false` and `get()` returns no
`prf.results`. **Option A cannot work on the laptop with passkeyd.** It *does* set
`UV|UP` on every assertion after a fingerprint match, so **Option B works fine** with it.

Linux alternatives, if PRF on the laptop specifically matters:

| Project | fprintd UV | hmac-secret/PRF | Maturity |
|---|---|---|---|
| [mc256/tpm-fido2-thinkpad-linux](https://github.com/mc256/tpm-fido2-thinkpad-linux) | Yes | **Yes** (README: "PRF extension: hmac-secret support") | Early: ~7 stars, tested on one ThinkPad model |
| [matejsmycka/linux-id](https://github.com/matejsmycka/linux-id) | Yes (`--auth fprintd`) | Not mentioned | tpm-fido fork, maintained |
| [llavero](https://github.com/Voyagerroc-Lab/llavero) | Yes | Not mentioned; CTAP2.1 + PIN protocols listed as not implemented | 3 commits |
| [verifidod](https://pkg.go.dev/github.com/cowboyrushforth/verifidod) | Yes | Not mentioned | small |
| [psanford/tpm-fido](https://github.com/psanford/tpm-fido) | No (presence only) | No | unmaintained |

(Only the passkeyd verdict is source-verified; the others are README-level.) Also see
[ArchWiki: WebAuthn](https://wiki.archlinux.org/title/WebAuthn) and
[Vitor Py: TPM-backed WebAuthn PRF on Linux](https://vitorpy.com/blog/2025-12-25-confer-to-linux-tpm-fido2-prf/).

---

## 4. Design options

### (A) Client-only: PRF-wrapped password

Flow: after a successful password unlock, offer "지문으로 기억하기". `create()` a
credential (rpId = current host, `userVerification: "required"`, `residentKey:
"discouraged"` is fine since we keep the credential ID) with `prf.eval.first = salt`
(32 random bytes); if no `prf.results`, immediately `get()` with `evalByCredential`. PRF
output → HKDF-SHA256(info="webmanager-unlock-v1") → AES-256-GCM key (non-extractable
WebCrypto key) → encrypt the password. Store `{credId, salt, iv, ciphertext, hashTag}` in
IndexedDB/localStorage. Unlock = `get()` with PRF → decrypt → existing
`POST /api/auth/unlock`.

Pros: zero server change; fits the request literally; per device, no server-side list.

Cons / risks, honestly:
- **Doesn't cover passkeyd** (§3), nor pre-Feb-2026 Windows Hello, Bitwarden-on-iOS etc.
- **The plaintext password is reconstructed in page JS on every unlock.** Anyone with
  script execution on the origin (XSS, a malicious code-server web extension, an extension
  webview) can call `get()` themselves; the user sees a normal fingerprint prompt, taps,
  and the attacker walks away with the **reusable, possibly reused-elsewhere password**,
  not just a 10-minute cookie. Note: webmanager shares its origin with code-server, and
  code-server serves extension webviews from the **same origin** (`webviewEndpoint` is a
  relative path in `lib/vscode/out/server-main.js`, sandbox includes `allow-same-origin`),
  so "script on this origin" is a wider set than webmanager's own bundle.
- Storage theft alone (shared device, disk image, localStorage dump) yields only
  ciphertext; useless without an authenticator UV. Good. And for CTAP2 hmac-secret, the
  authenticator keeps separate secrets for UV and non-UV evaluations, so a blob enrolled
  with UV can't be decrypted by a later UP-only assertion — the fingerprint requirement
  is cryptographic, not just a flag.
- Password change: the stale password decrypts fine and then gets `401` — which also
  counts toward the 5-failure backoff. Must detect → wipe the blob → show the password
  field → re-offer enrollment. Could be avoided with a non-secret gate identifier in
  `/api/auth/status` (e.g. HMAC of the hash under a fixed label) to invalidate proactively.
- Multiple credentials per device: fine (array of blobs, `allowCredentials` lists all,
  `evalByCredential` per ID); synced passkeys (iCloud/GPM) mean one credential may be
  usable on several devices but each device still needs its own ciphertext.
- Origin-partitioned: each hostname (and each embedding top-level site, due to storage
  partitioning) has its own storage → separate enrollment. Worst for router-in-iframe.
- No revocation other than "clear site data on that device" or changing the password.

### (B) Server-side WebAuthn as a second unlock method (recommended)

Flow: registration only from an already-unlocked session (cookie valid, and ideally
issued within the last few minutes). Server stores `{credentialID, publicKey, signCount,
rpID, transports, label, createdAt, lastUsedAt}`. Unlock = `POST
/api/auth/webauthn/begin` (challenge) → `get()` with `userVerification: "required"` and
`allowCredentials` = stored IDs → `POST /api/auth/webauthn/finish` → verify signature,
`UV` flag, rpIdHash, `clientDataJSON.origin` and challenge → `SetCookie(issueToken())`.

Pros:
- **Works with every authenticator that can do WebAuthn with UV** — passkeyd included,
  Windows Hello without the Feb update, Firefox/Linux, security keys, hybrid from phone.
  PRF support becomes irrelevant.
- **No secret on the client.** XSS can at most obtain one unlock (same as it could by
  riding the existing cookie) — never the reusable password.
- Origin is verified server-side (`clientDataJSON.origin`), so a sibling vhost sharing a
  parent domain can't use an assertion here.
- Real revocation: list/delete credentials in the UI; independent of the password; a
  password rotation doesn't break biometric unlock (decide whether it *should* — Q4).
- Rate limiting largely unnecessary for the WebAuthn path (can't be brute-forced), but
  failed verifications can still feed the same per-IP counter.

Cons / cost:
- Server state: a small JSON file, e.g.
  `/code/.local/share/code-docker/webmanager/webauthn-credentials.json` (0600, atomic write),
  next to the existing `claude-prefs.json` etc. It lives on the home volume, which a
  code-server terminal can edit (adding its own public key). That is not a new hole —
  code-server's integrated terminal is already an ungated root shell behind the same
  forward-auth, and it can already rewrite `WEBMANAGER_AUTH_PASSWORD_HASH`'s source — but
  it is worth stating in the doc.
- Challenge state: short-lived (≤2 min) in-memory map keyed by a random ID, or a
  stateless HMAC-signed challenge like the existing token. Restart just invalidates
  in-flight ceremonies.
- Dependency: [go-webauthn/webauthn](https://github.com/go-webauthn/webauthn) (the
  maintained successor of duo-labs/webauthn; module requires a recent Go — webmanager is
  on Go 1.25, fine). Attestation: `none` (we don't care about device make).
  Roughly: 2 registration + 2 assertion endpoints + list/delete, ~300–500 lines backend,
  plus a frontend helper using `PublicKeyCredential.parseRequestOptionsFromJSON` /
  `toJSON()` where available (Chrome 129+, Safari 18.x, Firefox 119+) or a tiny base64url
  shim.
- RP ID / origin configuration (§5).

**Is B strictly better?** For this use case, yes, on security and compatibility. The one
thing A has over B is "no server change and no state on the server". The user's stated
goal (fingerprint unlock on phone/tablet/laptop with passkeyd, cancel → password,
retryable) is fully met by B, and only partially by A.

(C, not recommended) A + B hybrid, i.e. PRF wrapping a *server-issued device secret*
instead of the password, gains nothing over B.

### UX (applies to either option; written for B)

- Enrollment: after a successful *password* unlock, the modal (or a toast) offers
  "이 기기에서 지문으로 잠금 해제" — never block the unlock on it. Also a "잠금 해제
  수단" section (probably Settings/보안) listing credentials with label, created, last
  used, delete. Label default from the UA ("Android Chrome", "Linux Firefox").
- Unlock modal when this device has an enrolled credential (remembered by a non-secret
  localStorage flag, or simply always offer when the server has any credential):
  - Show the modal with a primary "지문으로 잠금 해제" button, and try it **automatically
    once** if `navigator.userActivation.isActive` (the modal usually opens from a 401
    caused by a click). Safari ≥16 relaxed the user-gesture rule, but older WebKit and the
    await-a-fetch-first pattern can still reject; the button is the reliable path.
  - `NotAllowedError` (cancel, timeout, and "no matching credential" are deliberately
    indistinguishable) → keep the modal open, focus the password field, keep the
    "지문으로 다시 시도" button. Never auto-loop.
  - `InvalidStateError`/`SecurityError`/missing `navigator.credentials` (plain HTTP, IP
    host) → hide the WebAuthn button entirely, password only.
- `userVerification: "required"` on both create and get, and B's server must reject
  assertions without the UV flag. passkeyd always sets UV; phones use biometric or device
  PIN (the device PIN is an accepted UV — can't restrict to fingerprint only from the web).
- Do not use conditional mediation / autofill — irrelevant for an unlock modal.

---

## 5. RP ID, origins and iframes in this deployment

- **Secure context required.** `navigator.credentials` is unavailable on plain
  `http://` (except `localhost`). RP ID cannot be an IP address. So an HTTP-only LAN
  access by IP simply won't show the option — fine as a graceful degradation, but worth
  knowing (tailscale access should use a MagicDNS HTTPS name).
- **RP ID = exact hostname of the page**, e.g. `code.example.com`. Do **not** widen it to
  the registrable parent (`example.com`) even though that would let one credential serve
  `router.code.example.com` too: every vhost side project on the same parent domain could
  then trigger assertions (and, for A, obtain the same PRF output) for our RP ID. router
  vhosts exist precisely to keep side projects off this origin.
- **Multiple hostnames** (e.g. a public host and a tailnet host): with B, store `rpID` per
  credential and accept an assertion only when `clientDataJSON.origin`'s host equals
  that credential's rpID and the request's Host. Derive the expected RP from the request
  (nginx forwards `Host $host`; `requestIsHTTPS` already trusts nginx's
  `X-Forwarded-Proto` convention) — a forged Host header doesn't help an attacker because
  the signed clientData origin must match a registered rpID. Optional env override
  `WEBMANAGER_WEBAUTHN_RP_ID` / origin allowlist for unusual setups. Each hostname needs
  its own enrollment either way; Related Origin Requests
  (`/.well-known/webauthn`) could unify them later but isn't worth it now.
- **code-server launcher overlay** (`/manager/` iframed by code-server, same origin):
  `publickey-credentials-get`'s default allowlist is `'self'`, so a same-origin iframe is
  allowed without any `allow=` attribute. Should just work; verify with a real test.
- **Parallel track: webmanager inside a VS Code webview.** code-server serves webviews
  same-origin (`webviewEndpoint = <base>/out/vs/workbench/contrib/webview/browser/pre`),
  and the webview iframes set `allow="cross-origin-isolated; autoplay;
  local-network-access; clipboard-read; clipboard-write"` without the publickey tokens.
  Permissions Policy falls back to the default `'self'` allowlist for undeclared features,
  so if **every** hop is same-origin (workbench → webview host → webview content →
  webmanager `/manager/`) `get()` should still be permitted. If any hop is a different
  origin (e.g. a stock VS Code build using `*.vscode-cdn.net`), `get()` fails with
  `NotAllowedError` and we can't add the `allow` attribute because VS Code owns those
  iframes. Also Chrome requires the calling document to have focus. **Needs an empirical
  test; the design must treat it as "may be unavailable → password fallback"**, which the
  UX above already does. `create()` inside a nested iframe is more restricted still — do
  enrollment only at top level or in the same-origin launcher.
- **router (own authgate) in a cross-origin iframe**: would need
  `allow="publickey-credentials-get <router-origin>"` (and `-create` for enrollment) on
  `RouterFrame.tsx`'s iframe. Chrome allows cross-origin-iframe `create()` (since ~123)
  with user activation; **Safari does not allow cross-origin-iframe `create()`**, so
  enrollment would have to happen on router's own top-level page. With A, router's
  storage in the iframe is partitioned under webmanager's top-level site, separate from
  router opened top-level → double enrollment. With B, router gets its own credential
  store and RP ID (the router host); enrollment at top level, use from the iframe works
  with the `allow` delegation. When `ROUTER_MANAGER_HOSTS` is empty router shares the
  code-server origin, so no delegation is needed but RP IDs collide harmlessly (separate
  credential stores).
  Recommendation: ship webmanager first; do router as a follow-up by extracting the
  WebAuthn bits into something both authgate copies can use (or duplicate, matching how
  authgate itself is duplicated today).

---

## 6. Recommended design sketch (Option B)

Backend (`webmanager/backend`):
- `internal/authgate`: add `IssueFor(w, r)` (or reuse `SetCookie(issueToken())`) so the
  WebAuthn handler can mint the same cookie; treat a WebAuthn unlock as a fresh
  "typed" unlock for the 12 h cap (Q3).
- New `internal/webauthnunlock` (name TBD): credential store (JSON, atomic write), challenge
  cache, go-webauthn wrapper that builds a per-request `webauthn.Config{RPID: host,
  RPOrigins: [scheme://host]}`.
- Routes: `POST /api/auth/webauthn/register/{begin,finish}` (behind RequirePassword +
  "unlocked within N minutes"), `POST /api/auth/webauthn/unlock/{begin,finish}` (ungated,
  per-IP limited), `GET/DELETE /api/auth/webauthn/credentials[/id]` (gated).
  `/api/auth/status` gains `webauthnAvailable: bool` (any credential for this rpID).
- Only active when the password gate is configured (the gate being off means nothing to
  unlock). Env toggle to disable entirely (Q6).

Frontend:
- `UnlockModal.tsx`: WebAuthn button + one auto-attempt when user activation is live,
  cancel → password field, retry button; the rest of the 401-retry plumbing unchanged.
- Enrollment offer after password unlock; credential list/delete UI.

Docs: `docs/security-login.md` (+ `docs/webmanager-config.md` for any env var),
`webmanager/plan.md`; README-level security note about the credential file on `/code`.

Test plan: Android Chrome (GPM, fingerprint), iPhone/iPad Safari (Face/Touch ID),
Linux Chrome + Firefox with passkeyd (fprintd), cancel/timeout paths, HTTP/IP access
(button hidden), launcher overlay, (later) VS Code webview embed, restart (credentials
survive, cookie doesn't), credential delete, password change.

---

## 7. Risks

- Browser UX on Linux Chrome adds a "use security key" step before passkeyd's popup.
- Device PIN/passcode counts as UV on phones; we can't insist on a fingerprint.
- iframe/webview contexts may silently lack permission → must always fall back.
- go-webauthn is a new third-party dependency in a security-sensitive path (well
  maintained, widely used; pin and review).
- If Option A is chosen anyway: plaintext password exposure to any same-origin script
  (including code-server extension webviews, see §4A), and no laptop support with passkeyd.

---

## 8. QUESTIONS for the user (answers change the design)

1. **B instead of A OK?** The request was specifically "PRF-wrapped password". Given
   passkeyd has no hmac-secret, A would not work on the laptop. B gives the same UX on all
   three devices with nothing secret stored client-side. Go with B?
2. If A is still wanted (e.g. no server state at all): is switching the laptop from
   passkeyd to an hmac-secret-capable daemon (`tpm-fido2-thinkpad-linux`) acceptable, or
   is passkeyd a fixed choice?
3. Should a biometric unlock count as a fresh unlock for the 12 h hard cap (i.e. reset it),
   or should the cap still force a real password once every 12 h?
4. On password change (hash rotated), should enrolled biometric credentials be revoked
   automatically, or stay valid (they're independent secrets)?
5. Router-manager too, in the same pass, or webmanager first and router as a follow-up?
6. Default on (offered automatically whenever the password gate is on) or behind an
   explicit env toggle like WebDAV share?
7. Which hostnames does the user actually reach webmanager on (public host, tailnet host,
   IP)? Determines how many enrollments per device and whether an RP-ID/origin env
   override is worth adding now.
