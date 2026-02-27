/**
 * boot.ts - Runs BOOT.md at gateway startup.
 *
 * Called by the gateway:startup hook. Reads BOOT.md from the workspace,
 * runs it as a handleChat() turn on an isolated session, and logs the result.
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

function buildBootPrompt(instructions: string, strict = false): string {
  const header = strict
    ? [
        'BOOT STARTUP TASK (STRICT):',
        'You MUST use tools before answering.',
        'Allowed tools in BOOT mode: list_files, read_file only.',
        'Required: call list_files once, then call read_file for relevant file(s).',
        'NEVER call run_command, start_task, browser_*, or desktop_* tools.',
        'Do not claim files are unavailable unless a tool returned that error.',
        'After those calls, output the startup summary directly.',
      ].join('\n')
    : [
        'BOOT STARTUP TASK:',
        'Use tools to inspect workspace/task state before answering.',
        'Allowed tools in BOOT mode: list_files, read_file only.',
        'Do not call run_command/start_task/browser_*/desktop_*.',
        'Prefer one list_files call and targeted read_file calls, then summarize.',
      ].join('\n');
  return `${header}\n\n${instructions}`.trim();
}

export async function runBootMd(
  workspacePath: string,
  handleChat: HandleChatFn,
): Promise<BootResult> {
  const bootPath = path.join(workspacePath, 'BOOT.md');
  if (!fs.existsSync(bootPath)) return { status: 'skipped', reason: 'BOOT.md not found' };

  const raw = fs.readFileSync(bootPath, 'utf-8').trim();
  if (!raw) return { status: 'skipped', reason: 'BOOT.md is empty' };

  // Strip YAML frontmatter if present.
  const instructions = raw.replace(/^---[\s\S]*?---\n*/m, '').trim();
  if (!instructions) return { status: 'skipped', reason: 'BOOT.md has only frontmatter' };

  console.log('[boot-md] Running BOOT.md...');
  try {
    let toolCalls = 0;
    const firstPrompt = buildBootPrompt(instructions, false);
    const result = await handleChat(
      firstPrompt,
      'boot-startup',
      (evt, data) => {
        if (evt === 'tool_call') {
          toolCalls++;
          console.log(`[boot-md]  -> ${String(data?.action || 'unknown')}`);
        }
        if (evt === 'tool_result' && data?.error) {
          console.warn(`[boot-md]  x ${String(data?.action || 'unknown')}: ${String(data?.result || '').slice(0, 120)}`);
        }
      },
    );

    let finalText = String(result.text || '');
    if (toolCalls === 0) {
      console.warn('[boot-md] No tool calls detected on first pass. Retrying with strict tool-use prompt...');
      const strictPrompt = buildBootPrompt(instructions, true);
      const retry = await handleChat(
        strictPrompt,
        'boot-startup',
        (evt, data) => {
          if (evt === 'tool_call') console.log(`[boot-md]  -> ${String(data?.action || 'unknown')}`);
          if (evt === 'tool_result' && data?.error) {
            console.warn(`[boot-md]  x ${String(data?.action || 'unknown')}: ${String(data?.result || '').slice(0, 120)}`);
          }
        },
      );
      finalText = String(retry.text || '');
    }

    console.log(`[boot-md] Done: ${finalText.slice(0, 120)}`);
    return { status: 'ran', reply: finalText };
  } catch (err: any) {
    const reason = String(err?.message || err || 'unknown error');
    console.warn(`[boot-md] Failed: ${reason}`);
    return { status: 'failed', reason };
  }
}
