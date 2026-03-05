/**
 * task-control.ts - Task management tool
 *
 * Exposes TaskStore operations as a tool so agents can:
 * - List tasks (with filtering)
 * - Get specific task details
 * - Create new tasks
 * - Update task status/progress
 * - Cancel tasks
 *
 * Used by BOOT.md and automation workflows.
 */

import { ToolResult } from '../types.js';
import {
  listTasks,
  createTask,
  loadTask,
  saveTask,
  updateTaskStatus,
  appendJournal,
  deleteTask,
  type TaskRecord,
  type TaskStatus,
} from '../gateway/task-store.js';

const VALID_STATUSES: TaskStatus[] = [
  'queued', 'running', 'paused', 'stalled', 'needs_assistance',
  'complete', 'failed', 'waiting_subagent',
];

export const taskControlTool = {
  name: 'task_control',
  description: 'Manage workspace tasks: list, get, create, update, cancel, delete',
  schema: {
    action: 'Action: list, get, create, update, cancel, or delete',
    task_id: 'Task ID for get/update/cancel/delete actions',
    goal: 'Task goal/description for create action',
    status: 'Filter by status for list action (e.g. "pending", "running", "done", "failed")',
    include_all_sessions: 'Include tasks from all sessions (for list)',
    limit: 'Max results for list action (default 20)',
    new_status: 'New status for update action',
    journal_entry: 'Journal entry to append for update action',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'create', 'update', 'cancel', 'delete'],
        description: 'Action to perform',
      },
      task_id: {
        type: 'string',
        description: 'Task ID for get/update/cancel/delete actions',
      },
      goal: {
        type: 'string',
        description: 'Task goal/description for create action',
      },
      status: {
        type: 'string',
        description: 'Filter by status for list action',
      },
      include_all_sessions: {
        type: 'boolean',
        description: 'Include tasks from all sessions (default false)',
      },
      limit: {
        type: 'number',
        description: 'Max results for list action (default 20)',
      },
      new_status: {
        type: 'string',
        description: 'New status for update action',
      },
      journal_entry: {
        type: 'string',
        description: 'Journal entry to append for update action',
      },
    },
    required: ['action'],
    additionalProperties: true,
  },
  execute: async (args: any): Promise<ToolResult> => {
    try {
      const {
        action,
        task_id,
        goal,
        status,
        include_all_sessions,
        limit,
        new_status,
        journal_entry,
      } = args || {};

      if (!action) {
        return {
          success: false,
          error: 'action is required. Valid actions: list, get, create, update, cancel, delete',
        };
      }

      const normalizedAction = String(action).toLowerCase().trim();

      // LIST tasks
      if (normalizedAction === 'list') {
        try {
          const allTasks = listTasks();
          let filtered = allTasks;

          if (status) {
            const statusStr = String(status).toLowerCase().trim();
            filtered = filtered.filter(t => String(t.status || '').toLowerCase() === statusStr);
          }

          const maxResults = Math.max(1, Math.min(limit || 20, 100));
          const results = filtered.slice(0, maxResults);

          return {
            success: true,
            stdout: `Listed ${results.length} task(s)`,
            data: {
              count: results.length,
              total_available: filtered.length,
              tasks: results.map((t: TaskRecord) => ({
                id: t.id,
                title: t.title,
                prompt: t.prompt,
                status: t.status,
                startedAt: t.startedAt,
                lastProgressAt: t.lastProgressAt,
                stepCount: t.journal?.length || 0,
              })),
            },
          };
        } catch (err: any) {
          return { success: false, error: `Failed to list tasks: ${err?.message || err}` };
        }
      }

      // GET task
      if (normalizedAction === 'get') {
        if (!task_id) return { success: false, error: 'task_id is required for get action' };
        try {
          const task = loadTask(String(task_id));
          if (!task) return { success: false, error: `Task not found: ${task_id}` };
          return {
            success: true,
            stdout: `Loaded task: ${task.title}`,
            data: task,
          };
        } catch (err: any) {
          return { success: false, error: `Failed to get task: ${err?.message || err}` };
        }
      }

      // CREATE task
      if (normalizedAction === 'create') {
        if (!goal) return { success: false, error: 'goal is required for create action' };
        try {
          const task = createTask({
            title: String(goal).slice(0, 120),
            prompt: String(goal),
            sessionId: 'tool-created',
            channel: 'web',
            plan: [{ index: 0, description: String(goal), status: 'pending' }],
          });
          return {
            success: true,
            stdout: `Created task: ${task.id}`,
            data: { id: task.id, title: task.title, status: task.status },
          };
        } catch (err: any) {
          return { success: false, error: `Failed to create task: ${err?.message || err}` };
        }
      }

      // UPDATE task
      if (normalizedAction === 'update') {
        if (!task_id) return { success: false, error: 'task_id is required for update action' };
        try {
          const task = loadTask(String(task_id));
          if (!task) return { success: false, error: `Task not found: ${task_id}` };

          if (new_status) {
            const s = String(new_status) as TaskStatus;
            if (!VALID_STATUSES.includes(s)) {
              return { success: false, error: `Invalid status "${new_status}". Valid: ${VALID_STATUSES.join(', ')}` };
            }
            task.status = s;
            task.lastProgressAt = Date.now();
          }

          if (journal_entry) {
            appendJournal(task.id, { type: 'status_push', content: String(journal_entry) });
          }

          saveTask(task);
          return {
            success: true,
            stdout: `Updated task: ${task_id}`,
            data: { id: task.id, status: task.status, journal_entries: task.journal?.length || 0 },
          };
        } catch (err: any) {
          return { success: false, error: `Failed to update task: ${err?.message || err}` };
        }
      }

      // CANCEL task
      if (normalizedAction === 'cancel') {
        if (!task_id) return { success: false, error: 'task_id is required for cancel action' };
        try {
          const task = loadTask(String(task_id));
          if (!task) return { success: false, error: `Task not found: ${task_id}` };
          updateTaskStatus(String(task_id), 'failed');
          appendJournal(String(task_id), { type: 'status_push', content: 'Task cancelled by operator.' });
          return { success: true, stdout: `Cancelled task: ${task_id}`, data: { id: task_id, status: 'failed' } };
        } catch (err: any) {
          return { success: false, error: `Failed to cancel task: ${err?.message || err}` };
        }
      }

      // DELETE task
      if (normalizedAction === 'delete') {
        if (!task_id) return { success: false, error: 'task_id is required for delete action' };
        try {
          const task = loadTask(String(task_id));
          if (!task) return { success: false, error: `Task not found: ${task_id}` };
          deleteTask(String(task_id));
          return { success: true, stdout: `Deleted task: ${task_id}`, data: { id: task_id } };
        } catch (err: any) {
          return { success: false, error: `Failed to delete task: ${err?.message || err}` };
        }
      }

      return {
        success: false,
        error: `Unknown action: ${action}. Valid actions: list, get, create, update, cancel, delete`,
      };
    } catch (err: any) {
      return { success: false, error: `task_control error: ${err?.message || err}` };
    }
  },
};
