/**
 * browser-tools.ts - Browser Automation for LocalClaw
 * 
 * Strategy: Connect to user's Chrome via CDP (--remote-debugging-port=9222).
 * If Chrome isn't running with the debug port, launch it ourselves with a
 * dedicated LocalClaw profile so it doesn't conflict with the user's Chrome.
 * 
 * Snapshot: DOM-based element scraping (reliable across all Playwright versions).
 * No dependency on deprecated page.accessibility or page.ariaSnapshot APIs.
 */

type PwBrowser = any;
type PwContext = any;
type PwPage = any;

interface BrowserSession {
  browser: PwBrowser;
  context: PwContext;
  page: PwPage;
  lastSnapshot: string;
  createdAt: number;
}

interface SnapElement {
  ref: number;
  tag: string;        // raw tag name
  role: string;       // semantic role for the LLM
  name: string;       // visible text / label
  type?: string;      // input type="" if applicable
  placeholder?: string;
  value?: string;
  isInput: boolean;   // can this be filled?
}

// ─── Session Management ────────────────────────────────────────────────────────

const sessions: Map<string, BrowserSession> = new Map();
let playwrightModule: any = null;
let playwrightChecked = false;

const os = require('os');
const PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH
  || require('path').join(os.homedir(), '.playwright-browsers');

async function getPW(): Promise<any | null> {
  if (playwrightChecked) return playwrightModule;
  playwrightChecked = true;
  // Set PLAYWRIGHT_BROWSERS_PATH before Playwright loads so it can find its bundled Chromium
  process.env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_BROWSERS_PATH;
  try {
    playwrightModule = await (Function('return import("playwright")')() as Promise<any>);
    return playwrightModule;
  } catch {
    console.warn('[Browser] Playwright not installed. Run: npm install playwright && npx playwright install chromium');
    return null;
  }
}

async function isPortOpen(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://localhost:${port}/json/version`);
    return resp.ok;
  } catch { return false; }
}

async function getOrCreateSession(sessionId: string): Promise<BrowserSession> {
  if (sessions.has(sessionId)) return sessions.get(sessionId)!;

  const pw = await getPW();
  if (!pw) throw new Error('Playwright not installed. Run: npm install playwright && npx playwright install chromium');

  const debugPort = Number(process.env.CHROME_DEBUG_PORT || '9222');
  let browser: any;

  // Step 1: Try connecting to an existing Chrome with debug port
  if (await isPortOpen(debugPort)) {
    try {
      browser = await pw.chromium.connectOverCDP(`http://localhost:${debugPort}`);
      console.log(`[Browser] Connected to existing Chrome on port ${debugPort}`);
    } catch (e: any) {
      console.warn(`[Browser] Port ${debugPort} responded but CDP connect failed: ${e.message}`);
    }
  }

  // Step 2: Launch Chrome ourselves if not connected
  if (!browser) {
    console.log(`[Browser] Launching Chrome with --remote-debugging-port=${debugPort}...`);

    const chromePaths = [
      process.env.CHROME_PATH,
      // Playwright bundled Chromium (installed via `npx playwright install chromium`)
      `${PLAYWRIGHT_BROWSERS_PATH}/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${PLAYWRIGHT_BROWSERS_PATH}/chromium-1208/chrome-linux/chrome`,
      `${PLAYWRIGHT_BROWSERS_PATH}/chromium-1208/chrome-win/chrome.exe`,
      // macOS system Chrome
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      // Linux
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      // Windows
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ].filter(Boolean) as string[];

    const fs = await import('fs');
    const chromePath = chromePaths.find(p => fs.existsSync(p));

    if (chromePath) {
      // System Chrome found — launch with CDP so we can connect
      const path = await import('path');
      const os = await import('os');
      const profileDir = process.env.CHROME_PROFILE
        || path.join(os.homedir(), '.localclaw', 'chrome-debug-profile');

      if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

      const { spawn } = await import('child_process');
      spawn(chromePath, [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
      ], { detached: true, stdio: 'ignore' }).unref();

      console.log(`[Browser] Chrome profile: ${profileDir} (log in once, saved forever)`);

      let connected = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await isPortOpen(debugPort)) {
          try {
            browser = await pw.chromium.connectOverCDP(`http://localhost:${debugPort}`);
            connected = true;
            break;
          } catch { /* retry */ }
        }
      }
      if (!connected) throw new Error(`Chrome launched but did not respond on port ${debugPort} after 15s.`);
      console.log(`[Browser] Launched and connected to Chrome on port ${debugPort}`);
    } else {
      // No system Chrome — use Playwright's bundled Chromium directly
      console.log('[Browser] No system Chrome found. Launching Playwright bundled Chromium...');
      browser = await pw.chromium.launch({ headless: false, args: ['--no-first-run', '--no-default-browser-check'] });
      console.log('[Browser] Playwright Chromium launched.');
    }
  }

  // Get or create a context, then a page
  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pages = context.pages();
  // Use existing blank page or create new
  const page = pages.find((p: any) => p.url() === 'about:blank') || await context.newPage();

  const session: BrowserSession = { browser, context, page, lastSnapshot: '', createdAt: Date.now() };
  sessions.set(sessionId, session);
  console.log(`[Browser] Session created for ${sessionId}`);
  return session;
}

