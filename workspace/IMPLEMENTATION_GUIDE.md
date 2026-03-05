# SmallClaw Restructuring Implementation Guide

## Critical Findings

### Issue 1: runBootMd is Imported but Never Called
**File:** `src/gateway/server-v2.ts` (line 28)
**Status:** Imported but no `await runBootMd(...)` call exists
**Impact:** BOOT.md is never executed at startup
**Fix:** Add boot execution in server startup sequence

### Issue 2: task_control Tool Not Registered  
**File:** `src/tools/registry.ts`
**Status:** BOOT.md requires `task_control` but tool doesn't exist
**Impact:** BOOT.md's step 1 will fail
**Fix:** Create and register task_control tool (wraps TaskStore operations)

### Issue 3: Memory System Incomplete
**File:** `workspace/MEMORY.md` not found
**Status:** MEMORY.md referenced in buildPersonalityContext but file doesn't exist
**Impact:** Long-term memory not initialized
**Fix:** Create MEMORY.md template

### Issue 4: Daily Memory Not Initialized
**Status:** `.smallclaw/memory/` exists but is empty
**Impact:** Daily logs not being written
**Fix:** Ensure daily memory creation in session handlers

---

## Implementation Sequence

### Phase 1: Boot System (Items 1-2)

#### 1.1: Create task_control Tool
**File:** `src/tools/task-control.ts` (NEW)
```typescript
// Expose TaskStore operations as a tool
// Implement: list, get, create, update, delete, cancel
// Schema matches BOOT.md requirements
```

**File:** `src/tools/registry.ts` (EDIT)
```typescript
// Import and register taskControlTool
```

#### 1.2: Wire Up Boot Execution
**File:** `src/gateway/server-v2.ts` (EDIT)
```typescript
// Around line 800+ (server.listen callback):
// Add: const bootResult = await runBootMd(bootWorkspace, handleChat, taskControl);
```

#### 1.3: Enhance BOOT.md
**File:** `workspace/BOOT.md` (EDIT)
```markdown
// Expand to capture result and log to daily memory
// Add error handling
```

### Phase 2: Workspace Documentation (Items 3-8)

#### 2.1: Shorten SOUL.md
**File:** `workspace/SOUL.md` (EDIT)
- Condense Memory & Growth Rules (currently 200+ lines)
- Keep critical sections, remove redundancy
- Target: ~50% reduction

#### 2.2: Audit .smallclaw Folder
**File:** `workspace/SMALLCLAW_AUDIT.md` (NEW)
```
- sessions/: Active session files
- tasks/: Persisted task records
- cron/: Scheduled job definitions
- memory/: Daily session logs (YYYY-MM-DD.md)
- skills/: Enabled skill configurations
- credentials/: Encrypted credential storage
- logs/: Error and activity logs
```

#### 2.3: Clarify workspace/mnt
**Decision:** Does workspace/mnt exist and what's its purpose?
**Action:** Document or create with clear conventions

#### 2.4: Update AGENTS.md
**File:** `workspace/AGENTS.md` (EDIT)
- Verify boot sequence description
- Cross-check tool references
- Update any outdated sections

#### 2.5: Create TOOLS.md Complete List
**File:** `workspace/TOOLS.md` (EDIT)
- Update available tools list (add task_control if created)
- Add decision table for new categories
- Document tool profiles: minimal, coding, web, full

### Phase 3: System Runtime (Items 9-12)

#### 3.1: Verify Task Tools (Item 9)
**Tasks:**
- [ ] Confirm start_task, list_tasks, get_task, update_task are available
- [ ] Test task persistence and resumption
- [ ] Verify status transitions

#### 3.2: Redesign write_note (Item 10)
**Current:** Simple file append
**Target:** Intraday memory with notifications
```typescript
// write_note should:
// 1. Create entry in workspace/memory/YYYY-MM-DD-notes.md
// 2. Send browser/log notification
// 3. Support retrieval by recent context
// 4. Enable live WebSocket updates
```

#### 3.3: Memory System Redesign (Item 11)
**Create:** `workspace/MEMORY.md` (TEMPLATE)
**Update:** Define lifecycle:
- Capture → Daily notes (memory/YYYY-MM-DD.md)
- Archive → MEMORY.md (curated long-term)
- Update USER.md with recurring facts

#### 3.4: Document Runtime Prompts (Item 12)
**Create:** `workspace/SYSTEM_PROMPT_SPEC.md`
```
File Injection Order:
1. IDENTITY.md (200 char limit)
2. SOUL.md (500 char limit)
3. USER.md (300 char limit)
4. MEMORY.md (600 char limit)
5. SELF.md (600 char limit)
6. Daily notes from memory/YYYY-MM-DD.md
7. Active skills
8. Caller context (Telegram, browser, etc.)
9. Tool list (varies by profile)

Total budget: ~8000 tokens for prompt composition
```

---

## Workspace File Status

| File | Status | Action |
|------|--------|--------|
| BOOT.md | ✓ Exists | Wire up execution, enhance |
| IDENTITY.md | ✓ Exists | Reference in boot sequence |
| SOUL.md | ✓ Exists | Shorten ~50% |
| USER.md | ✓ Exists | Template for human context |
| AGENTS.md | ✓ Exists | Update references |
| SELF.md | ✓ Exists | Verify size limits |
| TOOLS.md | ✓ Exists | Complete tool list |
| MEMORY.md | ✗ Missing | Create template |
| memory/ | ✓ Empty | Initialize on first session |
| SMALLCLAW_AUDIT.md | ✗ Missing | Create audit doc |
| SYSTEM_PROMPT_SPEC.md | ✗ Missing | Create spec doc |
| RESTRUCTURE_PROGRESS.md | ✓ Created | Tracking document |

---

## Tool Creation Checklist (task_control)

```typescript
// task_control Tool Definition
{
  name: 'task_control',
  description: 'Manage workspace tasks: list, get, create, update, cancel',
  schema: {
    action: 'list|get|create|update|cancel',
    taskId: 'Task ID (for get/update/cancel)',
    goal: 'Task goal/description (for create)',
    status: 'Filter by status (for list)',
    limit: 'Max results (for list)',
  },
  execute: async (args) => {
    const { action, taskId, goal, status, limit } = args;
    
    if (action === 'list') {
      return listTasks({ status, limit: limit || 20 });
    } else if (action === 'get') {
      return loadTask(taskId);
    } else if (action === 'create') {
      return createTask({ goal });
    } else if (action === 'update') {
      return updateTask(taskId, args);
    } else if (action === 'cancel') {
      return updateTaskStatus(taskId, 'cancelled');
    }
  }
}
```

---

## Testing Checklist

- [ ] Boot sequence runs without errors
- [ ] task_control tool responds to all actions
- [ ] BOOT.md produces 2-3 sentence summary
- [ ] SOUL.md shortened without losing guidance
- [ ] TOOLS.md lists all tools including task_control
- [ ] Daily memory created on first chat
- [ ] System prompt injected with all workspace files
- [ ] Task resumption works after restart
- [ ] Telegra notifications work (if configured)
- [ ] Memory write and search working

---

## Notes

- Keep workspace files concise (~8K tokens total for system prompt)
- BOOT.md results should be logged to daily memory
- task_control is critical for automation and resumption
- Memory lifecycle: capture → daily → long-term curation
