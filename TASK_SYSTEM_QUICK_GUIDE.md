# SmallClaw Task System Quick Guide

Date: 2026-02-27

## What The Task System Is

SmallClaw has an autonomous background task engine that can:

- plan multi-step tasks,
- run them detached from the active chat request,
- pause/resume when blocked,
- stream status updates to the UI,
- and notify both the originating chat and Telegram on completion.

Core files:

- `src/gateway/task-store.ts`
- `src/gateway/background-task-runner.ts`
- `src/gateway/server-v2.ts`
- `web-ui/index.html`

## High-Level Architecture

There are 3 main layers:

1. Data layer (`task-store.ts`)
- Persists each task as JSON under `.localclaw/tasks/`.
- Maintains task index, status, plan steps, journal, and resume context.

2. Execution layer (`background-task-runner.ts`)
- Executes one task in autonomous rounds via `handleChat(...)`.
- Writes journal events, tool calls/results, and step completion progress.
- Applies retries, timeout handling, and pause-for-assistance logic.

3. Gateway/API/UI layer (`server-v2.ts`, `web-ui/index.html`)
- Creates tasks, starts runners, resumes/pauses/deletes tasks.
- Exposes REST + WS event stream to the web UI.
- Renders kanban board, task detail panel, and heartbeat controls.

## Task Lifecycle

1. Task creation
- User request is routed to background mode.
- Task record is created with:
  - `status = queued`
  - initial `plan[]`
  - `currentStepIndex = 0`
  - empty `resumeContext`

2. Execution start
- `BackgroundTaskRunner.start()` moves task to `running`.
- Runner uses deterministic session key `task_<taskId>`.
- Prior resume messages are restored (capped to recent history).

3. Round loop
- Each round builds a step-aware prompt and calls `handleChat(...)`.
- Tool calls/results are journaled and broadcast to UI.
- Step output is verified before advancing.
- On success, step is marked complete and runner continues.

4. Completion
- Status set to `complete`.
- Final summary persisted.
- Notification delivered to:
  - originating chat session,
  - Telegram (forced on completion when Telegram is configured).

5. Pause/failure
- On repeated transport/model issues, or loop stalls:
  - task goes to `needs_assistance` (or `paused` for user pause),
  - user is prompted with task ID + reason.

## Data Model (TaskRecord)

Key fields:

- `id`, `title`, `prompt`
- `sessionId` (originating chat session)
- `channel` (`web` or `telegram`)
- `status` (`queued`, `running`, `paused`, `stalled`, `needs_assistance`, `complete`, `failed`)
- `plan[]` with per-step status
- `currentStepIndex`
- `journal[]` (tool events, pauses, errors, status pushes)
- `resumeContext` (recent messages + metadata)
- `finalSummary`

## Runner Behavior Highlights

- Uses `MAX_RESUME_MESSAGES = 10` to prevent context bloat.
- Uses background session max history (`40`) for runner sessions.
- Per-round timeout defaults to 120s (`LOCALCLAW_BG_ROUND_TIMEOUT_MS` override supported).
- Transport errors are retried with backoff before pausing.
- Repetitive tool-call loop detection pauses stalled tasks.
- Step completion is verified before moving to next step.

## Pause/Resume Semantics

Follow-up handling in `server-v2.ts` now separates intent:

- status question: returns status only, does not resume,
- explicit resume: resumes task,
- explicit adjustment: queues adjustment and resumes,
- ambiguous message: keeps task paused and asks for explicit action.

This prevents accidental resumes on messages like "what happened?".

## Notifications

Delivery path (`_deliverToChannel`):

- writes paired messages into originating chat history:
  - synthetic user marker,
  - assistant result/status text.
- sends to Telegram when:
  - task channel is Telegram, or
  - completion flow uses forced Telegram delivery.

## Background Task Heartbeat

Separate from Cron heartbeat.

Config path:

- `.localclaw/task-heartbeat.json`

API:

- `GET /api/bg-tasks/heartbeat/config`
- `PUT /api/bg-tasks/heartbeat/config`

Used to periodically resume paused/queued/stalled tasks via advisor logic.

## API Endpoints (Task System)

Main endpoints in `server-v2.ts`:

- `GET /api/bg-tasks`
- `GET /api/bg-tasks/:id`
- `DELETE /api/bg-tasks/:id`
- `POST /api/bg-tasks/:id/pause`
- `POST /api/bg-tasks/:id/resume`
- `GET /api/bg-tasks/:id/stream`
- `GET /api/bg-tasks/heartbeat/config`
- `PUT /api/bg-tasks/heartbeat/config`

## Web UI Behavior

Tasks UI lives in `web-ui/index.html`:

- Header mode toggle: `Chat` and `Tasks`.
- Tasks board renders status columns from `/api/bg-tasks`.
- Task detail panel shows plan, journal, summary, and pause/resume controls.
- Heartbeat button in tasks header opens modal for interval + enabled toggle.
- Heartbeat modal supports close via:
  - Cancel/Close buttons,
  - outside click,
  - `Esc`.

## Eventing

WebSocket events drive real-time updates:

- `task_running`, `task_step_done`, `task_complete`, `task_failed`
- `task_paused`, `task_needs_assistance`
- `task_tool_call`
- heartbeat-related task events
- `task_notification` (status push to originating session)

## Operational Notes

- Tasks are durable on disk; they survive process restarts.
- Runner is guarded against duplicate starts per task ID.
- Session cleanup handles stale automated sessions.
- If provider/network fails mid-run, partial tool actions may already be committed.

## Quick Troubleshooting

If tasks appear stuck:

1. Check task journal in task detail panel.
2. Check for `needs_assistance` status and follow-up reason.
3. Verify provider/network health if errors show `fetch failed`/transport issues.
4. Resume explicitly with `resume` or a clear adjustment instruction.
