import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getPackageDir, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { RpcPeer } from "../extensions/rpc.ts";

// Replays the actual 2026-09-30 feasibility checks with Bun for BOTH processes.
test("Bun native RPC: persistent pair, isolation, restart, cancellation, steering and fork", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-poc-"));
  await Promise.all([mkdir(join(root, "config")), mkdir(join(root, "workspace"))]);
  const extension = resolve("test/poc/fixture.ts");
  const guard = resolve("test/poc/no-network.cjs");
  const checks: string[] = [];
  const pids: number[] = [];
  const env = {
    FUSION_PROOF_ROOT: root, FUSION_PROOF_EXTENSION: extension, FUSION_PROOF_GUARD: guard,
    FUSION_PROOF_SECRET: "PRIVATE_" + randomUUID(), PI_CODING_AGENT_DIR: join(root, "config"),
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
  };
  const make = (file?: string) => new RpcPeer({
    executable: process.execPath, runtimeArgs: ["--preload", guard], cliPath: join(getPackageDir(), "dist/bun/cli.js"), cwd: join(root, "workspace"), env,
    args: ["--provider", "fusion-proof", "--model", "lead", "--no-extensions", "-e", extension, "--no-skills", "--no-themes", "--no-prompt-templates", "--no-approve", "--thinking", "high", "--tools", "fusion_worker", "--session-dir", join(root, "lead-sessions"), ...(file ? ["--session", file] : [])],
  });
  let peer = make();
  const record = async () => (await peer.getEntries()).entries.findLast(e => e.type === "custom" && e.customType === "fusion-proof-checkpoint") as { data: { file: string; leaf: string; owner: string } };
  const prompt = async (message: string, count: number) => {
    const events: JsonAgentSessionEvent[] = [];
    const unsub = peer.onEvent(event => events.push(event));
    try { await peer.run(message, 30_000); } finally { unsub(); }
    const text = (await peer.getLastAssistantText()).text;
    expect(text).toContain(`WORKER_REPORT tasks=${count} remembered=true`);
    expect(events.some(e => e.type === "tool_execution_update")).toBe(true);
    return (await record()).data;
  };
  try {
    await peer.start(); pids.push(peer.pid!);
    const lead = await peer.getState(); expect(lead.model?.id).toBe("lead");
    const first = await prompt("FIRST", 1); const second = await prompt("SECOND", 2);
    expect(second.file).toBe(first.file);
    const messages = JSON.stringify((await peer.request({ type: "get_messages" })).messages);
    expect(messages).not.toContain(env.FUSION_PROOF_SECRET); expect(messages).not.toContain("WORKER_PRIVATE_TRACE");
    expect(await readFile(join(root, "workspace", "worker-output.txt"), "utf8")).toBe("worker tasks=2");
    checks.push("same persistent worker, context isolation, native write, progress");
    await peer.request({ type: "prompt", message: "/fixture_restart" });
    expect((await prompt("THIRD", 3)).file).toBe(first.file); checks.push("worker process restart restores same JSONL");
    const leadFile = (await peer.getState()).sessionFile!;
    await peer.stop(); peer = make(leadFile); await peer.start(); pids.push(peer.pid!);
    expect((await prompt("FOURTH", 4)).file).toBe(first.file); checks.push("both processes restart with original sessions");
    let cancel: Promise<void> | undefined;
    const unsub = peer.onEvent(event => {
      if (!cancel && event.type === "tool_execution_update" && JSON.stringify(event.partialResult).includes("tool_execution_start")) {
        cancel = peer.abort(); void cancel.catch(() => {});
      }
    });
    await peer.run("SLOW", 30_000); unsub(); expect(cancel).toBeDefined(); await cancel;
    expect((await peer.getState()).isStreaming).toBe(false);
    expect((await prompt("CONTINUE", 6)).file).toBe(first.file); checks.push("cancelled history persists and continues");
    const users = (await peer.request({ type: "get_fork_messages" })).messages;
    const fork = await peer.request({ type: "fork", entryId: users.find(m => m.text === "SECOND")!.entryId });
    expect(fork.cancelled).toBe(false);
    const branch = await prompt("BRANCH", 2); expect(branch.file).not.toBe(first.file);
    expect(await readFile(branch.file, "utf8")).not.toContain("FOURTH"); checks.push("fork excludes future worker history");
    let steer: Promise<unknown> | undefined;
    const unsteer = peer.onEvent(event => {
      if (!steer && event.type === "tool_execution_update" && JSON.stringify(event.partialResult).includes("tool_execution_start")) {
        steer = peer.request({ type: "prompt", message: "/fixture_steer" }); void steer.catch(() => {});
      }
    });
    expect((await prompt("STEER_TEST", 4)).file).toBe(branch.file); unsteer(); expect(steer).toBeDefined(); await steer;
    expect(await readFile(branch.file, "utf8")).toContain("CORRECTION_KEEP_SCOPE"); checks.push("in-flight steering in same history");
    expect((await peer.getState()).model?.id).toBe("lead");
    expect(await access(join(root, "network-attempts.log")).then(() => true, () => false)).toBe(false);
    checks.push("Lead unchanged; zero intercepted fetch/http/https attempts");
    console.log("Bun PoC PASS:", checks.join("; "));
  } finally {
    await peer.stop();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    await writeFile(join(root, "report.json"), JSON.stringify({ checks }, null, 2));
    if (process.env.KEEP_POC) console.log("PoC artifacts:", root); else await rm(root, { recursive: true, force: true });
  }
}, 90_000);
