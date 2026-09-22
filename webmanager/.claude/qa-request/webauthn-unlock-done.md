# Fingerprint (WebAuthn) unlock of the password gate — done, needs device QA

Implemented on 2026-09-22 as research option **B**: a server-side WebAuthn relying party. It was not built as a PRF-wrapped password, and the reasons are in `../research/webauthn-prf-unlock-research.md`:
- passkeyd has no hmac-secret/PRF;
- a wrapped password would be rebuilt in same-origin page JS on every unlock.

The owner chose B.

## What shipped

**Backend**

`internal/webauthnunlock` handles the credential store (JSON, 0600) and the ceremonies (go-webauthn v0.17.4 — the last release that builds with the image's Go 1.25; v0.18 needs 1.26).

Routes (`handlers_webauthn.go`):

| Route | Gating |
|---|---|
| `POST /api/auth/webauthn/unlock/{begin,finish}` | ungated; shares the password path's per-IP backoff via new `Gate.CheckAttempt/RecordFailure/RecordSuccess` |
| `POST /api/auth/webauthn/register/{begin,finish}` | begin takes the **password** itself, not just a cookie |
| `GET/DELETE /api/auth/webauthn/credentials[/{id}]` | gated |

`/api/auth/status` gained two fields: `webauthnEnroll` and `webauthn` (a credential exists for this host).

**Rules**

- **RP ID** is the request's exact hostname. IP hosts are refused.
- **Origin** is checked against the RP ID: https, or http only on localhost. The port is taken from what the browser signed.
- **User verification is required.**
- **The 12h hard cap counts from the last *typed* password.** The mechanism: `Gate.IssueFrom(passwordAt)`, with `passwordAt` persisted in the store and recorded by both password paths.
- **A hash change revokes everything.** The store keeps a hash tag and logs the count it revoked.
- **Clone warning** (signature counter went backwards) is refused.

**Frontend**

- `utils/webauthn.ts` is the ceremony and encoding helper (base64url shim, `toJSON` equivalent).
- `components/common/WebAuthn.tsx`:
  - the unlock button in both password forms — auto-tried once only when this browser enrolled **and** user activation is live, with a retry label after a cancel;
  - the enrollment offer after a password unlock (다시 묻지 않기 is stored per browser);
  - the device list in a Sheet, opened from a sidebar-footer fingerprint icon.
- `webauthnGate.ts` holds the non-component helpers.
- `api/client.ts` treats `/auth/webauthn/{unlock,register}/` as unlock paths: a 401 there never pops the password prompt, and a success notifies listeners.

**Env** (`example-env.webmanager` v19): `WEBMANAGER_WEBAUTHN_ENABLED` (default true, only meaningful with the gate on) and `WEBMANAGER_WEBAUTHN_PATH`.

## Verified (test stack, 2026-09-22)

End to end through the real UI, driven over CDP. The test used a Chrome **virtual authenticator** (ctap2, internal, UV). For a secure context, `http://localhost` inside `code-docker-chrome` was forwarded to code-docker's nginx.

- Password unlock shows the enrollment offer. 등록 stores a credential (`Linux Chrome`, rpId `localhost`) and sets the device flag.
- Cookie cleared → 지문으로 잠금 해제 → unlocked.
- UV failure → "취소되었습니다" plus "지문으로 다시 시도", and the page stays locked.
- Enrolling from the device list works (password re-typed there).
- A modal opened by clicking the sidebar lock auto-tries the fingerprint and closes unlocked.
- Changing the password hash logs `revoked 2 enrolled fingerprint unlock credential(s)`, and status reports `webauthn:false`.

Unit tests cover:
- `webauthnunlock`: revocation, per-host scoping, RP ID and origin rules, single-use ceremonies.
- `authgate.IssueFrom`: the cap, zero or future origin, and an unconfigured gate.

## Code review follow-ups (2026-09-22, commit be3a88b)

- **Ceremonies carry their kind** (register/unlock), and finishing one only accepts its own kind. Before this, an unlock challenge was issued ungated, and it could reach `FinishRegistration`. The only thing stopping that was go-webauthn happening to reject a login session's empty `CredParams`. Pinned by `TestCeremonyKindsDontMix`.
- **At most 64 unfinished ceremonies**, oldest dropped (unlock/begin is ungated).
- **Only verified-and-failed assertions feed the backoff.** An unknown or expired ceremony, or a malformed body, doesn't count. The backoff key is the TCP peer, which is nginx for every browser.
- **Labels are cut by rune.**
- **`Delete` rolls back memory when the save fails**, and a failed `PasswordAt` save is logged.
- **Frontend:** 429 now shows "too many attempts". A 404 on unlock/begin clears this browser's enrolled flag.

Reviewed and cleared: origin/RP ID, UV, sign counter, the 12h cap, hash revocation, gated vs. ungated routes, the `isUnlockPath` exclusions.

## Needs the owner (real devices, HTTPS)

- **Android Chrome** (Google Password Manager, fingerprint) and **iPhone/iPad Safari** (Face/Touch ID).
- **Linux Chrome/Firefox with passkeyd + fprintd.** passkeyd appears as a USB security key, so Chrome may show a "use a security key" step first.
- **Inside the code-server extension's webviews and the titlebar overlay.** Both are same-origin, so it should work, but it was not exercised on a real authenticator. The password fallback covers failure.
- **Multiple hostnames** (public plus tailnet): each needs its own enrollment, by design.

## Not done / follow-ups

- **router-manager** has its own authgate copy (`ROUTER_MANAGER_AUTH_PASSWORD_HASH`). It could get the same feature. Its cross-origin iframe inside webmanager would need `allow="publickey-credentials-get <origin>"` on `RouterFrame.tsx`, and Safari can't enroll from a cross-origin iframe, so enrollment would have to happen on router's own page. Deferred, as the owner decided (webmanager first).
- **The device list can't mark which entry is this browser's own.** Deleting any entry clears the local "enrolled" flag, which only turns off the automatic attempt.

## 2026-09-22: residentKey discouraged → required (Android)

Owner report from a tablet: enrolling or unlocking asked for a physical security key, and the Google Password Manager entry it offered only opened GPM's main page. Cause: `residentKey: "discouraged"` is what makes Chrome on Android use the legacy Play Services **FIDO2 API** (Google's attestation-format post: the FIDO2 API "is invoked by setting the residentKey parameter to discouraged"), the older sheet with security-key/GPM options, instead of the passkey path through Android's Credential Manager and the chosen passkey provider. Registration now asks for `required`.

Not taken: the suggested `authenticatorAttachment: "platform"`. Per the spec an omitted attachment means no filter (not "cross-platform"), and "platform" would exclude a USB/HID-attached authenticator — passkeyd on the owner's Linux desktop is exactly that (it advertises `rk` and `plat` in getInfo but reaches Chrome over uhid). passkeyd supports resident keys, so `required` doesn't cost it anything.

Consequences: a new enrollment is a passkey, so with Google Password Manager it syncs to the owner's other Android/Chrome devices; enrolling again on a device that already holds one is refused by `excludeCredentials`. Credentials enrolled before this stay non-discoverable and keep working (unlock still sends `allowCredentials`).

Verified on the test stack with a CDP virtual authenticator (gate on): enrollment offer → enroll (the authenticator's credential is `isResidentCredential: true`), fingerprint unlock, UV failure stays locked, sidebar modal auto-try. **Needs the tablet re-test**; enrollments already made on the tablet (if any) should be deleted and redone.
