import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SidekickModel } from "../config.ts";
import type {
  AssistantTranscriptItem,
  SidekickRunStatus,
  SidekickViewState,
  ToolTranscriptItem,
  TranscriptItem,
  UserTranscriptItem,
  ViewStateListener,
} from "./types.ts";

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n");
  }
  return "";
}

function cloneItem(item: TranscriptItem): TranscriptItem {
  if (item.kind === "user") {
    return { ...item };
  }
  if (item.kind === "assistant") {
    return {
      ...item,
      message: {
        ...item.message,
        content: Array.isArray(item.message.content) ? [...item.message.content] : [],
      },
    };
  }
  return {
    ...item,
    args: item.args && typeof item.args === "object" ? { ...item.args } : item.args,
    result: item.result
      ? {
          ...item.result,
          content: Array.isArray(item.result.content) ? [...item.result.content] : [],
          details: item.result.details && typeof item.result.details === "object" ? { ...item.result.details } : item.result.details,
        }
      : undefined,
  };
}

export class TranscriptProjection {
  private status: SidekickRunStatus = "idle";
  private model?: SidekickModel;
  private activeActivity?: string;
  private tasks = 0;
  private usage?: Usage;
  private durationMs = 0;
  private items: TranscriptItem[] = [];
  private itemMap = new Map<string, TranscriptItem>();
  private toolMap = new Map<string, ToolTranscriptItem>();
  private toolArgsBuffers = new Map<string, string>();
  private listeners = new Set<ViewStateListener>();
  private currentAssistantItem?: AssistantTranscriptItem;
  private generation = 0;

  constructor(initial?: { model?: SidekickModel; tasks?: number }) {
    this.model = initial?.model;
    this.tasks = initial?.tasks ?? 0;
  }

  getGeneration(): number {
    return this.generation;
  }

  setGeneration(gen: number): void {
    this.generation = gen;
  }

  getSnapshot(): SidekickViewState {
    return {
      status: this.status,
      model: this.model ? { ...this.model } : undefined,
      activeActivity: this.activeActivity,
      tasks: this.tasks,
      usage: this.usage ? { ...this.usage } : undefined,
      durationMs: this.durationMs,
      items: this.items.map(cloneItem),
    };
  }

