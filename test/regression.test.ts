import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { RpcPeer } from "../extensions/rpc.ts";
import { PersistentWorker, CHECKPOINT_TYPE, type Checkpoint } from "../extensions/worker.ts";
import { loadConfig, type SidekickConfig } from "../extensions/config.ts";

async function fixture(timeoutMs = 10_000, failFinalAppend = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-regression-"));
  const cwd = join(root, "workspace"); const agentDir = join(root, "config");
  await Promise.all([mkdir(join(cwd, ".pi"), { recursive: true }), mkdir(agentDir)]);
  const provider = resolve("test/poc/models.ts");
  const config: SidekickConfig = { enabled: true, sidekick: { provider: "sidekick-test", model: "worker", thinkingLevel: "high" }, providerExtensions: [provider], timeoutMs, maxReportChars: 12_000 };
  await writeFile(join(cwd, ".pi", "sidekick.json"), JSON.stringify(config));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
  const env = { FUSION_PROOF_ROOT: root, FUSION_PROOF_SECRET: "PRIVATE_" + randomUUID(), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...(failFinalAppend ? { TEST_FAIL_FINAL_APPEND: "1" } : {}) };
  const peers: RpcPeer[] = [];
  const make = async () => {
    const peer = new RpcPeer({ executable: process.execPath, runtimeArgs: ["--preload", resolve("test/poc/no-network.cjs")], cliPath: join(getPackageDir(), "dist/bun/cli.js"), cwd, env,
      args: ["--provider", "sidekick-test", "--model", "lead", "--thinking", "high", "--no-extensions", "-e", provider, "-e", resolve("extensions/index.ts"), "--no-approve", "--no-skills", "--no-themes", "--no-prompt-templates", "--tools", "sidekick,write", "--session-dir", join(root, "leads")] });
    peers.push(peer); await peer.start(); return peer;
  };
  const command = async (peer: RpcPeer, message: string) => { expect((await peer.request({ type: "prompt", message })).disposition).toBe("handled"); };
  const checkpoint = async (peer: RpcPeer) => {
    const entry = (await peer.getEntries()).entries.findLast(e => e.type === "custom" && e.customType === CHECKPOINT_TYPE);
    return entry?.type === "custom" ? entry.data as Checkpoint : undefined;
  };
  return { root, cwd, env, config, make, command, checkpoint, async finish() { await Promise.all(peers.map(p => p.stop())); expect(await access(join(root, "network-attempts.log")).then(() => true, () => false)).toBe(false); expect(await access(join(cwd, ".pi", "sidekick-writer.lock")).then(() => true, () => false)).toBe(false); await rm(root, { recursive: true, force: true }); } };
}

test("first preflight timeout reserves real JSONL and cannot execute later; restart reuses identity", async () => {
  const f = await fixture(300);
  try {
    const peer = await f.make(); await peer.run("PREFLIGHT_DELAY", 10_000);
    expect((await peer.getLastAssistantText()).text).toContain("timed out");
    const cp = (await f.checkpoint(peer))!;
    expect(await access(cp.file).then(() => true, () => false)).toBe(true);
    await f.command(peer, "/sidekick restart"); await peer.run("NEXT", 10_000);
    expect((await f.checkpoint(peer))?.sessionId).toBe(cp.sessionId);
    expect((await peer.getLastAssistantText()).text).toContain("handoffs=1");
    // Past the delayed preflight boundary, the timed-out task must NOT write.
    await new Promise(resolve => setTimeout(resolve, 3200));
    expect(await readFile(join(f.cwd, "worker-output.txt"), "utf8")).toBe("worker tasks=1");
    expect(await readFile(cp.file, "utf8")).not.toContain("PREFLIGHT_DELAY");
  } finally { await f.finish(); }
}, 15_000);

test("tree rollback to historical running checkpoint excludes future history even after reload", async () => {
  const f = await fixture();
  try {
    const peer = await f.make(); await peer.run("FIRST", 10_000); const original = (await f.checkpoint(peer))!;
    await peer.run("SECOND", 10_000); await peer.run("FUTURE_THIRD", 10_000);
    await f.command(peer, "/fixture_tree_running"); await f.command(peer, "/fixture_reload");
    await peer.run("BRANCH", 10_000); const cp = (await f.checkpoint(peer))!;
    expect(cp.file).not.toBe(original.file);
    expect((await peer.getLastAssistantText()).text).toContain("handoffs=1");
    const history = await readFile(cp.file, "utf8"); expect(history).not.toContain("FUTURE_THIRD"); expect(history).not.toContain("Goal:\\nSECOND");
  } finally { await f.finish(); }
}, 15_000);

test("workspace writer lease blocks another Sidekick AND another Lead's native write", async () => {
  const f = await fixture();
  try {
    const a = await f.make(); const b = await f.make();
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const unsub = a.onEvent(e => { if (e.type === "tool_execution_update" && JSON.stringify(e.partialResult).includes("Running bash")) started(); });
    const active = a.run("SLOW", 10_000); await ready;
    await b.run("FIRST", 10_000); expect((await b.getLastAssistantText()).text).toContain("Another Sidekick writer");
    await b.run("LEAD_WRITE", 10_000); expect((await b.getLastAssistantText()).text).toContain("Workspace writer is owned");
    expect(await access(join(f.cwd, "lead-write.txt")).then(() => true, () => false)).toBe(false);
    const blockedShell = await b.request({ type: "bash", command: "printf overwritten > worker-output.txt" }).then(r => r.output, error => String(error));
    expect(blockedShell).toContain("Workspace writer is owned");
    expect(await access(join(f.cwd, "worker-output.txt")).then(() => true, () => false)).toBe(false);
    await a.abort(); await active; unsub();
    await b.run("LEAD_WRITE", 10_000); expect(await readFile(join(f.cwd, "lead-write.txt"), "utf8")).toBe("lead mutation");
    expect((await b.request({ type: "bash", command: "printf native-shell > lead-shell.txt" })).exitCode).toBe(0);
    expect(await readFile(join(f.cwd, "lead-shell.txt"), "utf8")).toBe("native-shell");
  } finally { await f.finish(); }
}, 20_000);

