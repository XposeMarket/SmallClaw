# SmallClaw → OpenClaw Gap Analysis & Improvement Plan
*Cross-examination of OpenClaw docs against SmallClaw source. Focus: small-model (4B) compatibility.*

---

## TL;DR

SmallClaw has solid bones — the `node_call<>` execution channel, the cron scheduler, the fact-store, and the background task runner all work. But it's been built organically and has accumulated significant technical debt compared to what OpenClaw has evolved into. The gaps fall into five categories: **Memory**, **Cron/Heartbeat**, **Tool Calling**, **Session Management**, and **General Architecture**. Every item below is either a real bug, a context-budget leak that kills 4B models, or a missing feature that would meaningfully improve reliability.

---

## 1. Memory System

### 1.1 No `memory_search` Tool (Critical Gap)
**File:** `src/tools/memory.ts`, `src/tools/registry.ts`

SmallClaw only exposes `memory_write`. There is no agent-callable tool to *read* memory semantically. The `queryFactRecords()` function in `fact-store.ts` exists but is never wired up as a tool the model can call. The model has no autonomous way to recall anything it has stored.

**Fix:** Add a `memory_search` tool that calls `queryFactRecords()` and returns top matches. Even without vector embeddings, the existing BM25-style token scoring in `queryFactRecords` is good enough for a 4B model. Schema:
```ts
{
  name: 'memory_search',
  description: 'Search long-term memory for relevant facts',
  schema: {
    query: 'string (required) - what to look for',
    session_id: 'string (optional) - narrow to session scope',
    max: 'number (optional, default 5) - max results'
  }
}
```

### 1.2 Daily Memory Files Are Never Read Back
**File:** `src/gateway/memory-manager.ts` (lines: `appendDailyMemoryNote`, `getDailyMemoryPath`)

Daily memory files (`memory/YYYY-MM-DD.md`) are written by `appendDailyMemoryNote()` but **nothing ever reads them back into a session**. OpenClaw automatically reads today's + yesterday's daily note at session start. SmallClaw just appends and forgets.

**Fix:** In session initialization (`server-v2.ts`), read today's and yesterday's `memory/YYYY-MM-DD.md` and prepend them as a system context block before the main system prompt. Keep it capped at ~800 tokens.

### 1.3 Memory Architecture Is Over-Engineered for 4B Models
**File:** `src/gateway/memory-manager.ts`

The `persistMemoryClaim()` function routes to three destinations (DAILY_NOTE, TYPED_FACT, CURATED_PROFILE) based on type, scope, and confidence. This is correct architecture but the `addMemoryFact()` function duplicates the confidence threshold logic, the sanitize function, and the fact-store upsert — creating two code paths that can diverge. It also calls `registry.get('memory_write')` as a tool instead of calling the store directly, adding indirection and creating a circular dependency risk.

**Fix:** Collapse `addMemoryFact()` and `persistMemoryClaim()` into one function. The dual-write (daily note + SQLite) can stay, but remove the registry intermediary for internal writes. Only the model-facing `memory_write` tool should go through the registry.

### 1.4 No Pre-Compaction Memory Flush
**File:** No equivalent exists.

OpenClaw fires a silent agent turn before context compaction to prompt the model to write durable memory. SmallClaw has no context tracking at all, so it just hard-truncates at 20 messages with no warning and no flush.

**Fix:** Add a token estimate to `addMessage()`. When the session is nearing the context limit (e.g., >75% of `num_ctx`), inject a synthetic user message: *"Before continuing: write any important facts from this conversation to memory now."* Then allow one agent turn. This is the 4B-compatible version of OpenClaw's `memoryFlush`.

### 1.5 The Sanitize Function Is Duplicated
**Files:** `src/gateway/memory-manager.ts` (line ~23), `src/tools/memory.ts` (line ~8)

Two near-identical `sanitize()`/`sanitizeText()` functions exist in different files. They even read the same `cfg.memory_options.truncate_length` config key.

**Fix:** Extract to `src/tools/memory-utils.ts` and import from both.

