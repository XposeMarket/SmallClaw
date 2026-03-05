# SmallClaw Restructuring & Architecture Plan
**Status:** Planning Phase (No Code Changes Yet)  
**Date:** 2026-03-04  
**Owner:** Raul  

---

## Executive Summary

SmallClaw has several architectural issues preventing optimal performance:
1. Runtime context injection is heavy and inefficient (SELF.md injected every message)
2. Memory system is broken (no proper read/write/search tools exposed)
3. write_note is non-functional as intraday memory
4. BOOT system exists but isn't fully leveraged
5. Tool documentation is stale and not integrated into runtime
6. Identity synchronization is not enforced

This plan addresses all issues in a phased, low-risk approach with clear acceptance criteria.

---

## Part 1: Current State Analysis

### What Exists Right Now (Code References)

| Item | Status | Location | Behavior |
|------|--------|----------|----------|
| BOOT system | Partial | boot.ts:58, server-v2.ts:762, server-v2.ts:8335 | Runs once at gateway startup only |
| Context rebuild | Every turn | server-v2.ts:2721, server-v2.ts:3068, server-v2.ts:838 | Rebuilds full system prompt for each user message |
| SELF.md injection | Always-on | server-v2.ts:844 | Currently injected every user message (INEFFICIENT) |
| Tool definitions | Hardcoded | server-v2.ts:892, server-v2.ts:1290 | buildTools() + browser/desktop + agent-builder |
| write_note | Broken | server-v2.ts:2191 | Only works in task_... sessions, no-op elsewhere |
| memory_write/search | Defined but exposed | memory.ts, soul-loader.ts:14 | Code exists but NOT in main v2 tool surface |
| mnt/ folder | Unused | N/A | No runtime references in src/ |
| AGENTS.md | Subagent-only | server-v2.ts:7214, spawner.ts:57, soul-loader.ts:229 | Used by subagent/reactor paths, NOT main chat |

### Key Discovery: "Every Turn" Clarification

**Your question:** Does the AI receive a fresh system prompt every single message, or just at startup?

**Answer:** **Every single message.** Here's the flow:

```
Gateway Startup (once):
  → runBootMd() fires
  → Returns "here's current state" summary to log
  → Telegram notification sent (optional)

First User Message:
  → handleChat() called
  → buildPersonalityContext() rebuilds full system prompt
  → System prompt includes: IDENTITY.md + SOUL.md + USER.md + SELF.md (currently)
  → Plus memory excerpt, tool list, caller context
  → AI sees: [FULL SYSTEM PROMPT] + [FIRST MESSAGE]

Later User Messages:
  → handleChat() called AGAIN
  → buildPersonalityContext() REBUILDS system prompt (not cached)
  → Same full injection + recent chat history (~5 messages)
  → AI sees: [FULL SYSTEM PROMPT] + [RECENT HISTORY] + [NEW MESSAGE]
```

**Impact:** SELF.md is being injected **hundreds of times per day** even though it's only needed for debug scenarios.

---

## Part 2: Your Decisions (Confirmed)

### Decision 1: SELF.md Injection → On-Demand Only
**Current:** Always injected (wastes tokens)  
**Target:** Only included when user asks about errors, architecture, or how SmallClaw works  
**Trigger keywords:** "why", "error", "failed", "how does", "architecture", "debug"  
**Implementation:** Add intent detector in buildPersonalityContext()

### Decision 2: IDENTITY.md → Always-On Short Form
**Current:** Minimal identity file  
**Target:** Expanded slightly to include runtime identity facts but stay concise  
**Include:** Name, role, operational mode, baseline constraints  
**Example fields:**
```markdown
- Name: SmallClaw
- Role: Local AI agent for Raul
- Runtime: Ollama native tools on Windows
- Access: Native file system, shell, browser, desktop
- Constraints: ~8K token budget for system prompt
```

### Decision 3: Identity Sync Rule
**Problem:** If AI learns it should change name/role, where does it write?  
**Solution:** Identity-critical updates go to BOTH IDENTITY.md AND SOUL.md  
**Identity-critical fields:** Name, role framing, operational mode, baseline constraints  
**Example:**
- User says "call yourself Claw now"
- AI writes to SOUL.md: "Learned: user wants me called 'Claw'"
- AI writes to IDENTITY.md: "Name: Claw"
- Both files stay in sync

### Decision 4: Memory Tools Architecture
**Current state:**
- memory_write exists but not exposed in v2
- memory_search exists but not exposed in v2
- No memory_read tool at all

**Target state:**
```
memory_write(target, content):
  - Auto-routes to USER.md or SOUL.md
  - Optional explicit target override
  - Returns confirmation

memory_read(target):
  - Returns full contents of USER.md or SOUL.md or IDENTITY.md
  - No filtering, full document read
  - Returns file content as-is

memory_search(keywords, scope):
  - Searches USER.md + SOUL.md (+ optional IDENTITY.md)
  - Returns only matching snippets/notes
  - Does not return entire file
  - Example: memory_search("prefers typescript", "user") → returns 1-2 matching lines
```

**Routing logic for memory_write:**
- User preferences, habits, communication style → USER.md
- Assistant learned behaviors, principles, personality changes → SOUL.md
- Core identity changes (name, role, mode) → BOTH IDENTITY.md AND SOUL.md
- Optional explicit override: memory_write(target="USER.md", ...)

### Decision 5: write_note → Intraday Memory System
**Current:** Only persists to task journal in task sessions, no-op elsewhere  
**Target:** Full intraday temporary memory layer

**Behavior:**
1. write_note persists to `workspace/memory/YYYY-MM-DD-intraday-notes.md`
2. Works in ALL sessions (not just task sessions)
3. Entries are timestamped and tagged
4. Auto-cleaned at EOD (can archive to MEMORY.md if valuable)
5. Injected into prompt at startup as "today's notes so far"
6. Used for: collecting data, remembering current task state, temporary findings

