# SmallClaw Changelog

A running log of features, fixes, and improvements added to SmallClaw. Each entry includes what changed, why, and notes for update posts.

---

## [Unreleased] — In Progress

> Features built but not yet tagged in a release.

---

## 2026-02-27 — Sub-Agent Spawn Architecture

### What Changed
SmallClaw now supports spawning child agents from within background tasks. The primary agent can delegate work to isolated specialist sub-agents, wait for their results, and resume with their output injected into context — enabling multi-step agentic workflows without overloading a single context window.

### Two Modes

**Default mode (`subagent_mode: false`) — `delegate_to_specialist`**
Designed for 4B local models. Fixed specialist roles with structured I/O. Sequential execution. Safe and reliable on any Ollama setup.

**Full mode (`subagent_mode: true`) — `subagent_spawn`**
Free-form arbitrary task prompts (Claude Cowork-style). Parallel execution. Primary agent acts as orchestrator. Best for larger/smarter models.

Both modes share identical underlying machinery — only the entry-point tool differs.

### Tool Profiles
Sub-agents receive a restricted tool set based on their assigned role:

| Profile | Tools Available |
|---|---|
| `file_editor` | read/write file operations |
| `researcher` | read files + web search/fetch |
| `shell_runner` | run_command + read files |
| `reader_only` | read files only |

No profile includes `delegate_to_specialist` or `subagent_spawn` — recursion is prevented at the profile level and with an explicit depth guard.

### How It Works

```
Parent task calls delegate_to_specialist / subagent_spawn
        ↓
Child task created (parentTaskId, subagentProfile, onResumeInstruction)
        ↓
Parent status → 'waiting_subagent'
        ↓
Child BackgroundTaskRunner executes independently
        ↓
Child completes → resolveSubagentCompletion() fires
        ↓
[SUBAGENT RESULT: title]\n{summary}\n[/SUBAGENT RESULT] injected into parent context
        ↓
If all children done → parent status → 'queued', resumes automatically
```

### New Task Status
`waiting_subagent` — parent task pauses here until all pending child tasks complete.

### Config
```ts
orchestration: {
  subagent_mode: false  // true = full multi-agent spawn mode
}
```
Toggleable via `POST /api/orchestration/config`.

### Files Modified
- `src/gateway/task-store.ts` — `waiting_subagent` status, `SubagentProfile` type, `resolveSubagentCompletion()`, parent/child fields on `TaskRecord`
- `src/gateway/background-task-runner.ts` — delivery hook, run-loop waiting_subagent handling, context injection for profile/resume notes
- `src/gateway/server-v2.ts` — `TOOL_PROFILES`, `delegate_to_specialist` / `subagent_spawn` tool definitions, spawn handler in `handleChat()`, config API wiring
- `src/config/config.ts` — `subagent_mode: false` default
- `src/types.ts` — `subagent_mode?: boolean` on `SmallClawConfig`

### Update Post Draft
> **SmallClaw can now spawn sub-agents 🤖→🤖**
>
> Background tasks can delegate to specialist child agents — a file editor, a researcher, a shell runner — and wait for their results before continuing.
>
> The parent pauses, the child runs in its own isolated context, and when it's done the result is automatically injected back so the parent can carry on.
>
> Two modes: a conservative 4B-safe delegate mode with fixed specialist roles, and a full free-form spawn mode for larger models. Same plumbing either way.
>
> Zero new dependencies. Five files changed.

---

## 2026-02-27 — Soul & Memory Growth System

### What Changed
SmallClaw now has a full personality growth loop — it learns who you are, evolves its own character, and writes that knowledge to disk so it survives restarts and context resets.

### Core Pieces Built

**`workspace/SOUL.md` — rewritten with explicit growth rules.** The AI is now clearly instructed to:
- Extract user preferences and write them to `memory_write` proactively
- Update `USER.md` whenever it learns something new about the user
- Update its own `SOUL.md` when it develops a new operating principle
- Write session notes to daily memory before context compresses

**`workspace/USER.md` — rebuilt as a living document** with structured sections for identity, work style, projects, preferences, and technical context. Starts with helpful placeholders; Claw fills it in over time.

**`src/tools/persona.ts` — two new tools:**
- `persona_read` — reads SOUL.md, USER.md, IDENTITY.md, etc. with line numbers (read before editing)
- `persona_update` — surgically updates persona files via 4 modes: `append_section`, `upsert_line`, `replace_section`, `full_rewrite`. Every update is logged to today's daily memory.

**`src/gateway/session.ts` — upgraded memory flush prompt.** The pre-compaction silent turn now explicitly instructs the AI to run `memory_write`, `persona_update USER.md`, `persona_update SOUL.md`, and write a session note — not just a vague "save facts" reminder.

### The Growth Loop (How It Works)

```
User chats with Claw
        ↓
Claw learns something new (preference, project, fact)
        ↓
Claw calls memory_write or persona_update immediately
        ↓
Fact survives restart (in MEMORY.md, USER.md, or facts.json)
        ↓
Next session: fact is injected into system prompt
        ↓
Claw acts on it without being told again
```

When the context window fills up:
```
Context ~80% full → silent flush turn fires automatically
        ↓
Claw writes session notes + preference updates + USER.md changes
        ↓
Context compresses → new session starts with updated workspace files
```

### What This Looks Like in Practice
- First session: blank USER.md, generic SOUL.md
- After a few chats: Claw knows your name, your preferred response length, your timezone, which projects matter
- After a few weeks: SOUL.md has a `## Learned About [Name]` section. USER.md is full. Claw's tone is tuned to you.
- New sessions feel like continuing a conversation, not starting over