### 1.6 Temporal Decay / MMR Not Present
This is the "nice to have if we get there" category. OpenClaw's `temporalDecay` and MMR re-ranking for memory search are genuinely valuable for agents with months of daily notes. Since SmallClaw doesn't have vector search yet, the BM25 scorer in `queryFactRecords` should at least weight results by recency — just add a `(now - updated_at) / halflife` multiplier to the score before sorting.

---

## 2. Cron / Heartbeat

### 2.1 Heartbeat and Cron Jobs Are Conflated (Design Problem)
**File:** `src/gateway/cron-scheduler.ts`

In SmallClaw, the heartbeat is just another `CronJob` entry with `type: 'heartbeat'`. In OpenClaw, they are fundamentally different concepts:
- **Heartbeat**: runs in the *main session*, with full conversation context, batching multiple checks in one turn.
- **Cron job**: runs in an *isolated session* (`cron:<jobId>`), fresh context, optional model override.

SmallClaw's design means all cron jobs share the same session memory and the heartbeat mixes with discrete scheduled jobs. This is confusing for the model and inefficient.

**Fix:**
1. Pull heartbeat out of the jobs array into its own config/runner. Keep the `HeartbeatConfig` struct but manage it separately.
2. Add a `sessionMode: 'main' | 'isolated'` field to `CronJob`. For `isolated` jobs, create a fresh session ID (`cron_${job.id}_${Date.now()}`) and **do not persist history across runs** (already done — good). For `main` jobs, use the main session session ID so context carries.
3. Introduce a `HEARTBEAT.md` file concept: the heartbeat runner reads this file each tick and injects it as the prompt. This lets users edit what the heartbeat checks without restarting the server. OpenClaw's approach of putting the checklist in a file is much more flexible than a hardcoded prompt string on a job record.

### 2.2 Active Hours Check Is Ignored for Explicit Runs
**File:** `src/gateway/cron-scheduler.ts` line ~170 (`tick()`)

`runJobNow()` bypasses the model-busy guard (correct) but it also bypasses the active hours check. For most use cases this is fine, but `runJobNow` is also called internally from background task recovery paths where active hours should still apply.

**Fix:** `runJobNow()` should accept a `{ respectActiveHours: boolean }` option, defaulting to `false` for direct user calls and `true` for automated recovery calls.

### 2.3 No Stagger for Top-of-Hour Jobs
**File:** `src/gateway/cron-scheduler.ts` — `getNextRun()`

If a user has 3 cron jobs all set to `0 7 * * *`, they all queue simultaneously and the model-busy guard drops 2 of them permanently until next run. There's no jitter.

**Fix:** In `createJob()`, add an optional `staggerMs` field. If two jobs have the same nextRun time, add a deterministic offset based on job ID hash (e.g., `parseInt(job.id.slice(-6), 36) % 120000` for up to 2 min stagger).

### 2.4 Telegram Delivery Is a No-Op Stub
**File:** `src/gateway/cron-scheduler.ts` lines ~95–103

The `deliverTelegram()` stub has been there since initial implementation and the `deps.deliverTelegram` hook is wired up in `server-v2.ts` to the actual Telegram channel. However the `CronScheduler` still has its own internal stub that shadows it.

**Fix:** Remove the internal `deliverTelegram` function entirely. Only use `this.deps.deliverTelegram` (the injected dependency) for delivery. The stub is dead code that creates confusion.

### 2.5 Per-Job Model Override Not Supported
**File:** `src/gateway/cron-scheduler.ts`

OpenClaw lets cron jobs specify `model` and `thinking` overrides per job. SmallClaw always uses the globally configured model. For a small-model-focused fork, being able to say "use the 7B model for this weekly deep-analysis job" is valuable.

**Fix:** Add `model?: string` and `think?: boolean | 'low' | 'medium' | 'high'` to `CronJob`. Pass them to `handleChat()` as an override so the cron runner can temporarily use a different model.

### 2.6 `getNextRun` Month Field Is Silently Dropped
**File:** `src/gateway/cron-scheduler.ts` lines ~69–95

