import { useState, type ReactNode } from 'react'
import type { AssistantMessageContent, ToolResultContent, UserMessageContent } from './entryTypes'

// v1 scope (see session-log-plan.md): tool_use and its matching tool_result
// aren't paired up — they render independently, in transcript order, each
// as its own collapsible block. tool_use_id is shown so a reader can match
// them by eye when needed.

function Collapsible({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="session-log-collapsible">
      <button type="button" className="session-log-collapsible-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <div className="session-log-collapsible-body">{children}</div>}
    </div>
  )
}

function ToolResultBlock({ block }: { block: ToolResultContent }) {
  const label = `도구 결과${block.is_error ? ' (오류)' : ''} · ${block.tool_use_id.slice(0, 12)}`
  return (
    <Collapsible label={label}>
      {typeof block.content === 'string' ? (
        <pre className="session-log-pre">{block.content}</pre>
      ) : (
        block.content.map((item, i) => {
          if (item.type === 'text') return <pre key={i} className="session-log-pre">{item.text}</pre>
          if (item.type === 'image') return <p key={i} className="session-log-note">[이미지]</p>
          return <p key={i} className="session-log-note">[도구 참조: {item.tool_name}]</p>
        })
      )}
    </Collapsible>
  )
}

function renderUserItem(item: string | UserMessageContent, key: number) {
  if (typeof item === 'string') {
    return item.trim() ? <p key={key} className="session-log-text">{item}</p> : null
  }
  switch (item.type) {
    case 'text':
      return item.text.trim() ? <p key={key} className="session-log-text">{item.text}</p> : null
    case 'tool_result':
      return <ToolResultBlock key={key} block={item} />
    case 'image':
      return <p key={key} className="session-log-note">[이미지 첨부]</p>
    case 'document':
      return <p key={key} className="session-log-note">[문서 첨부]</p>
    default:
      return null
  }
}

export function UserContent({ content }: { content: UserEntryContent }) {
  if (typeof content === 'string') {
    return content.trim() ? <p className="session-log-text">{content}</p> : null
  }
  return <>{content.map((item, i) => renderUserItem(item, i))}</>
}

function renderAssistantBlock(block: AssistantMessageContent, key: number) {
  switch (block.type) {
    case 'text':
      return block.text.trim() ? <p key={key} className="session-log-text">{block.text}</p> : null
    case 'thinking':
      return block.thinking.trim() ? (
        <Collapsible key={key} label="사고 과정">
          <p className="session-log-text session-log-thinking">{block.thinking}</p>
        </Collapsible>
      ) : null
    case 'tool_use':
      return (
        <Collapsible key={key} label={`🔧 ${block.name}`}>
          <pre className="session-log-pre">{JSON.stringify(block.input, null, 2)}</pre>
        </Collapsible>
      )
    case 'tool_result':
      return <ToolResultBlock key={key} block={block} />
    default:
      return null
  }
}

export function AssistantContent({ content }: { content: AssistantMessageContent[] }) {
  return <>{content.map((block, i) => renderAssistantBlock(block, i))}</>
}

// Re-declared here (rather than imported) since UserEntry['message']['content']
// isn't separately exported by the vendored schema module.
type UserEntryContent = string | (string | UserMessageContent)[]
