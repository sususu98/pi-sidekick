import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir, getPackageDir, SessionManager, type JsonAgentSessionEvent, type SessionEntry, type SessionStats } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { sameModel, resolveProviderExtensions, type SidekickConfig, type SidekickModel } from "./config.ts";
import { RpcPeer } from "./rpc.ts";
import { collectUsage, totalUsage, zeroUsage } from "./usage.ts";

export const CHECKPOINT_TYPE = "pi-sidekick.checkpoint.v1";
export type WorkerStatus = "idle" | "running" | "cancelled" | "error";
export interface Checkpoint {
  version: 1;
  owner: string;
  file: string;
  sessionId: string;
  leaf: string | null;
  model: SidekickModel;
  status: WorkerStatus;
  tasks: number;
  stats?: SessionStats;
}
export function restoreCheckpoint(entries: readonly SessionEntry[]): Checkpoint | undefined {
  const entry = entries.findLast(e => e.type === "custom" && e.customType === CHECKPOINT_TYPE);
  if (!entry || entry.type !== "custom" || entry.data === null) return undefined; // Explicit reset tombstone.
  const data = entry.data as Checkpoint;
  if (!data || data.version !== 1 || typeof data.owner !== "string" || typeof data.file !== "string" || !data.file || typeof data.sessionId !== "string" || (typeof data.leaf !== "string" && data.leaf !== null) || !data.model || typeof data.model.provider !== "string" || typeof data.model.model !== "string" || !["idle", "running", "cancelled", "error"].includes(data.status) || !Number.isInteger(data.tasks) || data.tasks < 0) throw new Error("Invalid Sidekick checkpoint; restore the history or explicitly reset it");
  return data;
}
export interface Brief { brief: string; constraints?: string; acceptance?: string }
export function formatBrief(task: Brief): string {
  if (!task.brief.trim()) throw new Error("Sidekick brief must not be empty");
  // Prefix prevents a task starting with / from being interpreted as an RPC slash command.
  return ["Lead handoff — execute only this task.", "\nGoal:\n" + task.brief, "\nConstraints:\n" + (task.constraints || "Follow existing repository/user instructions; do not expand scope."), "\nAcceptance:\n" + (task.acceptance || "Report changes, actual checks/results, and remaining blockers.")].join("\n");
}
export interface WorkerResult {
  status: WorkerStatus;
  report: string;
  checkpoint?: Checkpoint;
  usage: Usage;
  durationMs: number;
}
interface WorkerOptions {
  cwd: string;
  owner: string;
  sessionDir: string;
  config: SidekickConfig;
  checkpoint?: Checkpoint;
  save: (checkpoint: Checkpoint) => void;
}

export class PersistentWorker {
  checkpoint?: Checkpoint;
  private peer?: RpcPeer;
  private fileRelease?: () => Promise<void>;
  private operation?: { controller: AbortController; done: Promise<WorkerResult> };
  private closing = false;
  private compromised?: Error;
  constructor(private readonly options: WorkerOptions) { this.checkpoint = options.checkpoint; }
  get busy(): boolean { return Boolean(this.operation); }
  get pid(): number | undefined { return this.peer?.pid; }

