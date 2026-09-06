// Copying text from a page served over plain http (this stack's default —
// http://<host>/manager) can't rely on navigator.clipboard: it's only
// exposed in a secure context, and where it does exist writeText() can
// still reject without a user gesture. The execCommand path is deprecated
// but is the only thing that works in exactly those cases, so both are
// kept, in that order.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy path below rather than giving up - a
    // rejected writeText() (insecure context, missing gesture) is exactly
    // the case execCommand still handles.
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
