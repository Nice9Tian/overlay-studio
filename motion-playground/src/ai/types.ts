export type AiProvider = "claude" | "agy" | "codex";

export interface ProviderInfo {
  id: AiProvider;
  label: string;
  available: boolean;
  version?: string;
  path?: string;
  note?: string;
}

export interface SttInfo {
  engine: string;
  available: boolean;
  hint?: string;
}

export type RunEvent =
  | { type: "run"; runId: string }
  | { type: "session"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; input?: unknown }
  | { type: "tool_result"; name: string; ok: boolean; summary?: string }
  | { type: "status"; text: string }
  | { type: "done"; sessionId?: string; usage?: unknown }
  | { type: "error"; message: string };

export interface ChatAttachment {
  url: string;
  name: string;
  kind: "video" | "srt" | "json" | "other";
  text?: string;
  durationSec?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: ChatAttachment[];
  tools?: {
    name: string;
    input?: unknown;
    ok?: boolean;
    summary?: string;
    expanded?: boolean;
  }[];
  statuses?: string[];
  error?: string;
  pending?: boolean;
}
