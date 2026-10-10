import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface FileLockOptions {
  /** Lock stale threshold in milliseconds. Defaults to 10,000 ms. Must be a positive integer. */
  stale?: number;
  /** Heartbeat interval in milliseconds. Defaults to max(floor(stale / 2), 10) ms. Must be a positive integer < stale. */
  update?: number;
  /** Maximum wait time for atomic gate in milliseconds. Defaults to 5,000 ms. Must be a positive integer. */
  gateTimeoutMs?: number;
  /** Callback triggered when lock ownership is lost or compromised. */
  onCompromised?: (error: Error) => void | Promise<void>;
  /** Internal test hooks for concurrency and fault-injection verification. */
  _testHooks?: {
    beforeHeartbeatGate?: () => Promise<void>;
    insideHeartbeatGate?: () => Promise<void>;
    beforeReleaseGate?: () => Promise<void>;
    insideReleaseGate?: () => Promise<void>;
    fs?: {
      writeFile?: (path: string, data: string, options?: unknown) => Promise<void>;
    };
  };
}

export type FileLockRelease = {
  (): Promise<void>;
  token?: string;
  forceHeartbeat?: () => Promise<void>;
  getCallbackRejection?: () => unknown;
};

export interface LockOwnerMetadata {
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
  lastHeartbeat: number;
}

export function lockError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Safe token pattern: alphanumeric, hyphen, underscore; 1 to 128 characters. */
const SAFE_TOKEN_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Check whether a process with the given PID is alive on the local host.
 */
export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== "number" || isNaN(pid) || pid <= 0 || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false; // Process does not exist
    }
    // EPERM means process exists but belongs to another user -> alive
    return true;
  }
}

/**
 * Executes a short critical section under an atomic mkdir gate.
 * The gate fails closed if ownership cannot be resolved within bounded wait time.
 * Uses monotonic performance.now() to protect against wall-clock regressions.
 */