**Example use case:**
```
Task: "Research competitor pricing for widgets"
10:15 AM: write_note("Found Acme pricing: $99/unit, free shipping")
10:45 AM: write_note("Bobbins pricing: $85/unit, $10 shipping")
11:00 AM: AI can memory_search("widget pricing") and get both notes instantly
11:30 AM: AI completes task, archives notes to MEMORY.md or user reviews and decides
EOD: Notes from YYYY-MM-DD-intraday-notes.md cleaned (or archived)
```

### Decision 6: BOOT System Enhancement
**Current:** Fetches tasks and memory, outputs summary in one call  
**Target:** Same, but add schedule status (lastRun/nextRun) to the snapshot

**Startup snapshot should include:**
1. Identity, Soul, User files (already loaded)
2. Blocked/paused/in-progress tasks (already included)
3. **NEW:** Schedule status (what's scheduled for today, when did last cron run)
4. **NEW:** Intraday notes from today (if any)

### Decision 7: TOOLS.md Strategy
**Current:** Stale, not referenced by main v2, updated manually  
**Target:** Live documentation + conditional runtime injection

**Parts A: Update TOOLS.md**
- Full list of all current tools (from buildTools())
- Decision table for when to use each
- Examples

**Part B: Conditional Reference Policy**
- TOOLS.md NOT always injected (saves tokens)
- Injected when:
  - Repeated tool failure detected (e.g., 3 consecutive failures)
  - User explicitly asks "what tools do I have"
  - Tool uncertainty detected in model reasoning
  - After hint from system: "you seem confused about tools, see TOOLS.md"

### Decision 8: AGENTS.md Scoping
**Current:** Used by subagent/reactor paths but unclear to users  
**Target:** Move to agent-specific workspaces, remove from main user runtime

**Action:**
- Keep AGENTS.md as guidance for subagent initialization
- Remove from main chat prompt injection
- Document clearly: "AGENTS.md is for subagent/multi-agent setups, not single-agent chat"

### Decision 9: Delete mnt/ Folder
**Current:** `D:\SmallClaw\mnt\` exists with no runtime references  
**Target:** Safe to delete

**Verification:**
- No references in src/
- No config keys point to it
- Appears to be leftover scaffolding

**Process:**
1. Backup mnt/ folder
2. Delete D:\SmallClaw\mnt\
3. Restart gateway
4. Verify no errors

### Decision 10: SOUL.md Shortening
**Current:** ~700 lines (too verbose)  
**Target:** ~350 lines (still comprehensive)

**Keep:**
- Core truths (be helpful, have opinions, be resourceful)
- Memory & growth rules (condensed)
- Personality section
- Limitations (be honest)
- Critical tool rules (web research, desktop focus, etc.)

**Cut:**
- Redundant examples
- Overly detailed explanations
- Duplicate principles
- Optional depth (move to SOUL_DETAILS.md if needed)

---

## Part 3: Target Architecture

### Layer 1: Startup (Runs Once)

```
Gateway Startup:
  ├─ Load Identity.md
  ├─ Load Soul.md
  ├─ Load User.md
  ├─ Fetch task summary (blocked, in-progress, paused)
  ├─ Fetch schedule status (lastRun, nextRun)
  ├─ Pre-fetch today's intraday notes
  └─ Log summary to console + send Telegram notification
```

### Layer 2: Runtime Base (Every User Message)

```
For each chat message:
  ├─ buildPersonalityContext() called
  ├─ Include: IDENTITY.md (short, always)
  ├─ Include: USER.md (short, always) (Im thinking maybe we do the same thing we are doing with Identity/Soul.md where identity is a shorter synced version of Soul.MD - but with user.md so we dont need to inject the entire user.md file, maybe a user_identity.md?)
  ├─ Include: Today's intraday notes (optional, short)
  ├─ Include: Tool list (only if needed)
  ├─ Include: SELF.md (ONLY if error/debug intent detected)
  └─ Append: Recent chat history (~5 messages)
```

### Layer 3: History (Rolling Context)

```
Chat history management:
  ├─ Keep last N messages (currently ~5)
  ├─ Session stored in .smallclaw/sessions/
  └─ Old sessions cleaned up after TTL
```

### Layer 4: Memory (Durable + Temporary)

```
Durable Persona Memory:
  ├─ IDENTITY.md (core identity, loaded at startup + per-message)
  ├─ SOUL.md (personality/principles, loaded per-message)
  ├─ USER.md (user preferences, loaded per-message)
  └─ Both readable/writable via memory_read/memory_write

Temporary Intraday Memory:
  ├─ workspace/memory/YYYY-MM-DD-intraday-notes.md
  ├─ write_note() persists here
  ├─ Searchable via memory_search()
  ├─ Auto-cleaned at EOD
  └─ Can be archived to durable memory if valuable

Structured Facts:
  ├─ .smallclaw/facts.json (key-value fact store)
  └─ Used for quick retrieval without file I/O
```

### Layer 5: On-Demand Debug Reference

```
When user asks "why did that fail?" or "how does SmallClaw work?":
  ├─ Inject SELF.md excerpt
  ├─ Get Context from rolling window of error message (this needs to be configured for task error messages as well)
	-AI Determines based on the error + how it works what happened,
  ├─ Suggest "run read_source tool to see implementation"
  └─ Build error diagnosis context
```

---

## Part 4: Implementation Roadmap

### Phase 1: Prompt Injection Refactor (Highest Priority)
**Goal:** Stop wasting tokens on always-injecting SELF.md

**Changes:**
- [ ] Modify `buildPersonalityContext()` in server-v2.ts:838
- [ ] Remove SELF.md from always-on injection
- [ ] Add intent detector for error/debug keywords
- [ ] Route to on-demand SELF.md inclusion only when triggered
- [ ] Keep IDENTITY.md always-on, expand slightly for runtime facts
- [ ] Test: Normal message doesn't include SELF.md, error question does

**Token savings:** ~200-300 tokens per normal message (SELF.md is large)

### Phase 2: Memory Tool Surface (Second Priority)
**Goal:** Expose memory_read, memory_search, memory_write in main v2

**Changes:**
- [ ] Create memory_read tool (full file read by target)
- [ ] Create memory_search tool (keyword search across USER.md + SOUL.md)
- [ ] Expose memory_write tool with auto-routing logic
- [ ] Add all three to buildTools() in server-v2.ts:892
- [ ] Implement routing logic:
  - USER.md for user preferences
  - SOUL.md for assistant learned behaviors
  - IDENTITY.md for core identity (dual-write rule)
- [ ] Add schemas and execution paths
- [ ] Test: AI can read, search, write to correct targets

### Phase 3: write_note Intraday Memory Upgrade (Third Priority)
**Goal:** Turn write_note into usable temporary memory layer

**Changes:**
- [ ] Extend write_note to work in all sessions (not just task_... sessions)
- [ ] Create workspace/memory/YYYY-MM-DD-intraday-notes.md on first write
- [ ] Add timestamp + tag support to note format
- [ ] Implement EOD cleanup policy (delete or archive)
- [ ] Add intraday notes snippet to BOOT snapshot
- [ ] Update write_note schema to include target (task, general, debug)
- [ ] Test: write_note works in any session, notes persist and are cleaned

### Phase 4: BOOT Enhancement (Fourth Priority)
**Goal:** Include schedule status + intraday notes in startup snapshot

**Changes:**
- [ ] Extend boot.ts snapshot builder to include:
  - Schedule status (nextRun, lastRun for cron jobs)
  - Intraday notes from today (if any)
- [ ] Keep single-call behavior (no AI tool calls)
- [ ] Return pre-packaged JSON snapshot
- [ ] Update BOOT.md or replace with system prompts
- [ ] Test: BOOT snapshot includes task + schedule state

### Phase 5: Identity Sync Rule (Fifth Priority)
**Goal:** Ensure identity-critical updates hit both files

**Changes:**
- [ ] Define identity-critical fields:
  - name
  - role/framing
  - operational_mode
  - baseline_constraints
- [ ] Add routing logic in memory_write:
  - If field is identity-critical, write to BOTH IDENTITY.md AND SOUL.md
- [ ] Log dual-writes for audit trail
- [ ] Test: User changes name, both files update

### Phase 6: TOOLS.md Update (Sixth Priority)
**Goal:** Live, accurate tool documentation + conditional injection

**Changes:**
- [ ] Generate or manually update TOOLS.md with full tool list:
  - All filesystem tools
  - All web tools
  - All memory tools
  - All task tools
  - All schedule tools
  - All other tools
- [ ] Add decision table (when to use each)
- [ ] Add examples
- [ ] Add conditional injection policy:
  - Detect repeated tool failure (3+ consecutive)
  - Inject TOOLS.md excerpt on failure
- [ ] Update AGENTS.md scoping:
  - Move subagent-specific guidance to agent workspaces
  - Remove from main user runtime expectations
- [ ] Test: TOOLS.md is accurate and only injected when needed

### Phase 7: SOUL.md Shortening (Seventh Priority)
**Goal:** Reduce SOUL.md from ~700 to ~350 lines

**Changes:**
- [ ] Keep core truths section (concise)
- [ ] Condense memory & growth rules (remove examples, keep rules)
- [ ] Keep personality section (brief)
- [ ] Keep limitations and boundaries (important)
- [ ] Keep critical tool rules (web research, desktop focus)
- [ ] Cut redundant examples and explanations
- [ ] Optionally create SOUL_DETAILS.md for expanded guidance
- [ ] Verify character count is acceptable
- [ ] Test: SOUL.md still provides adequate guidance at ~50% length

### Phase 8: Cleanup (Eighth Priority)
**Goal:** Remove unused artifacts

**Changes:**
- [ ] Backup D:\SmallClaw\mnt\ folder
- [ ] Delete D:\SmallClaw\mnt\
- [ ] Verify no runtime errors
- [ ] Verify no config references to mnt/
- [ ] Mark as complete

---

## Part 5: Detailed Specifications

### memory_write Tool Spec

```typescript
Tool Name: memory_write
Description: Write or update a memory entry to USER.md, SOUL.md, or IDENTITY.md

Parameters:
  - target (required): "user" | "soul" | "identity"
  - content (required): string (the memory entry)
  - key (optional): string (for structured updates like preferences)
  - override (optional): boolean (force exact target even if identity-critical)

Auto-Routing (unless override=true):
  - If content mentions user preferences/habits/communication style → USER.md
  - If content mentions AI behavior/principles/learned approach → SOUL.md
  - If content mentions name/role/mode changes → BOTH IDENTITY.md AND SOUL.md

Returns:
  {
    success: true|false,
    target: "user|soul|identity",
    written_to: ["user.md"] or ["identity.md", "soul.md"],
    content_snippet: "first 100 chars of what was written"
  }

Example Calls:
  1. memory_write(target="user", content="Raul prefers brief answers, expands only when asked")
     → writes to USER.md only
  
  2. memory_write(target="soul", content="Learned: be more direct, less verbose")
     → writes to SOUL.md only
  
  3. memory_write(target="identity", content="Name changed to Claw")
     → writes to BOTH IDENTITY.md AND SOUL.md
  
  4. memory_write(content="User wants me to be called Apex", override=false)
     → auto-routes to both files (identity-critical)
```

### memory_read Tool Spec

```typescript
Tool Name: memory_read
Description: Read complete contents of memory file

Parameters:
  - target (required): "user" | "soul" | "identity"

Returns:
  {
    success: true|false,
    target: "user|soul|identity",
    content: "full file contents",
    line_count: number,
    char_count: number
  }

Example Calls:
  1. memory_read(target="user")
     → returns full USER.md content
  
  2. memory_read(target="soul")
     → returns full SOUL.md content
  
  3. memory_read(target="identity")
     → returns full IDENTITY.md content
```

### memory_search Tool Spec

```typescript
Tool Name: memory_search
Description: Search USER.md and SOUL.md for keywords, return matching snippets only

Parameters:
  - keywords (required): string or string[] (what to search for)
  - scope (optional): "user" | "soul" | "both" (default: "both")
  - context_lines (optional): number (lines of context around match, default: 1)

Returns:
  {
    success: true|false,
    keywords: ["keyword1", "keyword2"],
    scope: "user|soul|both",
    matches: [
      {
        file: "user.md" | "soul.md",
        line_number: number,
        snippet: "matched text with context",
        relevance: 0.0-1.0
      },
      ...
    ],
    total_matches: number,
    note: "Returns snippets only, not full file"
  }

Example Calls:
  1. memory_search(keywords="typescript", scope="user")
     → returns matching lines from USER.md about typescript
  
  2. memory_search(keywords=["dark mode", "brief answers"])
     → returns all matches across both files
  
  3. memory_search(keywords="error handling", scope="soul")
     → returns SOUL.md sections about error handling
```

### write_note Tool Spec

```typescript
Tool Name: write_note
Description: Write temporary note to today's intraday memory

Parameters:
  - content (required): string (note content)
  - tag (optional): "task" | "debug" | "discovery" | "general" (default: "general")
  - task_id (optional): string (if related to specific task)

Behavior:
  - Appends to workspace/memory/YYYY-MM-DD-intraday-notes.md
  - Auto-creates file if doesn't exist
  - Adds timestamp and tag
  - Notes persist through session
  - Auto-cleaned at EOD (midnight)
  - Searchable via memory_search(keywords=..., scope="intraday")

Returns:
  {
    success: true|false,
    entry_id: UUID,
    timestamp: ISO8601,
    tag: string,
    content: "full note content",
    file: "workspace/memory/YYYY-MM-DD-intraday-notes.md"
  }

Example Calls:
  1. write_note(content="Found widget pricing: $99/unit", tag="discovery")
     → appends timestamped note to today's file
  
  2. write_note(content="Task halted waiting for user input", tag="task", task_id="abc123")
     → appends with task context
  
  3. write_note(content="Error stack trace for later investigation", tag="debug")
     → tags as debug for EOD review

EOD Cleanup Policy:
  - Every night at midnight (configurable)
  - Scan workspace/memory/YYYY-MM-DD-intraday-notes.md (previous day)
  - Two options:
    A) Delete (simple cleanup)
    B) Archive to workspace/MEMORY.md if contains valuable insights
  - Log archive decisions