  private async lock(path: string, onCompromised: () => void): Promise<() => Promise<void>> {
    await mkdir(dirname(path), { recursive: true });
    try { return await lockfile.lock(path, { realpath: false, stale: 10_000, update: 2000, retries: 0, onCompromised: (error) => { this.compromised = error; onCompromised(); } }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new Error(`Another Sidekick writer owns ${path}. Do not open a second writer.`);
      throw error;
    }
  }

  private async initialize(controller: AbortController): Promise<RpcPeer> {
    if (this.peer) return this.peer;
    const model = this.options.config.sidekick!;
    let checkpoint = this.checkpoint;
    if (checkpoint && !sameModel(checkpoint.model, model)) throw new Error("Sidekick model differs from its saved history. Restore the original config or use /sidekick reset --yes explicitly.");
    if (checkpoint) {
      // SessionManager.open() can silently create history for absent/invalid files;
      // fail closed before calling it so broken bindings never lose context.
      let records: Array<Record<string, unknown>>;
      try { records = (await readFile(checkpoint.file, "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
      catch (error) { throw new Error(`Cannot restore Sidekick history ${checkpoint.file}: ${String(error)}. No new history was created.`); }
      if (records[0]?.type !== "session" || records[0]?.id !== checkpoint.sessionId || resolve(String(records[0]?.cwd)) !== resolve(this.options.cwd)) throw new Error("Sidekick session identity/workspace mismatch");
      const manager = SessionManager.open(checkpoint.file);
      if (checkpoint.leaf && !manager.getEntry(checkpoint.leaf)) throw new Error("Sidekick checkpoint leaf is missing");
      if (checkpoint.owner !== this.options.owner || (manager.getLeafId() !== checkpoint.leaf && checkpoint.status !== "running")) {
        if (!checkpoint.leaf) throw new Error("Cannot branch an empty Sidekick checkpoint; use explicit reset");
        const file = manager.createBranchedSession(checkpoint.leaf);
        if (!file) throw new Error("Could not derive Sidekick branch");
        // Pi deliberately defers writing setup-only branches. Materialize its
        // canonical header/entries before opening, never let open() invent an ID.
        try { await readFile(file, "utf8"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await writeFile(file, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
        }
        checkpoint = { ...checkpoint, file, sessionId: manager.getSessionId(), owner: this.options.owner };
      }
    }
    controller.signal.throwIfAborted();
    const creating = !checkpoint;
    let reservedHeader: ReturnType<SessionManager["getHeader"]>;
    if (!checkpoint) {
      // Reserve an empty canonical Pi JSONL before launching the process. Native
      // Pi otherwise delays file creation until after auth/preflight. Use the SDK
      // header, not an invented user message or private SessionManager method.
      const manager = SessionManager.create(this.options.cwd, this.options.sessionDir);
      reservedHeader = manager.getHeader();
      checkpoint = { version: 1, owner: this.options.owner, file: manager.getSessionFile()!, sessionId: manager.getSessionId(), leaf: null, model, status: "idle", tasks: 0 };
    }
    const providerArgs = resolveProviderExtensions(this.options.cwd, this.options.config).flatMap(path => ["-e", path]);
    const peer = new RpcPeer({
      // process.execPath can be a compiled Pi binary, NOT the Bun runtime.
      executable: "bun",
      cliPath: join(getPackageDir(), "dist/bun/cli.js"), cwd: this.options.cwd,
      env: { PI_CODING_AGENT_DIR: getAgentDir(), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      args: ["--provider", model.provider, "--model", model.model, "--thinking", model.thinkingLevel,
        "--no-extensions", "-e", join(import.meta.dirname, "worker-entry.ts"), ...providerArgs,
        "--no-skills", "--no-themes", "--no-prompt-templates", "--no-approve", "--tools", "read,bash,edit,write",
        "--session-dir", this.options.sessionDir, ...(checkpoint ? ["--session", checkpoint.file] : [])],
      requestTimeoutMs: 5000,
    });
    let release: (() => Promise<void>) | undefined;
    try {
      // When restoring, claim the JSONL before starting any process that may write it.
      release = await this.lock(checkpoint.file, () => this.operation?.controller.abort(new Error("Sidekick session lock compromised")));
      if (creating) await writeFile(checkpoint.file, JSON.stringify(reservedHeader!) + "\n", { flag: "wx", mode: 0o600 });
      await peer.start();
      const state = await peer.getState();
      if (!state.sessionFile || state.model?.provider !== model.provider || state.model.id !== model.model || state.thinkingLevel !== model.thinkingLevel) throw new Error("Worker did not select the exact configured model/thinking level; refusing fallback");
      if (checkpoint && state.sessionId !== checkpoint.sessionId) throw new Error("Worker restored a different session; refusing history replacement");
      const next: Checkpoint = { version: 1, owner: this.options.owner, file: state.sessionFile, sessionId: state.sessionId, leaf: (await peer.getEntries()).leafId, model, status: "idle", tasks: checkpoint.tasks, stats: checkpoint.stats };
      this.options.save(next);
      this.checkpoint = next; this.peer = peer; this.fileRelease = release;
      return peer;
    } catch (error) { try { await peer.stop(); } finally { await this.release(release); } throw error; }
  }

  async run(task: Brief, signal: AbortSignal | undefined, progress: (activity: string) => void): Promise<WorkerResult> {
    if (this.closing) throw new Error("Sidekick is shutting down");
    if (this.compromised) throw new Error("Sidekick writer lock was compromised; restart after inspecting partial work");
    if (this.busy) throw new Error("Sidekick already has an active task; wait or steer it");
    if (!this.options.config.enabled || !this.options.config.sidekick) throw new Error("Sidekick is not configured/enabled");
    const message = formatBrief(task);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const done = this.execute(message, controller, progress);
    this.operation = { controller, done };
    try { return await done; }
    finally { signal?.removeEventListener("abort", abort); this.operation = undefined; }
  }

  private async execute(message: string, controller: AbortController, progress: (activity: string) => void): Promise<WorkerResult> {
    const started = performance.now();
    let workspaceRelease: (() => Promise<void>) | undefined;
    let unsubscribe = () => {};
    let abortWork: Promise<void> | undefined;
    let cursor: string | undefined;
    let initialized = false;
    let usage = zeroUsage();
    let error: unknown;
    let report = "";
    let status: WorkerStatus = "idle";
    const cancel = () => {
      const peer = this.peer;
      if (!peer || abortWork) return;
      abortWork = (async () => { await peer.clearQueue(); await peer.abort(); })();
      void abortWork.catch(async () => { await peer.stop(); });
    };
    try {
      controller.signal.throwIfAborted();
      workspaceRelease = await this.lock(join(this.options.cwd, ".pi", "sidekick-writer"), () => controller.abort(new Error("Workspace writer lock compromised")));
      const peer = await this.initialize(controller);
      initialized = true;
      cursor = this.checkpoint?.leaf ?? undefined;
      controller.signal.throwIfAborted();
      const running: Checkpoint = { ...this.checkpoint!, status: "running" };
      this.options.save(running); this.checkpoint = running;
      unsubscribe = peer.onEvent((event: JsonAgentSessionEvent) => {
        if (event.type === "tool_execution_start") progress(`Running ${event.toolName}`);
        else if (event.type === "tool_execution_end") progress(`${event.isError ? "Failed" : "Finished"} ${event.toolName}`);
        else if (event.type === "compaction_start") progress("Compacting Sidekick context");
        else if (event.type === "auto_retry_start") progress(`Sidekick retry ${event.attempt}`);
      });
      controller.signal.addEventListener("abort", cancel, { once: true });
      if (controller.signal.aborted) cancel();
      progress("Sidekick executing brief");
      controller.signal.throwIfAborted();
      await peer.run(message, this.options.config.timeoutMs, controller.signal);
      if (abortWork) await abortWork;
      controller.signal.throwIfAborted();
      const entries = (await peer.getEntries(cursor)).entries;
      const final = entries.findLast(e => e.type === "message" && e.message.role === "assistant");
      if (!final || final.type !== "message" || final.message.role !== "assistant") throw new Error("Worker finished without a new assistant report");
      if (final.message.stopReason === "error" || final.message.stopReason === "aborted") throw new Error(final.message.errorMessage || "Worker model failed");
      if (final.message.stopReason !== "stop") throw new Error(`Worker report is incomplete (${final.message.stopReason})`);
      report = (await peer.getLastAssistantText()).text ?? "";
      if (!report.trim()) throw new Error("Worker returned an empty report");
    } catch (caught) {
      error = caught;
      status = controller.signal.aborted ? "cancelled" : "error";
      // Timeout/error must not leave a writer running while Lead starts other work.
      cancel();
      if (abortWork) await abortWork.catch(() => {});
      // Native abort does not revoke an idle prompt's asynchronous preflight.
      // Close the process before releasing writer ownership. Keep the JSONL,
      // and restore it on the next EXPLICIT handoff, never replay this task.
      await this.peer?.stop(); this.peer = undefined;
      report = `Sidekick ${status}: ${String(error)}. Its history is retained; files may already have changed. Review partial work before assigning a new brief. The interrupted task was not re-run.`;
    } finally {
      unsubscribe(); controller.signal.removeEventListener("abort", cancel);
      try {
        if (initialized && this.checkpoint) {
          try { usage = await this.snapshot(cursor, status); }
          catch (checkpointError) {
            status = "error";
            report = `Sidekick history/checkpoint update failed: ${String(checkpointError)}. Partial work may exist. No success is claimed; the next explicit handoff must restore the original history.`;
            await this.peer?.stop(); this.peer = undefined;
          }
        }
      } finally {
        try {
          if (!this.peer) { await this.release(this.fileRelease); this.fileRelease = undefined; }
        } finally { await this.release(workspaceRelease); }
      }
    }
    const limit = this.options.config.maxReportChars;
    if (report.length > limit) report = report.slice(0, limit) + "\n[Report truncated. Full final report remains in the Sidekick session; raw traces were not copied to Lead.]";
    return { status, report, checkpoint: this.checkpoint, usage, durationMs: Math.round(performance.now() - started) };
  }

  private async release(release: (() => Promise<void>) | undefined): Promise<void> {
    try { await release?.(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERELEASED") throw error; }
  }

  private async snapshot(cursor: string | undefined, status: WorkerStatus): Promise<Usage> {
    if (!this.checkpoint) return zeroUsage();
    let leaf: string | null; let entries: SessionEntry[]; let stats: SessionStats;
    if (this.peer) {
      const result = await this.peer.getEntries(cursor); entries = result.entries; leaf = result.leafId;
      stats = await this.peer.getSessionStats();
    } else {
      // Read only AFTER the failed/cancelled process has exited. No second writer.
      const records = (await readFile(this.checkpoint.file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      if (records[0]?.type !== "session" || records[0]?.id !== this.checkpoint.sessionId) throw new Error("Sidekick JSONL identity mismatch");
      const manager = SessionManager.open(this.checkpoint.file);
      const all = manager.getEntries(); const index = cursor ? all.findIndex(e => e.id === cursor) : -1;
      if (cursor && index < 0) throw new Error("Sidekick usage cursor missing from persisted history");
      entries = all.slice(index + 1); leaf = manager.getLeafId();
      const totals = totalUsage(collectUsage(all));
      const messages = all.flatMap(e => e.type === "message" ? [e.message] : []);
      stats = { sessionId: this.checkpoint.sessionId, sessionFile: this.checkpoint.file, userMessages: messages.filter(m => m.role === "user").length, assistantMessages: messages.filter(m => m.role === "assistant").length,
        toolCalls: messages.reduce((n, m) => n + (m.role === "assistant" ? m.content.filter(c => c.type === "toolCall").length : 0), 0), toolResults: messages.filter(m => m.role === "toolResult").length, totalMessages: messages.length,
        tokens: { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite, total: totals.totalTokens }, cost: totals.cost.total };
    }
    const next: Checkpoint = { ...this.checkpoint, leaf, status, tasks: this.checkpoint.tasks + 1, stats };
    this.options.save(next); this.checkpoint = next; // Never publish uncommitted state.
    return totalUsage(collectUsage(entries));
  }

  async steer(message: string): Promise<void> {
    if (!this.busy || !this.peer) throw new Error("No active Sidekick task to steer");
    if (!message.trim()) throw new Error("Steering message must not be empty");
    const result = await this.peer.steer(message);
    if (result.disposition !== "queued") throw new Error("Sidekick steering was handled instead of queued");
  }
  async cancel(): Promise<void> {
    const operation = this.operation;
    if (!operation) return;
    operation.controller.abort(new Error("Sidekick cancelled"));
    await operation.done;
  }
  async stop(): Promise<void> {
    this.closing = true;
    await this.cancel();
    const peer = this.peer; this.peer = undefined;
    try { await peer?.stop(); }
    finally { await this.release(this.fileRelease); this.fileRelease = undefined; }
  }
}
