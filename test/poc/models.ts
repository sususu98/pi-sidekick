import "./no-network.cjs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const textOf = (message: { content: unknown }): string => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter(b => b.type === "text").map(b => b.text).join("\n") : "";
export default function models(pi: ExtensionAPI): void {
  if (!process.versions.bun) throw new Error("PoC requires native Bun in BOTH processes");
  pi.registerCommand("fixture_reload", { description: "Offline reload regression", handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerCommand("fixture_tree_running", { description: "Offline running checkpoint rollback", handler: async (_args, ctx) => {
    const entry = ctx.sessionManager.getBranch().find(e => e.type === "custom" && e.customType === "pi-sidekick.checkpoint.v1" && (e.data as { status?: string })?.status === "running");
    if (!entry) throw new Error("No running checkpoint");
    await ctx.navigateTree(entry.id, { summarize: false });
  } });
  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.model?.id === "worker" && event.prompt.includes("PREFLIGHT_DELAY")) await new Promise(resolve => setTimeout(resolve, 3000));
  });
  pi.registerProvider("sidekick-test", {
    api: "sidekick-test-api", baseUrl: "http://127.0.0.1:1/never-used", apiKey: "offline-fixture",
    models: ["lead", "worker"].map(id => ({ id, name: "Offline " + id, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "pending", usage: { input: 20, output: 10, cacheRead: 5, cacheWrite: 0, totalTokens: 35, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const users = context.messages.filter(m => m.role === "user");
        const latest = context.messages.at(-1)!;
        const goal = textOf(users.findLast(m => textOf(m).includes("Lead handoff")) ?? users.at(-1)!);
        const handoffs = users.filter(m => textOf(m).includes("Lead handoff")).length;
        const corrections = users.filter(m => textOf(m).includes("CORRECTION_KEEP_SCOPE")).length;
        const remembered = JSON.stringify(context.messages).includes(process.env.FUSION_PROOF_SECRET!);
        const report = `WORKER_REPORT handoffs=${handoffs} corrections=${corrections} remembered=${remembered}`;
        const emitText = (text: string) => {
          const i = output.content.length;
          output.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: i, partial: output });
          stream.push({ type: "text_delta", contentIndex: i, delta: text, partial: output });
          stream.push({ type: "text_end", contentIndex: i, content: text, partial: output });
        };
        if (options?.signal?.aborted) {
          output.stopReason = "aborted"; output.errorMessage = "fixture aborted";
          stream.push({ type: "error", reason: "aborted", error: output }); stream.end(); return;
        }
        if (model.id === "worker" && goal.includes("EXIT_WORKER")) { process.exit(17); }
        if (model.id === "worker" && goal.includes("MODEL_ERROR")) {
          output.stopReason = "error"; output.errorMessage = "fixture permanent model failure";
          stream.push({ type: "error", reason: "error", error: output }); stream.end(); return;
        }
        stream.push({ type: "start", partial: output });
        if (latest.role === "user" && !textOf(latest).includes("CORRECTION_KEEP_SCOPE")) {
          const task = textOf(latest);
          const args: Record<string, string> = model.id === "lead" ? { brief: task, constraints: "Modify only worker-output.txt; no dependencies", acceptance: "Use native tools and report actual result" }
            : task.includes("SLOW") || task.includes("STEER_TEST") ? { command: task.includes("SLOW") ? "sleep 20" : "sleep 0.5" }
            : task.includes("SECOND") ? { path: join(process.env.FUSION_PROOF_ROOT!, "workspace", "worker-output.txt"), oldText: "worker tasks=1", newText: "worker tasks=2" }
            : { path: join(process.env.FUSION_PROOF_ROOT!, "workspace", "worker-output.txt"), content: "worker tasks=" + handoffs };
          const name = model.id === "lead" ? (task.includes("LEAD_WRITE") ? "write" : "sidekick") : task.includes("SLOW") || task.includes("STEER_TEST") ? "bash" : task.includes("SECOND") ? "edit" : "write";
          if (model.id === "worker") emitText("WORKER_PRIVATE_TRACE " + process.env.FUSION_PROOF_SECRET);
          const i = output.content.length;
          const actualArgs = model.id === "lead" && task.includes("LEAD_WRITE") ? { path: join(process.env.FUSION_PROOF_ROOT!, "workspace", "lead-write.txt"), content: "lead mutation" } : args;
          const call = { type: "toolCall" as const, id: randomUUID(), name, arguments: actualArgs };
          output.content.push(call);
          stream.push({ type: "toolcall_start", contentIndex: i, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: i, toolCall: call, partial: output });
          output.stopReason = "toolUse";
        } else {
          emitText(model.id === "lead" ? "LEAD_REVIEW: " + textOf(latest) : report + (goal.includes("LONG_REPORT") ? "\n" + "x".repeat(50_000) : ""));
          output.stopReason = "stop";
        }
        stream.push({ type: "done", reason: output.stopReason, message: output }); stream.end();
      });
      return stream;
    },
  });
}
