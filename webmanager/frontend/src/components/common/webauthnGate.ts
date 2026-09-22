// Non-component half of WebAuthn.tsx (kept apart so that file only exports
// components): availability checks and the entry points into the one
// mounted WebAuthnHost.
import type { AuthStatus } from '../../api/types'
import { deviceEnrolled, offerDeclined, webauthnSupported } from '../../utils/webauthn'

// Whether a fingerprint unlock is worth offering here at all: the server has
// a credential for this host, and this browser can do WebAuthn.
export function webauthnUnlockAvailable(status: AuthStatus | null | undefined): boolean {
  return !!status?.webauthn && webauthnSupported()
}

// Whether enrolling can work here (the device list and the offer).
export function webauthnEnrollAvailable(status: AuthStatus | null | undefined): boolean {
  return !!status?.webauthnEnroll && webauthnSupported()
}

type HostHandlers = { offer: (password: string) => void; openManager: () => void }
let host: HostHandlers | null = null

export function registerWebAuthnHost(handlers: HostHandlers | null) {
  host = handlers
}

// Call right after a successful *password* unlock, with that password. A
// no-op when the offer doesn't apply (not available, this device already
// enrolled, or "다시 묻지 않기").
export function offerWebAuthnEnroll(status: AuthStatus | null | undefined, password: string) {
  if (!webauthnEnrollAvailable(status) || deviceEnrolled() || offerDeclined()) return
  host?.offer(password)
}

export function openWebAuthnManager() {
  host?.openManager()
}