```

---

## Part 6: Testing & Acceptance Criteria

### Acceptance Test 1: SELF.md Injection Removed
- [ ] Start SmallClaw
- [ ] Send normal message: "What's the weather today?"
- [ ] Check gateway log: SELF.md is NOT in system prompt
- [ ] Send error question: "Why did tool X fail?"
- [ ] Check gateway log: SELF.md IS in system prompt
- [ ] ✅ PASS: SELF.md only appears for error/debug questions

### Acceptance Test 2: IDENTITY.md Always-On
- [ ] Start SmallClaw
- [ ] Send any message
- [ ] Check gateway log: IDENTITY.md IS in system prompt
- [ ] Verify IDENTITY.md includes runtime facts (OS, access level, etc.)
- [ ] Send 5+ consecutive messages
- [ ] Check all prompts include IDENTITY.md
- [ ] ✅ PASS: IDENTITY.md present in every prompt

### Acceptance Test 3: Memory Tools Functional
- [ ] Test memory_write(target="user", content="test entry")
- [ ] Verify entry written to USER.md
- [ ] Test memory_read(target="user")
- [ ] Verify full USER.md contents returned
- [ ] Test memory_search(keywords="test")
- [ ] Verify matching snippets returned only
- [ ] Test memory_write with identity-critical content
- [ ] Verify BOTH IDENTITY.md AND SOUL.md updated
- [ ] ✅ PASS: All memory tools work, routing is correct

### Acceptance Test 4: write_note Intraday Memory
- [ ] Test write_note(content="test note", tag="discovery")
- [ ] Verify appended to workspace/memory/YYYY-MM-DD-intraday-notes.md
- [ ] Test multiple writes in one session
- [ ] Verify all notes timestamped and tagged
- [ ] Let session run past EOD cleanup trigger
- [ ] Verify previous day's notes cleaned/archived
- [ ] Test memory_search includes intraday notes
- [ ] ✅ PASS: write_note persists, cleans up, is searchable

### Acceptance Test 5: BOOT Enhancement
- [ ] Restart SmallClaw gateway
- [ ] Check log for BOOT startup summary
- [ ] Verify summary includes:
  - Task status (blocked/in-progress/paused)
  - Schedule status (nextRun/lastRun)
  - Today's intraday notes (if any)
- [ ] Verify all in ONE pre-fetched snapshot (no tool calls)
- [ ] ✅ PASS: BOOT snapshot comprehensive and efficient

### Acceptance Test 6: Identity Sync
- [ ] Send message: "Change my name to Apex"
- [ ] AI uses memory_write to update identity
- [ ] Check IDENTITY.md: updated with new name
- [ ] Check SOUL.md: also updated with new name
- [ ] Send next message: IDENTITY.md reflects new name
- [ ] ✅ PASS: Identity changes sync to both files

### Acceptance Test 7: TOOLS.md Conditional Injection
- [ ] Send message with valid tool call
- [ ] Tool executes, no error
- [ ] Check prompt: TOOLS.md NOT injected
- [ ] Send message that causes tool failure
- [ ] Repeat 2 more times (3 consecutive failures)
- [ ] On 3rd failure, check prompt: TOOLS.md IS injected
- [ ] ✅ PASS: TOOLS.md injected only on repeated failures

### Acceptance Test 8: SOUL.md Shortening
- [ ] Count lines in SOUL.md: should be ~350 (down from ~700)
- [ ] Verify all core principles still present
- [ ] Verify tool rules still present
- [ ] Verify personality section still present
- [ ] Send message and verify SOUL.md injected correctly
- [ ] ✅ PASS: SOUL.md is half size but still complete

### Acceptance Test 9: mnt/ Deletion Safe
- [ ] Backup D:\SmallClaw\mnt\
- [ ] Delete D:\SmallClaw\mnt\
- [ ] Restart gateway
- [ ] Check startup log: no errors about missing mnt/
- [ ] Send chat message
- [ ] Verify chat works normally
- [ ] Run through normal operation (tasks, memory, etc.)
- [ ] ✅ PASS: No regressions from deleting mnt/

### Acceptance Test 10: AGENTS.md Scoping
- [ ] Verify main chat prompt does NOT include AGENTS.md
- [ ] Verify subagent workspace still loads AGENTS.md
- [ ] Start multi-agent task (if available)
- [ ] Verify subagents still receive AGENTS guidance
- [ ] ✅ PASS: AGENTS.md scoped correctly

---

## Part 7: Detailed Implementation Tasks

### Task 1: Modify buildPersonalityContext() in server-v2.ts

```typescript
// Current (simplified):
function buildPersonalityContext(): string {
  const identity = readFile('IDENTITY.md');
  const soul = readFile('SOUL.md');
  const user = readFile('USER.md');
  const self = readFile('SELF.md');  // ALWAYS included
  return `${identity}\n${soul}\n${user}\n${self}`;
}

