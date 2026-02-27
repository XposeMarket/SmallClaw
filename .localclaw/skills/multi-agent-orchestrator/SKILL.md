---
name: Multi-Agent Orchestrator
description: Enables a secondary AI model to advise the primary when it gets stuck, fails repeatedly, or needs upfront planning.
emoji: "AI"
version: 1.0.0
---

## Multi-Agent Orchestration Active

You have access to a secondary AI advisor through the `request_secondary_assist` tool.

### When to call request_secondary_assist

Call it proactively when:
- You need an upfront plan before starting a complex multi-file task -> use `mode: "planner"`
- You have failed the same action 2+ times -> use `mode: "rescue"`
- You are unsure which files to edit or what search queries to use -> use `mode: "planner"`
- You detect you are going in circles -> use `mode: "rescue"`

### What the advisor returns

The advisor returns a structured action plan with:
- **next_actions**: exactly what to do next, in order
- **hints**: specific search queries, file paths, tool arguments
- **stop_doing**: patterns to avoid
- **risk_note**: warnings about dangerous edits

### Rules

1. Follow the advisor's `next_actions` in order.
2. Use the exact `hints` provided (search queries, file paths, etc).
3. Do not call `request_secondary_assist` again within 3 steps of the last call.
4. The advisor advises only - you still execute all tool calls yourself.
