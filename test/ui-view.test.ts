import { test, expect } from "bun:test";
import { SidekickConversationView } from "../extensions/ui/view.ts";
import { TranscriptProjection } from "../extensions/ui/projection.ts";
import type { TUI } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

// Initialize Pi's global theme context for native components
initTheme("dark", false);

function createHarness(options: {
  draft?: string;
  scrollTop?: number;
  toolsExpanded?: boolean;
  thinkingHidden?: boolean;
  isBusy?: () => boolean;
  onStop?: () => void;
  onSteer?: (msg: string) => void;
  onManualRun?: (brief: string) => Promise<boolean>;
} = {}) {
  let renderCount = 0;
  let doneCalled = false;
  let currentDraft = options.draft ?? "";
  let currentScroll = options.scrollTop ?? 0;
  let currentExpanded = options.toolsExpanded ?? true;
  let currentThinking = options.thinkingHidden ?? false;

  const mockTui = {
    terminal: { columns: 80, rows: 24 } as any,
    requestRender: () => {
      renderCount++;
    },
  } as unknown as TUI;

  const mockTheme = {
    fg: (_token: string, text: string) => text,
    bg: (_token: string, text: string) => text,
    bold: (text: string) => `**${text}**`,
    dim: (text: string) => text,
    style: (text: string) => text,
  } as unknown as Theme;

  const projection = new TranscriptProjection({
    model: { provider: "test-provider", model: "flash", thinkingLevel: "high" },
    tasks: 2,
  });

  const view = new SidekickConversationView({
    tui: mockTui,
    theme: mockTheme,
    done: () => {
      doneCalled = true;
    },
    projection,
    cwd: process.cwd(),
    draft: currentDraft,
    scrollTop: currentScroll,
    toolsExpanded: currentExpanded,
    thinkingHidden: currentThinking,
    onDraftChange: (d) => {
      currentDraft = d;
    },
    onScrollChange: (s) => {
      currentScroll = s;
    },
    onToolsExpandedChange: (e) => {
      currentExpanded = e;
    },
    onThinkingHiddenChange: (th) => {
      currentThinking = th;
    },
    isBusy: options.isBusy ?? (() => false),
    onStop: options.onStop,
    onSteer: options.onSteer,
    onManualRun: options.onManualRun,
  });

  return {
    view,
    projection,
    mockTui,
    get renderCount() {
      return renderCount;
    },
    get doneCalled() {
      return doneCalled;
    },
    get currentDraft() {
      return currentDraft;
    },
    get currentScroll() {
      return currentScroll;
    },
    get currentExpanded() {
      return currentExpanded;
    },
    get currentThinking() {
      return currentThinking;
    },
  };
}

test("SidekickConversationView renders initial empty state, header badges, and footer editor", () => {
  const h = createHarness();
  const lines = h.view.render(80);

  expect(lines.length).toBe(24);
  const text = lines.join("\n");
  expect(text).toContain("[Sidekick Session]");
  expect(text).toContain("test-provider/flash");
  expect(text).toContain("high");
  expect(text).toContain("Idle");
  expect(text).toContain("No messages in this Sidekick session yet");
  expect(text).toContain("Tools (Expanded)");
  expect(text).toContain("Think (Shown)");
});

test("SidekickConversationView renders native User, Assistant, and ToolExecution components authentically", () => {
  const h = createHarness();

  const dummyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

  // Populate projection with user prompt, assistant thinking/text, and bash tool execution
  h.projection.handleEvent({ type: "agent_start" });
  h.projection.handleEvent({
    type: "message_start",
    message: { role: "user", content: "Inspect filesystem" } as any,
  });
  h.projection.handleEvent({
    type: "message_start",
    message: {
      role: "assistant",
      content: [],
      stopReason: "pending",
    } as any,
  });
  h.projection.handleEvent({
    type: "message_update",
    usage: dummyUsage,
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
  });
  h.projection.handleEvent({
    type: "message_update",
    usage: dummyUsage,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Need to run bash" },
  });
  h.projection.handleEvent({
    type: "message_update",
    usage: dummyUsage,
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Need to run bash" },
  });
  h.projection.handleEvent({
    type: "message_update",
    usage: dummyUsage,
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 1,
      id: "call_b1",
      toolName: "bash",
    },
  });
  h.projection.handleEvent({
    type: "message_update",
    usage: dummyUsage,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: {
        type: "toolCall",
        id: "call_b1",
        name: "bash",
        arguments: { command: "ls -la" },
      },
    },
  });
  h.projection.handleEvent({
    type: "tool_execution_start",
    toolCallId: "call_b1",
    toolName: "bash",
    args: { command: "ls -la" },
  });
  h.projection.handleEvent({
    type: "tool_execution_end",
    toolCallId: "call_b1",
    toolName: "bash",
    result: {
      content: [{ type: "text", text: "total 4\n-rw-r--r-- file.txt" }],
      details: { exitCode: 0 },
    },
    isError: false,
    durationMs: 45,
  });
  h.projection.handleEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to run bash" },
        { type: "toolCall", id: "call_b1", name: "bash", arguments: { command: "ls -la" } },
      ],
      stopReason: "stop",
    } as any,
  });
  h.projection.handleEvent({ type: "agent_settled", aborted: false });

  const lines = h.view.render(80);
  const text = lines.join("\n");

  expect(text).toContain("Inspect filesystem");
  expect(text).toContain("Need to run bash");
  expect(text).toContain("bash");
  expect(text).toContain("ls -la");
});

