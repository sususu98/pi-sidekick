# Architecture and implementation gates

## Source requirements

- `01a0f02a-e1b6-7622-b768-668f0ec09ac7`, 2026-09-30: the user's requirement is two persistent conversation tracks. The concluding design is **one Lead + one isolated RPC Worker**, synchronous handoff, checkpoint restore, cancellation without discarding history, and no silent model fallback. Earlier in-process SDK pseudocode was illustrative and contained incorrect signatures; it is not the final design.
- `01a114a2-3394-7172-938a-f5425f8f4a09`, 2026-10-07/08: Jev navigates, Fusion executes, Dream consolidates memory. Many-worker collaboration is a future direction, not this milestone. Later single-session model-switching suggestions conflict with the explicit dual-session requirement and are not used.
- `01a12070-2ebc-73ed-a323-54a11a6138d0` is the subsequent history-lookup conversation, not the original architecture discussion.
- Current milestone: Bun compatibility first, then exactly two models. Lead remains the current Pi session/model; the configured Sidekick executes only assigned briefs. No hard-coded token-share target.

## Gates

1. Offline Bun PoC using the installed Pi extension loader and real native tools. Verify repeated delegation, separate JSONL/context, process restart, cancellation/continuation, in-flight steering, and Lead fork checkpoint isolation. Block outbound HTTP/fetch. No live model calls or user configuration changes.
2. Implement the small two-model extension using the proven mechanism; run the same checks against the production extension. Include failure paths, timeouts, malformed RPC, unexpected exits and resource cleanup.
3. Only then perform separately authorized real-model latency/quality tests. Mock success is not evidence of GPT/Gemini performance or complete Devin parity.

## RPC and Bun

Pi 1.1.0's exported `RpcClient` hard-codes `spawn("node", ...)`. It cannot select Bun through its public options. Do not patch Pi, access private client state, or install PATH shims. A small runtime-selectable transport is therefore needed for native Bun workers. It uses Pi's exported RPC command/response/event types and strict LF JSONL framing. Pi still owns the agent loop, tools, providers, persistence, compaction, steering and cancellation; this extension implements only orchestration and transport.

Use Pi's Bun CLI entry when running Bun. Explicitly select provider/model/thinking and verify actual worker state before dispatch; never silently fall back. Disable extension discovery in the Worker, loading only the worker-role extension and explicitly configured provider extensions. Standard credentials/models are resolved by Pi; credentials are not copied into Lead checkpoints or generated config.

## Invariants

- Reuse one idle Worker process/session across tasks; recreate a process from the same JSONL when necessary. Finished tasks do not dispose the Worker.
- Persist binding/checkpoints as non-context custom entries on the active Lead branch, not a global session map.
- Cancellation clears queues before abort, preserves partial history and warns that files may already have changed. Never automatically re-execute an interrupted task.
- Fork/backtracking uses the corresponding Worker leaf; future conversation must not leak into the branch. Conversation branching does not revert filesystem changes.
- One task/writer at a time. Do not impose an always-read-only Lead: the prior design explicitly permits necessary evidence reads and critical edits when the Worker is idle. Concurrency controls are not an OS sandbox.
- Forward activity metadata, not raw Worker thinking/logs, to Lead model context. Only final reports enter the handoff result.
- Use Pi's native independent compaction. No recursive agent tools in the Worker.
- First version is synchronous. Background delegation, multi-writer worktrees, risk routing, complex cost-savings estimates, and dual-window viewers are deferred. An external viewer must be read-only, never a second writer on the active JSONL.