// ─── DOM-Based Snapshot (works on ALL Playwright versions) ─────────────────────

async function takeSnapshot(page: PwPage, maxElements: number = 100): Promise<string> {
  try {
    const title = await page.title();
    const url = page.url();

    // Scrape the DOM directly — no dependency on accessibility APIs
    const elements: SnapElement[] = await page.evaluate((max: number) => {
      const doc = (globalThis as any).document;
      // Expanded selector set — includes data-testid (React apps), explicit search inputs
      const selector = [
        'a[href]', 'button', 'input', 'select', 'textarea',
        'input[type="search"]', 'input[type="text"]',
        '[role="button"]', '[role="link"]', '[role="tab"]', '[role="search"]',
        '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]',
        '[contenteditable="true"]',
        '[data-testid]',
        'h1', 'h2', 'h3',
      ].join(', ');

      // De-duplicate nodes (data-testid + input could match same element twice)
      const seen = new Set<any>();
      const nodes: any[] = [];
      for (const el of Array.from(doc.querySelectorAll(selector))) {
        if (!seen.has(el)) { seen.add(el); nodes.push(el); }
        if (nodes.length >= max) break;
      }

      const results: any[] = [];

      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        const tag = el.tagName.toLowerCase();
        const ariaRole = el.getAttribute('role') || '';
        const ariaLabel = el.getAttribute('aria-label') || '';
        const placeholder = el.getAttribute('placeholder') || '';
        const inputType = el.getAttribute('type') || '';
        const testId = el.getAttribute('data-testid') || '';
        const text = (el.innerText || '').trim().slice(0, 80);
        const val = el.value ? String(el.value).slice(0, 60) : '';

        // Determine visible name — prefer aria-label, then text, then placeholder, then data-testid
        let name = ariaLabel || text || placeholder || testId || '';
        if (!name && tag === 'input') name = placeholder || inputType || 'input';

        // Skip invisible or empty non-interactive elements
        if (!name && !['input', 'textarea', 'select'].includes(tag)) continue;
        if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;

        // Determine semantic role
        let role = ariaRole || tag;
        if (tag === 'a') role = 'link';
        if (tag === 'button' || ariaRole === 'button') role = 'button';
        if (tag === 'input' && ['text', 'search', 'email', 'url', 'tel', 'number', ''].includes(inputType)) role = 'textbox';
        if (tag === 'input' && inputType === 'search') role = 'searchbox';
        if (tag === 'textarea') role = 'textbox';
        if (tag === 'select' || ariaRole === 'combobox' || ariaRole === 'listbox') role = 'combobox';
        if (ariaRole === 'searchbox' || ariaRole === 'textbox') role = ariaRole;
        if (tag === 'input' && inputType === 'checkbox') role = 'checkbox';
        if (tag === 'input' && inputType === 'radio') role = 'radio';

        const isInput = ['textbox', 'searchbox', 'combobox', 'textarea'].includes(role)
          || (tag === 'input' && ['text', 'search', 'email', 'url', 'tel', 'number', ''].includes(inputType))
          || tag === 'textarea'
          || el.getAttribute('contenteditable') === 'true';

        results.push({
          ref: i + 1,
          tag,
          role,
          // Use placeholder as name fallback so model sees "Search Reddit" not empty string
          name: (name || placeholder || '').slice(0, 80),
          type: inputType || undefined,
          placeholder: placeholder || undefined,
          value: val || undefined,
          isInput,
          testId: testId || undefined,
        });
      }
      return results;
    }, maxElements);

    // Build compact text for the LLM
    const lines = [`Page: ${title}`, `URL: ${url}`, `Elements (${elements.length}):\n`];
    for (const el of elements) {
      let line = `[@${el.ref}] ${el.role}`;
      // Always show a name — fall back to placeholder so inputs are never shown as [@N] textbox ""
      const displayName = el.name || (el as any).placeholder || '';
      if (displayName) line += ` "${displayName}"`;
      if (el.isInput) line += ' [INPUT]';
      if (el.value) line += ` value="${el.value}"`;
      lines.push(line);
    }
    return lines.join('\n');
  } catch (err: any) {
    return `Snapshot error: ${err.message}`;
  }
}

