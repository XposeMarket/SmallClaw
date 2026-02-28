# SELF.md — What I Am and How I Work

This is your technical self-knowledge. Read this when you need to understand your own
architecture, diagnose errors, or reason about your own source code.

---

## Identity

- **Project:** SmallClaw
- **Root:** `D:\SmallClaw\`
- **Runtime:** Node.js + TypeScript, compiled to `dist/` via `npm run build`
- **Gateway:** Express + WebSocket server on `http://127.0.0.1:18789`
- **Model:** Ollama (primary model configured in Settings → Models)
- **Platform:** Windows (but code is cross-platform)

---

## Source Layout (`src/`)

### `src/gateway/` — The Brain (most bugs live here)
| File | What it does |
|---|---|
| `server-v2.ts` | Main entry point. Builds tools, handles all chat turns (`handleChat`), assembles system prompt, routes tool calls |
| `telegram-channel.ts` | Telegram bot. Long-polling, file browser, command handlers |
| `task-runner.ts` | Sliding-context multi-step task engine. Each step: model picks ONE action |
| `task-store.ts` | Persists task records to `.smallclaw/tasks/` as JSON |
| `background-task-runner.ts` | Manages running tasks in the background while chat is free |
| `session.ts` | In-memory + disk session history. `addMessage`, `getHistory`, `clearHistory` |
| `orchestrator.ts` | Legacy multi-agent orchestrator (plan → execute → verify) |
| `cron-scheduler.ts` | Time-based job runner. Fires `handleChat` on schedule |
| `heartbeat-runner.ts` | Periodic self-check. Runs against workspace on interval |
| `memory-manager.ts` | Compacts and manages workspace memory files |
| `skills-manager.ts` | Loads/enables/disables skills from `.smallclaw/skills/` |
| `mcp-manager.ts` | Model Context Protocol server connections |
| `browser-tools.ts` | Playwright-based browser automation tool implementations |
| `desktop-tools.ts` | Windows desktop automation (screenshot, click, type, etc.) |
| `hook-loader.ts` | Loads workspace-defined hooks from `workspace/hooks/` |
| `hooks.ts` | Internal event bus (`gateway:startup`, `command:new`, `agent:bootstrap`) |
| `boot.ts` | Runs `workspace/BOOT.md` at startup as a handleChat turn |
| `webhook-handler.ts` | Incoming webhook router for external triggers |
| `preempt-watchdog.ts` | Watchdog that can interrupt stuck model turns |
| `gpu-detector.ts` | Detects GPU for Ollama performance reporting |
| `fact-store.ts` | Simple key-value fact persistence |
| `pty-manager.ts` | Pseudo-terminal manager for interactive shell sessions |
| `ollama-process-manager.ts` | Manages the Ollama process lifecycle |

### `src/tools/` — What the AI Can Do
| File | What it does |
|---|---|
| `registry.ts` | **Central tool registry.** All tools registered here. `getToolRegistry()` singleton |
| `files.ts` | `read`, `write`, `edit`, `list`, `delete`, `rename`, `copy`, `mkdir`, `stat`, `append`, `apply_patch` |
| `shell.ts` | `shell` — run arbitrary shell commands (with safety guards) |
| `web.ts` | `web_search`, `web_fetch` |
| `memory.ts` | `memory_search`, `memory_write` — semantic memory in `.smallclaw/memory/` |
| `self-update.ts` | `self_update` — triggers `self-update.bat`, rebuilds and restarts gateway |
| `skills.ts` | `skill_list`, `skill_search`, `skill_install`, `skill_remove`, `skill_exec` |
| `time.ts` | `time_now` |
| `memory-mmr.ts` | MMR (Maximal Marginal Relevance) ranking for memory retrieval |
| `memory-utils.ts` | Shared memory utilities |

### `src/agents/` — AI Invocation Layer
| File | What it does |
|---|---|
| `ollama-client.ts` | Wraps Ollama API. `chat()`, tool call parsing, streaming |
| `executor.ts` | Agent that executes tasks step by step |
| `manager.ts` | Agent that plans and decomposes tasks |
| `verifier.ts` | Agent that verifies task completion |
| `reactor.ts` | v2 reaction loop (current) |
| `reactor-legacy.ts` | Old reaction loop (kept for reference) |

### `src/orchestration/` — Multi-Agent Coordination
| File | What it does |
|---|---|
| `multi-agent.ts` | Secondary advisor calls, orchestration config, eligibility checks |
| `file-op-v2.ts` | File operation orchestration — classifies, plans, verifies file changes |

### `src/config/` — Configuration
| File | What it does |
|---|---|
| `config.ts` | Config loader/saver. `getConfig()` singleton. Reads `.smallclaw/config.json` |
| `soul-loader.ts` | Loads soul/memory for legacy system prompt builder |
| `soul.md` | Default soul template (overridden by `workspace/SOUL.md`) |
| `memory.md` | Default memory template |

