/**
 * telegram-channel.ts — Telegram Bot for SmallClaw
 *
 * Uses raw Telegram Bot API via fetch() — no external dependencies.
 * Long polling loop: zero port forwarding, works from anywhere.
 *
 * Flow:
 *   1. User configures bot token + their Telegram user ID in settings
 *   2. Gateway starts long polling loop on boot (if enabled)
 *   3. Incoming messages → check allowlist → route to handleChat()
 *   4. Response → send back via Telegram sendMessage API
 *   5. Cron/heartbeat results can also push to Telegram
 *
 * File Browser:
 *   /browse [path]   — Opens inline keyboard file browser at workspace root (or given path)
 *   /download <path> — Downloads a file directly as a Telegram attachment
 *   Inline button callback_data drives all navigation in-place (edits existing message).
 */

import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/config';
import { loadPendingRepair, listPendingRepairs, applyApprovedRepair, deletePendingRepair, formatRepairProposal } from '../tools/self-repair';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  allowedUserIds: number[];
  streamMode: 'full' | 'partial';
}

interface TelegramDeps {
  handleChat: (
    message: string,
    sessionId: string,
    sendSSE: (event: string, data: any) => void,
    pinnedMessages?: Array<{ role: string; content: string }>,
    abortSignal?: { aborted: boolean },
    callerContext?: string,
    modelOverride?: string,
    executionMode?: 'interactive' | 'background_task' | 'heartbeat' | 'cron',
  ) => Promise<{ type: string; text: string; thinking?: string }>;
  addMessage: (
    sessionId: string,
    msg: { role: 'user' | 'assistant'; content: string; timestamp: number },
    options?: { deferOnMemoryFlush?: boolean; disableMemoryFlushCheck?: boolean }
  ) => void;
  getIsModelBusy: () => boolean;
  broadcast: (data: object) => void;
  getWorkspace?: (sessionId: string) => string | undefined;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
    date: number;
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name: string; username?: string };
    message: { message_id: number; chat: { id: number } };
    data: string;
  };
}

// ─── File Browser Config ───────────────────────────────────────────────────────

const BROWSER_MAX_BUTTONS_PER_ROW = 2;
const BROWSER_MAX_BUTTONS_TOTAL = 40;
const BROWSER_MAX_TEXT_PREVIEW = 2500; // bytes per page

// callback_data prefix scheme:
//   fb:dir:<b64path>       — navigate into a directory
//   fb:file:<b64path>      — open/preview a file (page 0)
//   fb:page:<b64path>:<n>  — paginate a text file preview (page n)
//   fb:home                — jump back to workspace root

// ─── Telegram Channel Class ────────────────────────────────────────────────────

export class TelegramChannel {
  private config: TelegramConfig;
  private deps: TelegramDeps;
  private polling: boolean = false;
  private lastUpdateId: number = 0;
  private botInfo: { id: number; first_name: string; username: string } | null = null;
  private abortController: AbortController | null = null;
  private workspaceRoot: string = process.cwd();

  constructor(config: TelegramConfig, deps: TelegramDeps) {
    this.config = config;
    this.deps = deps;
  }

  // ─── Bot API Helpers ─────────────────────────────────────────────────────────

  private get apiBase(): string {
    return `https://api.telegram.org/bot${this.config.botToken}`;
  }

  private async apiCall(method: string, body?: object): Promise<any> {
    const resp = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data: any = await resp.json();
    if (!data.ok) throw new Error(`Telegram API ${method}: ${data.description || 'unknown error'}`);
    return data.result;
  }