`getNextRun` destructures `[minuteField, hourField, domField, , dowField]` — the 4th field (month) is explicitly discarded with a comma. A job defined as `0 9 1 3 *` (9am on March 1st) will fire on the 1st of *every* month.

**Fix:** Parse and check the month field. Add `const months = parseField(monthField, 1, 12)` and check `(candidate.getMonth() + 1)` against it in the while loop.

### 2.7 Run History Is Not Persisted
**File:** `src/gateway/cron-scheduler.ts`

`lastRun`, `lastResult`, and `lastDuration` are stored on the job record (good) but there is no run history log file. OpenClaw stores per-job run history at `cron/runs/<jobId>.jsonl`. If a job fails repeatedly, there's no way to see the history.

**Fix:** After each job run, append a JSONL entry to `{storePath_dir}/runs/{jobId}.jsonl` with `{ t, status, duration, result_excerpt }`. Limit to last 50 entries per job.

---

## 3. Background Tasks

### 3.1 Session ID Collision Risk
**File:** `src/gateway/background-task-runner.ts` line ~120

```ts
const sessionId = `task_${taskId.slice(0, 8)}`;
```

Two UUIDs with the same first 8 characters will share session history. UUIDs have enough entropy that collisions are rare but not impossible, especially if task IDs are generated from a time-based source.

**Fix:** Use the full task ID: `const sessionId = \`task_${taskId}\``.

### 3.2 Resume Context Can Grow Unbounded
**File:** `src/gateway/background-task-runner.ts` line ~175 (`updateResumeContext`)

`resumeContext.messages` is updated from `getHistory(sessionId, 40)` after every round. `getHistory` returns up to 80 messages (40 turns × 2). After 10 rounds, the resume context in the task JSON could hold 80 messages. On the *next* resume, all 80 messages are re-injected into session history before the new prompt. For a 4B model with a 4096–8192 token context window, this will overflow immediately.

**Fix:** Cap resume context to the last 10 messages (5 turns). For background tasks, recency matters much more than full history. A task that needs 40+ turns of history to function is too large for a 4B model anyway.

```ts
const MAX_RESUME_MESSAGES = 10;
const sessionHistory = getHistory(sessionId, 40);
updateResumeContext(taskId, {
  messages: sessionHistory.slice(-MAX_RESUME_MESSAGES),
  ...
});
```

### 3.3 No Per-Step Timeout
**File:** `src/gateway/background-task-runner.ts` — `_runRoundWithRetry()`

A single `handleChat()` call can hang indefinitely (Ollama timeout, streaming stall, etc.). The retry logic handles connection errors but not hangs. There is no timeout on the outer `while(true)` step loop.

**Fix:** Wrap `handleChat()` in a `Promise.race` with a configurable timeout (default 120s for background tasks):
```ts
const roundTimeout = new Promise<never>((_, reject) => 
  setTimeout(() => reject(new Error('Round timeout (120s)')), 120_000)
);
const attemptResult = await Promise.race([
  this.handleChat(...),
  roundTimeout
]);
```

### 3.4 Task Prompt Is Repeated Verbatim Every Round
**File:** `src/gateway/background-task-runner.ts` line ~215

```ts
const prompt = firstRound && this.openingAction
  ? `[Resuming task from heartbeat...]\n\n${task.prompt}`
  : task.prompt;
```

After the first round, `task.prompt` (the full original user request) is passed to `handleChat()` every single round. For a 4B model, the original request + current session history + system prompt will quickly overflow context. Subsequent rounds should only pass the *current step description*, not the full original request.

**Fix:**
```ts
const currentStep = task.plan[task.currentStepIndex];
const prompt = firstRound
  ? task.prompt
  : `Continue task: ${task.title}\nCurrent step (${task.currentStepIndex + 1}/${task.plan.length}): ${currentStep?.description}\nPrevious step result: ${lastResult.slice(0, 300)}`;
```

### 3.5 `_deliverToChannel` Silently Swallows Errors
**File:** `src/gateway/background-task-runner.ts` lines ~295–310

Both the `addMessage` and the Telegram `sendToAllowed` calls are wrapped in empty `catch {}` blocks. Delivery failures are completely invisible.

