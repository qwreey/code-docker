import { useState } from 'react'
import { copyText } from '../../utils/clipboard'
import './common.css'

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    if (!(await copyText(text))) {
      setCopied(false)
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button type="button" className="btn btn-secondary btn-small" onClick={handleCopy}>
      {copied ? '복사됨' : '복사'}
    </button>
  )
}