// ─── Element Interaction ───────────────────────────────────────────────────────

// Shared selector used consistently across snapshot + click + fill
const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'select', 'textarea',
  'input[type="search"]', 'input[type="text"]',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="search"]',
  '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]',
  '[contenteditable="true"]',
  '[data-testid]',
  'h1', 'h2', 'h3',
].join(', ');

// Click the nth interactive element on the page
async function clickByRef(page: PwPage, ref: number): Promise<{ role: string; name: string }> {
  const result = await page.evaluate((args: { refIdx: number; sel: string }) => {
    const doc = (globalThis as any).document;
    const seen = new Set<any>();
    const nodes: any[] = [];
    for (const el of Array.from(doc.querySelectorAll(args.sel))) {
      if (!seen.has(el)) { seen.add(el); nodes.push(el); }
    }
    let counter = 0;
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();
      const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('data-testid') || '').trim().slice(0, 80);
      if (!name && !['input', 'textarea', 'select'].includes(tag)) continue;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
      counter++;
      if (counter === args.refIdx) {
        el.scrollIntoView({ block: 'center' });
        el.focus();
        el.click();
        const role = el.getAttribute('role') || tag;
        return { role, name: name || tag };
      }
    }
    return null;
  }, { refIdx: ref, sel: INTERACTIVE_SELECTOR });

  if (!result) throw new Error(`Element @${ref} not found`);
  // Wait longer for React re-renders and animations to settle
  await page.waitForTimeout(1500);
  return result;
}

