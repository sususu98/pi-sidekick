import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { JsonAgentSessionEvent, RpcCommand, RpcResponse, RpcSessionState, SessionEntry, SessionStats } from "@earendil-works/pi-coding-agent";

export interface PeerOptions {
  executable: string;
  runtimeArgs?: string[];
  cliPath: string;
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}
type Pending = { resolve: (value: RpcResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type CommandResult<T extends RpcCommand["type"]> = Extract<RpcResponse, { command: T; success: true }> extends { data: infer D } ? D : void;

/** Strict LF framing; unlike readline, U+2028/U+2029 are not separators. */
export class JsonlDecoder {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  constructor(private readonly receive: (record: unknown) => void, private readonly maxBytes = 64 * 1024 * 1024) {}
  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error("RPC record exceeds limit");
      if (line.trim()) this.receive(JSON.parse(line));
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) throw new Error("RPC record exceeds limit");
  }
  finish(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) throw new Error("RPC exited with an incomplete JSONL record");
  }
}

/** Runtime-selectable subprocess transport. All agent behavior remains native Pi. */
export class RpcPeer {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private events = new Set<(event: JsonAgentSessionEvent) => void>();
  private failures = new Set<(error: Error) => void>();
  private error?: Error;
  private nextId = 0;
  private stderr = "";
  private closing?: Promise<void>;
  private started = false;
  get pid(): number | undefined { return this.child?.pid; }
  constructor(private readonly options: PeerOptions) {}

  async start(): Promise<void> {
    if (this.started || this.closing) throw new Error("RPC peer is single-use; create a new peer to restart the process");
    this.started = true;
    const child = spawn(this.options.executable, [...(this.options.runtimeArgs ?? []), this.options.cliPath, "--mode", "rpc", ...this.options.args], {
      cwd: this.options.cwd, env: { ...process.env, ...this.options.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const decoder = new JsonlDecoder((record) => this.receive(record));
    child.stdout.on("data", (chunk: Buffer) => {
      try { decoder.push(chunk); } catch (error) { this.fail(new Error("Invalid RPC stream: " + String(error))); child.kill("SIGTERM"); }
    });
    child.stdout.on("end", () => { try { decoder.finish(); } catch (error) { this.fail(error as Error); } });
    child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
    child.on("error", (error) => this.fail(new Error("RPC process failed: " + error.message)));
    child.stdin.on("error", (error) => this.fail(new Error("RPC stdin failed: " + error.message)));
    child.once("exit", (code, signal) => this.fail(new Error(`RPC process exited (${code ?? signal}). ${this.stderr}`)));
    // A real handshake, not a fixed startup sleep. This does not invoke a model.
    try { await this.getState(); } catch (error) { await this.stop(); throw error; }
  }

  private receive(record: unknown): void {
    if (!record || typeof record !== "object" || typeof (record as { type?: unknown }).type !== "string") throw new Error("Invalid RPC record");
    const message = record as RpcResponse;
    if (message.type === "response") {
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.success) pending.resolve(message);
      else pending.reject(new Error(message.error));
      return;
    }
    // Worker dialogs must not hang a headless process waiting for an invisible UI.
    if ((record as { type: string }).type === "extension_ui_request") {
      const request = record as { id: string; method: string };
      if (["select", "confirm", "input", "editor"].includes(request.method)) {
        this.child?.stdin.write(JSON.stringify({ type: "extension_ui_response", id: request.id, cancelled: true }) + "\n");
      }
      return;
    }
    for (const listener of this.events) {
      try { listener(record as JsonAgentSessionEvent); } catch { /* Observers cannot corrupt transport. */ }
    }
  }

  private fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.failures) { try { listener(error); } catch { /* Observer isolation. */ } }
  }

  async request<T extends RpcCommand["type"]>(command: Extract<RpcCommand, { type: T }>, timeoutMs = this.options.requestTimeoutMs ?? 15_000): Promise<CommandResult<T>> {
    if (this.error) throw this.error;
    if (!this.child) throw new Error("RPC peer is not started");
    const id = String(++this.nextId);
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${command.type} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // Writable queues bytes and honors backpressure internally; write callbacks
      // surface errors without dropping or interleaving protocol records.
      this.child!.stdin.write(JSON.stringify({ ...command, id }) + "\n", (error) => { if (error) this.fail(error); });
    });
    if (response.command !== command.type) throw new Error("RPC response command mismatch");
    return ("data" in response ? response.data : undefined) as CommandResult<T>;
  }

  onEvent(listener: (event: JsonAgentSessionEvent) => void): () => void { this.events.add(listener); return () => { this.events.delete(listener); }; }
  onFailure(listener: (error: Error) => void): () => void { this.failures.add(listener); return () => { this.failures.delete(listener); }; }
  getState(): Promise<RpcSessionState> { return this.request({ type: "get_state" }); }
  getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> { return this.request({ type: "get_entries", since }); }
  getLastAssistantText(): Promise<{ text: string | null }> { return this.request({ type: "get_last_assistant_text" }); }
  getSessionStats(): Promise<SessionStats> { return this.request({ type: "get_session_stats" }); }
  async getMessages(): Promise<unknown[]> {
    const res = (await this.request({ type: "get_messages" })) as { messages: unknown[] };
    return res.messages;
  }
  clearQueue() { return this.request({ type: "clear_queue" }); }
  abort() { return this.request({ type: "abort" }); }
  steer(message: string) { return this.request({ type: "steer", message }); }

  async run(message: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    let unsubscribe = () => {}; let unfailed = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveRun!: () => void; let rejectFailure!: (error: Error) => void;
    const settled = new Promise<void>(resolve => { resolveRun = resolve; });
    const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
    void failure.catch(() => {});
    const abort = () => rejectFailure(signal?.reason instanceof Error ? signal.reason : new Error("Sidekick run cancelled"));
    try {
      unsubscribe = this.onEvent((event) => { if (event.type === "agent_settled") resolveRun(); });
      unfailed = this.onFailure(rejectFailure);
      signal?.addEventListener("abort", abort, { once: true });
      signal?.throwIfAborted();
      timer = setTimeout(() => rejectFailure(new Error("Sidekick task timed out")), timeoutMs);
      // Cancellation/exit/deadline must break BOTH acceptance and settled waits.
      // Native prompt can still be in asynchronous preflight before acceptance.
      const execution = (async () => {
        const accepted = await this.request({ type: "prompt", message }, Math.min(timeoutMs, this.options.requestTimeoutMs ?? 15_000));
        if (accepted.disposition !== "started") throw new Error(`Sidekick prompt was ${accepted.disposition}; no new task started`);
        await settled;
      })();
      await Promise.race([execution, failure]);
    } finally { unsubscribe(); unfailed(); signal?.removeEventListener("abort", abort); if (timer) clearTimeout(timer); }
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.close(); return this.closing;
  }
  private async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.fail(new Error("RPC peer closed"));
    // Failed spawn (ENOENT/EACCES) has no PID and emits error/close, not exit.
    if (!child.pid) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      this.child = undefined; this.events.clear(); this.failures.clear();
      return;
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const hard = setTimeout(() => { child.kill("SIGKILL"); }, 1500);
        const soft = setTimeout(() => { child.kill("SIGTERM"); }, 500);
        child.once("exit", () => { clearTimeout(soft); clearTimeout(hard); resolve(); });
        // Native Pi orderly shutdown; fall back to signals if startup or cleanup hangs.
        child.stdin.end();
      });
    }
    this.child = undefined; this.events.clear(); this.failures.clear();
  }
}
