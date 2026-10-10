import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SidekickModel } from "../config.ts";

export type SidekickRunStatus = "idle" | "running" | "error" | "cancelled";

export interface UserTranscriptItem {
  kind: "user";
  id: string;
  text: string;
}

export interface AssistantTranscriptItem {
  kind: "assistant";
  id: string;
  message: AssistantMessage;
  isStreaming?: boolean;
}

export interface ToolTranscriptItem {
  kind: "tool";
  id: string;
  toolCallId: string;
  toolName: string;
  args: any;
  argsComplete?: boolean;
  executionStarted?: boolean;
  result?: {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: any;
    isError: boolean;
    durationMs?: number;
  };
  isPartial?: boolean;
}

export type TranscriptItem = UserTranscriptItem | AssistantTranscriptItem | ToolTranscriptItem;

export interface SidekickViewState {
  status: SidekickRunStatus;
  model?: SidekickModel;
  activeActivity?: string;
  tasks: number;
  usage?: Usage;
  durationMs: number;
  items: TranscriptItem[];
}

export type ViewStateListener = (state: SidekickViewState) => void;
