/**
 * boot.ts - Runs BOOT.md at gateway startup.
 *
 * Pre-executes task_control, reads latest memory, checks schedule status,
 * and reads today's intraday notes — all server-side before the LLM sees anything.
 * LLM only needs to summarize — no tool calls required during boot.
 */

import fs from 'fs';
import path from 'path';

type BootResult =
  | { status: 'skipped'; reason: string }
  | { status: 'ran'; reply: string }
  | { status: 'failed'; reason: string };

type HandleChatFn = (
  message: string,
  sessionId: string,
  sendSSE: (event: string, data: any) => void,
) => Promise<{ text: string }>;

type TaskControlFn = (args: Record<string, any>) => Promise<any>;
type ScheduleControlFn = (args: Record<string, any>) => Promise<any>;

/**
 * Finds the most recent non-intraday memory file in workspace/memory/
 */
function readLatestMemory(workspacePath: string): { filename: string; content: string } | null {
  const memDir = path.join(workspacePath, 'memory');
  if (!fs.existsSync(memDir)) return null;
  const files = fs.readdirSync(memDir)
    .filter(f => f.endsWith('.md') && !f.includes('intraday-notes'))
    .sort()
    .reverse();
  if (!files.length) return null;
  const filename = files[0];
  const content = fs.readFileSync(path.join(memDir, filename), 'utf-8').trim();
  return { filename, content: content.slice(-3000) };
}

/**
 * Reads today's intraday notes if they exist
 */
function readTodayIntradayNotes(workspacePath: string): string {
  const today = new Date().toISOString().split('T')[0];
  const notesPath = path.join(workspacePath, 'memory', `${today}-intraday-notes.md`);
  if (!fs.existsSync(notesPath)) return '(no notes yet today)';
  const content = fs.readFileSync(notesPath, 'utf-8').trim();
  if (!content) return '(no notes yet today)';
  return content.slice(-1500);
}

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
    intradayNotes || '(no notes yet today)',
    '',
    '## LATEST MEMORY:',
    memoryData || '(no memory file found)',
    '',
    'Summarize: any tasks needing attention, any scheduled items coming up, today\'s notes if relevant, and one line on where things left off.',
  ].join('\n').trim();
}

export async function runBootMd(
  workspacePath: string,
  handleChat: HandleChatFn,
  taskControl?: TaskControlFn,
  scheduleControl?: ScheduleControlFn,
): Promise<BootResult> {
  const bootPath = path.join(workspacePath, 'BOOT.md');
  if (!fs.existsSync(bootPath)) return { status: 'skipped', reason: 'BOOT.md not found' };

  console.log('[boot-md] Running BOOT.md...');

  try {
    // Pre-fetch tasks server-side
    let taskData = '(task_control unavailable)';
    if (taskControl) {
      try {
        const result = await taskControl({ action: 'list', status: '', include_all_sessions: true, limit: 20 });
        taskData = JSON.stringify(result, null, 2).slice(0, 2000);
      } catch (e: any) {
        taskData = `(task_control error: ${e?.message || 'unknown'})`;
      }
    }

    // Pre-fetch schedule status server-side
    let scheduleData = '(schedule_control unavailable)';
    if (scheduleControl) {
      try {
        const result = await scheduleControl({ action: 'list', limit: 10 });
        scheduleData = JSON.stringify(result, null, 2).slice(0, 1000);
      } catch (e: any) {
        scheduleData = `(schedule error: ${e?.message || 'unknown'})`;
      }
    }

    // Pre-fetch latest memory file server-side
    let memoryData = '(no memory file found)';
    const mem = readLatestMemory(workspacePath);
    if (mem) {
      memoryData = `File: ${mem.filename}\n\n${mem.content}`;
    }

    // Pre-fetch today's intraday notes
    const intradayNotes = readTodayIntradayNotes(workspacePath);

    // Build prompt with all data already injected — LLM just summarizes
    const prompt = buildBootPrompt(taskData, memoryData, scheduleData, intradayNotes);

    const result = await handleChat(
      prompt,
      'boot-startup',
      (evt, data) => {
        if (evt === 'tool_call') {
          console.log(`[boot-md]  -> ${String(data?.action || 'unknown')} (unexpected during boot)`);
        }
      },
    );

    const finalText = String(result.text || '');
    console.log(`[boot-md] Done: ${finalText.slice(0, 120)}`);
    return { status: 'ran', reply: finalText };
  } catch (err: any) {
    const reason = String(err?.message || err || 'unknown error');
    console.warn(`[boot-md] Failed: ${reason}`);
    return { status: 'failed', reason };
  }
}