**Fix:** Log errors at minimum: `catch (e) { console.warn('[BTR] Delivery failed:', e) }`.

### 3.6 No Max-Step Guardrail Per Task
**File:** `src/gateway/background-task-runner.ts` — `_run()` while loop

The `BackgroundTaskRunner._run()` loop has no overall step limit. If a task's plan never completes (e.g., plan mutations keep adding steps), it will run forever. The `maxPlanDepth: 20` on `TaskRecord` guards against plan growth, but the *execution* loop doesn't check total rounds executed.

**Fix:** Track `roundsExecuted` in the runner. If `roundsExecuted > task.maxPlanDepth * 2`, force `needs_assistance`.

---

## 4. Tool Calling / Reactor

### 4.1 All Tools Are Always Injected (Context Budget Leak)
**File:** `src/tools/registry.ts`, `src/agents/reactor.ts` — `buildNodeCallSystemPrompt`

The system prompt in EXECUTE mode includes the full `getToolSchemas()` output — all 20+ tools injected as text into every prompt. For a 4B model with a 4096-token budget, this text easily costs 600–1000 tokens just for tool descriptions before the user's message appears.

**Fix:** Add tool profiles modeled on OpenClaw's approach:
- `minimal`: just `memory_search`, `memory_write`, `time_now`
- `coding`: fs tools + shell + memory
- `web`: web_search + web_fetch + memory
- `full`: everything

In `buildNodeCallSystemPrompt()`, accept `toolProfile` and only inject descriptions for the relevant tools. The profile can be determined from the user message (e.g., if message mentions a URL, include web tools).

### 4.2 Loop Detection Is Missing
**File:** `src/agents/reactor.ts`

The reactor has a format-violation fuse (good) and a repeat-result circuit breaker (good). But it has no "ping-pong" or "no-progress" detection — a model that alternates between two different node_call blocks with successful but useless results will loop until `maxSteps`.

**Fix:** Implement OpenClaw's `genericRepeat` detector. Track a rolling window of the last 6 `(action, result_hash)` pairs. If the same pair appears 3+ times, break with a warning.

### 4.3 `node_call` Sandbox Blocks `process.exit` But Not `process.kill`
**File:** `src/agents/reactor.ts` — `sandbox` object construction

The sandbox exposes a stripped `process` object but only locks down `env`, `platform`, and `cwd`. A model could write `node_call<process.kill(process.pid, 'SIGKILL')>` to kill the gateway process. `process.kill` is not blocked.

**Fix:**
```ts
process: {
  env: { NODE_ENV: process.env.NODE_ENV || 'production' },
  platform: process.platform,
  cwd: () => workspacePath,
  kill: () => { throw new Error('process.kill is blocked in sandbox'); },
  exit: () => { throw new Error('process.exit is blocked in sandbox'); },
},
```

### 4.4 `apply_patch` Tool Is Missing
**File:** Not present in SmallClaw.

OpenClaw's `apply_patch` is the gold standard for multi-file structured edits. SmallClaw's model has to read a whole file, modify it in JavaScript, and write it back — which is extremely unreliable for 4B models on large files because the entire file content must fit in context.

**Fix:** Add an `apply_patch` tool that accepts a unified diff string and applies it to workspace files. This allows the model to emit just the *diff* rather than the full file, massively reducing context usage.

### 4.5 Tool Schema Inference Uses String Descriptions Only
**File:** `src/tools/registry.ts` — `inferParamSchema()`

The schema inference heuristic works but it guesses types from description strings. Tools that return arrays (like `list_files`) are typed as `string`. This causes Ollama to sometimes pass the wrong type when using native tool calls.

**Fix:** Allow tools to optionally export a `jsonSchema` field with explicit OpenAPI-style parameter definitions. Fall back to the current inference for tools that don't provide it.

---

## 5. Session Management

### 5.1 Hard Limit of 20 Messages With Silent Drop (Critical for 4B)
**File:** `src/gateway/session.ts` lines ~62–65

