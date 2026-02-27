/**
 * hooks.ts - Lightweight internal event hook system for SmallClaw.
 *
 * No discovery, no YAML frontmatter, no plugin loading.
 * Just a typed EventEmitter with named events for:
 *   - gateway:startup -> run BOOT.md
 *   - command:new     -> snapshot session memory before reset
 */

import { EventEmitter } from 'events';

export interface HookBootstrapFile {
  path: string;
  content: string;
  label: string;
}

export type HookEvent =
  | { type: 'gateway:startup'; workspacePath: string }
  | { type: 'command:new'; sessionId: string; workspacePath: string; timestamp: number }
  | { type: 'command:reset'; sessionId: string; workspacePath: string; timestamp: number }
  | { type: 'command:stop'; sessionId: string; workspacePath: string; timestamp: number }
  | {
      type: 'agent:bootstrap';
      sessionId: string;
      workspacePath: string;
      bootstrapFiles: HookBootstrapFile[];
      timestamp: number;
    };

type HookHandler<T extends HookEvent = HookEvent> = (event: T) => Promise<void> | void;

class HookBus extends EventEmitter {
  register<T extends HookEvent['type']>(
    eventType: T,
    handler: HookHandler<Extract<HookEvent, { type: T }>>,
  ): void {
    this.on(eventType, handler);
  }

  async fire<T extends HookEvent>(event: T): Promise<void> {
    const handlers = this.rawListeners(event.type) as HookHandler<T>[];
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err: any) {
        console.warn(`[hooks] Handler for "${event.type}" threw: ${String(err?.message || err)}`);
      }
    }
  }
}

export const hookBus = new HookBus();