export async function withGate<T>(
  gatePath: string,
  fn: () => Promise<T>,
  options?: { gateTimeoutMs?: number }
): Promise<T> {
  const timeoutMs = options?.gateTimeoutMs ?? 5_000;
  const start = performance.now();
  let delay = 5;

  while (true) {
    try {
      await mkdir(gatePath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (performance.now() - start >= timeoutMs) {
        throw lockError(
          "ELOCKED",
          `Lock gate timed out waiting for ${gatePath}. If a previous owner crashed holding the gate, verify the process is dead and remove ${gatePath} manually.`
        );
      }
      const sleepMs = Math.min(delay, 50) + Math.floor(Math.random() * 5);
      await new Promise((r) => setTimeout(r, sleepMs));
      delay = Math.min(delay * 1.5, 50);
    }
  }

  let fnError: unknown;
  try {
    return await fn();
  } catch (err) {
    fnError = err;
    throw err;
  } finally {
    try {
      await rmdir(gatePath);
    } catch (gateErr) {
      if ((gateErr as NodeJS.ErrnoException).code !== "ENOENT") {
        const cleanupError = lockError(
          (gateErr as NodeJS.ErrnoException).code ?? "EFAIL",
          `Failed to cleanly release lock gate ${gatePath}: ${(gateErr as Error).message}`
        );
        if (fnError) {
          Object.assign(cleanupError, { cause: fnError });
        }
        throw cleanupError;
      }
    }
  }
}

/**
 * Reads and strictly validates owner metadata schema from lockPath.
 * Any missing, negative, corrupted, or schema-violating metadata fails closed with ELOCKED.
 */
async function readOwnerMetadata(lockPath: string): Promise<{ file: string; metadata: LockOwnerMetadata } | null> {
  let entries: string[];
  try {
    entries = await readdir(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const ownerFiles = entries.filter((e) => (e.startsWith("owner-") && e.endsWith(".json")) || e === "owner.json");
  if (ownerFiles.length === 0) {
    return null;
  }
  if (ownerFiles.length > 1) {
    throw lockError("ELOCKED", `Ambiguous lock state: multiple owner files in ${lockPath}`);
  }

  const ownerFile = ownerFiles[0];
  const fullPath = join(lockPath, ownerFile);
  let raw: string;
  try {
    raw = await readFile(fullPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw lockError("ELOCKED", `Corrupted owner metadata JSON in ${fullPath}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw lockError("ELOCKED", `Invalid owner metadata object in ${fullPath}`);
  }

  const obj = parsed as Record<string, unknown>;

  // Strict PID check: must be a positive integer
  if (typeof obj.pid !== "number" || !Number.isInteger(obj.pid) || obj.pid <= 0) {
    throw lockError("ELOCKED", `Invalid owner PID in metadata: ${fullPath} (pid must be a positive integer)`);
  }

  // Strict token check: non-empty safe string
  if (typeof obj.token !== "string" || !SAFE_TOKEN_PATTERN.test(obj.token)) {
    throw lockError("ELOCKED", `Invalid or unsafe owner token in metadata: ${fullPath}`);
  }

  // Token consistency with filename: if owner-<token>.json, the filename token must match JSON content
  const tokenMatch = ownerFile.match(/^owner-([a-zA-Z0-9_-]+)\.json$/);
  if (tokenMatch && tokenMatch[1] !== obj.token) {
    throw lockError("ELOCKED", `Owner token mismatch between filename (${ownerFile}) and metadata token (${obj.token})`);
  }

  // Strict hostname check: non-empty string <= 256 chars
  if (typeof obj.hostname !== "string" || obj.hostname.trim().length === 0 || obj.hostname.length > 256) {
    throw lockError("ELOCKED", `Invalid owner hostname in metadata: ${fullPath}`);
  }

  // Strict timestamps: finite positive numbers
  if (typeof obj.createdAt !== "number" || !Number.isFinite(obj.createdAt) || obj.createdAt <= 0) {
    throw lockError("ELOCKED", `Invalid createdAt timestamp in metadata: ${fullPath}`);
  }
  if (typeof obj.lastHeartbeat !== "number" || !Number.isFinite(obj.lastHeartbeat) || obj.lastHeartbeat <= 0) {
    throw lockError("ELOCKED", `Invalid lastHeartbeat timestamp in metadata: ${fullPath}`);
  }

  return {
    file: ownerFile,
    metadata: {
      token: obj.token,
      pid: obj.pid,
      hostname: obj.hostname,
      createdAt: obj.createdAt,
      lastHeartbeat: obj.lastHeartbeat,
    },
  };
}

function validateOptions(options: FileLockOptions): { stale: number; update: number; gateTimeoutMs: number } {
  const stale = options.stale ?? 10_000;
  if (!Number.isFinite(stale) || stale <= 0 || !Number.isInteger(stale)) {
    throw lockError("EINVAL", "FileLock option 'stale' must be a positive integer");
  }

  const update = options.update ?? Math.max(Math.floor(stale / 2), 10);
  if (!Number.isFinite(update) || update <= 0 || !Number.isInteger(update)) {
    throw lockError("EINVAL", "FileLock option 'update' must be a positive integer");
  }
  if (update >= stale) {
    throw lockError("EINVAL", `FileLock option 'update' (${update}ms) must be less than 'stale' (${stale}ms)`);
  }

  const gateTimeoutMs = options.gateTimeoutMs ?? 5_000;
  if (!Number.isFinite(gateTimeoutMs) || gateTimeoutMs <= 0 || !Number.isInteger(gateTimeoutMs)) {
    throw lockError("EINVAL", "FileLock option 'gateTimeoutMs' must be a positive integer");
  }

  return { stale, update, gateTimeoutMs };
}

/**
 * Bun-safe cross-process advisory lock.
 *
 * Guarantees and design bounds:
 * 1. Local-host advisory: liveness verification relies on local OS signals (`process.kill(pid, 0)`).
 *    Locks held by foreign hostnames or containing corrupted metadata fail closed with ELOCKED.
 * 2. Atomic serialization: all acquire, reclaim, heartbeat, and release operations are serialized
 *    via an atomic `mkdir` gate (`<target>.lock.gate`).
 * 3. Safe dead-owner reclamation: stale locks are only reclaimed if the owning process is confirmed
 *    dead on the local machine AND its lastHeartbeat age has exceeded the stale threshold. Living but
 *    paused/busy processes are never stolen. Fresh-but-dead owners fail closed until stale duration passes.
 * 4. Token-specific owner files and non-recursive `rmdir`: each lease writes `owner-<token>.json`.
 *    A stale release or heartbeat verifies its specific token file and will never delete or renew
 *    a successor's lock.
 * 5. Fail-closed gate: if a process crashes while holding the gate directory, wait times out with
 *    ELOCKED. To recover, confirm the owner process is dead and remove `<target>.lock.gate` manually.
 */
export async function acquireFileLock(target: string, options: FileLockOptions = {}): Promise<FileLockRelease> {
  const { stale, update, gateTimeoutMs } = validateOptions(options);
  const lockPath = `${resolve(target)}.lock`;
  const gatePath = `${lockPath}.gate`;
  const localHostname = hostname();
  const writeFn = options._testHooks?.fs?.writeFile ?? writeFile;

  await mkdir(dirname(lockPath), { recursive: true });

  const token = randomUUID();
  const tokenFileName = `owner-${token}.json`;
  const tokenFilePath = join(lockPath, tokenFileName);

  // Phase 1: Acquire or reclaim under atomic gate
  await withGate(gatePath, async () => {
    let lockStat: { mtimeMs: number } | null = null;
    try {
      lockStat = await stat(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (lockStat !== null) {
      const existingOwner = await readOwnerMetadata(lockPath);
      if (!existingOwner) {
        throw lockError("ELOCKED", `Lock directory exists without valid owner metadata: ${lockPath}`);
      }

      if (existingOwner.metadata.hostname !== localHostname) {
        throw lockError("ELOCKED", `Lock is held by another host (${existingOwner.metadata.hostname}): ${target}`);
      }

      if (isProcessAlive(existingOwner.metadata.pid)) {
        throw lockError("ELOCKED", `Lock file is already being held by active process ${existingOwner.metadata.pid}: ${target}`);
      }

      // Owner process is dead on local host. Check stale duration.
      const now = Date.now();
      const age = now - existingOwner.metadata.lastHeartbeat;
      if (age <= stale) {
        throw lockError(
          "ELOCKED",
          `Lock file owner (PID ${existingOwner.metadata.pid}) is dead but lease has not expired yet (${age}ms <= ${stale}ms): ${target}`
        );
      }

      // Expired dead owner: reclaim safely
      await unlink(join(lockPath, existingOwner.file));
      await rmdir(lockPath);
    }

    // Create fresh lock directory and token-specific metadata file
    await mkdir(lockPath);

    const metadata: LockOwnerMetadata = {
      token,
      pid: process.pid,
      hostname: localHostname,
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
    };

    try {
      await writeFn(tokenFilePath, JSON.stringify(metadata), { mode: 0o600 });
    } catch (writeErr) {
      // Clean up partially written file and newly created directory on initialization failure
      await unlink(tokenFilePath).catch(() => {});
      await rmdir(lockPath).catch(() => {});
      throw writeErr;
    }
  }, { gateTimeoutMs });

  // Phase 2: Lease tracking and heartbeat
  type LockStatus = "active" | "closing" | "finished";
  let status: LockStatus = "active";
  let isCompromised = false;
  let compromisedError: (Error & { code: string }) | undefined;
  let callbackRejection: unknown | undefined;
  let inFlightHeartbeat: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let releasePromise: Promise<void> | undefined;

  const notifyCompromised = (error: unknown): void => {
    if (status === "finished" || isCompromised) return;
    isCompromised = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    const failure = error instanceof Error
      ? (("code" in error ? error : Object.assign(error, { code: "ECOMPROMISED" })) as Error & { code: string })
      : lockError("ECOMPROMISED", String(error));
    failure.name = "FileLockCompromisedError";
    compromisedError = failure;

    if (options.onCompromised) {
      try {
        const res = options.onCompromised(failure);
        if (res && typeof (res as Promise<unknown>).then === "function") {
          (res as Promise<unknown>).catch((cbErr) => {
            callbackRejection = cbErr;
            Object.assign(failure, { callbackError: cbErr });
            process.emitWarning(
              `onCompromised callback rejected: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
              "FileLockCallbackWarning"
            );
          });
        }
      } catch (cbErr) {
        callbackRejection = cbErr;
        Object.assign(failure, { callbackError: cbErr });
        process.emitWarning(
          `onCompromised callback threw: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
          "FileLockCallbackWarning"
        );
      }
    }
  };

  const heartbeat = async (): Promise<void> => {
    if (status === "finished" || isCompromised) return;
    if (inFlightHeartbeat) return;

    const currentPromise = (async () => {
      try {
        if (options._testHooks?.beforeHeartbeatGate) {
          await options._testHooks.beforeHeartbeatGate();
        }

        await withGate(gatePath, async () => {
          if (status === "finished" || isCompromised) return;

          if (options._testHooks?.insideHeartbeatGate) {
            await options._testHooks.insideHeartbeatGate();
          }

          let content: string;
          try {
            content = await readFile(tokenFilePath, "utf8");
          } catch (err) {
            throw lockError("ECOMPROMISED", `Owner file missing or unreadable: ${tokenFilePath}`);
          }

          let parsed: LockOwnerMetadata;
          try {
            parsed = JSON.parse(content);
          } catch {
            throw lockError("ECOMPROMISED", `Owner file corrupted: ${tokenFilePath}`);
          }

          if (parsed.token !== token || parsed.pid !== process.pid || parsed.hostname !== localHostname) {
            throw lockError("ECOMPROMISED", `Lock token mismatch: expected token=${token} pid=${process.pid}, found token=${parsed.token} pid=${parsed.pid}`);
          }

          parsed.lastHeartbeat = Date.now();
          await writeFile(tokenFilePath, JSON.stringify(parsed), { mode: 0o600 });

          const now = new Date();
          await utimes(lockPath, now, now);
        }, { gateTimeoutMs });
      } catch (error) {
        notifyCompromised(error);
      }
    })();

    inFlightHeartbeat = currentPromise;
    try {
      await currentPromise;
    } finally {
      if (inFlightHeartbeat === currentPromise) {
        inFlightHeartbeat = undefined;
      }
    }
  };

  timer = setInterval(() => {
    heartbeat().catch(() => {});
  }, update);

  const maybeUnref = timer as ReturnType<typeof setInterval> & { unref?: () => void };
  maybeUnref.unref?.();

  // Phase 3: Release function
  const release = async (): Promise<void> => {
    if (status === "finished") {
      throw lockError("ERELEASED", `Lock is already released: ${lockPath}`);
    }

    if (status === "closing") {
      // Concurrently called: await active release
      return await releasePromise!;
    }

    status = "closing";

    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }

    releasePromise = (async () => {
      try {
        // Drain any in-flight heartbeat before releasing
        if (inFlightHeartbeat) {
          try {
            await inFlightHeartbeat;
          } catch {
            // Error forwarded to notifyCompromised
          }
        }

        if (isCompromised) {
          throw compromisedError ?? lockError("ECOMPROMISED", `Lock was compromised: ${lockPath}`);
        }

        if (options._testHooks?.beforeReleaseGate) {
          await options._testHooks.beforeReleaseGate();
        }

        await withGate(gatePath, async () => {
          if (options._testHooks?.insideReleaseGate) {
            await options._testHooks.insideReleaseGate();
          }

          let dirExists = false;
          try {
            await stat(lockPath);
            dirExists = true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }

          if (!dirExists) {
            return; // Lock directory was already removed
          }

          let rawContent: string | null = null;
          try {
            rawContent = await readFile(tokenFilePath, "utf8");
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }

          if (rawContent === null) {
            const failure = lockError("ECOMPROMISED", `Lock owner file missing before release: ${tokenFilePath}`);
            notifyCompromised(failure);
            throw lockError("ENOTACQUIRED", `Lock is no longer owned by this token (${token}): ${lockPath}`);
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(rawContent);
          } catch {
            const failure = lockError("ECOMPROMISED", `Lock owner file corrupted before release: ${tokenFilePath}`);
            notifyCompromised(failure);
            throw failure;
          }

          if (
            !parsed ||
            typeof parsed !== "object" ||
            (parsed as Record<string, unknown>).token !== token ||
            (parsed as Record<string, unknown>).pid !== process.pid ||
            (parsed as Record<string, unknown>).hostname !== localHostname
          ) {
            const failure = lockError(
              "ECOMPROMISED",
              `Lock metadata in ${tokenFilePath} was altered before release (token mismatch or invalid owner)`
            );
            notifyCompromised(failure);
            throw lockError("ENOTACQUIRED", `Lock metadata token mismatch: ${tokenFilePath}`);
          }

          // Verified owner: unlink specific token file, then rmdir
          await unlink(tokenFilePath);
          try {
            await rmdir(lockPath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }, { gateTimeoutMs });
      } finally {
        status = "finished";
        releasePromise = undefined;
      }
    })();

    return await releasePromise;
  };

  const fileRelease = release as FileLockRelease;
  fileRelease.token = token;
  fileRelease.forceHeartbeat = heartbeat;
  fileRelease.getCallbackRejection = () => callbackRejection;

  return fileRelease;
}