// Fill the nth interactive element
async function fillByRef(page: PwPage, ref: number, text: string): Promise<{ role: string; name: string }> {
  const result = await page.evaluate((args: { ref: number; text: string; sel: string }) => {
    const doc = (globalThis as any).document;
    const seen = new Set<any>();
    const nodes: any[] = [];
    for (const el of Array.from(doc.querySelectorAll(args.sel))) {
      if (!seen.has(el)) { seen.add(el); nodes.push(el); }
    }
    let counter = 0;
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();
      const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('data-testid') || '').trim().slice(0, 80);
      if (!name && !['input', 'textarea', 'select'].includes(tag)) continue;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
      counter++;
      if (counter === args.ref) {
        const isInput = ['input', 'textarea', 'select'].includes(tag)
          || el.getAttribute('contenteditable') === 'true'
          || ['textbox', 'searchbox', 'combobox'].includes(el.getAttribute('role') || '');
        if (!isInput) return { error: `Element @${args.ref} (${el.getAttribute('role') || tag}) is not a text input.` };

        el.scrollIntoView({ block: 'center' });
        el.focus();

        if (tag === 'select') {
          el.value = args.text;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.getAttribute('contenteditable') === 'true') {
          el.innerHTML = args.text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // Clear + set value + dispatch events (works for React/Angular inputs too)
          const nativeSetter = Object.getOwnPropertyDescriptor((globalThis as any).HTMLInputElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor((globalThis as any).HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(el, args.text);
          else el.value = args.text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { role: el.getAttribute('role') || tag, name: name || tag };
      }
    }
    return { error: `Element @${args.ref} not found` };
  }, { ref, text, sel: INTERACTIVE_SELECTOR });

  if (!result || result.error) throw new Error(result?.error || `Element @${ref} not found`);
  await page.waitForTimeout(800);
  return result as { role: string; name: string };
}

// Press a key (e.g. Enter, Tab)
async function pressKey(page: PwPage, key: string): Promise<void> {
  await page.keyboard.press(key);
  // Allow page navigation / React state updates to settle
  await page.waitForTimeout(1500);
}

// ─── Exported Tool Handlers ────────────────────────────────────────────────────

export async function browserOpen(sessionId: string, url: string): Promise<string> {
  let session: BrowserSession;
  try {
    session = await getOrCreateSession(sessionId);
  } catch (err: any) {
    return `ERROR: ${err.message}`;
  }

  try {
    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

    await session.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Best-effort networkidle wait — catches SPAs that hydrate after domcontentloaded
    // Non-blocking: if it times out that's fine, we just take a snapshot with what's loaded
    await session.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    // Extra settle time for React/Next hydration
    await session.page.waitForTimeout(1500);

    const snapshot = await takeSnapshot(session.page);
    session.lastSnapshot = snapshot;
    return snapshot;
  } catch (err: any) {
    return `ERROR: Navigation failed: ${err.message}`;
  }
}

export async function browserSnapshot(sessionId: string): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return 'ERROR: No browser session. Use browser_open first.';
  try {
    const snapshot = await takeSnapshot(session.page);
    session.lastSnapshot = snapshot;
    return snapshot;
  } catch (err: any) {
    return `ERROR: Snapshot failed: ${err.message}`;
  }
}

export async function browserClick(sessionId: string, ref: number): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return 'ERROR: No browser session. Use browser_open first.';
  try {
    const el = await clickByRef(session.page, ref);
    // Extra settle before snapshot — dialogs / dropdowns / navigation need time
    await session.page.waitForTimeout(500);
    const snapshot = await takeSnapshot(session.page);
    session.lastSnapshot = snapshot;
    return `Clicked @${ref} (${el.role}: "${el.name}")\n\n${snapshot}`;
  } catch (err: any) {
    return `ERROR: Click @${ref} failed: ${err.message}`;
  }
}

export async function browserFill(sessionId: string, ref: number, text: string): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return 'ERROR: No browser session. Use browser_open first.';
  try {
    const el = await fillByRef(session.page, ref, text);
    const snapshot = await takeSnapshot(session.page);
    session.lastSnapshot = snapshot;
    return `Filled @${ref} (${el.role}: "${el.name}") with "${text.slice(0, 50)}"\n\n${snapshot}`;
  } catch (err: any) {
    return `ERROR: Fill @${ref} failed: ${err.message}`;
  }
}

export async function browserPressKey(sessionId: string, key: string): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return 'ERROR: No browser session. Use browser_open first.';
  try {
    await pressKey(session.page, key);
    // Best-effort networkidle after key press (Enter often triggers navigation)
    await session.page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    const snapshot = await takeSnapshot(session.page);
    session.lastSnapshot = snapshot;
    return `Pressed "${key}"\n\n${snapshot}`;
  } catch (err: any) {
    return `ERROR: Key press failed: ${err.message}`;
  }
}

export async function browserWait(sessionId: string, ms: number): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return 'ERROR: No browser session. Use browser_open first.';
  const clamped = Math.min(Math.max(ms || 1000, 500), 8000);
  try {
    await session.page.waitForTimeout(clamped);
    const snapshot = await takeSnapshot(session.page);
    session.lastSnapshot = snapshot;
    return `Waited ${clamped}ms\n\n${snapshot}`;
  } catch (err: any) {
    return `ERROR: Wait failed: ${err.message}`;
  }
}