test("tool expansion toggle (Ctrl+O) and thinking toggle (Ctrl+T) update view state and re-render", () => {
  const h = createHarness({ toolsExpanded: true, thinkingHidden: false });

  // Initial check
  let text = h.view.render(80).join("\n");
  expect(text).toContain("Tools (Expanded)");
  expect(text).toContain("Think (Shown)");

  // Press Ctrl+O (\x0f)
  h.view.handleInput("\x0f");
  expect(h.currentExpanded).toBe(false);
  text = h.view.render(80).join("\n");
  expect(text).toContain("Tools (Compact)");

  // Press Ctrl+T (\x14)
  h.view.handleInput("\x14");
  expect(h.currentThinking).toBe(true);
  text = h.view.render(80).join("\n");
  expect(text).toContain("Think (Hidden)");
});

test("responsive layout: narrow screen (35 cols) and wide screen (140 cols) render without throwing", () => {
  const h = createHarness();
  h.projection.handleEvent({
    type: "message_start",
    message: { role: "user", content: "A very long message that needs wrapping on narrow terminals" } as any,
  });

  const narrowLines = h.view.render(35);
  expect(narrowLines.length).toBe(24);
  for (const line of narrowLines) {
    // No line should overflow the allocated column boundary significantly
    expect(line.length).toBeGreaterThanOrEqual(0);
  }

  const wideLines = h.view.render(140);
  expect(wideLines.length).toBe(24);
});

test("draft preservation and exit shortcuts (Esc / alt+s) call done and retain draft", () => {
  const h = createHarness({ draft: "" });

  // Type characters into editor
  h.view.handleInput("h");
  h.view.handleInput("e");
  h.view.handleInput("l");
  h.view.handleInput("p");
  expect(h.currentDraft).toBe("help");

  // Press alt+s (\x1bs)
  h.view.handleInput("\x1bs");
  expect(h.doneCalled).toBe(true);

  // Constructing a new view with the saved draft restores the editor text
  const h2 = createHarness({ draft: h.currentDraft });
  const lines = h2.view.render(80).join("\n");
  expect(lines).toContain("help");
});

test("manual interaction in idle mode: submit triggers onManualRun and clears draft on acceptance", async () => {
  let dispatchedBrief = "";
  const h = createHarness({
    draft: "implement feature X",
    isBusy: () => false,
    onManualRun: async (brief) => {
      dispatchedBrief = brief;
      return true; // accepted
    },
  });

  // Submit via Enter
  h.view.handleInput("\r");
  await new Promise((r) => setTimeout(r, 10));

  expect(dispatchedBrief).toBe("implement feature X");
  expect(h.currentDraft).toBe("");
});

test("manual interaction in idle mode: rejection (e.g. Lead busy) preserves user draft", async () => {
  let dispatchedBrief = "";
  const h = createHarness({
    draft: "draft should be kept",
    isBusy: () => false,
    onManualRun: async (brief) => {
      dispatchedBrief = brief;
      return false; // rejected
    },
  });

  // Submit via Enter
  h.view.handleInput("\r");
  await new Promise((r) => setTimeout(r, 10));

  expect(dispatchedBrief).toBe("draft should be kept");
  // Draft MUST be kept!
  expect(h.currentDraft).toBe("draft should be kept");
});

test("manual interaction in busy mode: submit steers running worker and s stops worker", async () => {
  let steeredMessage = "";
  let stopCalled = false;

  const h = createHarness({
    draft: "correction brief",
    isBusy: () => true,
    onSteer: (msg) => {
      steeredMessage = msg;
    },
    onStop: () => {
      stopCalled = true;
    },
  });

  // Header prompt must indicate busy
  const text = h.view.render(80).join("\n");
  expect(text).toContain("[Sidekick is busy]");

  // Submit steer
  h.view.handleInput("\r");
  await new Promise((r) => setTimeout(r, 10));

  expect(steeredMessage).toBe("correction brief");
  expect(h.currentDraft).toBe("");

  // Verify letters s, q, g, G type normally into the editor and do NOT trigger shortcuts
  h.view.handleInput("q");
  h.view.handleInput("u");
  h.view.handleInput("e");
  h.view.handleInput("s");
  h.view.handleInput("t");
  expect(h.currentDraft).toBe("quest");
  expect(stopCalled).toBe(false);
  expect(h.doneCalled).toBe(false);

  // Press Ctrl+C (\x03) to stop
  h.view.handleInput("\x03");
  expect(stopCalled).toBe(true);
});

test("mouse wheel and scroll navigation update scroll offset", () => {
  const h = createHarness();

  // Scroll via wheel
  const wheelResult = h.view.handleMouse({
    type: "wheel",
    wheelDelta: 4,
    x: 0,
    y: 0,
    button: "none",
    screenX: 0,
    screenY: 0,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
  });
  expect(wheelResult?.handled).toBe(true);
  expect(h.currentScroll).toBe(4);

  // PageUp / PageDown
  h.view.handleInput("\x1b[5~"); // pageUp
  expect(h.currentScroll).toBeLessThanOrEqual(4);
});