### Files Changed
- `workspace/SOUL.md` — full rewrite with growth rules
- `workspace/USER.md` — rebuilt as living user model
- `src/tools/persona.ts` — new file (`persona_read`, `persona_update`)
- `src/tools/registry.ts` — registered new persona tools
- `src/gateway/session.ts` — upgraded `PRE_COMPACTION_MEMORY_FLUSH_PROMPT`

### Update Post Draft
> **SmallClaw now grows with you 🌱**
>
> Every session, SmallClaw learns a little more about how you work — your preferences, your projects, how you like to communicate. It writes that to disk so it survives restarts.
>
> When the context window fills up, a silent turn fires automatically: Claw writes its session notes, updates its model of you, and evolves its own soul file before the context compresses.
>
> Over time: SOUL.md develops a `## Learned About [You]` section. USER.md fills in. The AI's tone tunes to yours.
>
> New sessions feel like continuing a conversation, not starting over.

---

## 2026-02-27 — Self-Repair System (Design Phase)

### What Changed
Designed the full self-repair architecture. No code written yet — see `SELF-REPAIR.md` for the complete plan.

### What It Will Enable
SmallClaw will be able to:
- Read its own source code (`src/`) to analyze errors from failed background tasks
- Generate a surgical unified diff patch to fix the bug
- Send you a proposal over Telegram with the exact change it wants to make
- Wait for your explicit `/approve <id>` before touching anything
- Apply the patch, rebuild, restart, and confirm — or revert and report if the build fails

### Architecture Summary
Four new deliverables:
1. `workspace/SELF.md` — architecture map injected into system prompt (AI learns its own file structure)
2. `src/tools/source-access.ts` — read-only `read_source` / `list_source` tools exposing `src/` to the AI
3. `src/tools/self-repair.ts` — `propose_repair` tool that stores pending patches with approval gate
4. `/approve` and `/reject` handlers in `telegram-channel.ts`

### Key Design Decision
The AI can **read and analyze** source autonomously. It can **never apply changes** without your explicit `/approve <id>` over Telegram. The confirmation gate is hardcoded — not a setting.

### Status
- [x] Architecture designed (`SELF-REPAIR.md`)
- [x] `workspace/SELF.md` — complete
- [x] `src/tools/source-access.ts` — complete (`read_source`, `list_source`)
- [x] `src/tools/self-repair.ts` — complete (`propose_repair`, `applyApprovedRepair`)
- [x] Telegram `/repairs`, `/repair`, `/approve`, `/reject` handlers — complete
- [x] Registry registration — complete
- [x] `SELF.md` injected into `buildPersonalityContext` in `server-v2.ts`

### Update Post Draft
> **Coming to SmallClaw: Self-Repair 🔧**
>
> Working on something ambitious: SmallClaw will soon be able to find and fix bugs in its own source code.
>
> When a background task fails with what looks like a source bug, it reads its own codebase, analyzes the error, writes a patch, and asks you over Telegram: "Want me to fix this?"
>
> You reply `/approve` — it patches, rebuilds, restarts, and confirms. Or `/reject` to discard it.
>
> The AI can never touch source code without your explicit approval. That gate is hardcoded.
>
> Still in design — implementation coming next.

---

## 2026-02-27 — Telegram File Browser

### What Changed
Added a full inline file browser to the Telegram channel (`src/gateway/telegram-channel.ts`), inspired by the [openclaw-telegram-chat-file-browser](https://github.com/timotme/openclaw-telegram-chat-file-browser) plugin.

No new dependencies — built entirely on the existing raw Telegram Bot API fetch layer already in SmallClaw.

### New Commands

| Command | Description |
|---|---|
| `/browse` | Opens the file browser at your workspace root |
| `/browse <path>` | Opens the browser at a specific subfolder |
| `/download <path>` | Sends a file directly as a Telegram attachment |

### How It Works

- **Inline keyboard navigation** — tapping a folder button navigates into it; the message edits in-place (no new messages spamming the chat).
- **File preview** — text files render in a `<pre>` block with ◀️ / ▶️ pagination (2,500 chars per page, configurable).
- **Binary detection** — files with null bytes are detected and shown with their size + a `/download` hint instead of garbled output.
- **Path safety** — all paths are clamped to the workspace root; no directory traversal possible.
- **Paths in callback_data** — absolute paths are base64url-encoded directly into button data, so zero server-side state is needed for navigation.

### Files Modified
- `src/gateway/telegram-channel.ts` — all changes contained here

### Config Constants (top of file, easy to tune)
```ts
const BROWSER_MAX_BUTTONS_PER_ROW = 2;   // buttons per row in the keyboard
const BROWSER_MAX_BUTTONS_TOTAL   = 40;  // max files/folders shown per directory
const BROWSER_MAX_TEXT_PREVIEW    = 2500; // chars per page for text preview
```

### Update Post Draft
> **New in SmallClaw: Telegram File Browser 📁**
>
> You can now browse your entire workspace from Telegram — no app switching, no SSH.
>
> Send `/browse` to your SmallClaw bot and get an inline keyboard showing your workspace files and folders. Tap to navigate, tap a file to preview it, and use `/download <path>` to pull any file directly into the chat as an attachment.
>
> Works on text files with full pagination, detects binary files and shows their size, and navigates entirely in-place (edits the same message — no chat spam).
>
> Zero new dependencies. One file changed.

---

## Template — How to Add a New Entry

Copy this block when logging the next change:

```md
## YYYY-MM-DD — Short Title

### What Changed
1–3 sentence summary of what was built or fixed.

### New Commands / APIs / Config
(table or bullet list if applicable)

### How It Works
Brief technical explanation — enough for someone reading the code cold.

### Files Modified
- `path/to/file.ts` — what changed

### Update Post Draft
> Ready-to-post blurb for socials / release notes.
```

---

*This file is maintained manually. Add an entry every time a meaningful feature or fix lands.*
