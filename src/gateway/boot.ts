/**
 * boot.ts - Runs BOOT.md at gateway startup.
 *
 * Pre-executes task_control and reads the latest memory file server-side,
 * then injects the results directly into the boot prompt so the LLM only
 * needs to summarize — no tool calls required during boot.
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

/**
 * Finds the most recent memory file in workspace/memory/
 */
function readLatestMemory(workspacePath: string): { filename: string; content: string } | null {
  const memDir = path.join(workspacePath, 'memory');
  if (!fs.existsSync(memDir)) return null;
  const files = fs.readdirSync(memDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();
  if (!files.length) return null;
  const filename = files[0];
  const content = fs.readFileSync(path.join(memDir, filename), 'utf-8').trim();
  return { filename, content: content.slice(-3000) }; // last 3000 chars is enough context
}

function buildBootPrompt(taskData: string, memoryData: string): string {
  return [
    'BOOT STARTUP SUMMARY:',
    'The following data has already been fetched for you. Do not call any tools.',
    'Read the data below and reply with a 2-3 sentence startup summary.',
    '',
    '## CURRENT TASKS:',
    taskData || '(no tasks found)',
    '',
    '## LATEST MEMORY:',
    memoryData || '(no memory file found)',
    '',
    'Summarize: any tasks needing attention, and one line on where things left off.',
  ].join('\n').trim();
}

export async function runBootMd(
  workspacePath: string,
  handleChat: HandleChatFn,
  taskControl?: TaskControlFn,
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

    // Pre-fetch latest memory file server-side
    let memoryData = '(no memory file found)';
    const mem = readLatestMemory(workspacePath);
    if (mem) {
      memoryData = `File: ${mem.filename}\n\n${mem.content}`;
    }

    // Build prompt with data already injected — LLM just summarizes
    const prompt = buildBootPrompt(taskData, memoryData);

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