// Target (simplified):
function buildPersonalityContext(messageText: string, isErrorContext: boolean): string {
  const identity = readFile('IDENTITY.md');
  const soul = readFile('SOUL.md');
  const user = readFile('USER.md');
  
  let context = `${identity}\n${soul}\n${user}`;
  
  // Only include SELF.md if error/debug intent detected
  const shouldIncludeSelf = isErrorContext || 
    detectErrorIntentKeywords(messageText); // ["why", "error", "failed", "how does", "architecture"]
  
  if (shouldIncludeSelf) {
    const self = readFile('SELF.md');
    context += `\n${self}`;
  }
  
  return context;
}

// Helper function:
function detectErrorIntentKeywords(text: string): boolean {
  const keywords = ['why', 'error', 'failed', 'how does', 'architecture', 'debug', 'caused'];
  const lowerText = text.toLowerCase();
  return keywords.some(kw => lowerText.includes(kw));
}
```

**Code Location:** server-v2.ts around line 838 in buildPersonalityContext()

**Files to Modify:**
- `src/gateway/server-v2.ts` (modify buildPersonalityContext)
- `src/gateway/server-v2.ts` (modify handleChat to detect error context)

---

### Task 2: Create memory_read Tool

```typescript
// File: src/tools/memory-read.ts (NEW)