  subscribe(listener: ViewStateListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        // UI listeners cannot crash projection
      }
    }
  }

  setModel(model?: SidekickModel): void {
    this.model = model;
    this.notify();
  }

  setStatus(status: SidekickRunStatus): void {
    this.status = status;
    this.notify();
  }

  setTasks(tasks: number): void {
    this.tasks = tasks;
    this.notify();
  }

  setUsage(usage?: Usage): void {
    this.usage = usage;
    this.notify();
  }

  setDurationMs(durationMs: number): void {
    this.durationMs = durationMs;
    this.notify();
  }

  clear(): void {
    this.items = [];
    this.itemMap.clear();
    this.toolMap.clear();
    this.toolArgsBuffers.clear();
    this.currentAssistantItem = undefined;
    this.activeActivity = undefined;
    this.notify();
  }

  /**
   * Seed projection from branch entries of a session file.
   */
  seedFromEntries(entries: SessionEntry[]): void {
    this.clear();
    for (const entry of entries) {
      if (entry.type === "message") {
        const msg = entry.message;
        if (msg.role === "user") {
          const text = extractText(msg.content);
          if (text) {
            const userItem: UserTranscriptItem = {
              kind: "user",
              id: entry.id,
              text,
            };
            this.items.push(userItem);
            this.itemMap.set(userItem.id, userItem);
          }
        } else if (msg.role === "assistant") {
          const assistantMsg = msg as AssistantMessage;
          const assistantItem: AssistantTranscriptItem = {
            kind: "assistant",
            id: entry.id,
            message: { ...assistantMsg, content: [...assistantMsg.content] },
            isStreaming: false,
          };
          this.items.push(assistantItem);
          this.itemMap.set(assistantItem.id, assistantItem);

          for (const block of assistantMsg.content) {
            if (block.type === "toolCall") {
              const toolItem: ToolTranscriptItem = {
                kind: "tool",
                id: `${entry.id}-${block.id}`,
                toolCallId: block.id,
                toolName: block.name,
                args: block.arguments,
                argsComplete: true,
                executionStarted: true,
              };
              this.items.push(toolItem);
              this.itemMap.set(toolItem.id, toolItem);
              this.toolMap.set(block.id, toolItem);
            }
          }
        } else if (msg.role === "toolResult") {
          const toolCallId = msg.toolCallId;
          const toolItem = this.toolMap.get(toolCallId);
          if (toolItem) {
            toolItem.result = {
              content: msg.content as any,
              details: msg.details,
              isError: msg.isError ?? false,
            };
            toolItem.isPartial = false;
            toolItem.executionStarted = true;
          }
        }
      }
    }
    this.notify();
  }

  /**
   * Handle delta and authoritative events emitted over RPC.
   */
  handleEvent(event: JsonAgentSessionEvent): void {
    switch (event.type) {
      case "agent_start": {
        this.status = "running";
        this.activeActivity = undefined;
        this.notify();
        break;
      }

      case "message_start": {
        if (event.message.role === "user") {
          const text = extractText(event.message.content);
          const userItem: UserTranscriptItem = {
            kind: "user",
            id: randomUUID(),
            text,
          };
          this.items.push(userItem);
          this.itemMap.set(userItem.id, userItem);
          this.notify();
        } else if (event.message.role === "assistant") {
          const msg = event.message as AssistantMessage;
          const assistantItem: AssistantTranscriptItem = {
            kind: "assistant",
            id: randomUUID(),
            message: {
              ...msg,
              content: Array.isArray(msg.content) ? [...msg.content] : [],
              stopReason: msg.stopReason ?? "pending",
            },
            isStreaming: true,
          };
          this.currentAssistantItem = assistantItem;
          this.items.push(assistantItem);
          this.itemMap.set(assistantItem.id, assistantItem);
          this.notify();
        }
        break;
      }

      case "message_update": {
        if (event.usage) {
          this.usage = event.usage;
        }

        const me = event.assistantMessageEvent;
        if (!me) break;

        if (!this.currentAssistantItem) {
          const assistantItem: AssistantTranscriptItem = {
            kind: "assistant",
            id: randomUUID(),
            message: {
              role: "assistant",
              content: [],
              stopReason: "pending",
              api: "rpc",
              provider: this.model?.provider ?? "unknown",
              model: this.model?.model ?? "unknown",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              timestamp: Date.now(),
            },
            isStreaming: true,
          };
          this.currentAssistantItem = assistantItem;
          this.items.push(assistantItem);
          this.itemMap.set(assistantItem.id, assistantItem);
        }

        const msg = this.currentAssistantItem.message;
        const content = msg.content;
        const idx = (me as { contentIndex?: number }).contentIndex ?? 0;

        switch (me.type) {
          case "text_start": {
            content[idx] = { type: "text", text: "" };
            break;
          }
          case "text_delta": {
            if (!content[idx] || content[idx].type !== "text") {
              content[idx] = { type: "text", text: "" };
            }
            (content[idx] as TextContent).text += me.delta;
            break;
          }
          case "text_end": {
            content[idx] = { type: "text", text: me.content };
            break;
          }
          case "thinking_start": {
            content[idx] = { type: "thinking", thinking: "" };
            break;
          }
          case "thinking_delta": {
            if (!content[idx] || content[idx].type !== "thinking") {
              content[idx] = { type: "thinking", thinking: "" };
            }
            (content[idx] as ThinkingContent).thinking += me.delta;
            break;
          }
          case "thinking_end": {
            content[idx] = { type: "thinking", thinking: me.content };
            break;
          }
          case "toolcall_start": {
            const toolCall: ToolCall = {
              type: "toolCall",
              id: me.id,
              name: me.toolName,
              arguments: {},
            };
            content[idx] = toolCall;
            this.toolArgsBuffers.set(me.id, "");

            let toolItem = this.toolMap.get(me.id);
            if (!toolItem) {
              toolItem = {
                kind: "tool",
                id: randomUUID(),
                toolCallId: me.id,
                toolName: me.toolName,
                args: {},
                argsComplete: false,
                executionStarted: false,
                isPartial: true,
              };
              this.items.push(toolItem);
              this.itemMap.set(toolItem.id, toolItem);
              this.toolMap.set(me.id, toolItem);
            }
            break;
          }
          case "toolcall_delta": {
            const activeCall = content[idx];
            const callId = activeCall && activeCall.type === "toolCall" ? activeCall.id : undefined;
            if (callId) {
              const prev = this.toolArgsBuffers.get(callId) ?? "";
              const next = prev + me.delta;
              this.toolArgsBuffers.set(callId, next);
              try {
                const parsed = JSON.parse(next);
                if (parsed && typeof parsed === "object") {
                  const toolItem = this.toolMap.get(callId);
                  if (toolItem) {
                    toolItem.args = parsed;
                  }
                  if (activeCall && activeCall.type === "toolCall") {
                    activeCall.arguments = parsed;
                  }
                }
              } catch {
                // Incomplete JSON chunk, wait for next delta or toolcall_end
              }
            }
            break;
          }
          case "toolcall_end": {
            content[idx] = me.toolCall;
            this.toolArgsBuffers.delete(me.toolCall.id);
            const toolItem = this.toolMap.get(me.toolCall.id);
            if (toolItem) {
              toolItem.args = me.toolCall.arguments;
              toolItem.argsComplete = true;
            }
            break;
          }
        }

        this.notify();
        break;
      }

      case "message_end": {
        if (event.message.role === "assistant") {
          const authoritativeMsg = event.message as AssistantMessage;
          if (this.currentAssistantItem) {
            this.currentAssistantItem.message = authoritativeMsg;
            this.currentAssistantItem.isStreaming = false;
          }

          if (Array.isArray(authoritativeMsg.content)) {
            for (const block of authoritativeMsg.content) {
              if (block.type === "toolCall") {
                this.toolArgsBuffers.delete(block.id);
                let toolItem = this.toolMap.get(block.id);
                if (!toolItem) {
                  toolItem = {
                    kind: "tool",
                    id: randomUUID(),
                    toolCallId: block.id,
                    toolName: block.name,
                    args: block.arguments,
                    argsComplete: true,
                    executionStarted: true,
                  };
                  this.items.push(toolItem);
                  this.itemMap.set(toolItem.id, toolItem);
                  this.toolMap.set(block.id, toolItem);
                } else {
                  toolItem.args = block.arguments;
                  toolItem.argsComplete = true;
                }
              }
            }
          }

          this.currentAssistantItem = undefined;
          this.notify();
        }
        break;
      }

      case "tool_execution_start": {
        let toolItem = this.toolMap.get(event.toolCallId);
        if (!toolItem) {
          toolItem = {
            kind: "tool",
            id: randomUUID(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            argsComplete: true,
            executionStarted: true,
            isPartial: true,
          };
          this.items.push(toolItem);
          this.itemMap.set(toolItem.id, toolItem);
          this.toolMap.set(event.toolCallId, toolItem);
        } else {
          toolItem.toolName = event.toolName;
          if (event.args && Object.keys(event.args).length > 0) {
            toolItem.args = event.args;
          }
          toolItem.executionStarted = true;
          toolItem.argsComplete = true;
          toolItem.isPartial = true;
        }
        this.activeActivity = `Running ${event.toolName}`;
        this.notify();
        break;
      }

      case "tool_execution_update": {
        const toolItem = this.toolMap.get(event.toolCallId);
        if (toolItem) {
          toolItem.result = event.partialResult as any;
          toolItem.isPartial = true;
          toolItem.executionStarted = true;
        }
        this.notify();
        break;
      }

      case "tool_execution_end": {
        const toolItem = this.toolMap.get(event.toolCallId);
        if (toolItem) {
          toolItem.result = {
            content: event.result.content as any,
            details: event.result.details,
            isError: event.isError,
            durationMs: event.durationMs,
          };
          toolItem.isPartial = false;
          toolItem.executionStarted = true;
        }
        this.activeActivity = undefined;
        this.notify();
        break;
      }

      case "agent_settled": {
        this.status = event.aborted ? "cancelled" : "idle";
        this.activeActivity = undefined;
        if (this.currentAssistantItem) {
          this.currentAssistantItem.isStreaming = false;
          this.currentAssistantItem = undefined;
        }
        this.notify();
        break;
      }
    }
  }

  /**
   * Load cold session history directly from JSONL file anchored at leafId.
   */
  static async loadColdBranch(
    sessionFile: string,
    expectedSessionId: string,
    expectedCwd: string,
    leafId?: string | null
  ): Promise<SessionEntry[]> {
    let raw: string;
    try {
      raw = await readFile(sessionFile, "utf8");
    } catch (err) {
      throw new Error(`Cannot read session file ${sessionFile}: ${String(err)}`);
    }

    const lines = raw.trim().split("\n");
    if (lines.length === 0 || !lines[0].trim()) {
      throw new Error(`Session file ${sessionFile} is empty or missing header`);
    }

    let header: Record<string, unknown>;
    try {
      header = JSON.parse(lines[0]);
    } catch {
      throw new Error(`Corrupted session header in ${sessionFile}`);
    }

    if (header.type !== "session" || header.id !== expectedSessionId) {
      throw new Error(`Session file identity mismatch: expected ${expectedSessionId}, found ${header.id}`);
    }

    if (resolve(String(header.cwd)) !== resolve(expectedCwd)) {
      throw new Error(`Session workspace mismatch: expected ${expectedCwd}, found ${header.cwd}`);
    }

    // A null/undefined leaf represents an empty branch.
    if (!leafId) {
      return [];
    }

    const entryMap = new Map<string, SessionEntry>();
    const seenIds = new Set<string>();

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let entry: SessionEntry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        throw new Error(`Corrupted JSON entry at line ${i + 1} in ${sessionFile}`);
      }
      if (seenIds.has(entry.id)) {
        throw new Error(`Duplicate entry ID ${entry.id} found in ${sessionFile}`);
      }
      seenIds.add(entry.id);
      entryMap.set(entry.id, entry);
    }

    if (!entryMap.has(leafId)) {
      throw new Error(`Missing leaf entry ${leafId} in session file ${sessionFile}`);
    }

    const branchEntries: SessionEntry[] = [];
    let currentId: string | null | undefined = leafId;
    const visited = new Set<string>();

    while (currentId) {
      if (visited.has(currentId)) {
        throw new Error(`Cyclic entry chain in session at ${currentId}`);
      }
      visited.add(currentId);

      const entry = entryMap.get(currentId);
      if (!entry) {
        throw new Error(`Broken parent chain: entry ${currentId} missing in ${sessionFile}`);
      }
      branchEntries.unshift(entry);
      currentId = entry.parentId;
    }

    return branchEntries;
  }
}
