// Vendored from https://github.com/d-kimuson/claude-code-viewer
// (MIT License), commit 3c8eb62f4edbd700055c63f361078122d53339b2,
// path src/lib/conversation-schema/ — unmodified except for this notice.
// Not published as a standalone npm package, so this is a manual copy, not
// a real dependency; see webmanager/.claude/session-log-plan.md for why and
// how to re-sync. Models Claude Code's undocumented ~/.claude/projects
// session transcript JSONL schema.
import { z } from "zod";
import { AgentNameEntrySchema } from "./entry/AgentNameEntrySchema.ts";
import { AgentSettingEntrySchema } from "./entry/AgentSettingEntrySchema.ts";
import { AiTitleEntrySchema } from "./entry/AiTitleEntrySchema.ts";
import { type AssistantEntry, AssistantEntrySchema } from "./entry/AssistantEntrySchema.ts";
import { AttachmentEntrySchema } from "./entry/AttachmentEntrySchema.ts";
import { CustomTitleEntrySchema } from "./entry/CustomTitleEntrySchema.ts";
import { FileHistorySnapshotEntrySchema } from "./entry/FileHIstorySnapshotEntrySchema.ts";
import { LastPromptEntrySchema } from "./entry/LastPromptEntrySchema.ts";
import { PermissionModeEntrySchema } from "./entry/PermissionModeEntrySchema.ts";
import { PrLinkEntrySchema } from "./entry/PrLinkEntrySchema.ts";
import { ProgressEntrySchema } from "./entry/ProgressEntrySchema.ts";
import { QueueOperationEntrySchema } from "./entry/QueueOperationEntrySchema.ts";
import { SummaryEntrySchema } from "./entry/SummaryEntrySchema.ts";
import { type SystemEntry, SystemEntrySchema } from "./entry/SystemEntrySchema.ts";
import { type UserEntry, UserEntrySchema } from "./entry/UserEntrySchema.ts";

export const ConversationSchema = z.union([
  UserEntrySchema,
  AssistantEntrySchema,
  SummaryEntrySchema,
  SystemEntrySchema,
  FileHistorySnapshotEntrySchema,
  QueueOperationEntrySchema,
  ProgressEntrySchema,
  CustomTitleEntrySchema,
  AiTitleEntrySchema,
  AgentNameEntrySchema,
  AgentSettingEntrySchema,
  PermissionModeEntrySchema,
  PrLinkEntrySchema,
  LastPromptEntrySchema,
  AttachmentEntrySchema,
]);

export type Conversation = z.infer<typeof ConversationSchema>;
export type SidechainConversation = UserEntry | AssistantEntry | SystemEntry;