```ts
if (session.history.length > 20) {
  session.history = session.history.slice(-20);
}
```

This is silent, unannounced context truncation. The model's last message might reference something that was just truncated. For 4B models this is doubly bad because: (1) the model loses grounding, (2) there's no compaction summary so the dropped context is gone forever.

**Fix:** Instead of a hard-coded 20-message limit, implement proper **context-aware pruning**:
1. Keep a running token estimate (rough: `content.length / 3.5`).
2. When the session exceeds `num_ctx * 0.7`, trigger a compaction turn: ask the model to summarize the conversation so far into a single assistant message, then replace the oldest half of history with that summary.
3. Configurable via `cfg.session.maxMessages` and `cfg.session.compactionThreshold`.

### 5.2 Background Task Sessions Use the Same 20-Message Limit
**File:** `src/gateway/session.ts`, used by `background-task-runner.ts`

Background tasks accumulate history differently from user chats — they might have 5 tool call + result pairs per step with no user messages at all. The 20-message cap drops tool results the model needs to complete later steps.

**Fix:** Accept a `maxMessages` parameter in `addMessage()` or allow per-session configuration:
```ts
export function addMessage(id: string, msg: ChatMessage, maxMessages = 20): void
```
Background tasks should use `maxMessages: 40`.

### 5.3 No Session Pruning for Tool Results
**File:** `src/gateway/session.ts`

OpenClaw has a distinct **session pruning** step separate from compaction: trim oversized tool result bodies *in-memory before each request* without touching the session JSONL. SmallClaw stores everything in the message content string with no size capping. A single `readTool` result on a large file will write the whole file content into the session JSON.

**Fix:** In `addMessage()`, if `role === 'assistant'` and content length > 2000 chars, store a truncated version with `[truncated: N chars]` suffix. Tool results > 1000 chars in the stored history are wasteful.

### 5.4 Sessions Are Never Cleaned Up
**File:** `src/gateway/session.ts`

Session JSON files in `.localclaw/sessions/` accumulate forever. The cron session IDs (`cron_job_xxx_1234567890`) and background task session IDs create new files on every run.

**Fix:** On gateway startup, delete session files older than 7 days that don't match the main session IDs. Add a `cleanupSessions()` function called from the startup code.

---

## 6. Tool Registry & Architecture

### 6.1 Tool Registry Is a Singleton But Wired Eagerly
**File:** `src/tools/registry.ts`

The `ToolRegistry` constructor registers all tools eagerly. If a tool module throws on import (e.g., missing optional dependency for web search), it crashes the entire registry.

**Fix:** Wrap each `this.register()` call in a try-catch with a warning log. Tools that fail to load are simply not available rather than crashing the gateway.

### 6.2 No Hook System
**File:** No equivalent exists.

OpenClaw's hook system (event-driven callbacks on `command:new`, `command:reset`, `gateway:startup`, `agent:bootstrap`) is what powers the session-memory hook (saves context on `/new`), the boot-md hook, and custom automation. SmallClaw has nothing equivalent.

This is a significant missing feature for a system aspiring to be an OpenClaw fork. The minimum viable version:

**Fix:** Add a simple `EventEmitter`-based hook system in `src/gateway/hooks.ts`:
```ts
export const hooks = new EventEmitter();
// In server-v2.ts when /new is issued:
hooks.emit('command:new', { sessionId, timestamp });
// In gateway startup:
hooks.emit('gateway:startup');
```
Ship a `session-memory` hook by default that saves the last 10 lines of conversation to `memory/YYYY-MM-DD-slug.md` when `/new` is called.

### 6.3 Config Loading Has No Validation
**File:** `src/config/config.ts` (not read, but referenced throughout)

Multiple files call `getConfig().getConfig()` and then access nested properties with optional chaining (`cfg.memory_options?.truncate_length ?? 1000`). If the config file is malformed, these silently use defaults everywhere. There's no validation or schema check at startup.

**Fix:** Add a `validateConfig()` function called at startup that checks required fields and logs warnings for missing optional fields.

### 6.4 Fact-Store Is Loaded From Disk on Every Query
**File:** `src/gateway/fact-store.ts` — `loadStore()`

