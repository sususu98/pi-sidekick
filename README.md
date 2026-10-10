# pi-sidekick

Fusion-style pairing for [Pi](https://github.com/earendil-works/pi): keep the current frontier model as **Lead**, delegate bounded work to one fast **persistent Sidekick**, then review its report. Both keep separate native Pi JSONL histories.

## Status

First milestone implemented: **Bun-native RPC + two models**. Tested offline with Bun 1.4.2 and Pi 1.1.0 using deterministic models and real built-in tools. Real-provider latency/quality and interactive terminal appearance have **not** been validated. No automatic model routing, worker pool, background handoff or split-screen viewer yet.

## Development / local loading

```sh
bun install --frozen-lockfile
bun run check
pi -e ./extensions/index.ts
```

To run the Lead itself with Bun during local development:

```sh
bun ./node_modules/@earendil-works/pi-coding-agent/dist/bun/cli.js -e ./extensions/index.ts
```

The Sidekick always runs Pi's Bun entry using `bun` on PATH. A normal npm-installed Pi package and a Bun runtime are required; standalone compiled Pi distributions without `dist/bun/cli.js` are not supported yet. Loading the extension does not start a worker or call a model. Nothing is installed into your global Pi configuration automatically.

## Choose the pair

Select the Lead normally with Pi's `/model`, then configure a **different** Sidekick:

```text
/sidekick model cpal-google/gemini-3.8-flash high
/sidekick status
```

The provider/model must actually be registered and authenticated in your Pi installation. These are examples, not bundled model definitions. Model selection enables delegation and is persisted on this Lead branch, without changing global model defaults.

Alternatively, set defaults for new Lead sessions in `.pi/sidekick.json`:

```json
{
  "enabled": true,
  "sidekick": {
    "provider": "cpal-google",
    "model": "gemini-3.8-flash",
    "thinkingLevel": "high"
  },
  "providerExtensions": [],
  "timeoutMs": 600000,
  "maxReportChars": 12000
}
```

**Custom providers:** normal `models.json`, stored credentials and environment variables are resolved by the worker's native Pi. Provider registrations held only in the Lead's process cannot cross RPC automatically. If your provider comes from an extension, explicitly list its absolute file path (or a path relative to the workspace) in `providerExtensions`. Only list trusted **provider** extensions, never this Sidekick extension. Worker extension discovery is disabled; its tools are restricted to `read`, `bash`, `edit`, `write`.

Session-saved command configuration takes precedence over the file's new-session defaults. Do not put API keys in this file. The worker's actual provider/model/thinking are checked before dispatch; missing providers, credentials or unsupported thinking fail without silently selecting another model.

## Workflow and commands

The Lead calls `sidekick({ brief, constraints?, acceptance? })`. A handoff blocks until the native worker settles, then returns its final report and usage. Only activity metadata is streamed to the Lead; private reasoning and raw tool logs stay in the worker history. Send review feedback through the same tool to continue the same conversation.

| Command | Effect |
|---|---|
| `/sidekick status` | Pair, state and worker JSONL path |
| `/sidekick model provider/id [thinking]` | Bind a model; default thinking is `high` |
| `/sidekick on` / `/sidekick off` | Enable/disable delegation; retain history |
| `/sidekick steer correction` | Queue correction in the active worker |
| `/sidekick cancel` | Stop execution and retain partial history |
| `/sidekick restart` | Stop process; restore the same history on next handoff |
| `/sidekick reset --yes` | Explicitly detach history; leave old JSONL and workspace files intact |
| `/sidekick stats` | Separate Lead and last-checkpoint Sidekick token counts |

Changing the worker model requires an explicit history reset. Normal successful tasks keep the worker alive and idle. Cancellation, timeout or transport failure may stop the **process** to prevent late preflight execution; the next explicit handoff restores its **session**, not a replay of the interrupted task.

## Reliability and limits

- Bindings/checkpoints live in non-context custom entries on the active Lead branch. Restart and `/reload` restore them.
- Fork/tree navigation derives the worker's corresponding conversation branch, excluding future history. **This never rolls back filesystem edits.** Inspect files after branching or cancellation.
- Heartbeat writer leases serialize cooperating Sidekick, Lead mutating tools, and Pi's native local `!`/RPC Bash across the same workspace. Critical Lead edits are still allowed while the worker is idle. This is **not an OS sandbox**; external programs, background processes and dishonest tool annotations are outside this guarantee. The native user-Bash wrapper owns local execution; combining it with another extension that replaces user-Bash operations (for example remote SSH execution) is not supported in this milestone.
- File leases use a Bun-safe atomic `mkdir` gate and token-specific metadata (`<target>.lock/owner-<token>.json`), replacing `proper-lockfile` to avoid the uncaught exception reported when Pi's Bun fs Proxy encountered `proper-lockfile/lib/mtime-precision.js:6 fs[cacheSymbol]` (TypeError: Proxy handler get result non-configurable/non-writable invariant). This is tailored to the Pi/Bun fs-proxy environment, not a broad claim that proper-lockfile fails everywhere under Bun.
- Reclamation is strictly local-host advisory: an expired lock is only automatically reclaimed if the owning process PID is confirmed dead on the local host (`ESRCH`) and its heartbeat age has exceeded `stale`. Living but paused/busy processes are never stolen. Foreign hostnames, corrupted/incomplete metadata, and stuck gate locks fail closed (`ELOCKED`). If a process crashes while holding the gate directory, confirm the owner process is dead before removing `<target>.lock.gate` manually.
- **Safe migration from crashed proper-lockfile sessions:** An earlier crash under `proper-lockfile` may leave an empty `.pi/sidekick-writer.lock` directory on disk. The new protocol conservatively rejects ownerless directories as invalid metadata (`ELOCKED`). To safely recover: first confirm no Lead or Sidekick process is running; then delete the empty directory with non-recursive `rmdir .pi/sidekick-writer.lock`. Do **not** delete your session JSONL files and do **not** run `/sidekick reset` (which detaches worker conversation history).
- Do not open a second writable Pi instance on an active worker JSONL. Use a read-only viewer for auditing.
- Reports are bounded. Missing/corrupt history fails closed; only explicit reset starts fresh history. A failed checkpoint is not reported as success. A **Lead session append/storage failure** stops the Worker, then terminates the unsafe Lead runtime: native Pi mutates its in-memory tree before writing, and has no public transactional rollback. Repair storage and resume the last valid persisted session; do not continue from the poisoned in-memory tree.
- Both sessions use native Pi compaction independently. Persistent history does not imply permanent prompt-cache hits or a fixed token/cost saving.

See [architecture and implementation gates](docs/architecture.md) and [offline verification](docs/verification.md).

## License

MIT