  // ─── Public Methods ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.config.enabled || !this.config.botToken) {
      console.log('[Telegram] Disabled or no bot token — skipping');
      return;
    }

    // Resolve workspace root at start time from config
    try {
      const cfg = getConfig().getConfig() as any;
      const ws = cfg?.workspace?.path;
      if (ws && fs.existsSync(ws)) this.workspaceRoot = ws;
    } catch {
      // fall back to cwd
    }

    try {
      this.botInfo = await this.apiCall('getMe');
      console.log(`[Telegram] Connected as @${this.botInfo!.username} (${this.botInfo!.first_name})`);
    } catch (err: any) {
      console.error(`[Telegram] Failed to connect: ${err.message}`);
      return;
    }

    this.polling = true;
    this.pollLoop();
  }

  stop(): void {
    this.polling = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    console.log('[Telegram] Polling stopped');
  }

  updateConfig(newConfig: Partial<TelegramConfig>): void {
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, ...newConfig };

    if (wasEnabled && !this.config.enabled) {
      this.stop();
    } else if (!wasEnabled && this.config.enabled) {
      this.start();
    }
  }

  getStatus(): { connected: boolean; username: string | null; polling: boolean } {
    return {
      connected: this.botInfo !== null,
      username: this.botInfo?.username || null,
      polling: this.polling,
    };
  }

  /** Send a message to all allowed users (for cron/heartbeat delivery) */
  async sendToAllowed(text: string): Promise<void> {
    if (!this.config.enabled || !this.config.botToken) return;
    try {
      for (const userId of this.config.allowedUserIds) {
        try {
          await this.sendMessage(userId, text);
        } catch (err: any) {
          console.error(`[Telegram] Failed to send to ${userId}: ${err.message}`);
        }
      }
    } catch (err: any) {
      console.error(`[Telegram] sendToAllowed no-op guard: ${String(err?.message || err)}`);
    }
  }

  /** Send a single message */
  async sendMessage(chatId: number, text: string): Promise<void> {
    // Telegram messages max 4096 chars — split if needed
    const chunks = this.splitMessage(text, 4000);
    for (const chunk of chunks) {
      await this.apiCall('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'HTML',
      }).catch(() => {
        // Retry without parse_mode if HTML fails
        return this.apiCall('sendMessage', { chat_id: chatId, text: chunk });
      });
    }
  }

  /** Test the bot token — returns bot info or throws */
  async testConnection(): Promise<{ username: string; firstName: string }> {
    const info = await this.apiCall('getMe');
    return { username: info.username, firstName: info.first_name };
  }

  // ─── Long Polling Loop ───────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    console.log('[Telegram] Starting long poll loop...');

    while (this.polling) {
      try {
        this.abortController = new AbortController();
        const resp = await fetch(`${this.apiBase}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`, {
          signal: this.abortController.signal,
        });
        const data: any = await resp.json();

        if (!data.ok || !Array.isArray(data.result)) continue;

        for (const update of data.result as TelegramUpdate[]) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          if (update.callback_query) {
            this.handleCallbackQuery(update.callback_query).catch(err =>
              console.error('[Telegram] Callback query error:', err.message)
            );
          } else if (update.message?.text) {
            this.handleIncomingMessage(update.message).catch(err =>
              console.error('[Telegram] Message handling error:', err.message)
            );
          }
        }
      } catch (err: any) {
        if (err.name === 'AbortError') break;
        console.error('[Telegram] Poll error:', err.message);
        // Wait before retrying on error
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  // ─── File Browser Helpers ────────────────────────────────────────────────────

  /** Encode a filesystem path to URL-safe base64 for use in callback_data */
  private encodePathB64(p: string): string {
    return Buffer.from(p).toString('base64url');
  }

  /** Decode URL-safe base64 path from callback_data */
  private decodePathB64(b64: string): string {
    return Buffer.from(b64, 'base64url').toString('utf-8');
  }

  /** Resolve a user-supplied relative path against workspace root, with traversal guard */
  private resolveWorkspacePath(rel: string): string {
    const root = path.resolve(this.workspaceRoot);
    const resolved = path.resolve(root, rel);
    // Security: clamp to workspace root to prevent path traversal
    if (!resolved.startsWith(root)) return root;
    return resolved;
  }

  /** Build the inline keyboard + caption for a directory listing */
  private buildDirectoryKeyboard(dirPath: string): { text: string; reply_markup: object } | null {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return null;
    }

    // Sort: folders first, then files, both alphabetical
    const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));
    const all = [...dirs, ...files].slice(0, BROWSER_MAX_BUTTONS_TOTAL);

    const wsRoot = path.resolve(this.workspaceRoot);
    const relDir = path.relative(wsRoot, dirPath) || '.';

    // Build file/folder buttons
    const buttons: Array<{ text: string; callback_data: string }> = [];
    for (const entry of all) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        buttons.push({
          text: `📁 ${entry.name}`,
          callback_data: `fb:dir:${this.encodePathB64(fullPath)}`,
        });
      } else {
        buttons.push({
          text: `📄 ${entry.name}`,
          callback_data: `fb:file:${this.encodePathB64(fullPath)}`,
        });
      }
    }

    // Navigation row at the bottom
    const navRow: Array<{ text: string; callback_data: string }> = [];
    const parentDir = path.dirname(dirPath);
    const resolvedDir = path.resolve(dirPath);
    if (parentDir !== dirPath && resolvedDir !== wsRoot) {
      navRow.push({ text: '⬆️ Up', callback_data: `fb:dir:${this.encodePathB64(parentDir)}` });
    }
    navRow.push({ text: '🏠 Home', callback_data: 'fb:home' });

    // Group buttons into rows of BROWSER_MAX_BUTTONS_PER_ROW
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < buttons.length; i += BROWSER_MAX_BUTTONS_PER_ROW) {
      rows.push(buttons.slice(i, i + BROWSER_MAX_BUTTONS_PER_ROW));
    }
    rows.push(navRow);

    const caption = `📂 <b>${relDir}</b>\n<i>${dirs.length} folders · ${files.length} files</i>`;

    return {
      text: caption,
      reply_markup: { inline_keyboard: rows },
    };
  }

  /** Build text preview + pagination keyboard for a file */
  private buildFilePreview(filePath: string, page: number): { text: string; reply_markup: object } {
    const wsRoot = path.resolve(this.workspaceRoot);
    const relFile = path.relative(wsRoot, filePath);
    const b64 = this.encodePathB64(filePath);
    const parentB64 = this.encodePathB64(path.dirname(filePath));
    const backBtn = { text: '⬆️ Back', callback_data: `fb:dir:${parentB64}` };
    const homeBtn = { text: '🏠 Home', callback_data: 'fb:home' };

    let content: Buffer;
    try {
      content = fs.readFileSync(filePath);
    } catch (e: any) {
      return {
        text: `❌ Cannot read file: <code>${relFile}</code>\n${e.message}`,
        reply_markup: { inline_keyboard: [[backBtn, homeBtn]] },
      };
    }

    // Binary detection: look for null bytes in the first 512 bytes
    const isBinary = content.slice(0, 512).includes(0);
    if (isBinary) {
      const size = content.length;
      const sizeStr = size > 1024 * 1024
        ? `${(size / 1024 / 1024).toFixed(1)} MB`
        : size > 1024
          ? `${(size / 1024).toFixed(1)} KB`
          : `${size} B`;
      return {
        text: `📦 <b>${relFile}</b>\n\n<i>Binary file — ${sizeStr}</i>\n\nUse /download ${relFile} to download it.`,
        reply_markup: { inline_keyboard: [[backBtn, homeBtn]] },
      };
    }

    const fullText = content.toString('utf-8');
    const totalPages = Math.max(1, Math.ceil(fullText.length / BROWSER_MAX_TEXT_PREVIEW));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    const chunk = fullText.slice(safePage * BROWSER_MAX_TEXT_PREVIEW, (safePage + 1) * BROWSER_MAX_TEXT_PREVIEW);

    // Escape HTML entities for <pre> block
    const escaped = chunk
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const header = `📄 <b>${relFile}</b> — page ${safePage + 1}/${totalPages}\n\n`;
    const preview = `${header}<pre>${escaped}</pre>`;

    // Pagination row
    const pageRow: Array<{ text: string; callback_data: string }> = [];
    if (safePage > 0) pageRow.push({ text: '◀️ Prev', callback_data: `fb:page:${b64}:${safePage - 1}` });
    if (safePage < totalPages - 1) pageRow.push({ text: '▶️ Next', callback_data: `fb:page:${b64}:${safePage + 1}` });

    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    if (pageRow.length) keyboard.push(pageRow);
    keyboard.push([backBtn, homeBtn]);

    return {
      text: preview.slice(0, 4000),
      reply_markup: { inline_keyboard: keyboard },
    };
  }

  /** Send a new browser message, or edit an existing one in-place */
  private async sendBrowserView(
    chatId: number,
    payload: { text: string; reply_markup: object },
    existingMessageId?: number,
  ): Promise<number> {
    const body = {
      chat_id: chatId,
      text: payload.text,
      parse_mode: 'HTML',
      reply_markup: payload.reply_markup,
    };

    if (existingMessageId) {
      try {
        await this.apiCall('editMessageText', { ...body, message_id: existingMessageId });
        return existingMessageId;
      } catch {
        // Fall through to send a new message if edit fails
      }
    }

    const result = await this.apiCall('sendMessage', body);
    return result.message_id as number;
  }

  // ─── Callback Query Handler (File Browser Navigation) ────────────────────────

  private async handleCallbackQuery(cq: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;
    const userId = cq.from.id;
    const data = cq.data;

    // Dismiss the loading spinner immediately
    await this.apiCall('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});

    // Allowlist check
    if (this.config.allowedUserIds.length > 0 && !this.config.allowedUserIds.includes(userId)) return;

    // Only handle file browser callbacks
    if (!data.startsWith('fb:')) return;

    let payload: { text: string; reply_markup: object } | null = null;

    if (data === 'fb:home') {
      payload = this.buildDirectoryKeyboard(path.resolve(this.workspaceRoot));

    } else if (data.startsWith('fb:dir:')) {
      const dirPath = this.decodePathB64(data.slice('fb:dir:'.length));
      payload = this.buildDirectoryKeyboard(dirPath);

    } else if (data.startsWith('fb:file:')) {
      const filePath = this.decodePathB64(data.slice('fb:file:'.length));
      payload = this.buildFilePreview(filePath, 0);

    } else if (data.startsWith('fb:page:')) {
      // Format: fb:page:<b64path>:<pageNum>
      const rest = data.slice('fb:page:'.length);
      const lastColon = rest.lastIndexOf(':');
      const b64 = rest.slice(0, lastColon);
      const pageNum = parseInt(rest.slice(lastColon + 1), 10) || 0;
      const filePath = this.decodePathB64(b64);
      payload = this.buildFilePreview(filePath, pageNum);
    }

    if (!payload) return;

    try {
      await this.apiCall('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: payload.text,
        parse_mode: 'HTML',
        reply_markup: payload.reply_markup,
      });
    } catch (err: any) {
      // Telegram returns an error if the content is identical — that's fine, ignore it
      if (!err.message?.includes('message is not modified')) {
        console.error('[Telegram] editMessageText error:', err.message);
      }
    }
  }

  // ─── Message Handler ─────────────────────────────────────────────────────────

  private async handleIncomingMessage(msg: TelegramUpdate['message']): Promise<void> {
    if (!msg || !msg.text) return;

    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const userName = msg.from.first_name || msg.from.username || 'Unknown';

    console.log(`[Telegram] Message from ${userName} (${userId}): ${text.slice(0, 80)}`);

    // Check allowlist
    if (this.config.allowedUserIds.length > 0 && !this.config.allowedUserIds.includes(userId)) {
      console.log(`[Telegram] Rejected message from unauthorized user ${userId}`);
      await this.sendMessage(chatId, '🦞 Unauthorized. Your Telegram user ID is not in the allowlist.\n\nYour ID: <code>' + userId + '</code>');
      return;
    }

    // ── /browse command ────────────────────────────────────────────────────────
    if (text.startsWith('/browse')) {
      const arg = text.slice('/browse'.length).trim();
      const targetPath = arg ? this.resolveWorkspacePath(arg) : path.resolve(this.workspaceRoot);
      const payload = this.buildDirectoryKeyboard(targetPath);
      if (!payload) {
        await this.sendMessage(chatId, `❌ Cannot open path: <code>${arg || '.'}</code>`);
        return;
      }
      await this.sendBrowserView(chatId, payload);
      return;
    }

    // ── /download command ──────────────────────────────────────────────────────
    if (text.startsWith('/download')) {
      const arg = text.slice('/download'.length).trim();
      if (!arg) {
        await this.sendMessage(chatId, '❌ Usage: /download &lt;path&gt;');
        return;
      }
      const filePath = this.resolveWorkspacePath(arg);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        await this.sendMessage(chatId, `❌ File not found: <code>${arg}</code>`);
        return;
      }
      try {
        const fileBuffer = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);
        const formData = new FormData();
        formData.append('chat_id', String(chatId));
        formData.append('document', new Blob([fileBuffer]), fileName);
        const resp = await fetch(`${this.apiBase}/sendDocument`, { method: 'POST', body: formData });
        const data: any = await resp.json();
        if (!data.ok) throw new Error(data.description || 'sendDocument failed');
        console.log(`[Telegram] Sent file ${fileName} to ${userId}`);
      } catch (err: any) {
        await this.sendMessage(chatId, `❌ Download failed: ${err.message}`);
      }
      return;
    }

    // ── Built-in commands ──────────────────────────────────────────────────────
    if (text === '/start') {
      await this.sendMessage(chatId, `🦞 <b>SmallClaw connected!</b>\n\nYour Telegram user ID: <code>${userId}</code>\n\nJust send me a message and I'll respond using your local LLM.\n\n<b>Commands:</b>\n/status — check connection\n/clear — reset chat history\n/browse — browse workspace files\n/download &lt;path&gt; — download a file\n\n<b>Self-Repair:</b>\n/repairs — list pending repair proposals\n/repair &lt;id&gt; — show full details of a repair\n/approve &lt;id&gt; — apply a repair, rebuild &amp; restart\n/reject &lt;id&gt; — discard a repair`);
      return;
    }
    if (text === '/status') {
      const busy = this.deps.getIsModelBusy();
      await this.sendMessage(chatId, `🦞 <b>Status</b>\n\nModel: ${busy ? '🔄 Busy' : '✅ Ready'}\nBot: @${this.botInfo?.username || 'unknown'}\nYour ID: <code>${userId}</code>`);
      return;
    }
    if (text === '/clear') {
      try {
        const { clearHistory } = await import('./session');
        clearHistory(`telegram_${userId}`);
      } catch {}
      await this.sendMessage(chatId, '🦞 Chat history cleared.');
      return;
    }

    // ── /repairs — list pending self-repair proposals ───────────────────────────
    if (text === '/repairs') {
      const pending = listPendingRepairs();
      if (pending.length === 0) {
        await this.sendMessage(chatId, '🦞 No pending repairs.');
        return;
      }
      const lines = pending.map(r =>
        `🔧 <b>#${r.id}</b> — <code>${r.affectedFile}</code>\n   ${r.errorSummary.slice(0, 80)}`
      );
      await this.sendMessage(chatId, `🦞 <b>Pending Repairs (${pending.length})</b>\n\n${lines.join('\n\n')}\n\nUse /approve &lt;id&gt; or /reject &lt;id&gt;`);
      return;
    }

    // ── /approve <id> — apply a pending repair ──────────────────────────────────
    if (text.startsWith('/approve')) {
      const repairId = text.slice('/approve'.length).trim();
      if (!repairId) {
        await this.sendMessage(chatId, '❌ Usage: /approve &lt;repair-id&gt;\n\nUse /repairs to list pending repairs.');
        return;
      }
      const repair = loadPendingRepair(repairId);
      if (!repair) {
        await this.sendMessage(chatId, `❌ No pending repair found with ID: <code>${repairId}</code>\n\nUse /repairs to list pending repairs.`);
        return;
      }
      if (repair.status !== 'pending') {
        await this.sendMessage(chatId, `❌ Repair <code>#${repairId}</code> is not pending (status: ${repair.status}).`);
        return;
      }

      await this.sendMessage(chatId, `🔧 Applying repair <code>#${repairId}</code>...\n\nPatching <code>${repair.affectedFile}</code>, then rebuilding. This may take 30–60 seconds.`);

      // Run in background so Telegram doesn't time out
      applyApprovedRepair(repairId).then(async (result) => {
        try {
          await this.sendMessage(chatId, result.message);
        } catch {}
      }).catch(async (err) => {
        try {
          await this.sendMessage(chatId, `❌ Unexpected error during repair: ${err.message}`);
        } catch {}
      });
      return;
    }

    // ── /reject <id> — discard a pending repair ─────────────────────────────────
    if (text.startsWith('/reject')) {
      const repairId = text.slice('/reject'.length).trim();
      if (!repairId) {
        await this.sendMessage(chatId, '❌ Usage: /reject &lt;repair-id&gt;');
        return;
      }
      const repair = loadPendingRepair(repairId);
      if (!repair) {
        await this.sendMessage(chatId, `❌ No repair found with ID: <code>${repairId}</code>.`);
        return;
      }
      const deleted = deletePendingRepair(repairId);
      await this.sendMessage(chatId, deleted
        ? `🗑️ Repair <code>#${repairId}</code> discarded.\n\n<i>Fixed: ${repair.affectedFile}</i>`
        : `❌ Could not delete repair <code>#${repairId}</code>.`
      );
      return;
    }

    // ── /repair <id> — show full details of a pending repair ────────────────────
    if (text.startsWith('/repair ')) {
      const repairId = text.slice('/repair '.length).trim();
      const repair = loadPendingRepair(repairId);
      if (!repair) {
        await this.sendMessage(chatId, `❌ No repair found with ID: <code>${repairId}</code>. Use /repairs to list all.`);
        return;
      }
      await this.sendMessage(chatId, formatRepairProposal(repair));
      return;
    }

    // Check if model is busy
    if (this.deps.getIsModelBusy()) {
      await this.sendMessage(chatId, '🦞 I\'m currently busy with another task. Try again in a moment.');
      return;
    }

    // Send "typing" indicator
    await this.apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    // Route to handleChat
    const sessionId = `telegram_${userId}`;
    const events: Array<{ type: string; data: any }> = [];
    const sendSSE = (type: string, data: any) => { events.push({ type, data }); };

    try {
      const telegramContext = 'CONTEXT: You are responding via Telegram. You are running on the user\'s local Windows PC. All computer tools (run_command, browser_open, browser_snapshot, browser_click, browser_fill, browser_press_key, browser_wait, browser_close, desktop_screenshot, desktop_find_window, desktop_focus_window, desktop_click, desktop_drag, desktop_wait, desktop_type, desktop_press_key, desktop_get_clipboard, desktop_set_clipboard) are fully available and operational. Use them confidently when the user asks you to open, browse, or interact with anything on their computer.';
      const isDesktopStatusCheck =
        /\b(vs code|vscode|codex)\b/i.test(text)
        && /\b(done|finished|complete|completed|responded)\b/i.test(text);
      const statusContext = isDesktopStatusCheck
        ? 'CONTEXT: This Telegram request is a desktop status check. First action should be desktop_screenshot (then desktop advisor flow), not browser tools.'
        : '';
      const callerContext = statusContext ? `${telegramContext}\n${statusContext}` : telegramContext;
      const result = await this.deps.handleChat(text, sessionId, sendSSE, undefined, undefined, callerContext);
      const responseText = result.text || 'No response generated.';

      // Persist both messages to session history AFTER handleChat completes
      // (handleChat reads history internally, so we save after to avoid duplication)
      this.deps.addMessage(sessionId, { role: 'user', content: text, timestamp: Date.now() }, { disableMemoryFlushCheck: true });
      this.deps.addMessage(sessionId, { role: 'assistant', content: responseText, timestamp: Date.now() }, { disableMemoryFlushCheck: true });

      await this.sendMessage(chatId, responseText);

      // Broadcast to web UI that a Telegram message was processed
      this.deps.broadcast({
        type: 'telegram_message',
        from: userName,
        userId,
        text: text.slice(0, 100),
        response: responseText.slice(0, 200),
      });

      console.log(`[Telegram] Replied to ${userName}: ${responseText.slice(0, 80)}`);
    } catch (err: any) {
      console.error(`[Telegram] handleChat error:`, err.message);
      await this.sendMessage(chatId, `🦞 Error: ${err.message}`);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Try to split at newline
      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLen);
      if (splitAt <= 0) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }
}