Every call to `upsertFactRecord()`, `queryFactRecords()`, and `pruneFactStore()` calls `loadStore()` which reads and parses `facts.json` from disk. Under cron job load with multiple jobs running and memory writes happening, this is 10–20 synchronous file reads per minute.

**Fix:** Cache the store in memory with a dirty flag. Only write to disk when the store is mutated, and only reload from disk when the file's mtime has changed:
```ts
let storeCache: FactStore | null = null;
let storeMtime = 0;
function loadStore(): FactStore {
  const mtime = fs.statSync(path).mtimeMs;
  if (storeCache && mtime === storeMtime) return storeCache;
  storeCache = parseFromDisk();
  storeMtime = mtime;
  return storeCache;
}
```

---

## 7. Quick-Win Summary (Prioritized)

| Priority | Item | File | Effort | Impact |
|---|---|---|---|---|
| 🔴 Critical | Add `memory_search` tool | `src/tools/memory.ts` + registry | 1h | Model can recall facts |
| 🔴 Critical | Cap resume context to 10 msgs | `background-task-runner.ts` | 30m | Prevents 4B context overflow |
| 🔴 Critical | Fix repeated full prompt per round | `background-task-runner.ts` | 1h | Saves ~50% context per task round |
| 🔴 Critical | Fix silent 20-message drop → compaction | `session.ts` | 3h | Prevents context amnesia |
| 🟠 High | Read daily memory notes at session start | `server-v2.ts` | 1h | Memory actually used |
| 🟠 High | Separate heartbeat from cron jobs | `cron-scheduler.ts` | 2h | Cleaner architecture |
| 🟠 High | Add HEARTBEAT.md file concept | `cron-scheduler.ts` | 1h | User-editable checklist |
| 🟠 High | Fix month field in `getNextRun` | `cron-scheduler.ts` | 20m | Cron expressions work correctly |
| 🟠 High | Block `process.kill` in sandbox | `reactor.ts` | 10m | Security fix |
| 🟠 High | Tool profiles (inject only relevant tools) | `registry.ts` + `reactor.ts` | 2h | Saves 600-1000 tokens/request |
| 🟡 Medium | Per-job model override | `cron-scheduler.ts` + `server-v2.ts` | 1h | Use better model for weekly jobs |
| 🟡 Medium | Per-step timeout in BackgroundTaskRunner | `background-task-runner.ts` | 30m | No more hung tasks |
| 🟡 Medium | Deduplicate sanitize function | `memory-manager.ts` + `memory.ts` | 20m | Code health |
| 🟡 Medium | Persist cron run history (JSONL) | `cron-scheduler.ts` | 1h | Debuggability |
| 🟡 Medium | Cache fact-store in memory | `fact-store.ts` | 1h | Performance |
| 🟡 Medium | Full task ID for session key | `background-task-runner.ts` | 5m | Prevent collision |
| 🟢 Low | Loop detection in reactor | `reactor.ts` | 1h | Prevents infinite tool loops |
| 🟢 Low | `apply_patch` tool | new file | 2h | Better multi-file edits |
| 🟢 Low | Basic hook system | new file | 3h | Extensibility |
| 🟢 Low | Session file cleanup on startup | `session.ts` | 30m | Disk hygiene |
| 🟢 Low | Temporal decay in fact scoring | `fact-store.ts` | 1h | Recent facts ranked higher |
| 🟢 Low | Stagger for simultaneous cron jobs | `cron-scheduler.ts` | 30m | Prevent job collisions |

---

## 8. Things That Are Already Good (Don't Break These)

