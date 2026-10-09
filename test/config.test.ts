import { test, expect } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { parseConfig, parseModelSpec, resolveProviderExtensions } from "../extensions/config.ts";
import { CHECKPOINT_TYPE, restoreCheckpoint, type Checkpoint } from "../extensions/worker.ts";

test("strict configuration validates models, thinking, bounds and provider paths", () => {
  expect(parseConfig({}).enabled).toBe(false);
  const model = parseModelSpec("openrouter/google/gemini", "high");
  expect(model).toEqual({ provider: "openrouter", model: "google/gemini", thinkingLevel: "high" });
  const config = parseConfig({ sidekick: model, providerExtensions: ["provider.ts"] });
  expect(config.enabled).toBe(true); expect(resolveProviderExtensions("/tmp/workspace", config)).toEqual(["/tmp/workspace/provider.ts"]);
  for (const invalid of [null, [], { enabled: true }, { secretKey: "must-not-store" }, { enabled: "yes" }, { sidekick: { provider: "a", model: "b", thinkingLevel: "ultra" } }, { timeoutMs: 0 }, { maxReportChars: 5 }, { providerExtensions: [4] }]) expect(() => parseConfig(invalid)).toThrow();
  expect(() => parseModelSpec("no-provider")).toThrow();
});

test("binding restore follows active branch and explicit reset, not all appended entries", () => {
  const manager = SessionManager.inMemory("/tmp/workspace");
  const cp: Checkpoint = { version: 1, owner: "lead", file: "/tmp/worker.jsonl", sessionId: "worker", leaf: "leaf", model: parseModelSpec("a/b"), status: "idle", tasks: 1 };
  const first = manager.appendCustomEntry(CHECKPOINT_TYPE, cp);
  manager.appendCustomEntry(CHECKPOINT_TYPE, { ...cp, tasks: 2 });
  expect(restoreCheckpoint(manager.getBranch())?.tasks).toBe(2);
  manager.branch(first); expect(restoreCheckpoint(manager.getBranch())?.tasks).toBe(1);
  manager.appendCustomEntry(CHECKPOINT_TYPE, null); expect(restoreCheckpoint(manager.getBranch())).toBeUndefined();
  manager.appendCustomEntry(CHECKPOINT_TYPE, { version: 999 }); expect(() => restoreCheckpoint(manager.getBranch())).toThrow();
});
