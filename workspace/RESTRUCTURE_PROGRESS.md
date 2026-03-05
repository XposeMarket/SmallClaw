# SmallClaw Restructuring Progress

Session: 2026-03-04

## Overview
12 planned improvements to workspace structure, memory management, and runtime systems.

---

## Items

### 1. BOOT.MD → Boot System Conversion ❌
Convert BOOT.md from a static checklist to a dynamic task runner.
- [ ] Implement boot sequence in `src/gateway/boot.ts` or enhance existing
- [ ] Make boot executable with proper task state tracking
- [ ] Integrate with task persistence

### 2. Auto-Startup Sequence ❌
Establish automatic chain: Identity → Soul → User → tasks/status/runtime
- [ ] Wire up IDENTITY.md loading at startup
- [ ] Ensure SOUL.md is loaded for system prompt
- [ ] Load USER.md context before handling messages
- [ ] Load task status and resume any pending tasks

### 3. Soul.MD Shortening ❌
Reduce SOUL.md verbosity while maintaining guidance
- [ ] Condense Memory & Growth Rules section
- [ ] Consolidate overlapping principles
- [ ] Target: keep critical sections, reduce ~30% length
- Current length: ~700 lines

### 4. .smallclaw Folder Audit ❌
Review folder structure and usage
- [ ] Document purpose of each subdirectory
- [ ] Check for stale/unused data
- [ ] Verify cleanup policies

### 5. MNT Folder Purpose Determination ❌
Clarify what workspace/mnt should contain
- [ ] Does it exist? Check current state
- [ ] Define use case (temp files? external data?)
- [ ] Establish naming/cleanup conventions

### 6. AGENTS.MD Reference Check ❌
Verify AGENTS.md still accurately describes workspace
- [ ] Cross-check against current tool implementation
- [ ] Update any out-of-date references
- [ ] Ensure boot sequence description is correct

### 7. SELF.MD Usage Verification ❌
Confirm SELF.md is loaded and used properly
- [ ] Check buildPersonalityContext() includes SELF.md
- [ ] Verify size limits (600 chars mentioned)
- [ ] Document when to read SELF.md vs when to use it

### 8. TOOLS.md Full Tool List Update ❌
Ensure TOOLS.md includes all 7+ new API endpoints
- [ ] List all current tools in registry
- [ ] Add decision table for new tool categories
- [ ] Document any breaking changes since last update

### 9. Task Management Tools Verification ❌
Confirm all task tools working properly
- [ ] Test `start_task`, `list_tasks`, `get_task`, `update_task`
- [ ] Verify task persistence and resumption
- [ ] Check task status transitions

### 10. write_note Redesign ❌
Redesign write_note for intraday memory with notifications
- [ ] Add notification system (browser notification? log entry?)
- [ ] Support quick capture with optional context
- [ ] Implement retrieval mechanism
- [ ] Consider WebSocket live-updates

### 11. Memory System Redesign ❌
Redesign memory system targeting workspace/User.MD, workspace/Soul.MD
- [ ] Clarify memory vs workspace files
- [ ] Implement lifecycle (capture → workspace → archive)
- [ ] Update MEMORY.md documentation
- [ ] Define what goes where

### 12. Runtime Prompts Documentation ❌
Document all system prompt components and their sizes
- [ ] List all files injected into system prompt
- [ ] Document character limits
- [ ] Create template for system prompt composition
- [ ] Note any dynamic injection points

---

## Next Steps

1. Start with Items 1-3 (Boot system and startup sequence)
2. Move to Items 4-6 (Workspace structure and documentation)
3. Continue with Items 7-12 (Tools, memory, and runtime)
