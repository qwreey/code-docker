// Fingerprint (WebAuthn) unlock of the password gate - the browser half of
// backend/handlers_webauthn.go. The server is the relying party: it hands
// out challenges, keeps the enrolled public keys and mints the same unlock
// cookie a typed password gets. Nothing secret is ever stored here - the one
// localStorage flag below only decides whether to *try* automatically.
import { api, ApiError } from '../api/client'

// WebAuthn needs a secure context (HTTPS, or localhost) and a browser that
// has it at all. Anything else: password only, no button.
export function webauthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof window.PublicKeyCredential === 'function' &&
    !!navigator.credentials
  )
}

// Whether *this* browser enrolled a credential. The server only knows that
// some device on this host did; auto-starting the prompt on a device that
// never enrolled would open a browser dialog with nothing to pick.
const ENROLLED_KEY = 'webmanager-webauthn-enrolled'
// "다시 묻지 않기" on the enrollment offer.
const DECLINED_KEY = 'webmanager-webauthn-offer-declined'

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    // storage unavailable - the flag just doesn't persist
  }
}

export const deviceEnrolled = () => readFlag(ENROLLED_KEY)
export const offerDeclined = () => readFlag(DECLINED_KEY)
export const declineOffer = () => writeFlag(DECLINED_KEY, true)

// ---- base64url <-> bytes (the server speaks JSON, WebAuthn speaks buffers)

function fromB64url(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

function toB64url(buf: ArrayBuffer | null | undefined): string | undefined {
  if (!buf) return undefined
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type JsonDescriptor = { id: string; type: string; transports?: string[] }

function descriptors(list: JsonDescriptor[] | undefined) {
  return (list ?? []).map((d) => ({ ...d, id: fromB64url(d.id) })) as PublicKeyCredentialDescriptor[]
}

// Exactly what WebAuthn Level 3's PublicKeyCredential.toJSON() produces,
// written out for browsers that don't have it yet.
function credentialToJSON(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorResponse & {
    attestationObject?: ArrayBuffer
    authenticatorData?: ArrayBuffer
    signature?: ArrayBuffer
    userHandle?: ArrayBuffer | null
    getTransports?: () => string[]
  }
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      attestationObject: toB64url(r.attestationObject),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      userHandle: toB64url(r.userHandle),
      transports: r.getTransports?.(),
    },
  }
}

export type WebAuthnOutcome = 'ok' | 'cancelled' | 'password-required' | 'failed'

// NotAllowedError covers a cancelled prompt, a timeout, and "no credential
// on this device" alike - browsers deliberately don't tell them apart. All
// of them just mean: fall back to the password, offer to try again.
function outcomeOf(err: unknown): WebAuthnOutcome {
  if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return 'cancelled'
  if (err instanceof ApiError && err.status === 409) return 'password-required'
  return 'failed'
}

type BeginResponse<T> = { ceremony: string; options: { publicKey: T } }

type JsonRequestOptions = Omit<PublicKeyCredentialRequestOptions, 'challenge' | 'allowCredentials'> & {
  challenge: string
  allowCredentials?: JsonDescriptor[]
}

// Unlocks with the fingerprint (or whatever user verification the device
// uses). Resolves with the outcome rather than throwing, since every
// failure has the same remedy: the password field stays right there.
export async function unlockWithWebAuthn(): Promise<{ outcome: WebAuthnOutcome; message?: string }> {
  try {
    const begin = await api.post<BeginResponse<JsonRequestOptions>>('/auth/webauthn/unlock/begin')
    const pk = begin.options.publicKey
    const cred = (await navigator.credentials.get({
      publicKey: {
        ...pk,
        challenge: fromB64url(pk.challenge),
        allowCredentials: descriptors(pk.allowCredentials),
      },
    })) as PublicKeyCredential | null
    if (!cred) return { outcome: 'cancelled' }
    await api.post(`/auth/webauthn/unlock/finish?ceremony=${encodeURIComponent(begin.ceremony)}`, credentialToJSON(cred))
    writeFlag(ENROLLED_KEY, true)
    return { outcome: 'ok' }
  } catch (err) {
    return { outcome: outcomeOf(err), message: err instanceof Error ? err.message : String(err) }
  }
}

type JsonCreationOptions = Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'> & {
  challenge: string
  user: { id: string; name: string; displayName: string }
  excludeCredentials?: JsonDescriptor[]
}

// A readable default label for the credential list ("Android Chrome").
export function defaultDeviceLabel(): string {
  const ua = navigator.userAgent
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /SamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : ''
  return [os, browser].filter(Boolean).join(' ') || '이 기기'
}

// Enrolls this device. Needs the password (see the backend's register/begin
// for why a cookie isn't enough) - the enrollment offer passes the one that
// was just typed.
export async function enrollWebAuthn(password: string, label: string): Promise<{ outcome: WebAuthnOutcome; message?: string }> {
  try {
    const begin = await api.post<BeginResponse<JsonCreationOptions>>('/auth/webauthn/register/begin', { password, label })
    const pk = begin.options.publicKey
    const cred = (await navigator.credentials.create({
      publicKey: {
        ...pk,
        challenge: fromB64url(pk.challenge),
        user: { ...pk.user, id: fromB64url(pk.user.id) },
        excludeCredentials: descriptors(pk.excludeCredentials),
      },
    })) as PublicKeyCredential | null
    if (!cred) return { outcome: 'cancelled' }
    await api.post(`/auth/webauthn/register/finish?ceremony=${encodeURIComponent(begin.ceremony)}`, credentialToJSON(cred))
    writeFlag(ENROLLED_KEY, true)
    return { outcome: 'ok' }
  } catch (err) {
    return { outcome: outcomeOf(err), message: err instanceof Error ? err.message : String(err) }
  }
}

export function forgetDeviceEnrollment() {
  writeFlag(ENROLLED_KEY, false)
}
