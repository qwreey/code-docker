// Thin typing/parsing layer over the vendored conversation-schema module
// (see webmanager/.claude/session-log-plan.md) — everything that actually
// knows the JSONL entry shape lives in src/vendor/claude-conversation-schema,
// this file just re-derives the few types the chat renderer needs and wraps
// a per-line safeParse so a malformed/future-format line degrades to `null`
// instead of throwing, matching the backend's own per-line degrade
// convention.
import type { z } from 'zod'
import { ConversationSchema, type Conversation } from '../../../vendor/claude-conversation-schema/index.ts'
import type { TextContentSchema } from '../../../vendor/claude-conversation-schema/content/TextContentSchema.ts'
import type { ThinkingContentSchema } from '../../../vendor/claude-conversation-schema/content/ThinkingContentSchema.ts'
import type { ToolUseContentSchema } from '../../../vendor/claude-conversation-schema/content/ToolUseContentSchema.ts'
import type { ToolResultContentSchema } from '../../../vendor/claude-conversation-schema/content/ToolResultContentSchema.ts'
import type { UserMessageContent } from '../../../vendor/claude-conversation-schema/message/UserMessageSchema.ts'
import type { AssistantMessageContent } from '../../../vendor/claude-conversation-schema/message/AssistantMessageSchema.ts'

export type UserEntry = Extract<Conversation, { type: 'user' }>
export type AssistantEntry = Extract<Conversation, { type: 'assistant' }>

export type TextContent = z.infer<typeof TextContentSchema>
export type ThinkingContent = z.infer<typeof ThinkingContentSchema>
export type ToolUseContent = z.infer<typeof ToolUseContentSchema>
export type ToolResultContent = z.infer<typeof ToolResultContentSchema>

export type { UserMessageContent, AssistantMessageContent }

// isNoiseUserEntry recognizes the `<command-name>...`/`<local-command-
// stdout>...` wrapper text Claude Code's CLI inserts for slash-command
// invocations. Only the surrounding `<local-command-caveat>` wrapper
// message carries isMeta:true (already filtered separately) — the
// command-name/stdout entries themselves don't, so without this check
// they'd render as if they were real conversation turns.
export function isNoiseUserEntry(entry: UserEntry): boolean {
  const content = entry.message.content
  const text = typeof content === 'string' ? content : ''
  return (
    text.startsWith('<command-name>') ||
    text.startsWith('<local-command-stdout>') ||
    text.startsWith('<local-command-stderr>')
  )
}

// parseConversationLine parses one raw JSONL line into a typed Conversation
// entry, or null if it's not valid JSON or doesn't match any known entry
// shape (a future Claude Code version adding a new entry type, for
// instance) — the caller skips nulls rather than failing the whole
// transcript render.
export function parseConversationLine(line: string): Conversation | null {
  if (!line) return null
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return null
  }
  const result = ConversationSchema.safeParse(json)
  return result.success ? result.data : null
}
