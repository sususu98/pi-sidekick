import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export interface SidekickModel { provider: string; model: string; thinkingLevel: ThinkingLevel }
export interface SidekickConfig {
  enabled: boolean;
  sidekick?: SidekickModel;
  providerExtensions: string[];
  timeoutMs: number;
  maxReportChars: number;
}
export const DEFAULT_CONFIG: SidekickConfig = { enabled: false, providerExtensions: [], timeoutMs: 600_000, maxReportChars: 12_000 };
export function parseConfig(value: unknown): SidekickConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sidekick configuration must be an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!["enabled", "sidekick", "providerExtensions", "timeoutMs", "maxReportChars"].includes(key)) throw new Error(`Unknown sidekick setting: ${key}`);
  let sidekick: SidekickModel | undefined;
  if (raw.sidekick !== undefined) {
    if (!raw.sidekick || typeof raw.sidekick !== "object" || Array.isArray(raw.sidekick)) throw new Error("sidekick must be an object");
    const model = raw.sidekick as Record<string, unknown>;
    for (const key of Object.keys(model)) if (!["provider", "model", "thinkingLevel"].includes(key)) throw new Error(`Unknown model setting: ${key}`);
    if (typeof model.provider !== "string" || !model.provider.trim() || typeof model.model !== "string" || !model.model.trim()) throw new Error("sidekick.provider and sidekick.model are required");
    const thinkingLevel = model.thinkingLevel ?? "high";
    if (!THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel)) throw new Error("Invalid sidekick thinkingLevel");
    sidekick = { provider: model.provider.trim(), model: model.model.trim(), thinkingLevel: thinkingLevel as ThinkingLevel };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("enabled must be boolean");
  const enabled = (raw.enabled as boolean | undefined) ?? Boolean(sidekick);
  if (enabled && !sidekick) throw new Error("Configure a sidekick model first");
  const providerExtensions = raw.providerExtensions ?? [];
  if (!Array.isArray(providerExtensions) || providerExtensions.some(p => typeof p !== "string" || !p.trim())) throw new Error("providerExtensions must be an array of nonempty file paths");
  const number = (key: "timeoutMs" | "maxReportChars", min: number, max: number): number => {
    const n = raw[key] ?? DEFAULT_CONFIG[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
    return n;
  };
  return { enabled, sidekick, providerExtensions: [...providerExtensions], timeoutMs: number("timeoutMs", 100, 86_400_000), maxReportChars: number("maxReportChars", 256, 100_000) };
}
export async function loadConfig(cwd: string): Promise<SidekickConfig> {
  try { return parseConfig(JSON.parse(await readFile(join(cwd, ".pi", "sidekick.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG, providerExtensions: [] }; throw error; }
}
export function parseModelSpec(spec: string, thinkingLevel = "high"): SidekickModel {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) throw new Error("Use provider/model-id (the model ID may itself contain /)");
  return parseConfig({ sidekick: { provider: spec.slice(0, slash), model: spec.slice(slash + 1), thinkingLevel } }).sidekick!;
}
export const resolveProviderExtensions = (cwd: string, config: SidekickConfig): string[] => config.providerExtensions.map(path => resolve(cwd, path));
export const sameModel = (a: SidekickModel, b: SidekickModel) => a.provider === b.provider && a.model === b.model && a.thinkingLevel === b.thinkingLevel;
