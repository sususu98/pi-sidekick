import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getPackageDir, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { RpcPeer } from "../extensions/rpc.ts";
import { CHECKPOINT_TYPE, type Checkpoint } from "../extensions/worker.ts";
import type { SidekickConfig } from "../extensions/config.ts";

async function harness(overrides: Partial<SidekickConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-integration-"));
  const cwd = join(root, "workspace"); const agentDir = join(root, "config");
  await Promise.all([mkdir(join(cwd, ".pi"), { recursive: true }), mkdir(agentDir)]);
  const provider = resolve("test/poc/models.ts");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
  await writeFile(join(cwd, ".pi", "sidekick.json"), JSON.stringify({ enabled: true, sidekick: { provider: "sidekick-test", model: "worker", thinkingLevel: "high" }, providerExtensions: [provider], ...overrides }));
  const env = { FUSION_PROOF_ROOT: root, FUSION_PROOF_SECRET: "PRIVATE_" + randomUUID(), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  const make = (file?: string) => new RpcPeer({
    executable: process.execPath, runtimeArgs: ["--preload", resolve("test/poc/no-network.cjs")], cliPath: process.env.TEST_PI_ENTRY ?? join(getPackageDir(), "dist/bun/cli.js"), cwd, env,
    args: ["--provider", "sidekick-test", "--model", "lead", "--thinking", "high", "--no-extensions", "-e", provider, "-e", resolve("extensions/index.ts"), "--no-skills", "--no-themes", "--no-prompt-templates", "--no-approve", "--tools", "sidekick,write", "--session-dir", join(root, "lead-sessions"), ...(file ? ["--session", file] : [])],
  });
  let peer = make(); const peers = [peer];
  const record = async () => {
    const entry = (await peer.getEntries()).entries.findLast(e => e.type === "custom" && e.customType === CHECKPOINT_TYPE);
    return entry?.type === "custom" ? entry.data as Checkpoint | null : undefined;
  };
  const run = async (message: string) => {
    const events: JsonAgentSessionEvent[] = []; const unsub = peer.onEvent(e => events.push(e));
    try { await peer.run(message, 20_000); } finally { unsub(); }
    return { text: (await peer.getLastAssistantText()).text ?? "", checkpoint: await record(), events };
  };
  const command = async (message: string) => { const r = await peer.request({ type: "prompt", message }); expect(r.disposition).toBe("handled"); };
  return {
    root, cwd, env, get peer() { return peer; }, record, run, command,
    async start() { await peer.start(); },
    async companion() { const companion = make(); peers.push(companion); await companion.start(); return companion; },
    async restart() { const file = (await peer.getState()).sessionFile!; await peer.stop(); peer = make(file); peers.push(peer); await peer.start(); },
    async finish() {
      const pids = peers.map(p => p.pid).filter((pid): pid is number => pid !== undefined);
      await Promise.all(peers.map(p => p.stop()));
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      expect(await access(join(root, "network-attempts.log")).then(() => true, () => false)).toBe(false);
      expect(await access(join(cwd, ".pi", "sidekick-writer.lock")).then(() => true, () => false)).toBe(false);
      if (process.env.KEEP_POC) console.log("Integration artifacts:", root); else await rm(root, { recursive: true, force: true });
    },
  };
}

test("production extension: two persistent Bun models, history, shutdown/reload, cancellation, steering, fork and reset", async () => {
  const h = await harness();
  try {
    await h.start();
    const first = await h.run("FIRST"); expect(first.text).toContain("handoffs=1 corrections=0 remembered=true");
    expect(first.checkpoint?.model.model).toBe("worker"); expect(first.events.some(e => e.type === "tool_execution_update")).toBe(true);
    const file = first.checkpoint!.file; const id = first.checkpoint!.sessionId;
    const second = await h.run("SECOND"); expect(second.checkpoint?.file).toBe(file); expect(second.checkpoint?.sessionId).toBe(id);
    expect(second.text).toContain("handoffs=2"); expect(await readFile(join(h.cwd, "worker-output.txt"), "utf8")).toBe("worker tasks=2");
    expect(second.checkpoint?.stats?.tokens.total).toBe(140);
    const leadMessages = JSON.stringify((await h.peer.request({ type: "get_messages" })).messages);
    expect(leadMessages).not.toContain(h.env.FUSION_PROOF_SECRET); expect(leadMessages).not.toContain("WORKER_PRIVATE_TRACE");
    const result = (await h.peer.getEntries()).entries.findLast(e => e.type === "message" && e.message.role === "toolResult");
    expect(result?.type === "message" && result.message.role === "toolResult" ? result.message.usage?.totalTokens : undefined).toBe(70);
    await h.command("/sidekick restart"); expect((await h.run("THIRD")).checkpoint?.file).toBe(file);
    await h.restart(); expect((await h.run("FOURTH")).checkpoint?.file).toBe(file);
    await h.command("/fixture_reload"); expect((await h.record())?.file).toBe(file);
    let cancel: Promise<void> | undefined;
    const unsub = h.peer.onEvent(e => {
      if (!cancel && e.type === "tool_execution_update" && JSON.stringify(e.partialResult).includes("Running bash")) { cancel = h.peer.abort(); void cancel.catch(() => {}); }
    });
    await h.run("SLOW"); unsub(); expect(cancel).toBeDefined(); await cancel;
    expect((await h.peer.getState()).isStreaming).toBe(false); expect((await h.record())?.status).toBe("cancelled");
    const continuation = await h.run("CONTINUE"); expect(continuation.text).toContain("handoffs=6"); expect(continuation.checkpoint?.sessionId).toBe(id);
    let steer: Promise<void> | undefined;
    const unsteer = h.peer.onEvent(e => {
      if (!steer && e.type === "tool_execution_update" && JSON.stringify(e.partialResult).includes("Running bash")) { steer = h.command("/sidekick steer CORRECTION_KEEP_SCOPE"); void steer.catch(() => {}); }
    });
    const steered = await h.run("STEER_TEST"); unsteer(); expect(steer).toBeDefined(); await steer;
    expect(steered.text).toContain("handoffs=7 corrections=1"); expect(steered.checkpoint?.file).toBe(file);
    const forkMessages = (await h.peer.request({ type: "get_fork_messages" })).messages;
    expect((await h.peer.request({ type: "fork", entryId: forkMessages.find(m => m.text === "SECOND")!.entryId })).cancelled).toBe(false);
    const branch = await h.run("BRANCH"); expect(branch.checkpoint?.file).not.toBe(file); expect(branch.text).toContain("handoffs=2 corrections=0");
    expect(await readFile(branch.checkpoint!.file, "utf8")).not.toContain("FOURTH");
    await h.command("/sidekick reset --yes"); const fresh = await h.run("FRESH");
    expect(fresh.checkpoint?.file).not.toBe(branch.checkpoint?.file); expect(fresh.text).toContain("handoffs=1");
    expect(await access(file).then(() => true, () => false)).toBe(true);
    expect((await h.peer.getState()).model?.id).toBe("lead");
    await h.command("/sidekick off");
    const off = await h.run("OFF_TASK"); expect(off.checkpoint?.file).toBe(fresh.checkpoint?.file);
    expect(off.text).not.toContain("handoffs=2");
    await h.command("/sidekick on"); expect((await h.run("ON_TASK")).text).toContain("handoffs=2");
    console.log("Production pair PASS: persistence, isolation, usage, restart, cancellation, steering, fork, explicit reset and on/off");
  } finally { await h.finish(); }
}, 90_000);

test("production errors: model failure, task timeout, report bounds and missing-history fail closed", async () => {
  const h = await harness({ timeoutMs: 1000, maxReportChars: 256 });
  try {
    await h.start();
    expect((await h.run("FIRST")).checkpoint).toBeDefined();
    const failed = await h.run("MODEL_ERROR"); expect(failed.text).toContain("Sidekick error"); expect(failed.checkpoint?.status).toBe("error");
    const crashed = await h.run("EXIT_WORKER"); expect(crashed.text).toContain("RPC process exited");
    expect((await h.run("AFTER_CRASH")).checkpoint?.sessionId).toBe(failed.checkpoint?.sessionId);
    const timed = await h.run("SLOW"); expect(timed.text).toContain("timed out"); expect((await h.peer.getState()).isStreaming).toBe(false);
    const recovered = await h.run("CONTINUE"); expect(recovered.checkpoint?.sessionId).toBe(failed.checkpoint?.sessionId);
    const long = await h.run("LONG_REPORT"); expect(long.text).toContain("Report truncated"); expect(long.text.length).toBeLessThan(600);
    const original = long.checkpoint!.file;
    await h.command("/sidekick restart"); await rm(original);
    const missing = await h.run("NEXT"); expect(missing.text).toContain("Cannot restore Sidekick history");
    expect(missing.checkpoint?.file).toBe(original); // no silent fresh session
  } finally { await h.finish(); }
}, 60_000);

test("production lock lifecycle: multiple native Bash, Lead write and /fixture_reload cycles under actual Pi host", async () => {
  const h = await harness();
  try {
    await h.start();
    for (let cycle = 1; cycle <= 3; cycle++) {
      // 1. Native bash through user_bash hook (claims and releases workspace writer lease)
      const bashResult = await h.peer.request({ type: "bash", command: `printf "cycle-${cycle}" > cycle-${cycle}.txt` });
      expect(bashResult.exitCode).toBe(0);
      expect(await readFile(join(h.cwd, `cycle-${cycle}.txt`), "utf8")).toBe(`cycle-${cycle}`);
      expect(await access(join(h.cwd, ".pi", "sidekick-writer.lock")).then(() => true, () => false)).toBe(false);

      // 2. Lead native write tool execution (claims and releases workspace writer lease)
      await h.run("LEAD_WRITE");
      expect(await readFile(join(h.cwd, "lead-write.txt"), "utf8")).toBe("lead mutation");
      expect(await access(join(h.cwd, ".pi", "sidekick-writer.lock")).then(() => true, () => false)).toBe(false);

      // 3. /fixture_reload: reloads extension context in actual Pi host
      await h.command("/fixture_reload");
      expect(await access(join(h.cwd, ".pi", "sidekick-writer.lock")).then(() => true, () => false)).toBe(false);
    }
  } finally {
    await h.finish();
  }
}, 60_000);


test("production fails closed for absent worker provider, identical models and missing registered model", async () => {
  for (const overrides of [
    { providerExtensions: [] },
    { sidekick: { provider: "sidekick-test", model: "lead", thinkingLevel: "high" as const } },
    { sidekick: { provider: "sidekick-test", model: "missing", thinkingLevel: "high" as const } },
  ]) {
    const h = await harness(overrides);
    try {
      await h.start(); const result = await h.run("FIRST");
      expect(result.text).not.toContain("WORKER_REPORT"); expect(result.checkpoint).toBeUndefined();
      expect(result.text).toMatch(/exact configured|two different models|not registered|RPC process/);
    } finally { await h.finish(); }
  }
}, 60_000);
