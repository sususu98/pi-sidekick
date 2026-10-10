import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, stat, unlink, utimes, writeFile, access } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock, isProcessAlive, lockError, withGate } from "../extensions/lock.ts";

test("isProcessAlive accurately reflects process state", async () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(-1)).toBe(false);
  expect(isProcessAlive(0)).toBe(false);
  expect(isProcessAlive(NaN)).toBe(false);
  expect(isProcessAlive(1.5)).toBe(false);

  // Spawn and wait for a process to terminate
  const child = Bun.spawn(["bun", "-e", "process.exit(0)"]);
  await child.exited;
  expect(isProcessAlive(child.pid)).toBe(false);
});

test("strict metadata validation: negative, zero, float PID, token mismatch, and corrupted schema fail closed without deleting", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-lock-schema-"));
  const target = join(root, "schema-test");
  const lockDir = `${target}.lock`;

  try {
    await mkdir(lockDir, { recursive: true });

    // Test cases that must fail closed with ELOCKED and NOT be deleted
    const badCases: Array<{ name: string; file: string; content: string }> = [
      {
        name: "negative PID",
        file: "owner-token-neg.json",
        content: JSON.stringify({ token: "token-neg", pid: -123, hostname: hostname(), createdAt: Date.now() - 60000, lastHeartbeat: Date.now() - 60000 }),
      },
      {
        name: "zero PID",
        file: "owner-token-zero.json",
        content: JSON.stringify({ token: "token-zero", pid: 0, hostname: hostname(), createdAt: Date.now() - 60000, lastHeartbeat: Date.now() - 60000 }),
      },
      {
        name: "float PID",
        file: "owner-token-float.json",
        content: JSON.stringify({ token: "token-float", pid: 123.45, hostname: hostname(), createdAt: Date.now() - 60000, lastHeartbeat: Date.now() - 60000 }),
      },
      {
        name: "filename token mismatch",
        file: "owner-tokenA.json",
        content: JSON.stringify({ token: "tokenB", pid: 999999, hostname: hostname(), createdAt: Date.now() - 60000, lastHeartbeat: Date.now() - 60000 }),
      },
      {
        name: "unsafe token characters",
        file: "owner-bad.json",
        content: JSON.stringify({ token: "../unsafe/path", pid: 999999, hostname: hostname(), createdAt: Date.now() - 60000, lastHeartbeat: Date.now() - 60000 }),
      },
      {
        name: "empty hostname",
        file: "owner-token-nohost.json",
        content: JSON.stringify({ token: "token-nohost", pid: 999999, hostname: "", createdAt: Date.now() - 60000, lastHeartbeat: Date.now() - 60000 }),
      },
      {
        name: "negative timestamp",
        file: "owner-token-negtime.json",
        content: JSON.stringify({ token: "token-negtime", pid: 999999, hostname: hostname(), createdAt: -100, lastHeartbeat: -100 }),
      },
      {
        name: "corrupted JSON",
        file: "owner-token-broken.json",
        content: "{ broken json",
      },
    ];

    for (const testCase of badCases) {
      const filePath = join(lockDir, testCase.file);
      await writeFile(filePath, testCase.content, { mode: 0o600 });

      // Must fail closed with ELOCKED
      await expect(acquireFileLock(target, { stale: 2000 })).rejects.toMatchObject({ code: "ELOCKED" });

      // Crucial: metadata file and lock directory MUST NOT have been deleted
      expect(await access(filePath).then(() => true, () => false)).toBe(true);
      expect(await access(lockDir).then(() => true, () => false)).toBe(true);

      // Clean up for next sub-case
      await unlink(filePath);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale reclaim semantics: living PID never stolen, fresh-but-dead rejected, expired dead reclaimed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-lock-stale-"));
  const target = join(root, "stale-semantics");
  const lockDir = `${target}.lock`;

  try {
    await mkdir(lockDir, { recursive: true });

    // 1. Living process with old heartbeat: NEVER STOLEN even when age > stale
    const aliveToken = "alive-token";
    const aliveFile = join(lockDir, `owner-${aliveToken}.json`);
    await writeFile(
      aliveFile,
      JSON.stringify({
        token: aliveToken,
        pid: process.pid,
        hostname: hostname(),
        createdAt: Date.now() - 30_000,
        lastHeartbeat: Date.now() - 30_000,
      }),
      { mode: 0o600 }
    );
    await expect(acquireFileLock(target, { stale: 2000 })).rejects.toMatchObject({ code: "ELOCKED" });
    expect(await access(aliveFile).then(() => true, () => false)).toBe(true);
    await unlink(aliveFile);

    // 2. Dead process with fresh heartbeat (age <= stale): fresh-but-dead must NOT be reclaimed yet
    const deadChild = Bun.spawn(["bun", "-e", "process.exit(0)"]);
    await deadChild.exited;
    const deadPid = deadChild.pid;
    expect(isProcessAlive(deadPid)).toBe(false);

    const freshDeadToken = "fresh-dead-token";
    const freshDeadFile = join(lockDir, `owner-${freshDeadToken}.json`);
    await writeFile(
      freshDeadFile,
      JSON.stringify({
        token: freshDeadToken,
        pid: deadPid,
        hostname: hostname(),
        createdAt: Date.now(),
        lastHeartbeat: Date.now(), // freshly dead!
      }),
      { mode: 0o600 }
    );

    // Stale threshold is 500ms; heartbeat was just set to now
    await expect(acquireFileLock(target, { stale: 500 })).rejects.toMatchObject({ code: "ELOCKED" });
    // Still exists: not stolen
    expect(await access(freshDeadFile).then(() => true, () => false)).toBe(true);

    // Wait until age > stale (wait 600ms)
    await new Promise((r) => setTimeout(r, 600));

    // Now age > stale: expired dead owner is safely reclaimed!
    const release = await acquireFileLock(target, { stale: 500 });
    expect(release).toBeDefined();
    expect(release.token).not.toBe(freshDeadToken);

    // Clean release
    await release();
    expect(await access(lockDir).then(() => true, () => false)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release with tampered metadata before heartbeat: refuses to delete, triggers onCompromised, and returns error", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-lock-tamper-release-"));
  const target = join(root, "tamper-before-release");
  const lockDir = `${target}.lock`;

  try {
    let compromisedError: Error | undefined;
    const release = await acquireFileLock(target, {
      stale: 200_000,
      update: 100_000, // Do not auto heartbeat
      onCompromised: (err) => { compromisedError = err; },
    });
    const token = release.token!;
    const tokenFile = join(lockDir, `owner-${token}.json`);

    // Tamper with the owner file content before heartbeat runs (simulate external alteration)
    await writeFile(
      tokenFile,
      JSON.stringify({
        token: "successor-or-tampered-token",
        pid: process.pid,
        hostname: hostname(),
        createdAt: Date.now(),
        lastHeartbeat: Date.now(),
      }),
      { mode: 0o600 }
    );

    // Call release(): must detect tamper, NOT delete tokenFile, notify compromise, and throw
    await expect(release()).rejects.toThrow();

    expect(compromisedError).toBeDefined();
    expect((compromisedError as any).code).toBe("ECOMPROMISED");

    // The tampered / successor file MUST NOT have been deleted!
    expect(await access(tokenFile).then(() => true, () => false)).toBe(true);
    expect(await access(lockDir).then(() => true, () => false)).toBe(true);

    await rm(lockDir, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release closing status drains in-flight heartbeat and delivers compromise callback with rejection tracking", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-lock-drain-"));
  const target = join(root, "drain-lease");
  const lockDir = `${target}.lock`;

  try {
    let callbackDelivered = false;
    let insideHeartbeat = false;
    let unblockHeartbeat!: () => void;
    const heartbeatPaused = new Promise<void>((r) => { unblockHeartbeat = r; });

    const release = await acquireFileLock(target, {
      update: 50,
      onCompromised: async (_err) => {
        callbackDelivered = true;
        throw new Error("Simulated onCompromised rejection");
      },
      _testHooks: {
        insideHeartbeatGate: async () => {
          insideHeartbeat = true;
          // While paused inside gate, delete the lock directory to simulate fatal failure
          await rm(lockDir, { recursive: true, force: true });
          await heartbeatPaused;
        },
      },
    });

    // Wait until heartbeat enters gate
    while (!insideHeartbeat) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Call release while heartbeat is inside gate
    const releasePromise = release();

    // Heartbeat can now proceed and notice lockDir is gone
    unblockHeartbeat();

    // Release should reject with ECOMPROMISED
    await expect(releasePromise).rejects.toMatchObject({ code: "ECOMPROMISED" });

    // The onCompromised callback MUST have been called even though release was in "closing" status!
    expect(callbackDelivered).toBe(true);

    // Callback rejection was recorded
    const rejection = release.getCallbackRejection?.();
    expect(rejection).toBeDefined();
    expect((rejection as Error).message).toContain("Simulated onCompromised rejection");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent release calls await the active release cleanly and subsequent calls throw ERELEASED", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-lock-concurrent-release-"));
  const target = join(root, "concurrent-release");

  try {
    const release = await acquireFileLock(target, { stale: 200_000, update: 100_000 });

    // Call release concurrently 3 times
    const results = await Promise.allSettled([release(), release(), release()]);

    // All concurrent in-flight calls should succeed cleanly
    for (const res of results) {
      expect(res.status).toBe("fulfilled");
    }

    // Subsequent call after finished must throw ERELEASED
    await expect(release()).rejects.toMatchObject({ code: "ERELEASED" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initialization failure with partial write cleans up partial file, directory, and gate without residue", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-lock-partial-write-"));
  const target = join(root, "partial-fault");
  const lockDir = `${target}.lock`;
  const gateDir = `${lockDir}.gate`;

  try {
    // Custom writeFile hook: writes 10 bytes then throws EIO
    const partialWriteHook = async (filePath: string, data: string, opts: unknown) => {
      await writeFile(filePath, data.slice(0, 10), opts as any);
      throw lockError("EIO", "Simulated EIO after partial write");
    };

    await expect(
      acquireFileLock(target, {
        _testHooks: {
          fs: { writeFile: partialWriteHook },
        },
      })
    ).rejects.toMatchObject({ code: "EIO" });

    // Completely cleaned up after partial write failure
    expect(await access(lockDir).then(() => true, () => false)).toBe(false);
    expect(await access(gateDir).then(() => true, () => false)).toBe(false);

    // Immediately acquire normally to verify clean state
    const release = await acquireFileLock(target);
    expect(await access(lockDir).then(() => true, () => false)).toBe(true);
    await release();
    expect(await access(lockDir).then(() => true, () => false)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("withGate reports non-ENOENT rmdir cleanup errors instead of claiming clean gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-gate-err-"));
  const gatePath = join(root, "test.gate");

  try {
    // Create a non-empty gate directory inside the gate so rmdir fails with ENOTEMPTY
    await expect(
      withGate(gatePath, async () => {
        await writeFile(join(gatePath, "nested-file.txt"), "blocking-file");
        return "ok";
      })
    ).rejects.toThrow("Failed to cleanly release lock gate");

    // Clean up
    await rm(gatePath, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("option validation rejects invalid intervals and timeouts with EINVAL", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-lock-opts-"));
  const target = join(root, "opts");

  try {
    await expect(acquireFileLock(target, { stale: -100 })).rejects.toMatchObject({ code: "EINVAL" });
    await expect(acquireFileLock(target, { stale: 0 })).rejects.toMatchObject({ code: "EINVAL" });
    await expect(acquireFileLock(target, { stale: 1.5 })).rejects.toMatchObject({ code: "EINVAL" });
    await expect(acquireFileLock(target, { update: 10_000, stale: 5_000 })).rejects.toMatchObject({ code: "EINVAL" });
    await expect(acquireFileLock(target, { gateTimeoutMs: 0 })).rejects.toMatchObject({ code: "EINVAL" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multiple independent Bun processes concurrently reclaiming the same dead owner: exactly ONE winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-lock-reclaim-"));
  const target = join(root, "contested");
  const lockDir = `${target}.lock`;

  try {
    await mkdir(lockDir, { recursive: true });

    // Spawn a child that immediately exits to get a verified dead PID
    const deadChild = Bun.spawn(["bun", "-e", "process.exit(0)"]);
    await deadChild.exited;
    const deadPid = deadChild.pid;
    expect(isProcessAlive(deadPid)).toBe(false);

    const deadToken = "dead-owner-token";
    await writeFile(
      join(lockDir, `owner-${deadToken}.json`),
      JSON.stringify({
        token: deadToken,
        pid: deadPid,
        hostname: hostname(),
        createdAt: Date.now() - 30_000,
        lastHeartbeat: Date.now() - 30_000,
      }),
      { mode: 0o600 }
    );

    // Helper script run by independent Bun child processes
    const workerScript = join(root, "worker.mjs");
    await writeFile(
      workerScript,
      `
import { acquireFileLock } from ${JSON.stringify(join(process.cwd(), "extensions", "lock.ts"))};
const target = process.argv[2];
try {
  const release = await acquireFileLock(target, { stale: 2000, update: 200, gateTimeoutMs: 4000 });
  // Winner holds the lock briefly so competing processes must observe ELOCKED
  await new Promise((r) => setTimeout(r, 300));
  await release();
  process.exit(0);
} catch (err) {
  if (err && err.code === "ELOCKED") {
    process.exit(1);
  }
  console.error("Worker error:", err);
  process.exit(2);
}
      `.trim()
    );

    // Launch 6 independent processes concurrently
    const CONCURRENCY = 6;
    const processes = Array.from({ length: CONCURRENCY }, () =>
      Bun.spawn(["bun", workerScript, target], { stdout: "pipe", stderr: "pipe" })
    );

    const exitCodes = await Promise.all(processes.map((p) => p.exited));

    const winners = exitCodes.filter((code) => code === 0);
    const locked = exitCodes.filter((code) => code === 1);
    const errors = exitCodes.filter((code) => code === 2);

    expect(errors.length).toBe(0);
    expect(winners.length).toBe(1);
    expect(locked.length).toBe(CONCURRENCY - 1);

    // Winner released cleanly; no orphaned lock or gate
    expect(await access(lockDir).then(() => true, () => false)).toBe(false);
    expect(await access(`${lockDir}.gate`).then(() => true, () => false)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated acquire, heartbeat, and release cycles complete cleanly without resource leaks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-lock-loop-"));
  const target = join(root, "tight-loop");

  try {
    for (let i = 0; i < 30; i++) {
      const release = await acquireFileLock(target, { update: 50 });
      await release.forceHeartbeat!();
      await release();

      // Double release check for ERELEASED
      await expect(release()).rejects.toMatchObject({ code: "ERELEASED" });
    }

    expect(await access(`${target}.lock`).then(() => true, () => false)).toBe(false);
    expect(await access(`${target}.lock.gate`).then(() => true, () => false)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
