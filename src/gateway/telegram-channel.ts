/**
 * telegram-channel.ts — Telegram Bot for LocalClaw
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
 */

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
}

// ─── Telegram Channel Class ────────────────────────────────────────────────────

export class TelegramChannel {
  private config: TelegramConfig;
  private deps: TelegramDeps;
  private polling: boolean = false;
  private lastUpdateId: number = 0;
  private botInfo: { id: number; first_name: string; username: string } | null = null;
  private abortController: AbortController | null = null;

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
          if (update.message?.text) {
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

    // Handle special commands
    if (text === '/start') {
      await this.sendMessage(chatId, `🦞 <b>LocalClaw connected!</b>\n\nYour Telegram user ID: <code>${userId}</code>\n\nJust send me a message and I'll respond using your local LLM.\n\nCommands:\n/status — check connection\n/clear — reset chat history`);
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
