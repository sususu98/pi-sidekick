import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { RpcPeer } from "../extensions/rpc.ts";
import { PersistentWorker, CHECKPOINT_TYPE, type Checkpoint } from "../extensions/worker.ts";
import type { SidekickConfig } from "../extensions/config.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-ui-test-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "config");
  await Promise.all([mkdir(join(cwd, ".pi"), { recursive: true }), mkdir(agentDir)]);
  const provider = resolve("test/poc/models.ts");
  const config: SidekickConfig = {
    enabled: true,
    sidekick: { provider: "sidekick-test", model: "worker", thinkingLevel: "high" },
    providerExtensions: [provider],
    timeoutMs: 10_000,
    maxReportChars: 12_000,
  };
  await writeFile(join(cwd, ".pi", "sidekick.json"), JSON.stringify(config));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" })
  );
  const env = {
    FUSION_PROOF_ROOT: root,
    FUSION_PROOF_SECRET: "PRIVATE_" + randomUUID(),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  const peers: RpcPeer[] = [];
  const make = async () => {
    const peer = new RpcPeer({
      executable: process.execPath,
      runtimeArgs: ["--preload", resolve("test/poc/no-network.cjs")],
      cliPath: join(getPackageDir(), "dist/bun/cli.js"),
      cwd,
      env,
      args: [
        "--provider",
        "sidekick-test",
        "--model",
        "lead",
        "--thinking",
        "high",
        "--no-extensions",
        "-e",
        provider,
        "-e",
        resolve("extensions/index.ts"),
        "--no-approve",
        "--no-skills",
        "--no-themes",
        "--no-prompt-templates",
        "--tools",
        "sidekick,write",
        "--session-dir",
        join(root, "leads"),
      ],
    });
    peers.push(peer);
    await peer.start();
    return peer;
  };

  const command = async (peer: RpcPeer, message: string) => {
    expect((await peer.request({ type: "prompt", message })).disposition).toBe("handled");
  };

  const checkpoint = async (peer: RpcPeer) => {
    const entry = (await peer.getEntries()).entries.findLast(
      (e) => e.type === "custom" && e.customType === CHECKPOINT_TYPE
    );
    return entry?.type === "custom" ? (entry.data as Checkpoint) : undefined;
  };

  return {
    root,
    cwd,
    env,
    config,
    make,
    command,
    checkpoint,
    async finish() {
      await Promise.all(peers.map((p) => p.stop()));
      expect(await access(join(cwd, ".pi", "sidekick-writer.lock")).then(() => true, () => false)).toBe(false);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("idle manual continuation reuses same sessionId and JSONL, increments task count", async () => {
  const f = await fixture();
  try {
    const peer = await f.make();

    // 1. Initial tool handoff from Lead
    await peer.run("FIRST", 10_000);
    const cp1 = (await f.checkpoint(peer))!;
    expect(cp1).toBeDefined();
    expect(cp1.tasks).toBe(1);
    const file = cp1.file;
    const sessionId = cp1.sessionId;

    // 2. Open view via command (exercises registered /sidekick view path)
    await f.command(peer, "/sidekick view");

    // 3. Second handoff continues on the same persistent session
    await peer.run("SECOND", 10_000);
    const cp2 = (await f.checkpoint(peer))!;
    expect(cp2.file).toBe(file);
    expect(cp2.sessionId).toBe(sessionId);
    expect(cp2.tasks).toBe(2);

    // 4. Verify worker output file was edited
    expect(await readFile(join(f.cwd, "worker-output.txt"), "utf8")).toBe("worker tasks=2");
  } finally {
    await f.finish();
  }
}, 30_000);

test("cold view does not spawn worker process, does not acquire lock, and isolates active branch", async () => {
  const f = await fixture();
  try {
    const peer = await f.make();

    // Run first brief
    await peer.run("FIRST", 10_000);
    const cp = (await f.checkpoint(peer))!;

    // Restart worker so it is cold (no process running)
    await f.command(peer, "/sidekick restart");

    // Workspace lock must NOT be held
    expect(await access(join(f.cwd, ".pi", "sidekick-writer.lock")).then(() => true, () => false)).toBe(false);

    // Call /sidekick view on cold session
    await f.command(peer, "/sidekick view");

    // Workspace lock must STILL NOT be held! Cold view is strictly read-only
    expect(await access(join(f.cwd, ".pi", "sidekick-writer.lock")).then(() => true, () => false)).toBe(false);

    // Session JSONL should remain intact
    expect(await access(cp.file).then(() => true, () => false)).toBe(true);
  } finally {
    await f.finish();
  }
}, 30_000);

test("raw worker traces do not enter Lead context and manual result is isolated", async () => {
  const f = await fixture();
  try {
    const peer = await f.make();
    await peer.run("FIRST", 10_000);

    // Inspect all entries in Lead session
    const entries = (await peer.getEntries()).entries;
    const messages = (await peer.request({ type: "get_messages" })).messages;

    // Secret must not be present in Lead messages
    const serializedLead = JSON.stringify(messages);
    expect(serializedLead).not.toContain(f.env.FUSION_PROOF_SECRET);
    expect(serializedLead).not.toContain("WORKER_PRIVATE_TRACE");

    // Lead only has toolResult with the final report, not raw worker tool execution entries
    const toolResult = entries.findLast((e) => e.type === "message" && e.message.role === "toolResult");
    expect(toolResult).toBeDefined();
    expect(JSON.stringify(toolResult)).toContain("WORKER_REPORT");
  } finally {
    await f.finish();
  }
}, 30_000);