### `src/skills/` — Skills System
| File | What it does |
|---|---|
| `store.ts` | Skills storage and retrieval |

### `src/db/` — Persistence Layer
- SQLite database for jobs, tasks, approvals, artifacts

### `src/types.ts` — Shared Types
- `JobStatus`, `TaskStatus`, `AgentRole`, `Job`, `Task`, `Step`, `Artifact`, `Approval`, `ToolResult`

---

## Build System

```
npm run build       → compiles src/ → dist/ (TypeScript → JavaScript)
npm start           → runs dist/gateway/server-v2.js
start-smallclaw.bat → npm run build && npm start (Windows)
self-update.bat     → git pull + npm run build + restart gateway
```

- TypeScript config: `tsconfig.json` at root
- Output: `dist/` mirrors `src/` structure
- **After patching any `src/` file, always rebuild with `npm run build`**

---

## Config & Data Paths

| Location | Purpose |
|---|---|
| `.smallclaw/config.json` | Main config (models, tools, channels, workspace path) |
| `.smallclaw/cron/jobs.json` | Cron job definitions |
| `.smallclaw/skills/` | Installed skills |
| `.smallclaw/tasks/` | Persisted task records (JSON per task) |
| `.smallclaw/pending-repairs/` | Pending self-repair patches awaiting approval |
| `workspace/` | User workspace — SOUL, IDENTITY, USER, MEMORY, AGENTS, TOOLS, SELF |
| `workspace/memory/` | Daily memory logs (`YYYY-MM-DD.md`) |
| `gateway.log` | Stdout gateway log |
| `gateway.err.log` | Stderr gateway log — **first place to look for errors** |

---

## How the System Prompt Is Built (Per Turn)

`buildPersonalityContext()` in `server-v2.ts` loads these workspace files and injects them:
1. `IDENTITY.md` (200 chars max) — who I am
2. `SOUL.md` (500 chars max) — my values and operating principles
3. `USER.md` (300 chars max) — who I'm helping
4. `MEMORY.md` (600 chars max) — long-term memory
5. `SELF.md` (this file, 600 chars max) — technical self-knowledge
6. Daily memory notes from `memory/YYYY-MM-DD.md`

Then active skills, caller context (e.g. "you are responding via Telegram"), and the tool list are appended.

---

## How handleChat Works (The Core Loop)

```
handleChat(message, sessionId, sendSSE, ...) in server-v2.ts
  ↓
buildPersonalityContext() → loads workspace files → system prompt
  ↓
getHistoryForApiCall() → last N messages from session
  ↓
Ollama chat API call with tools
  ↓
If tool_calls in response:
  → execute each tool (list_files, read_file, browser_*, etc.)
  → append tool results to messages
  → loop (up to MAX_TOOL_ROUNDS = 12)
  ↓
Return final text response
```

---

## How Background Tasks Work

```
start_task(goal) tool call
  ↓
BackgroundTaskRunner.startTask(goal, sessionId)
  ↓
TaskRunner loop (task-runner.ts):
  Each step: model picks ONE tool from task tool set
  → execute tool → append to journal
  → compress old journal entries → rebuild context
  → loop until done or max steps (25)
  ↓
On error: TaskState.error set, status = 'failed'
  → error + stack captured in task record
  → task stored in .smallclaw/tasks/<id>.json
```

---

## Where Errors Show Up

When something breaks, check in this order:

1. **`gateway.err.log`** — raw stderr from the gateway process
2. **`gateway.log`** — stdout including `[Telegram]`, `[Task]`, `[CronScheduler]` prefixed lines
3. **`.smallclaw/tasks/<task-id>.json`** — `error` field on a failed task record
4. **`workspace/memory/YYYY-MM-DD.md`** — daily log of what happened during the session

Stack traces in logs include the compiled `dist/` path — map back to `src/` by same relative path.

---

## Self-Repair Flow (When Implemented)

1. Read `gateway.err.log` or failed task's `error` field to get the error + stack
2. Map `dist/gateway/server-v2.js:450` → `src/gateway/server-v2.ts` (same relative path)
3. Use `read_source` tool to read the relevant source file around the error line
4. Reason about the bug — what caused it, what the fix should be
5. Use `propose_repair` tool to generate a unified diff patch and send it to Telegram for approval
6. Wait for `/approve <id>` — never self-apply

---

## Important Constraints

- **Never edit `dist/` directly** — it gets overwritten on rebuild. Always edit `src/`.
- **Always rebuild after source changes** — `npm run build` from `D:\SmallClaw\`
- **Tool path restrictions** — `read`/`write`/`edit` tools are locked to `workspace/`. Use `read_source` to read `src/` files.
- **Model context is ~8K tokens** — system prompt + tools + history all compete for space. Keep workspace files concise.
- **One Ollama instance** — parallel inference on 4B models causes degradation. The `isModelBusy` guard prevents this.