export async function browserClose(sessionId: string): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return 'No browser session to close.';
  try {
    // Don't close the whole browser (user's Chrome) — just close our page
    await session.page.close();
    sessions.delete(sessionId);
    console.log(`[Browser] Session closed for ${sessionId}`);
    return 'Browser tab closed.';
  } catch (err: any) {
    sessions.delete(sessionId);
    return `Browser closed (with warning: ${err.message})`;
  }
}

// ─── Tool Definitions (for Ollama) ─────────────────────────────────────────────

export function getBrowserToolDefinitions(): any[] {
  return [
    {
      type: 'function',
      function: {
        name: 'browser_open',
        description: 'Open a URL in the browser. Returns a snapshot of interactive page elements with @ref numbers — this IS your view of the page, read it immediately. Find the link or button you need by its @ref number, then use browser_click to navigate. Do NOT call browser_open again for a different URL within the same site — use browser_click on the link @ref instead. For searches, build a direct search URL (e.g. github.com/search?q=query, reddit.com/search/?q=query). Elements marked [INPUT] can be filled. If element count looks low, call browser_wait to let JS finish loading.',
        parameters: {
          type: 'object', required: ['url'],
          properties: { url: { type: 'string', description: 'Full URL to navigate to. For searches, build the search URL directly.' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_snapshot',
        description: 'Re-scan the current page and return an updated list of interactive elements with @ref numbers. Call this after a click or fill to see what changed. If the element count seems low for a complex page, use browser_wait first to let the page finish loading.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_click',
        description: 'Click a page element by its @ref number. Always take a browser_snapshot after clicking to see the result. If the snapshot looks unchanged after clicking, the wrong element was clicked — pick a different @ref and try again.',
        parameters: {
          type: 'object', required: ['ref'],
          properties: { ref: { type: 'number', description: '@ref number from the most recent snapshot' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_fill',
        description: 'Type text into an [INPUT] element by its @ref number. Only works on elements labelled [INPUT] in the snapshot. After filling, use browser_press_key with "Enter" to submit, or browser_click on the submit button.',
        parameters: {
          type: 'object', required: ['ref', 'text'],
          properties: {
            ref: { type: 'number', description: '@ref number of an [INPUT] element from the snapshot' },
            text: { type: 'string', description: 'Text to type into the field' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_press_key',
        description: 'Press a keyboard key. Use "Enter" to submit a form or search after filling an input. Use "Escape" to close a popup. Use "Tab" to move focus to the next field.',
        parameters: {
          type: 'object', required: ['key'],
          properties: { key: { type: 'string', description: 'Key name: Enter, Tab, Escape, ArrowDown, ArrowUp, Space' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_wait',
        description: 'Wait for the page to finish loading, then return a fresh snapshot. Use this when: (1) a page just loaded but has few elements, (2) after a click that should open something but the snapshot looks unchanged, (3) waiting for search results or dynamic content to appear.',
        parameters: {
          type: 'object',
          properties: { ms: { type: 'number', description: 'Milliseconds to wait before snapping (500-8000, default 2000)' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_close',
        description: 'Close the browser tab when done.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
}

export { INTERACTIVE_SELECTOR };

// ─── Session State Helpers (for system prompt injection) ───────────────────────

export function hasBrowserSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export function getBrowserSessionInfo(sessionId: string): { active: boolean; url?: string; title?: string } {
  const session = sessions.get(sessionId);
  if (!session) return { active: false };
  try {
    const url = session.page.url();
    const snapshot = session.lastSnapshot || '';
    // Extract title from lastSnapshot first line: "Page: <title>"
    const titleMatch = snapshot.match(/^Page:\s*(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : undefined;
    return { active: true, url, title };
  } catch {
    return { active: true };
  }
}

// Cleanup on process exit
process.on('exit', () => {
  for (const [, session] of sessions) {
    try { session.page.close(); } catch {}
  }
});