- **`node_call<>` execution channel** — This is genuinely clever and works better than native tool calls for 4B models. Keep it as the primary path.
- **`HEARTBEAT_OK` suppression** — Correctly suppresses silent heartbeat ticks. Keep exactly as-is.
- **`isModelBusy` guard in tick()** — Prevents cron from interrupting user chat. Keep.
- **`extractNodeCallBlocks` custom parser** — The custom parser that handles `=>`, `>=`, `>>` edge cases is correct and significantly better than the naive regex. Keep.
- **Format violation fuse** — The 3-strike fuse with `nextStepDisableThink` retry is a smart optimization. Keep.
- **`shouldDiscardClaim()` in memory-manager** — Error text filtering before memory writes prevents garbage from polluting the fact store. Keep and extend.
- **Fact TTL by type** — `defaultExpiryHoursForKey()` in fact-store is exactly the right approach. Extend it for more key patterns.
- **Atomic file writes in fact-store** — The `tmp-then-rename` pattern in `saveStore()` is correct and prevents corrupted writes. Keep everywhere that writes JSON.
- **Background task journal** — The `appendJournal()` system gives good auditability. The 500-entry trim is reasonable.
- **`BackgroundTaskRunner.requestPause`** — The static pause registry pattern is clean and prevents duplicate runners.

---

## 9. Latest Implemented Edits (2026-02-27)

- **Cron scheduler persistence hardening**
  - `src/gateway/cron-scheduler.ts`
  - `saveStore()` is now atomic (`tmp` write + `renameSync`).

- **Cron job output session semantics clarified**
  - `src/gateway/cron-scheduler.ts`
  - `CronJob.sessionId` renamed to `CronJob.lastOutputSessionId`.
  - Backward-compatible load migration added: reads legacy `sessionId` into `lastOutputSessionId`.

- **Cron run-history retention improved**
  - `src/gateway/cron-scheduler.ts`
  - `appendRunHistory()` now defaults to **200** entries (was 50).
  - Configurable via `config.tasks.maxRunHistory` (minimum 10).

- **Cron isolated-session cleanup tightened**
  - `src/gateway/cron-scheduler.ts`
  - Isolated runs use per-run session IDs and now explicitly clear session history at start/end of run.

- **WebSocket typing safety**
  - `src/gateway/server-v2.ts`
  - `wss` typed as `WebSocketServer | undefined`; guarded close in shutdown path.

- **Background task channel delivery coherence**
  - `src/gateway/background-task-runner.ts`
  - Delivery now writes paired synthetic user marker + assistant message to avoid orphaned assistant turns.

- **Background task resume context durability**
  - `src/gateway/background-task-runner.ts`
  - Final completion paths now persist a last resume-context snapshot for later inspection.

- **Session write performance**
  - `src/gateway/session.ts`
  - Added debounced session saves (500ms) and explicit `flushSession(id)`.
  - `addMessage(..., { disableAutoSave: true })` supported for high-frequency writers.
  - Background runner now batches writes and flushes per round/terminal path.

- **Session API-context pruning model**
  - `src/gateway/session.ts`, `src/gateway/server-v2.ts`
  - Full assistant content is persisted.
  - Added `getHistoryForApiCall()` to prune oversized assistant messages in-memory before model calls.
  - `server-v2` now uses `getHistoryForApiCall()` for prompt assembly.

- **Memory relevance upgrades**
  - `src/gateway/fact-store.ts`, `src/tools/memory-mmr.ts`
  - Added exponential temporal decay to fact ranking (30-day half-life) with evergreen path exemption.
  - Added MMR diversity re-ranking for memory search results.
  - Added fact-store in-memory cache with mtime guard.

- **Hook system expansion**
  - `src/gateway/hooks.ts`, `src/gateway/hook-loader.ts`, `src/gateway/server-v2.ts`
  - Added `agent:bootstrap`, `command:reset`, `command:stop` events.
  - Added workspace hook discovery (`hooks/*/handler.js` + optional `HOOK.md` events metadata).
  - `agent:bootstrap` now fires before prompt bootstrap assembly and can mutate `bootstrapFiles`.

- **Tool-loop guard in chat reactor path**
  - `src/gateway/server-v2.ts`
  - Added repeat-call loop detection in `handleChat` tool loop (warn/block thresholds with synthetic tool feedback).

- **apply_patch validation hardening**
  - `src/tools/files.ts`
  - Added detection for `git apply` �Skipped patch ...� false-success cases.
  - Tool now fails when check/apply skips all targeted files.
