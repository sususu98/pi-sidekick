import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { writeSync } from "node:fs";
import lockfile from "proper-lockfile";
import { Type } from "typebox";
import { createLocalBashOperations, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, parseConfig, parseModelSpec, sameModel, type SidekickConfig } from "./config.ts";
import { CHECKPOINT_TYPE, PersistentWorker, restoreCheckpoint } from "./worker.ts";
import { collectUsage, totalUsage } from "./usage.ts";

const CONFIG_TYPE = "pi-sidekick.config.v1";
export default function sidekickExtension(pi: ExtensionAPI): void {
  let config: SidekickConfig = { ...DEFAULT_CONFIG, providerExtensions: [] };
  let worker: PersistentWorker | undefined;
  let configurationError: string | undefined;
  let unsafeLead: Error | undefined;
  const fatalStorageFailure = (): never => {
    // Native appendEntry mutates the in-memory tree before writing disk. There
    // is no public rollback API; returning to the agent could persist orphaned
    // children of an unsaved entry. Fail-stop ONLY after worker cleanup.
    try { writeSync(2, "pi-sidekick: fatal Lead persistence failure. Worker stopped. Repair storage and resume the last valid persisted session. " + String(unsafeLead) + "\n"); }
    finally { process.exit(1); }
  };
  const append = (type: string, data: unknown, insideHandoff = false) => {
    if (unsafeLead) { if (!insideHandoff) fatalStorageFailure(); throw unsafeLead; }
    try { pi.appendEntry(type, data); }
    catch (error) {
      unsafeLead = new Error("Lead session append failed: " + String(error));
      if (!insideHandoff) fatalStorageFailure();
      throw unsafeLead;
    }
  };
  const writerLeases = new Map<string, () => Promise<void>>();
  const releaseWriters = async () => {
    const leases = [...writerLeases.values()]; writerLeases.clear();
    await Promise.all(leases.map(async release => { try { await release(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERELEASED") throw error; } }));
  };

  const activate = () => {
    const tools = pi.getActiveTools().filter(name => name !== "sidekick");
    if (config.enabled && !configurationError) tools.push("sidekick");
    pi.setActiveTools(tools);
  };
  const createWorker = (ctx: ExtensionContext) => new PersistentWorker({
    cwd: ctx.cwd, owner: ctx.sessionManager.getSessionId(),
    sessionDir: join(ctx.sessionManager.getSessionDir(), "sidekick", ctx.sessionManager.getSessionId()),
    config, checkpoint: restoreCheckpoint(ctx.sessionManager.getBranch()),
    save: checkpoint => append(CHECKPOINT_TYPE, checkpoint, true),
  });
  const start = async (ctx: ExtensionContext, navigating = false) => {
    await worker?.stop(); await releaseWriters(); worker = undefined; configurationError = undefined;
    try {
      const saved = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === CONFIG_TYPE);
      config = saved?.type === "custom" ? parseConfig(saved.data) : await loadConfig(ctx.cwd);
      // A running checkpoint reached by /tree is historical, not crash recovery.
      // Persist this distinction so /reload before the next handoff cannot adopt
      // the Worker's future history as an interrupted current task.
      const checkpoint = restoreCheckpoint(ctx.sessionManager.getBranch());
      if (navigating && checkpoint?.status === "running") append(CHECKPOINT_TYPE, { ...checkpoint, status: "cancelled" });
      worker = createWorker(ctx);
    } catch (error) {
      configurationError = String(error); config = { ...DEFAULT_CONFIG, providerExtensions: [] };
      ctx.ui.notify("Sidekick disabled: " + configurationError, "error");
    }
    activate();
    ctx.ui.setStatus("pi-sidekick", config.enabled ? "Sidekick · idle" : undefined);
  };
  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_tree", (_event, ctx) => start(ctx, true));
  pi.on("agent_settled", async () => { await releaseWriters(); });
  pi.on("session_shutdown", async () => { try { await worker?.stop(); } finally { worker = undefined; await releaseWriters(); } });

  // The Lead may still read evidence or make critical edits while the Worker is
  // idle. During execution, block potentially mutating sibling/nested tools.
  // This is a cooperative concurrency guard, not an operating-system sandbox.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "sidekick") return;
    const readOnly = ["read", "grep", "find", "ls"].includes(event.toolName) || pi.getAllTools().find(tool => tool.name === event.toolName)?.annotations?.readOnlyHint === true;
    if (readOnly) return;
    if (worker?.busy) return { block: true, reason: "Sidekick owns the workspace writer. Wait, cancel, or steer it first." };
    // Nested calls inherit their parent's lease; no self-deadlock for codemode.
    if ([...writerLeases.keys()].some(id => event.toolCallId.startsWith(id + "/"))) return;
    await mkdir(join(ctx.cwd, ".pi"), { recursive: true });
    try {
      const release = await lockfile.lock(join(ctx.cwd, ".pi", "sidekick-writer"), { realpath: false, stale: 10_000, update: 2000, retries: 0, onCompromised: () => ctx.abort() });
      writerLeases.set(event.toolCallId, release);
    } catch (error) {
      return { block: true, reason: "Workspace writer is owned by another Lead/Sidekick: " + String(error) };
    }
  });
  pi.on("tool_result", async (event) => {
    const release = writerLeases.get(event.toolCallId);
    if (!release) return;
    writerLeases.delete(event.toolCallId);
    try { await release(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERELEASED") throw error; }
  });

  pi.on("user_bash", (_event, ctx) => {
    if (worker?.busy) throw new Error("Sidekick owns the workspace writer. Cancel or wait before running a shell command.");
    const local = createLocalBashOperations();
    return { operations: { exec: async (command, cwd, options) => {
      await mkdir(join(ctx.cwd, ".pi"), { recursive: true });
      const controller = new AbortController();
      let release: () => Promise<void>;
      try {
        release = await lockfile.lock(join(ctx.cwd, ".pi", "sidekick-writer"), { realpath: false, stale: 10_000, update: 2000, retries: 0, onCompromised: error => controller.abort(error) });
      } catch (error) { throw new Error("Workspace writer is owned by another Lead/Sidekick: " + String(error)); }
      try { return await local.exec(command, cwd, { ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal }); }
      finally { try { await release(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERELEASED") throw error; } }
    } } };
  });

  pi.registerTool({
    name: "sidekick", label: "Persistent Sidekick", exposure: "model-only", defaultActive: false, executionMode: "sequential",
    description: "Send a bounded implementation, exploration or verification brief to your one persistent Sidekick session. It retains context across handoffs and returns a final report for your review. Synchronous: only one task can run at a time.",
    promptSnippet: "Delegate bounded execution to the persistent Sidekick; review its final report.",
    promptGuidelines: [
      "You are the Lead: plan, decide, review and communicate with the user. Delegate hands-on execution through sidekick, with scope, constraints and acceptance criteria.",
      "The Sidekick retains its own history. Send follow-up feedback to the same tool, not a new disposable agent. Do not spawn other agents unless the user asks.",
      "Do not edit/run mutating tools concurrently with Sidekick. You may inspect necessary evidence and perform critical edits when it is idle.",
      "Review actual changes and verification evidence before declaring success. If a handoff is interrupted, files may already have changed: never blindly repeat it.",
    ],
    annotations: { readOnlyHint: false, openWorldHint: true },
    parameters: Type.Object({
      brief: Type.String({ minLength: 1, description: "Goal, scope, decided interfaces, and necessary context for this task" }),
      constraints: Type.Optional(Type.String({ description: "Restrictions and decisions the Sidekick must not change" })),
      acceptance: Type.Optional(Type.String({ description: "Checks/results required for Lead review" })),
    }),
    async execute(_id, task, signal, onUpdate, ctx) {
      if (configurationError) throw new Error(configurationError);
      if (!config.enabled || !config.sidekick || !worker) throw new Error("Configure with /sidekick model provider/model-id high, then enable with /sidekick on");
      const model = ctx.modelRegistry.find(config.sidekick.provider, config.sidekick.model);
      if (!model) throw new Error("Configured Sidekick model is not registered in Pi; no fallback was selected");
      if (ctx.model?.provider === model.provider && ctx.model.id === model.id) throw new Error("This milestone requires two different models: select a different Sidekick or Lead");
      ctx.ui.setStatus("pi-sidekick", "Sidekick · executing");
      try {
        const result = await worker.run(task, signal, activity => {
          ctx.ui.setStatus("pi-sidekick", "Sidekick · " + activity);
          // Only activity metadata is forwarded, never worker text/arguments/results.
          onUpdate?.({ content: [{ type: "text", text: activity }], details: { status: "running" } });
        });
        return { content: [{ type: "text", text: result.report }], details: { status: result.status, checkpoint: result.checkpoint, durationMs: result.durationMs }, usage: result.usage, isError: result.status !== "idle" };
      } finally {
        if (unsafeLead) fatalStorageFailure(); // worker.run has finished its nested cleanup
        ctx.ui.setStatus("pi-sidekick", "Sidekick · idle");
      }
    },
  });

  pi.registerCommand("sidekick", {
    description: "Persistent pair: status | model provider/id [thinking] | on | off | steer text | cancel | restart | reset --yes | stats",
    async handler(args, ctx) {
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (command === "status") {
          const cp = worker?.checkpoint;
          ctx.ui.notify([
            `Lead: ${ctx.model ? ctx.model.provider + "/" + ctx.model.id : "none"}`,
            `Sidekick: ${config.sidekick ? config.sidekick.provider + "/" + config.sidekick.model + " · " + config.sidekick.thinkingLevel : "not configured"}`,
            `Mode: ${config.enabled ? "on" : "off"}; state: ${worker?.busy ? "running" : cp?.status ?? "not started"}`,
            `Session: ${cp?.file ?? "created lazily on first handoff"}`,
            ...(configurationError ? ["Error: " + configurationError] : []),
          ].join("\n"), "info"); return;
        }
        if (command === "cancel") { await worker?.cancel(); ctx.ui.notify("Sidekick stopped; history retained. Files were not reverted.", "info"); return; }
        if (command === "steer") { if (!worker) throw new Error("Sidekick is not configured"); await worker.steer(rest.join(" ")); ctx.ui.notify("Correction queued in the active Sidekick session.", "info"); return; }
        if (command === "stats") {
          // Do not double-count worker usage already attached to Lead tool results.
          const lead = totalUsage(collectUsage(ctx.sessionManager.getBranch().filter(e => !(e.type === "message" && e.message.role === "toolResult"))));
          const stats = worker?.checkpoint?.stats;
          ctx.ui.notify(`Lead: input=${lead.input} output=${lead.output} cacheRead=${lead.cacheRead} cacheWrite=${lead.cacheWrite}\nSidekick (last checkpoint): input=${stats?.tokens.input ?? 0} output=${stats?.tokens.output ?? 0} cacheRead=${stats?.tokens.cacheRead ?? 0} cacheWrite=${stats?.tokens.cacheWrite ?? 0}; handoffs=${worker?.checkpoint?.tasks ?? 0}`, "info"); return;
        }
        if (worker?.busy || writerLeases.size) throw new Error("Workspace is busy; cancel or wait before changing Sidekick configuration/history");
        if (command === "reset") {
          if (rest[0] !== "--yes" && (!ctx.hasUI || !(await ctx.ui.confirm("Reset Sidekick history?", "Create new history on the next handoff. Existing files and the old JSONL will NOT be deleted or reverted.")))) return;
          await worker?.stop(); append(CHECKPOINT_TYPE, null); worker = createWorker(ctx);
          ctx.ui.notify("Sidekick binding reset. Files and old history retained.", "info"); return;
        }
        if (command === "restart") { await worker?.stop(); worker = createWorker(ctx); ctx.ui.notify("Sidekick process stopped; next handoff restores its existing history.", "info"); return; }
        let next: SidekickConfig;
        if (command === "model") {
          if (!rest[0] || rest.length > 2) throw new Error("Usage: /sidekick model provider/model-id [thinking]");
          const model = parseModelSpec(rest[0], rest[1]);
          if (!ctx.modelRegistry.find(model.provider, model.model)) throw new Error("Sidekick model not found in Pi");
          if (worker?.checkpoint && !sameModel(worker.checkpoint.model, model)) throw new Error("Existing Sidekick history is bound to another model. Use /sidekick reset --yes first.");
          next = parseConfig({ ...config, enabled: true, sidekick: model });
        } else if (command === "on" || command === "off") next = parseConfig({ ...config, enabled: command === "on" });
        else throw new Error("Usage: /sidekick status|model provider/id [thinking]|on|off|steer text|cancel|restart|reset --yes|stats");
        await worker?.stop(); config = next; configurationError = undefined;
        append(CONFIG_TYPE, config); worker = createWorker(ctx); activate();
        ctx.ui.setStatus("pi-sidekick", config.enabled ? "Sidekick · idle" : undefined);
        ctx.ui.notify("Sidekick configuration saved to this Lead branch; global Pi defaults were not changed.", "info");
      } catch (error) { ctx.ui.notify(String(error), "error"); }
    },
  });
}
