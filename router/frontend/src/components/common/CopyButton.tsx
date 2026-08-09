import { useState } from 'react'
import './common.css'

// Hand-ported from webmanager/frontend/src/components/common/CopyButton.tsx
// - same reasoning as ErrorBanner/Sheet/Skeleton (see that component's own
// doc comment) rather than depending on @code-docker/router-frontend, which
// this component now lives inside anyway.
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button type="button" className="btn btn-secondary btn-small" onClick={handleCopy}>
      {copied ? '복사됨' : '복사'}
    </button>
  )
}
