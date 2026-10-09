import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface ModelUsage { provider: string; model: string; usage: Usage }
export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export function addUsage(target: Usage, value: Usage): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) target[key] += value[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target.cost[key] += value.cost[key];
  if (value.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + value.reasoning;
  if (value.cacheWrite1h !== undefined) target.cacheWrite1h = (target.cacheWrite1h ?? 0) + value.cacheWrite1h;
}
export function collectUsage(entries: readonly SessionEntry[]): ModelUsage[] {
  const models = new Map<string, ModelUsage>();
  const add = (provider: string, model: string, usage: Usage) => {
    const key = JSON.stringify([provider, model]);
    let record = models.get(key);
    if (!record) { record = { provider, model, usage: zeroUsage() }; models.set(key, record); }
    addUsage(record.usage, usage);
  };
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") add(entry.message.provider, entry.message.model, entry.message.usage);
    else if (entry.type === "usage") add(entry.provider, entry.model, entry.usage);
    else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) add("unknown", "summary", entry.usage);
    else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) add("nested", entry.message.toolName, entry.message.usage);
  }
  return [...models.values()];
}
export function totalUsage(models: readonly ModelUsage[]): Usage {
  const usage = zeroUsage();
  for (const model of models) addUsage(usage, model.usage);
  return usage;
}