test("failed final checkpoint is an error and never publishes uncommitted success", async () => {
  const f = await fixture();
  const old = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.env);
  let worker: PersistentWorker | undefined;
  try {
    const saved: Checkpoint[] = [];
    worker = new PersistentWorker({ cwd: f.cwd, owner: "offline-save-failure", sessionDir: join(f.root, "workers"), config: await loadConfig(f.cwd), save: cp => {
      if (cp.tasks === 1) throw new Error("checkpoint write failed"); saved.push(cp);
    } });
    const result = await worker.run({ brief: "FIRST" }, undefined, () => {});
    expect(result.status).toBe("error"); expect(result.report).toContain("checkpoint write failed");
    expect(result.checkpoint?.status).toBe("running"); expect(result.checkpoint?.tasks).toBe(0); expect(saved.at(-1)?.status).toBe("running");
  } finally { await worker?.stop(); for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await f.finish(); }
}, 15_000);

test("restored-session lock compromise cancels CURRENT task and releases workspace", async () => {
  const f = await fixture();
  const old = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]])); Object.assign(process.env, f.env);
  let worker: PersistentWorker | undefined;
  try {
    const options = { cwd: f.cwd, owner: "offline-lock", sessionDir: join(f.root, "workers"), config: f.config, save: (_cp: Checkpoint) => {} };
    worker = new PersistentWorker(options); await worker.run({ brief: "FIRST" }, undefined, () => {}); const cp = worker.checkpoint;
    await worker.stop(); worker = new PersistentWorker({ ...options, checkpoint: cp });
    await worker.run({ brief: "NEXT" }, undefined, () => {}); // Establish restored lease on an earlier controller.
    let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
    const active = worker.run({ brief: "SLOW" }, undefined, activity => { if (activity === "Running bash") ready(); });
    await started; await rm(cp!.file + ".lock", { recursive: true, force: true });
    expect((await active).status).toBe("cancelled");
    expect(await access(join(f.cwd, ".pi", "sidekick-writer.lock")).then(() => true, () => false)).toBe(false);
    await expect(worker.run({ brief: "AGAIN" }, undefined, () => {})).rejects.toThrow("compromised");
  } finally { await worker?.stop(); for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await f.finish(); }
}, 15_000);

test("real native append ENOSPC fail-stops dirty Lead AFTER worker cleanup, with no orphan entries", async () => {
  const f = await fixture(10_000, true);
  try {
    const peer = await f.make(); const leadFile = (await peer.getState()).sessionFile!;
    await expect(peer.run("FIRST", 10_000)).rejects.toThrow("RPC process exited");
    expect(await readFile(join(f.root, "append-failure.log"), "utf8")).toContain("native in-memory mutation");
    const records = (await readFile(leadFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const ids = new Set(records.map(e => e.id));
    for (const entry of records) if (entry.parentId) expect(ids.has(entry.parentId)).toBe(true);
    expect(records.some(e => e.customType === CHECKPOINT_TYPE && e.data?.tasks === 1)).toBe(false);
    expect(await access(join(f.cwd, ".pi", "sidekick-writer.lock")).then(() => true, () => false)).toBe(false);
    expect(await readFile(join(f.cwd, "worker-output.txt"), "utf8")).toBe("worker tasks=1");
    await expect(peer.getState()).rejects.toThrow(); // No restart from poisoned in-memory tree.
  } finally { await f.finish(); }
}, 15_000);

test("first preflight cancellation retains binding and never executes the revoked brief later", async () => {
  const f = await fixture();
  try {
    const peer = await f.make(); let cancelled: Promise<void> | undefined;
    const unsub = peer.onEvent(e => {
      if (!cancelled && e.type === "tool_execution_update" && JSON.stringify(e.partialResult).includes("Sidekick executing brief")) {
        cancelled = peer.abort(); void cancelled.catch(() => {});
      }
    });
    await peer.run("PREFLIGHT_DELAY", 10_000); unsub(); expect(cancelled).toBeDefined(); await cancelled;
    const cp = (await f.checkpoint(peer))!; expect(cp.status).toBe("cancelled");
    expect(await access(cp.file).then(() => true, () => false)).toBe(true);
    await f.command(peer, "/sidekick restart"); await peer.run("CONTINUE", 10_000);
    expect((await f.checkpoint(peer))?.file).toBe(cp.file);
    await new Promise(resolve => setTimeout(resolve, 3200));
    expect(await readFile(join(f.cwd, "worker-output.txt"), "utf8")).toBe("worker tasks=1");
    expect(await readFile(cp.file, "utf8")).not.toContain("PREFLIGHT_DELAY");
  } finally { await f.finish(); }
}, 15_000);
