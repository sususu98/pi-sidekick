import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptProjection } from "../extensions/ui/projection.ts";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

const dummyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("RPC stream reconstruction: delta-only text and thinking stream without duplication or token loss", () => {
  const projection = new TranscriptProjection({
    model: { provider: "test-provider", model: "test-model", thinkingLevel: "high" },
  });

  const events: JsonAgentSessionEvent[] = [
    { type: "agent_start" },
    {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        stopReason: "pending",
        api: "rpc",
        provider: "test-provider",
        model: "test-model",
        timestamp: Date.now(),
      } as any,
    },
    // Thinking stream
    {
      type: "message_update",
      usage: dummyUsage,
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    },
    {
      type: "message_update",
      usage: dummyUsage,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Deep " },
    },
    {
      type: "message_update",
      usage: dummyUsage,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reflection." },
    },
    {
      type: "message_update",
      usage: dummyUsage,
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Deep reflection." },
    },
    // Text stream
    {
      type: "message_update",
      usage: dummyUsage,
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    },
    {
      type: "message_update",
      usage: dummyUsage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hello " },
    },
    {
      type: "message_update",
      usage: dummyUsage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "world!" },
    },
    {
      type: "message_update",
      usage: dummyUsage,
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Hello world!" },
    },
    // Authoritative message_end
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Deep reflection." },
          { type: "text", text: "Hello world!" },
        ],
        stopReason: "stop",
        api: "rpc",
        provider: "test-provider",
        model: "test-model",
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      },
    },
    { type: "agent_settled", aborted: false },
  ];

  for (const event of events) {
    projection.handleEvent(event);
  }

  const snap = projection.getSnapshot();
  expect(snap.status).toBe("idle");
  expect(snap.items.length).toBe(1);

  const item = snap.items[0];
  expect(item.kind).toBe("assistant");
  if (item.kind === "assistant") {
    expect(item.isStreaming).toBe(false);
    expect(item.message.content.length).toBe(2);
    expect((item.message.content[0] as any).thinking).toBe("Deep reflection.");
    expect((item.message.content[1] as any).text).toBe("Hello world!");
  }
});

test("RPC stream reconstruction: tool calls buffer toolcall_delta and end with authoritative arguments", () => {
  const projection = new TranscriptProjection();

  const events: JsonAgentSessionEvent[] = [
    { type: "agent_start" },
    {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        stopReason: "pending",
      } as any,
    },
    {
      type: "message_update",
      usage: dummyUsage,
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        id: "call_bash_1",
        toolName: "bash",
      },
    },
    // Streaming arguments delta
    {
      type: "message_update",
      usage: dummyUsage,
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "{\"command\":",
      },
    },
    {
      type: "message_update",
      usage: dummyUsage,
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "\"echo 'building'\"}",
      },
    },
    {
      type: "message_update",
      usage: dummyUsage,
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          id: "call_bash_1",
          name: "bash",
          arguments: { command: "echo 'building'" },
        },
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: "call_bash_1",
      toolName: "bash",
      args: { command: "echo 'building'" },
    },
    {
      type: "tool_execution_update",
      toolCallId: "call_bash_1",
      toolName: "bash",
      args: { command: "echo 'building'" },
      partialResult: {
        content: [{ type: "text", text: "building...\n" }],
        details: {},
      },
    },
    {
      type: "tool_execution_end",
      toolCallId: "call_bash_1",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "building... done\n" }],
        details: { exitCode: 0 },
      },
      isError: false,
      durationMs: 150,
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bash_1",
            name: "bash",
            arguments: { command: "echo 'building'" },
          },
        ],
        stopReason: "toolUse",
      } as any,
    },
    { type: "agent_settled", aborted: false },
  ];

  for (const event of events) {
    projection.handleEvent(event);
  }

  const snap = projection.getSnapshot();
  expect(snap.status).toBe("idle");
  expect(snap.items.length).toBe(2);

  const toolItem = snap.items.find((i) => i.kind === "tool");
  expect(toolItem).toBeDefined();
  if (toolItem && toolItem.kind === "tool") {
    expect(toolItem.toolName).toBe("bash");
    expect(toolItem.args.command).toBe("echo 'building'");
    expect(toolItem.argsComplete).toBe(true);
    expect(toolItem.executionStarted).toBe(true);
    expect(toolItem.isPartial).toBe(false);
    expect(toolItem.result?.content[0]?.text).toBe("building... done\n");
    expect(toolItem.result?.isError).toBe(false);
    expect(toolItem.result?.durationMs).toBe(150);
  }

  // Verify immutability: mutating snap.items does not alter projection internal items
  (snap.items as any).length = 0;
  expect(projection.getSnapshot().items.length).toBe(2);
});

test("cold session loading from JSONL: validates identity, isolates active branch, excludes future branch entries, handles empty branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-cold-test-"));
  const sessionFile = join(root, "session.jsonl");
  const sessionId = "01948833-2222-7777-8888-000000000001";

  try {
    const records = [
      { type: "session", version: 1, id: sessionId, timestamp: "2026-10-10T00:00:00.000Z", cwd: root },
      { id: "e1", parentId: null, type: "message", message: { role: "user", content: "Brief 1" } },
      { id: "e2", parentId: "e1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Response 1" }] } },
      { id: "e3", parentId: "e2", type: "message", message: { role: "user", content: "Branch A text" } },
      { id: "e4", parentId: "e2", type: "message", message: { role: "user", content: "Branch B text" } },
    ];

    await writeFile(sessionFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    // 1. Loading with leaf "e3" must ONLY include e1, e2, e3 (excludes e4)
    const branchA = await TranscriptProjection.loadColdBranch(sessionFile, sessionId, root, "e3");
    expect(branchA.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);

    // 2. Loading with leaf "e4" must include e1, e2, e4 (excludes e3)
    const branchB = await TranscriptProjection.loadColdBranch(sessionFile, sessionId, root, "e4");
    expect(branchB.map((e) => e.id)).toEqual(["e1", "e2", "e4"]);

    // 3. Null leaf represents an empty branch -> returns empty array
    const emptyBranch = await TranscriptProjection.loadColdBranch(sessionFile, sessionId, root, null);
    expect(emptyBranch).toEqual([]);

    // 4. Missing leaf must throw error
    await expect(TranscriptProjection.loadColdBranch(sessionFile, sessionId, root, "nonexistent-leaf")).rejects.toThrow("Missing leaf entry");

    // 5. Identity mismatch must reject
    await expect(TranscriptProjection.loadColdBranch(sessionFile, "wrong-session-id", root, "e3")).rejects.toThrow("identity mismatch");

    // 6. Cwd mismatch must reject
    await expect(TranscriptProjection.loadColdBranch(sessionFile, sessionId, "/different/cwd", "e3")).rejects.toThrow("workspace mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
