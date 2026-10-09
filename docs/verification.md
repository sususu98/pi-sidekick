# Offline verification

## Run

```sh
bun install --frozen-lockfile
bun run check
```

To exercise the actual installed Pi entry instead of the dependency's unbundled CLI, run `TEST_PI_ENTRY="$(command -v pi)" bun test test/integration.test.ts` (still fully isolated/offline). The user's installed Bun wrapper was also verified this way.

Set `KEEP_POC=1` to retain the PoC/production-pair fixtures in temporary directories. Tests never install the extension into user configuration or invoke real providers. Both Lead and Worker run native Pi under Bun.

## Coverage

- `test/poc.test.ts`: replays the actual 2026-09-30 feasibility fixture against the current Pi version, including persistence, context isolation, native file tools, progress, process restarts, cancellation, steering and fork.
- `test/integration.test.ts`: repeats those requirements against the production extension, including `/reload`, reset/on/off, model failures, worker exit/recovery, timeout, report limits, missing history, absent providers and identical-model rejection. Worker usage is attached to Lead tool results once.
- `test/config.test.ts`: strict configuration/model parsing and branch-local binding/reset restoration.
- `test/rpc.test.ts`: split UTF-8/Unicode separators, CRLF, malformed/incomplete/oversized framing, missing executable cleanup, handled/rejected prompts, early exit and request deadlines.
- `test/regression.test.ts`: delayed preflight cannot execute after timeout; first-failure reserved JSONL survives restart; historical running-checkpoint tree rollback survives reload; cross-Lead/Sidekick/model-tool/native-user-Bash single-writer leases; final checkpoint failure is not success; actual native append ENOSPC fail-stops the dirty Lead after Worker cleanup; restored lock compromise cancels the current controller and releases the workspace.

Every fixture has isolated credentials/settings/workspace/session directories. Deterministic providers emit real model events and invoke native `write`, `edit`, and `bash`. A guard rejects fetch/http/https calls and records any intercepted attempt; tests assert none occurred. Missing-executable and RPC-only transport tests have no models. Cleanup closes clients and checks process/lock release.

## Important implementation edges

1. Pi 1.1.0's public `RpcClient` forces Node. Our thin transport accepts the runtime and uses exported native protocol types; no private client access, PATH shim, custom agent loop or Pi patch.
2. Native `abort()` can succeed while prompt authentication/hooks are still in preflight. Error/cancel handling closes the process before releasing writer ownership; session history remains resumable.
3. Native Pi defers creating a new or setup-only branch JSONL until conversation exists. Reserve a canonical SDK-generated header (and native setup entries for a setup-only branch) before launching/opening it, so failure cannot save a nonexistent binding or invent a new session identity. No fake user message is inserted.
4. Recovery of an actually interrupted run and navigation to a historical running checkpoint are different. Tree navigation persists a branch-local cancellation marker, so subsequent reload cannot absorb future Worker history.
5. Persist final checkpoint state before publishing it. Native Pi's append mutates its own in-memory tree first; on actual Lead append failure, stop the Worker and fail-stop the Lead before it can write children of an uncommitted entry. A test injects ENOSPC into native `fs.appendFileSync`, not just a mock callback. Cleanup uses nested finally blocks so a compromised file lease cannot skip workspace release.
6. Cancellation races both prompt acceptance and settled waits. Closing only after a still-pending acceptance promise resolves is too late: a delayed preflight could already execute the revoked brief.
7. Native user Bash bypasses `tool_call`. Wrap native local Bash operations with the same workspace lease; test the actual RPC `bash` command, not only a model-issued `write`.

## Not demonstrated

These tests do not establish real GPT/Gemini performance, upstream cache retention, cost savings, complete Devin behavior, visual TUI quality or two-window rendering. No production extension has been globally installed and no live model validation is implied.