export const memoryReadTool = {
  name: 'memory_read',
  description: 'Read complete contents of memory file (USER.md, SOUL.md, or IDENTITY.md)',
  schema: {
    target: 'Which file to read: user, soul, or identity',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['user', 'soul', 'identity'],
        description: 'Which memory file to read',
      },
    },
    required: ['target'],
    additionalProperties: true,
  },
  execute: async (args: any) => {
    const target = String(args?.target || '').toLowerCase().trim();
    
    const validTargets = { user: 'USER.md', soul: 'SOUL.md', identity: 'IDENTITY.md' };
    if (!validTargets[target]) {
      return {
        success: false,
        error: `Invalid target. Valid: ${Object.keys(validTargets).join(', ')}`,
      };
    }
    
    const filename = validTargets[target];
    const filePath = path.join(workspacePath, filename);
    
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        success: true,
        target,
        content,
        line_count: content.split('\n').length,
        char_count: content.length,
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to read ${filename}: ${err.message}`,
      };
    }
  },
};
```

**Files to Create:**
- `src/tools/memory-read.ts` (NEW)

**Files to Modify:**
- `src/tools/registry.ts` (import and register memoryReadTool)

---

### Task 3: Create memory_search Tool

```typescript
// File: src/tools/memory-search.ts (NEW)

export const memorySearchTool = {
  name: 'memory_search',
  description: 'Search USER.md and SOUL.md for keywords, return only matching snippets',
  schema: {
    keywords: 'One or more keywords to search for (space or comma separated)',
    scope: 'Scope: user, soul, or both (default: both)',
    context_lines: 'Lines of context around match (default: 1)',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      keywords: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        description: 'Keywords to search for',
      },
      scope: {
        type: 'string',
        enum: ['user', 'soul', 'both'],
        description: 'Which files to search (default: both)',
      },
      context_lines: {
        type: 'number',
        description: 'Lines of context around match (default: 1)',
      },
    },
    required: ['keywords'],
    additionalProperties: true,
  },
  execute: async (args: any) => {
    const keywordArg = args?.keywords;
    const scope = String(args?.scope || 'both').toLowerCase().trim();
    const contextLines = Math.max(0, Math.min(3, Number(args?.context_lines || 1)));
    
    // Parse keywords
    let keywords: string[] = [];
    if (Array.isArray(keywordArg)) {
      keywords = keywordArg.map(k => String(k).toLowerCase().trim());
    } else if (typeof keywordArg === 'string') {
      keywords = keywordArg
        .split(/[\s,]+/)
        .map(k => k.toLowerCase().trim())
        .filter(k => k.length > 0);
    }
    
    if (keywords.length === 0) {
      return { success: false, error: 'No valid keywords provided' };
    }
    
    const filesToSearch: Record<string, string> = {};
    const workspacePath = getConfig().getWorkspacePath();
    
    if (scope === 'user' || scope === 'both') {
      const userPath = path.join(workspacePath, 'USER.md');
      if (fs.existsSync(userPath)) {
        filesToSearch['user.md'] = fs.readFileSync(userPath, 'utf-8');
      }
    }
    
    if (scope === 'soul' || scope === 'both') {
      const soulPath = path.join(workspacePath, 'SOUL.md');
      if (fs.existsSync(soulPath)) {
        filesToSearch['soul.md'] = fs.readFileSync(soulPath, 'utf-8');
      }
    }
    
    // Search
    const matches = [];
    for (const [filename, content] of Object.entries(filesToSearch)) {
      const lines = content.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lowerLine = line.toLowerCase();
        
        // Check if line matches any keyword
        const matchedKeywords = keywords.filter(kw => lowerLine.includes(kw));
        if (matchedKeywords.length === 0) continue;
        
        // Build snippet with context
        const startLine = Math.max(0, i - contextLines);
        const endLine = Math.min(lines.length - 1, i + contextLines);
        const snippet = lines.slice(startLine, endLine + 1).join('\n');
        
        // Relevance: how many keywords matched
        const relevance = matchedKeywords.length / keywords.length;
        
        matches.push({
          file: filename,
          line_number: i + 1,
          matched_keywords: matchedKeywords,
          snippet,
          relevance,
        });
      }
    }
    
    return {
      success: true,
      keywords,
      scope,
      total_matches: matches.length,
      matches: matches.slice(0, 10), // Limit to 10 matches
      note: 'Returns snippets only, not full files. Limited to top 10 matches.',
    };
  },
};
```

**Files to Create:**
- `src/tools/memory-search.ts` (NEW)

**Files to Modify:**
- `src/tools/registry.ts` (import and register memorySearchTool)

---

### Task 4: Expose memory_write in buildTools()

**Files to Modify:**
- `src/tools/memory.ts` (expose memory_write tool with enhanced routing)
- `src/tools/registry.ts` (add memoryWriteTool to buildTools)
- `src/gateway/server-v2.ts` (ensure memory_write is in tool list)

**Changes to memory_write:**

```typescript
// Enhanced memory_write with auto-routing and dual-write for identity changes

const IDENTITY_CRITICAL_KEYWORDS = [
  'name', 'role', 'framing', 'operational mode', 'mode', 'baseline', 
  'constraint', 'call', 'named', 'identity'
];

export const memoryWriteTool = {
  name: 'memory_write',
  description: 'Write memory entry to USER.md, SOUL.md, or IDENTITY.md with auto-routing',
  schema: {
    content: 'Memory entry content to write',
    target: 'Optional target: user, soul, or identity (auto-routes if not specified)',
    key: 'Optional key for structured updates',
    override: 'Optional boolean to force exact target despite auto-routing',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Memory entry content' },
      target: { 
        type: 'string',
        enum: ['user', 'soul', 'identity'],
        description: 'Target file (auto-routed if not specified)'
      },
      key: { type: 'string', description: 'Optional structured key' },
      override: { type: 'boolean', description: 'Force exact target' },
    },
    required: ['content'],
    additionalProperties: true,
  },
  execute: async (args: any) => {
    const content = String(args?.content || '').trim();
    if (!content) {
      return { success: false, error: 'content is required' };
    }
    
    let target = String(args?.target || '').toLowerCase().trim() || null;
    const override = args?.override === true;
    
    // Auto-routing if no target specified
    if (!target && !override) {
      const lowerContent = content.toLowerCase();
      
      // Check if identity-critical
      const isIdentityCritical = IDENTITY_CRITICAL_KEYWORDS.some(kw => 
        lowerContent.includes(kw)
      );
      
      if (isIdentityCritical) {
        target = 'BOTH'; // Special case: write to both
      } else if (
        lowerContent.includes('prefer') ||
        lowerContent.includes('like') ||
        lowerContent.includes('habit') ||
        lowerContent.includes('user') ||
        lowerContent.includes('communication')
      ) {
        target = 'user';
      } else {
        target = 'soul';
      }
    }
    
    // Write to target(s)
    const writtenTo = [];
    
    if (target === 'BOTH' || target === 'identity') {
      // Write to IDENTITY.md
      appendToFile('IDENTITY.md', content);
      writtenTo.push('identity.md');
    }
    
    if (target === 'BOTH' || target === 'soul') {
      // Write to SOUL.md
      appendToFile('SOUL.md', content);
      writtenTo.push('soul.md');
    }
    
    if (target === 'user' || target === 'USER') {
      // Write to USER.md
      appendToFile('USER.md', content);
      writtenTo.push('user.md');
    }
    
    if (writtenTo.length === 0) {
      return { success: false, error: `Invalid target: ${target}` };
    }
    
    return {
      success: true,
      written_to: writtenTo,
      content_snippet: content.substring(0, 100),
      note: writtenTo.length > 1 ? 'Identity-critical change written to multiple files' : undefined,
    };
  },
};
```

---

### Task 5: Extend write_note for Intraday Memory

**Files to Modify:**
- `src/gateway/server-v2.ts` (enhance write_note handler around line 2191)
- Create `src/tools/write-note.ts` (NEW) as tool wrapper

**Changes:**

```typescript
// Enhanced write_note handler

const INTRADAY_NOTES_DIR = path.join(workspacePath, 'memory');

export const writeNoteTool = {
  name: 'write_note',
  description: 'Write temporary note to today\'s intraday memory (auto-cleaned at EOD)',
  schema: {
    content: 'Note content',
    tag: 'Optional tag: task, debug, discovery, or general',
    task_id: 'Optional task ID if related to specific task',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Note content' },
      tag: { 
        type: 'string',
        enum: ['task', 'debug', 'discovery', 'general'],
        description: 'Note tag/category'
      },
      task_id: { type: 'string', description: 'Related task ID if applicable' },
    },
    required: ['content'],
    additionalProperties: true,
  },
  execute: async (args: any) => {
    const content = String(args?.content || '').trim();
    const tag = String(args?.tag || 'general').toLowerCase();
    const taskId = args?.task_id ? String(args.task_id) : null;
    
    if (!content) {
      return { success: false, error: 'content is required' };
    }
    
    // Ensure memory dir exists
    if (!fs.existsSync(INTRADAY_NOTES_DIR)) {
      fs.mkdirSync(INTRADAY_NOTES_DIR, { recursive: true });
    }
    
    // Get today's file
    const today = new Date().toISOString().split('T')[0];
    const notesFile = path.join(INTRADAY_NOTES_DIR, `${today}-intraday-notes.md`);
    
    // Format entry
    const timestamp = new Date().toISOString();
    const entryId = crypto.randomUUID();
    let entry = `\n### [${tag.toUpperCase()}] ${timestamp}\n${content}`;
    if (taskId) {
      entry += `\n_Related task: ${taskId}_`;
    }
    
    // Append to file
    try {
      fs.appendFileSync(notesFile, entry + '\n');
      
      return {
        success: true,
        entry_id: entryId,
        timestamp,
        tag,
        task_id: taskId || null,
        file: notesFile,
        content_snippet: content.substring(0, 50),
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to write note: ${err.message}`,
      };
    }
  },
};
```

---

### Task 6: Enhance BOOT Snapshot

**Files to Modify:**
- `src/gateway/boot.ts` (enhance snapshot builder)

**Changes:**

```typescript
// Enhanced boot snapshot with schedule status + intraday notes

function buildBootPrompt(taskData: string, memoryData: string, scheduleData: string, intradayNotes: string): string {
  return [
    'BOOT STARTUP SUMMARY:',
    'The following data has already been fetched for you. Do not call any tools.',
    'Read the data below and reply with a 2-3 sentence startup summary.',
    '',
    '## CURRENT TASKS:',
    taskData || '(no tasks found)',
    '',
    '## SCHEDULE STATUS:',
    scheduleData || '(no scheduled jobs)',
    '',
    '## TODAY\'S NOTES:',
    intradayNotes || '(no notes yet)',
    '',
    '## LATEST MEMORY:',
    memoryData || '(no memory file found)',
    '',
    'Summarize: any tasks needing attention, any scheduled items coming up, and one line on where things left off.',
  ].join('\n').trim();
}

export async function runBootMd(
  workspacePath: string,
  handleChat: HandleChatFn,
  taskControl?: TaskControlFn,
  scheduleControl?: ScheduleControlFn,
): Promise<BootResult> {
  // ... existing code ...
  
  // Pre-fetch schedule status
  let scheduleData = '(schedule_control unavailable)';
  if (scheduleControl) {
    try {
      const result = await scheduleControl({ action: 'list', limit: 10 });
      scheduleData = JSON.stringify(result, null, 2).slice(0, 1000);
    } catch (e: any) {
      scheduleData = `(schedule error: ${e?.message})`;
    }
  }
  
  // Pre-fetch today's intraday notes
  let intradayNotes = '(no notes)';
  const today = new Date().toISOString().split('T')[0];
  const notesPath = path.join(workspacePath, 'memory', `${today}-intraday-notes.md`);
  if (fs.existsSync(notesPath)) {
    const notes = fs.readFileSync(notesPath, 'utf-8').slice(-1500);
    intradayNotes = notes;
  }
  
  const prompt = buildBootPrompt(taskData, memoryData, scheduleData, intradayNotes);
  
  // ... rest of function ...
}
```

---

### Task 7: Update IDENTITY.md with Runtime Facts

**File:** `workspace/IDENTITY.md` (MODIFY)

**Current:**
```markdown
- Name: SmallClaw
- Creature: AI agent — a lobster in your workspace 🦞
- Vibe: Direct, resourceful, occasionally dry. Gets things done.
- Emoji: 🦞
- Version: v2 (native Ollama tool calling)
```

**Target (Expanded but Still Short):**
```markdown
- **Name:** SmallClaw
- **Role:** Local AI agent for Raul, running on Windows with native tool access
- **Runtime:** Ollama native tools, TypeScript/Node.js gateway
- **Access:** Full file system, shell commands, browser automation, desktop control
- **Personality:** Direct, resourceful, occasionally dry. Gets things done.
- **Emoji:** 🦞
- **Constraints:** ~8K token budget for system prompt per message

**What I Am Right Now:**
- Running locally on your machine (not cloud-based)
- Can execute code, read files, control your desktop
- Learn and grow through USER.md and SOUL.md updates
- Remember important facts in facts.json
```

---

### Task 8: Shorten SOUL.md

**File:** `workspace/SOUL.md` (MODIFY)

**Strategy:**
- Keep core truths section (2-3 sentences each)
- Condense memory & growth rules section (current: ~200 lines → target: ~50 lines)
- Keep personality section (brief)
- Keep limitations (brief)
- Keep critical tool rules (condensed)
- Remove all examples and extended explanations

**New structure (~350 lines total):**
1. Core Truths (condensed)
2. Your Personality (brief)
3. Memory & Growth Rules (condensed)
4. Critical Tool Rules (condensed)
5. Boundaries (brief)
6. Your Limitations (brief)

---

### Task 9: Update TOOLS.md with Full List

**File:** `workspace/TOOLS.md` (MODIFY)

**New content structure:**

```markdown
# TOOLS.md — Available Tools

## File & Shell Tools
- `shell` - Execute shell commands
- `read` - Read file contents
- `write` - Write file contents
- `edit` - Edit specific lines in file
- `list` - List directory contents
- `delete` - Delete file or directory
- `rename` - Rename file
- `copy` - Copy file
- `mkdir` - Create directory
- `stat` - Get file metadata
- `append` - Append to file
- `apply_patch` - Apply unified diff patch

## Web Tools
- `web_search` - Google Custom Search
- `web_fetch` - Fetch and parse web page

## Memory Tools
- `memory_write` - Write to USER.md or SOUL.md
- `memory_read` - Read full USER.md or SOUL.md
- `memory_search` - Search both memory files by keyword

## Intraday Memory
- `write_note` - Write temporary note (auto-cleaned at EOD)

## Task Tools
- `task_control` - List/get/create/update tasks

## Schedule Tools
- `schedule_job` - Manage cron schedules

## Browser Tools
- `browser_open` - Open web browser
- `browser_snapshot` - Screenshot current page
- `browser_click` - Click element
- `browser_fill` - Fill form field
- ... (full list)

## Desktop Tools
- `desktop_screenshot` - Screenshot desktop
- `desktop_click` - Click mouse
- `desktop_type` - Type text
- ... (full list)

## Decision Table

| What you need | Use this |
|---|---|
| Read a website, GitHub, Reddit | web_search + web_fetch |
| Login to website or fill form | browser_open + browser_click |
| Read or create local files | read/write/edit tools |
| Interact with desktop/apps | desktop_screenshot, desktop_click, etc |
| Search memory/persona | memory_search |
| Remember something important | memory_write |
| Quick temporary note | write_note |

## When to Use TOOLS.md

TOOLS.md is automatically consulted when:
- You make 3+ consecutive tool call errors
- You seem uncertain which tool to use
- You explicitly ask "what tools do I have"

Otherwise, TOOLS.md is not injected to save context tokens.

## Notes
- Line-based file tools (replace_lines, insert_after) work best for edits
- web_search is fragile with special characters; use quoted terms carefully
- Desktop focus requires short process names (msedge, code, not full window title)
```

---

### Task 10: Move AGENTS.md Guidance

**Current State:** AGENTS.md in main workspace, included in prompts

**Target State:** 
- Keep AGENTS.md in main workspace for reference/documentation
- Remove from main chat prompt injection
- Add note at top: "For subagent/multi-agent setups only"

---

## Part 8: File-by-File Change Summary

| File | Change | Priority | Difficulty |
|------|--------|----------|------------|
| `workspace/IDENTITY.md` | Expand with runtime facts | P1 | Easy |
| `workspace/SOUL.md` | Shorten ~50%, consolidate | P1 | Easy |
| `workspace/TOOLS.md` | Full tool list + decision table | P1 | Easy |
| `workspace/memory/YYYY-MM-DD-intraday-notes.md` | Create on first write (NEW) | P2 | Easy |
| `src/gateway/server-v2.ts` | Remove SELF.md always-on injection, add intent detection | P2 | Medium |
| `src/tools/memory-read.ts` | Create memory_read tool | P2 | Easy |
| `src/tools/memory-search.ts` | Create memory_search tool | P2 | Easy |
| `src/tools/memory.ts` | Enhance memory_write with auto-routing + dual-write | P2 | Medium |
| `src/tools/write-note.ts` | Create write_note as intraday memory tool | P2 | Easy |
| `src/tools/registry.ts` | Register new tools | P2 | Easy |
| `src/gateway/boot.ts` | Add schedule + intraday notes to snapshot | P3 | Medium |
| `D:\SmallClaw\mnt\` | Delete (after backup) | P4 | Easy |

---

## Part 9: Rollback Plan

If any change causes issues:

1. **SELF.md injection regressed:** Revert `server-v2.ts` changes, re-add SELF.md to always-on
2. **Memory tools broken:** Revert `src/tools/memory-*.ts` and `registry.ts`
3. **write_note failing:** Revert `src/tools/write-note.ts`
4. **BOOT broken:** Revert `src/gateway/boot.ts`
5. **mnt/ deletion issue:** Restore from backup

All changes should be committed to git before starting implementation.

---

## Part 10: Timeline & Effort Estimate

| Phase | Tasks | Effort | Blockers |
|-------|-------|--------|----------|
| Phase 1 | IDENTITY.md, SOUL.md, TOOLS.md, AGENTS.md scoping | 2-3 hours | None |
| Phase 2 | Memory tool surface (read/search/write) + registry | 3-4 hours | None |
| Phase 3 | write_note intraday memory | 2-3 hours | None |
| Phase 4 | BOOT enhancement | 2 hours | None |
| Phase 5 | Identity sync rule | 1-2 hours | None |
| Phase 6 | Intent detection for SELF.md | 2-3 hours | None |
| Phase 7 | Testing & acceptance | 3-4 hours | None |
| Phase 8 | mnt/ cleanup | 0.5 hours | None |

**Total Estimated Effort:** 16-23 hours

**Can be parallelized:** Yes, phases 1-5 can run in parallel if multiple developers

---

## Approval Checklist

Before implementation begins, confirm:

- [ ] All 12 original questions answered clearly
- [ ] Target architecture understood and approved
- [ ] Memory tool routing logic correct
- [ ] Identity sync rule makes sense
- [ ] write_note intraday behavior approved
- [ ] BOOT enhancement scope approved
- [ ] Testing criteria are realistic
- [ ] Timeline is acceptable
- [ ] Ready to proceed to Phase 1

---

**Document Complete. Ready for Implementation Planning.**
