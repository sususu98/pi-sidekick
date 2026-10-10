import type { KeybindingsManager, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  type Component,
  Editor,
  type Focusable,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  getSelectListTheme,
  type Theme,
  ToolExecutionComponent,
  type ToolRenderers,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { TranscriptProjection } from "./projection.ts";

export interface SidekickViewOptions {
  tui: TUI;
  theme: Theme;
  kb?: KeybindingsManager;
  done: () => void;
  projection: TranscriptProjection;
  cwd: string;
  draft?: string;
  scrollTop?: number;
  autoScroll?: boolean;
  toolsExpanded?: boolean;
  thinkingHidden?: boolean;
  onDraftChange?: (draft: string) => void;
  onScrollChange?: (scrollTop: number, autoScroll: boolean) => void;
  onToolsExpandedChange?: (expanded: boolean) => void;
  onThinkingHiddenChange?: (hidden: boolean) => void;
  isBusy: () => boolean;
  onStop?: () => Promise<void> | void;
  onSteer?: (message: string) => Promise<void> | void;
  onManualRun?: (brief: string) => Promise<boolean>;
}

export class SidekickConversationView implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private done: () => void;
  private projection: TranscriptProjection;
  private cwd: string;
  private editor: Editor;
  private toolDefs = new Map<string, ToolRenderers>();
  private componentMap = new Map<string, Component>();
  private unsubscribeProjection?: () => void;
  private toolsExpanded: boolean;
  private thinkingHidden: boolean;
  private scrollTop: number;
  private autoScroll: boolean;
  private options: SidekickViewOptions;
  private submitting = false;
  private disposed = false;

  constructor(options: SidekickViewOptions) {
    this.options = options;
    this.tui = options.tui;
    this.theme = options.theme;
    this.done = options.done;
    this.projection = options.projection;
    this.cwd = options.cwd;
    this.toolsExpanded = options.toolsExpanded ?? true;
    this.thinkingHidden = options.thinkingHidden ?? false;
    this.scrollTop = options.scrollTop ?? 0;
    this.autoScroll = options.autoScroll ?? true;

    // Initialize native tool definitions for full rendering
    this.toolDefs.set("bash", createBashToolDefinition(this.cwd) as unknown as ToolRenderers);
    this.toolDefs.set("write", createWriteToolDefinition(this.cwd) as unknown as ToolRenderers);
    this.toolDefs.set("edit", createEditToolDefinition(this.cwd) as unknown as ToolRenderers);
    this.toolDefs.set("read", createReadToolDefinition(this.cwd) as unknown as ToolRenderers);
    this.toolDefs.set("find", createFindToolDefinition(this.cwd) as unknown as ToolRenderers);
    this.toolDefs.set("grep", createGrepToolDefinition(this.cwd) as unknown as ToolRenderers);
    this.toolDefs.set("ls", createLsToolDefinition(this.cwd) as unknown as ToolRenderers);

    // Native multi-line Editor from pi-tui
    this.editor = new Editor(this.tui, {
      borderColor: (str: string) => this.theme.fg("border", str),
      selectList: getSelectListTheme(),
    });
    this.editor.focused = true;
    if (options.draft) {
      this.editor.setText(options.draft);
    }
    this.editor.onChange = (text: string) => {
      this.options.onDraftChange?.(text);
    };

    this.editor.onSubmit = async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || this.submitting) return;
      this.submitting = true;

      try {
        if (this.options.isBusy()) {
          await this.options.onSteer?.(trimmed);
          this.editor.setText("");
          this.options.onDraftChange?.("");
        } else {
          const accepted = await this.options.onManualRun?.(trimmed);
          if (accepted) {
            this.editor.setText("");
            this.options.onDraftChange?.("");
          } else {
            this.editor.setText(trimmed);
            this.options.onDraftChange?.(trimmed);
          }
        }
      } catch {
        this.editor.setText(trimmed);
        this.options.onDraftChange?.(trimmed);
      } finally {
        this.submitting = false;
        if (!this.disposed) this.tui.requestRender();
      }
    };

    this.unsubscribeProjection = this.projection.subscribe(() => {
      if (!this.disposed) this.tui.requestRender();
    });
  }

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeProjection?.();
    this.unsubscribeProjection = undefined;
    this.componentMap.clear();
  }

  invalidate(): void {
    this.editor.invalidate();
    for (const comp of this.componentMap.values()) {
      comp.invalidate?.();
    }
  }

  private scrollBy(delta: number): void {
    if (delta < 0) {
      this.autoScroll = false;
    }
    this.scrollTop = Math.max(0, this.scrollTop + delta);
    this.options.onScrollChange?.(this.scrollTop, this.autoScroll);
    if (!this.disposed) this.tui.requestRender();
  }

  private scrollToStart(): void {
    this.autoScroll = false;
    this.scrollTop = 0;
    this.options.onScrollChange?.(this.scrollTop, this.autoScroll);
    if (!this.disposed) this.tui.requestRender();
  }

  private scrollToEnd(): void {
    this.autoScroll = true;
    this.options.onScrollChange?.(this.scrollTop, this.autoScroll);
    if (!this.disposed) this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta !== undefined) {
      this.scrollBy(event.wheelDelta);
      return { handled: true };
    }
    return this.editor.handleMouse(event);
  }

  handleInput(data: string): void {
    // alt+s toggles view close and return to Lead
    if (data === "\x1bs" || data === "escape+s") {
      this.done();
      return;
    }

    // escape returns to Lead
    if (matchesKey(data, "escape")) {
      this.done();
      return;
    }

    // Ctrl+C stops running Sidekick task
    if (matchesKey(data, "ctrl+c") || data === "\x03") {
      if (this.options.isBusy()) {
        void (async () => {
          try {
            await this.options.onStop?.();
          } catch {
            // Stop caught
          }
        })();
        return;
      }
    }

    // Ctrl+O toggles tool output expansion
    if (matchesKey(data, "ctrl+o") || data === "\x0f") {
      this.toolsExpanded = !this.toolsExpanded;
      this.options.onToolsExpandedChange?.(this.toolsExpanded);
      for (const comp of this.componentMap.values()) {
        if (comp instanceof ToolExecutionComponent) {
          comp.setExpanded(this.toolsExpanded);
        }
      }
      if (!this.disposed) this.tui.requestRender();
      return;
    }

    // Ctrl+T toggles thinking visibility
    if (matchesKey(data, "ctrl+t") || data === "\x14") {
      this.thinkingHidden = !this.thinkingHidden;
      this.options.onThinkingHiddenChange?.(this.thinkingHidden);
      for (const comp of this.componentMap.values()) {
        if (comp instanceof AssistantMessageComponent) {
          comp.setHideThinkingBlock(this.thinkingHidden);
        }
      }
      if (!this.disposed) this.tui.requestRender();
      return;
    }

    // Page scrolling keys
    if (matchesKey(data, "pageUp")) {
      this.scrollBy(-5);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollBy(5);
      return;
    }
    if (matchesKey(data, "ctrl+home")) {
      this.scrollToStart();
      return;
    }
    if (matchesKey(data, "ctrl+end")) {
      this.scrollToEnd();
      return;
    }

    // When editor is empty, up and down arrows scroll the transcript
    if (this.editor.getText() === "") {
      if (matchesKey(data, "up")) {
        this.scrollBy(-1);
        return;
      }
      if (matchesKey(data, "down")) {
        this.scrollBy(1);
        return;
      }
    }

    // All letters, punctuation, spaces, and multi-line keys go straight into the editor!
    this.editor.handleInput(data);
    if (!this.disposed) this.tui.requestRender();
  }

  render(width: number): string[] {
    const termRows = this.tui.terminal?.rows ?? 24;
    const safeWidth = width;
    const th = this.theme;
    const state = this.projection.getSnapshot();

    // 1. Build Header
    const isRunning = state.status === "running" || this.options.isBusy();
    const statusIcon = isRunning
      ? th.fg("warning", "● Running")
      : state.status === "error"
        ? th.fg("error", "✗ Error")
        : state.status === "cancelled"
          ? th.fg("muted", "⊘ Cancelled")
          : th.fg("success", "✓ Idle");

    const modelTag = state.model ? `${state.model.provider}/${state.model.model}` : "none";
    const thinkTag = state.model?.thinkingLevel ? ` · ${state.model.thinkingLevel}` : "";
    const activeAct = state.activeActivity ? ` · ${state.activeActivity}` : "";
    const tokenInfo = state.usage ? ` · ${state.usage.totalTokens} tokens` : "";

    const headerLine1 = `${th.bold(th.fg("accent", " [Sidekick Session] "))}${statusIcon} · ${th.bold(modelTag)}${thinkTag}${activeAct}${tokenInfo}`;
    const toolsLabel = this.toolsExpanded ? "Expanded" : "Compact";
    const thinkLabel = this.thinkingHidden ? "Hidden" : "Shown";
    const headerLine2 = th.fg(
      "dim",
      ` Esc: Lead | Enter: Send | C-o: Tools (${toolsLabel}) | C-t: Think (${thinkLabel}) | C-c: Stop`
    );
    const divider = th.fg("border", "─".repeat(safeWidth));

    const headerLines = [
      truncateToWidth(headerLine1, safeWidth, "...", true),
      truncateToWidth(headerLine2, safeWidth, "...", true),
      divider,
    ];

    // 2. Build Editor (Footer)
    const busy = this.options.isBusy();
    const promptLabel = busy
      ? th.fg("warning", " [Sidekick is busy] Enter will steer task:")
      : th.fg("accent", " [Sidekick is idle] Enter will dispatch task:");

    const editorLines = this.editor.render(safeWidth);
    const footerLines = [
      divider,
      truncateToWidth(promptLabel, safeWidth, "...", true),
      ...editorLines.map((line) => truncateToWidth(line, safeWidth, "...", true)),
    ];

    // 3. Transcript Body Lines
    const chromeCount = headerLines.length + footerLines.length;
    const viewportHeight = Math.max(1, termRows - chromeCount);

    const bodyLines: string[] = [];
    const items = state.items;

    // Prune stale components not in current items
    const activeIds = new Set(items.map((i) => i.id));
    for (const id of this.componentMap.keys()) {
      if (!activeIds.has(id)) {
        this.componentMap.delete(id);
      }
    }

    if (items.length === 0) {
      bodyLines.push("");
      bodyLines.push(truncateToWidth(th.fg("muted", "  (No messages in this Sidekick session yet.)"), safeWidth, "...", true));
      bodyLines.push(truncateToWidth(th.fg("dim", "  Type a brief below and press Enter to start working with Sidekick."), safeWidth, "...", true));
      bodyLines.push("");
    } else {
      for (const item of items) {
        if (item.kind === "user") {
          let comp = this.componentMap.get(item.id);
          if (!comp) {
            comp = new UserMessageComponent(item.text, getMarkdownTheme());
            this.componentMap.set(item.id, comp);
          }
          bodyLines.push(...comp.render(safeWidth));
          bodyLines.push("");
        } else if (item.kind === "assistant") {
          let comp = this.componentMap.get(item.id) as AssistantMessageComponent | undefined;
          if (!comp) {
            comp = new AssistantMessageComponent(item.message, this.thinkingHidden, getMarkdownTheme());
            this.componentMap.set(item.id, comp);
          } else {
            comp.setHideThinkingBlock(this.thinkingHidden);
            comp.updateContent(item.message, item.isStreaming);
          }
          bodyLines.push(...comp.render(safeWidth));
          bodyLines.push("");
        } else if (item.kind === "tool") {
          let comp = this.componentMap.get(item.id) as ToolExecutionComponent | undefined;
          if (!comp) {
            comp = new ToolExecutionComponent(
              item.toolName,
              item.toolCallId,
              item.args,
              { outputPad: 1 },
              this.toolDefs.get(item.toolName),
              this.tui,
              this.cwd
            );
            comp.setExpanded(this.toolsExpanded);
            if (item.executionStarted) comp.markExecutionStarted();
            if (item.argsComplete) comp.setArgsComplete();
            if (item.result) {
              comp.updateResult(item.result, item.isPartial ?? false);
            }
            this.componentMap.set(item.id, comp);
          } else {
            comp.updateArgs(item.args);
            if (item.executionStarted) comp.markExecutionStarted();
            if (item.argsComplete) comp.setArgsComplete();
            if (item.result) {
              comp.updateResult(item.result, item.isPartial ?? false);
            }
            comp.setExpanded(this.toolsExpanded);
          }
          bodyLines.push(...comp.render(safeWidth));
          bodyLines.push("");
        }
      }
    }

    const totalBody = bodyLines.length;
    const maxScroll = Math.max(0, totalBody - viewportHeight);

    if (this.autoScroll) {
      this.scrollTop = maxScroll;
    } else {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
      if (this.scrollTop >= maxScroll) {
        this.autoScroll = true;
      }
    }

    const visibleBody = bodyLines.slice(this.scrollTop, this.scrollTop + viewportHeight);
    while (visibleBody.length < viewportHeight) {
      visibleBody.push("");
    }

    const allOutput = [...headerLines, ...visibleBody, ...footerLines];
    // Guarantee total height never exceeds termRows
    return allOutput.slice(0, termRows);
  }
}
