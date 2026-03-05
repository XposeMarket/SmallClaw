/**
 * browser-tools.ts - Browser Automation for SmallClaw
 * 
 * Strategy: Connect to user's Chrome via CDP (--remote-debugging-port=9222).
 * If Chrome isn't running with the debug port, launch it ourselves with a
 * dedicated SmallClaw profile so it doesn't conflict with the user's Chrome.
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
  lastSnapshotAt: number;  // epoch ms when lastSnapshot was captured; 0 = never
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

export type BrowserPageType = 'x_feed' | 'search_results' | 'article' | 'chat_interface' | 'generic';

export interface BrowserFeedItem {
  id?: string;
  author?: string;
  handle?: string;
  time?: string;
  text?: string;
  link?: string;
  title?: string;
  snippet?: string;
  source?: string;
  metrics?: {
    likes?: string;
    replies?: string;
    reposts?: string;
    views?: string;
  };
}

export interface BrowserAdvisorPacket {
  page: {
    title: string;
    url: string;
    pageType: BrowserPageType;
  };
  snapshot: string;
  snapshotElements: number;
  extractedFeed: BrowserFeedItem[];
  textBlocks: string[];
  pageText: string;          // visible body text for non-feed pages (chat responses, articles)
  isGenerating: boolean;    // true when a chat interface is still streaming a response
  contentHash: string;
}

// ─── Session Management ────────────────────────────────────────────────────────

const sessions: Map<string, BrowserSession> = new Map();
let playwrightModule: any = null;
let playwrightChecked = false;

function ensurePlaywrightBrowsersPath(): void {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  try {
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(os.homedir(), '.playwright-browsers');
  } catch {
    // Best-effort only; Playwright has its own defaults.
  }
}

async function findBundledChromiumExecutable(): Promise<string | null> {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const home = os.homedir();
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(home, '.playwright-browsers'),
    path.join(home, '.playwright-browsers'),
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? path.join(home, 'AppData', 'Local', 'ms-playwright')
        : path.join(home, '.cache', 'ms-playwright'),
  ];

  const exeCandidates = process.platform === 'darwin'
    ? ['chrome-mac/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? ['chrome-win/chrome.exe']
      : ['chrome-linux/chrome'];

  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.toLowerCase().startsWith('chromium-'))
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a));
      for (const dir of dirs) {
        for (const rel of exeCandidates) {
          const candidate = path.join(root, dir, rel);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // Continue scanning other roots.
    }
  }
  return null;
}

async function getPW(): Promise<any | null> {
  if (playwrightChecked) return playwrightModule;
  playwrightChecked = true;
  ensurePlaywrightBrowsersPath();
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
      process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '',
      process.platform === 'linux' ? '/usr/bin/google-chrome' : '',
      process.platform === 'linux' ? '/usr/bin/google-chrome-stable' : '',
      process.platform === 'linux' ? '/usr/bin/chromium-browser' : '',
      process.platform === 'linux' ? '/usr/bin/chromium' : '',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      await findBundledChromiumExecutable(),
    ].filter(Boolean) as string[];

    const fs = await import('fs');
    const chromePath = chromePaths.find(p => fs.existsSync(p));

    if (chromePath) {
      const path = await import('path');
      const os = await import('os');
      const profileDir = process.env.CHROME_PROFILE
        || path.join(os.homedir(), '.smallclaw', 'chrome-debug-profile');

      // Ensure profile dir exists
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

      // Wait for Chrome to start
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
      if (!connected) throw new Error(`Chrome launched but did not respond on port ${debugPort} after 15s. Close any existing Chrome windows and try again.`);
      console.log(`[Browser] Launched and connected to Chrome on port ${debugPort}`);
    } else {
      console.log('[Browser] No system Chrome found; launching Playwright Chromium directly.');
      browser = await pw.chromium.launch({ headless: false });
    }
  }

  // Get or create a context, then a page
  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pages = context.pages();
  // Use existing blank page or create new
  const page = pages.find((p: any) => p.url() === 'about:blank') || await context.newPage();

  const session: BrowserSession = { browser, context, page, lastSnapshot: '', lastSnapshotAt: 0, createdAt: Date.now() };
  sessions.set(sessionId, session);
  console.log(`[Browser] Session created for ${sessionId}`);

  // Auto-handle OAuth popups (e.g. "Continue as Raul" Google sign-in dialog).
  // These appear as new pages in the context and are invisible to the DOM snapshot.
  // We click the primary confirm button automatically so the agent doesn't get stuck.
  context.on('page', async (popup: any) => {
    try {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      const popupUrl = popup.url();
      console.log(`[Browser] Popup opened: ${popupUrl}`);
      // Google OAuth confirm page: click the blue continue/confirm button
      const confirmSelectors = [
        'button[id="submit_approve_access"]',  // Google OAuth approve
        'button:has-text("Continue")',
        'button:has-text("Allow")',
        'button:has-text("Confirm")',
        'button:has-text("Accept")',
        '#submit_approve_access',
      ];
      for (const sel of confirmSelectors) {
        try {
          const btn = popup.locator(sel).first();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await btn.click();
            console.log(`[Browser] Auto-clicked popup confirm: ${sel}`);
            break;
          }
        } catch { /* try next selector */ }
      }
    } catch (err: any) {
      console.warn(`[Browser] Popup handler error: ${err.message}`);
    }
  });

  return session;
}

// ─── DOM-Based Snapshot (works on ALL Playwright versions) ─────────────────────

async function takeSnapshot(page: PwPage, maxElements: number = 100): Promise<string> {
  try {
    const title = await page.title();
    const url = page.url();

    // Scrape the DOM directly — no dependency on accessibility APIs
    const snapshotData: {
      elements: SnapElement[];
      diagnostics: {
        scanned: number;
        included: number;
        hidden: number;
        unlabeled_non_input: number;
        unnamed_input_included: number;
      };
      modalOpen: boolean;
      modalLabel: string;
    } = await page.evaluate((max: number) => {
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

      // ── Modal / dialog detection ───────────────────────────────────────────
      // If a modal or dialog is open, ONLY elements inside it are interactable.
      // Scanning the full DOM would expose background elements the AI cannot
      // actually click (they are aria-hidden or covered by the overlay).
      // Priority: aria-modal dialogs > role=dialog > data-testid dialogs.
      const openModal = (
        doc.querySelector('[role="dialog"][aria-modal="true"]')
        || doc.querySelector('[role="dialog"]:not([aria-hidden="true"])')
        || doc.querySelector('[data-testid="sheetDialog"], [data-testid="confirmationSheetDialog"], [data-testid="keyboardShortcutModal"]')
        || doc.querySelector('dialog[open]')
        // X.com reply-permission dropdown and other sheets that aren't role=dialog
        || doc.querySelector('[data-testid="Dropdown"]')
        || doc.querySelector('[role="menu"]')
        || null
      );
      const searchRoot = openModal || doc;

      // De-duplicate nodes (data-testid + input could match same element twice)
      const seen = new Set<any>();
      const nodes: any[] = [];
      for (const el of Array.from(searchRoot.querySelectorAll(selector))) {
        if (!seen.has(el)) { seen.add(el); nodes.push(el); }
        if (nodes.length >= max) break;
      }

      const results: any[] = [];
      const diagnostics = {
        scanned: nodes.length,
        included: 0,
        hidden: 0,
        unlabeled_non_input: 0,
        unnamed_input_included: 0,
      };

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
        const isContentEditable = el.getAttribute('contenteditable') === 'true';
        const inputLikeTag = ['input', 'textarea', 'select'].includes(tag) || isContentEditable;

        // Determine visible name — prefer aria-label, then text, then placeholder, then data-testid
        let name = ariaLabel || text || placeholder || testId || '';
        if (!name && tag === 'input') name = placeholder || inputType || 'input';
        if (!name && isContentEditable) name = 'editable';

        // Skip invisible or empty non-interactive elements
        if (!name && !inputLikeTag) {
          diagnostics.unlabeled_non_input++;
          continue;
        }
        const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        const hiddenByBox =
          (el.offsetWidth === 0 && el.offsetHeight === 0)
          || (rect ? (rect.width === 0 && rect.height === 0) : false);
        const style = typeof (globalThis as any).getComputedStyle === 'function'
          ? (globalThis as any).getComputedStyle(el)
          : null;
        const hiddenByStyle =
          !!style
          && (style.display === 'none' || style.visibility === 'hidden');
        if (hiddenByBox || hiddenByStyle) {
          diagnostics.hidden++;
          continue;
        }

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
          || isContentEditable;

        if (!name && isInput) diagnostics.unnamed_input_included++;

        results.push({
          // Keep refs contiguous and aligned with click/fill counters.
          ref: results.length + 1,
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
      diagnostics.included = results.length;
      const modalLabel = openModal
        ? (openModal.getAttribute('aria-label') || openModal.getAttribute('aria-labelledby') && (doc.getElementById(openModal.getAttribute('aria-labelledby') || '') as any)?.innerText || openModal.getAttribute('data-testid') || 'dialog')
        : '';
      return { elements: results, diagnostics, modalOpen: !!openModal, modalLabel: String(modalLabel || '').trim().slice(0, 80) };
    }, maxElements);
    const rawElements = Array.isArray(snapshotData?.elements) ? snapshotData.elements : [];
    const elements: SnapElement[] = rawElements
      .map((raw: any, idx: number) => {
        const role = String(raw?.role || raw?.tag || 'element').trim().toLowerCase() || 'element';
        const tag = String(raw?.tag || role || 'div').trim().toLowerCase() || 'div';
        const name = String(raw?.name || raw?.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const type = raw?.type ? String(raw.type).replace(/\s+/g, ' ').trim().slice(0, 40) : undefined;
        const placeholder = raw?.placeholder
          ? String(raw.placeholder).replace(/\s+/g, ' ').trim().slice(0, 80)
          : undefined;
        const value = raw?.value
          ? String(raw.value).replace(/\s+/g, ' ').trim().slice(0, 60)
          : undefined;
        const isInput = !!raw?.isInput
          || ['textbox', 'searchbox', 'combobox', 'textarea'].includes(role)
          || tag === 'input'
          || tag === 'textarea'
          || tag === 'select';
        return {
          ref: idx + 1,
          tag,
          role,
          name,
          type,
          placeholder,
          value,
          isInput,
        };
      })
      .filter((el) => el.name.length > 0 || el.isInput);

    const toCount = (value: unknown, fallback: number): number => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
    };
    const rawDiagnostics = snapshotData?.diagnostics && typeof snapshotData.diagnostics === 'object'
      ? snapshotData.diagnostics as Record<string, unknown>
      : {};
    const diagnostics = {
      scanned: toCount(rawDiagnostics.scanned, Math.max(rawElements.length, elements.length)),
      included: elements.length,
      hidden: toCount(rawDiagnostics.hidden, 0),
      unlabeled_non_input: toCount(rawDiagnostics.unlabeled_non_input, 0),
      unnamed_input_included: toCount(rawDiagnostics.unnamed_input_included, 0),
    };
    if (diagnostics.scanned < diagnostics.included) {
      diagnostics.scanned = diagnostics.included;
    }

    // Build compact text for the LLM
    const displayUrlRaw = String(url || '').replace(/\s+/g, ' ').trim();
    const displayUrl = displayUrlRaw.length > 360 ? `${displayUrlRaw.slice(0, 357)}...` : displayUrlRaw;
    const lines = [
      `Page: ${title}`,
      `Elements (${elements.length}):`,
      `Snapshot diagnostics: scanned=${diagnostics.scanned} included=${diagnostics.included} hidden=${diagnostics.hidden} unlabeled_non_input=${diagnostics.unlabeled_non_input} unnamed_input_included=${diagnostics.unnamed_input_included}`,
      `URL: ${displayUrl}`,
      '',
    ];
    for (const el of elements) {
      let line = `[@${el.ref}] ${el.role}`;
      // Always show a name — fall back to placeholder so inputs are never shown as [@N] textbox ""
      const displayName = el.name || (el as any).placeholder || '';
      if (displayName) line += ` "${displayName}"`;
      if (el.isInput) line += ' [INPUT]';
      if (el.value) line += ` value="${el.value}"`;
      lines.push(line);
    }
    const snapshotText = lines.join('\n');

    // Modal / dialog open — warn the AI so it doesn't try to interact with background elements.
    if (snapshotData?.modalOpen) {
      const label = snapshotData.modalLabel ? ` ("${snapshotData.modalLabel}")` : '';
      return snapshotText
        + `\n\n[MODAL OPEN]${label} A dialog/modal is blocking the page. The ${elements.length} elements above are ONLY the controls inside this modal. Background page elements are NOT accessible until the modal is closed. To dismiss: look for a Close button or press Escape with browser_press_key({"key":"Escape"}).`;
    }

    // Login wall detection — append an explicit action hint so the agent doesn't loop.
    // If the page looks like a login wall and there's a one-click sign-in button, say so.
    const elementText = elements.map(e => e.name).join(' ').toLowerCase();
    const isLoginWall = /join today|sign in|log in|create account/i.test(title + ' ' + elementText);
    if (isLoginWall) {
      const signInRef = elements.find(e =>
        /sign in as|continue as|sign in with google|sign in with apple/i.test(e.name)
      );
      if (signInRef) {
        return snapshotText + `\n\n[LOGIN PAGE DETECTED] Click @${signInRef.ref} ("${signInRef.name}") to sign in immediately. Do NOT loop on snapshots.`;
      }
      const plainSignIn = elements.find(e => /^sign in$/i.test(e.name.trim()));
      if (plainSignIn) {
        return snapshotText + `\n\n[LOGIN PAGE DETECTED] Click @${plainSignIn.ref} ("${plainSignIn.name}") to proceed to the login form.`;
      }
    }

    return snapshotText;
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
    // Respect modal focus traps — same logic as takeSnapshot
    const openModal = (
      doc.querySelector('[role="dialog"][aria-modal="true"]')
      || doc.querySelector('[role="dialog"]:not([aria-hidden="true"])')
      || doc.querySelector('[data-testid="sheetDialog"], [data-testid="confirmationSheetDialog"], [data-testid="keyboardShortcutModal"]')
      || doc.querySelector('dialog[open]')
      || doc.querySelector('[data-testid="Dropdown"]')
      || doc.querySelector('[role="menu"]')
      || null
    );
    const searchRoot = openModal || doc;
    const seen = new Set<any>();
    const nodes: any[] = [];
    for (const el of Array.from(searchRoot.querySelectorAll(args.sel))) {
      if (!seen.has(el)) { seen.add(el); nodes.push(el); }
    }
    let counter = 0;
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const isContentEditable = el.getAttribute('contenteditable') === 'true';
      const isInputLike = ['input', 'textarea', 'select'].includes(tag)
        || isContentEditable
        || ['textbox', 'searchbox', 'combobox'].includes(role);
      const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('data-testid') || '').trim().slice(0, 80)
        || (isContentEditable ? 'editable' : '');
      if (!name && !isInputLike) continue;
      const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      const hiddenByBox =
        (el.offsetWidth === 0 && el.offsetHeight === 0)
        || (rect ? (rect.width === 0 && rect.height === 0) : false);
      const style = typeof (globalThis as any).getComputedStyle === 'function'
        ? (globalThis as any).getComputedStyle(el)
        : null;
      const hiddenByStyle = !!style && (style.display === 'none' || style.visibility === 'hidden');
      if (hiddenByBox || hiddenByStyle) continue;
      counter++;
      if (counter === args.refIdx) {
        el.scrollIntoView({ block: 'center' });
        el.focus();
        el.click();
        return { role: role || tag, name: name || tag };
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
async function fillByRef(page: PwPage, ref: number, text: string): Promise<{ role: string; name: string; needsNativeType?: boolean }> {
  const result = await page.evaluate((args: { ref: number; text: string; sel: string }) => {
    const doc = (globalThis as any).document;
    // Respect modal focus traps — same logic as takeSnapshot
    const openModal = (
      doc.querySelector('[role="dialog"][aria-modal="true"]')
      || doc.querySelector('[role="dialog"]:not([aria-hidden="true"])')
      || doc.querySelector('[data-testid="sheetDialog"], [data-testid="confirmationSheetDialog"], [data-testid="keyboardShortcutModal"]')
      || doc.querySelector('dialog[open]')
      || doc.querySelector('[data-testid="Dropdown"]')
      || doc.querySelector('[role="menu"]')
      || null
    );
    const searchRoot = openModal || doc;
    const seen = new Set<any>();
    const nodes: any[] = [];
    for (const el of Array.from(searchRoot.querySelectorAll(args.sel))) {
      if (!seen.has(el)) { seen.add(el); nodes.push(el); }
    }
    let counter = 0;
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const isContentEditable = el.getAttribute('contenteditable') === 'true';
      const isInput = ['input', 'textarea', 'select'].includes(tag)
        || isContentEditable
        || ['textbox', 'searchbox', 'combobox'].includes(role);
      const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('data-testid') || '').trim().slice(0, 80)
        || (isContentEditable ? 'editable' : '');
      if (!name && !isInput) continue;
      const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      const hiddenByBox =
        (el.offsetWidth === 0 && el.offsetHeight === 0)
        || (rect ? (rect.width === 0 && rect.height === 0) : false);
      const style = typeof (globalThis as any).getComputedStyle === 'function'
        ? (globalThis as any).getComputedStyle(el)
        : null;
      const hiddenByStyle = !!style && (style.display === 'none' || style.visibility === 'hidden');
      if (hiddenByBox || hiddenByStyle) continue;
      counter++;
      if (counter === args.ref) {
        if (!isInput) return { error: `Element @${args.ref} (${el.getAttribute('role') || tag}) is not a text input.` };

        el.scrollIntoView({ block: 'center' });
        el.focus();

        if (tag === 'select') {
          el.value = args.text;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.getAttribute('contenteditable') === 'true') {
          // contenteditable: mark element for Playwright-native handling outside evaluate().
          // execCommand inside evaluate() is unreliable via CDP because OS focus may not
          // be on the element. Return a sentinel so the Node.js side can use page.keyboard.
          el.scrollIntoView({ block: 'center' });
          el.click(); // bring DOM focus to the element
          return { role: role || tag, name: name || tag, needsNativeType: true };
        } else {
          // Clear + set value + dispatch events (works for React/Angular inputs too)
          const nativeSetter = Object.getOwnPropertyDescriptor((globalThis as any).HTMLInputElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor((globalThis as any).HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(el, args.text);
          else el.value = args.text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { role: role || tag, name: name || tag };
      }
    }
    return { error: `Element @${args.ref} not found` };
  }, { ref, text, sel: INTERACTIVE_SELECTOR });

  if (!result || result.error) throw new Error(result?.error || `Element @${ref} not found`);

  // contenteditable elements (e.g. X.com composer) need Playwright-native typing.
  // The evaluate() click above set DOM focus; now we clear any existing content
  // with Ctrl+A then type the text through the real CDP keyboard pipeline.
  if ((result as any).needsNativeType) {
    // Small wait for React to process the click/focus event
    await page.waitForTimeout(300);
    // Select-all to clear any pre-existing text in the composer
    await page.keyboard.press('Control+A');
    await page.waitForTimeout(100);
    // Type text character by character — this fires real KeyDown/KeyPress/KeyUp/Input
    // events that React's synthetic event system correctly intercepts.
    await page.keyboard.type(text, { delay: 20 });
    await page.waitForTimeout(400);
  } else {
    await page.waitForTimeout(800);
  }

  return { role: result.role, name: result.name, needsNativeType: !!(result as any).needsNativeType };
}

// Press a key (e.g. Enter, Tab)
async function pressKey(page: PwPage, key: string): Promise<void> {
  await page.keyboard.press(key);
  // Allow page navigation / React state updates to settle
  await page.waitForTimeout(1500);
}

function parseSnapshotElementCount(snapshot: string): number {
  const m = String(snapshot || '').match(/Elements\s*\((\d+)\):/i);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return `h${(hash >>> 0).toString(16)}`;
}

function normalizeFeedItemText(item: BrowserFeedItem): string {
  return [
    item.id || '',
    item.author || '',
    item.handle || '',
    item.time || '',
    item.text || '',
    item.link || '',
    item.title || '',
    item.snippet || '',
    item.source || '',
  ].join('|');
}

function dedupeFeedItems(items: BrowserFeedItem[]): BrowserFeedItem[] {
  const out: BrowserFeedItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.id
      ? `id:${item.id}`
      : item.link
        ? `link:${item.link}`
        : stableHash(normalizeFeedItemText(item).slice(0, 500));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildPacketHash(input: {
  url: string;
  pageType: BrowserPageType;
  snapshot: string;
  extractedFeed: BrowserFeedItem[];
  textBlocks: string[];
  pageText?: string;
}): string {
  const compact = [
    input.url,
    input.pageType,
    input.snapshot.slice(0, 1800),
    ...input.extractedFeed.slice(0, 40).map((i) => normalizeFeedItemText(i)),
    ...input.textBlocks.slice(0, 20),
    (input.pageText || '').slice(0, 800),
  ].join('\n');
  return stableHash(compact);
}

async function extractStructuredFromPage(
  page: PwPage,
  maxItems: number,
): Promise<{
  pageType: BrowserPageType;
  extractedFeed: BrowserFeedItem[];
  textBlocks: string[];
  pageText: string;
  isGenerating: boolean;
}> {
  const extracted = await page.evaluate((max: number) => {
    const doc = (globalThis as any).document;
    const normalize = (v: any, maxLen: number = 400) =>
      String(v || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
    const toAbs = (href: string) => {
      try { return new URL(href, (globalThis as any).location.href).toString(); } catch { return String(href || '').trim(); }
    };
    const host = String((globalThis as any).location.hostname || '').toLowerCase();
    const url = String((globalThis as any).location.href || '').toLowerCase();
    const title = normalize((globalThis as any).document.title || '', 180);
    const out: { pageType: any; extractedFeed: any[]; textBlocks: string[]; pageText: string; isGenerating: boolean } = {
      pageType: 'generic',
      extractedFeed: [],
      textBlocks: [],
      pageText: '',
      isGenerating: false,
    };

    // ── Chat interface detection (ChatGPT, Claude, Gemini, etc.) ────────────────
    const isChatInterface = /(^|\.)chatgpt\.com$/.test(host)
      || /(^|\.)claude\.ai$/.test(host)
      || /(^|\.)gemini\.google\.com$/.test(host)
      || /(^|\.)chat\.openai\.com$/.test(host)
      || /\/c\/[a-f0-9-]{8,}/.test(url);   // generic /c/<uuid> conversation URL pattern

    if (isChatInterface) {
      out.pageType = 'chat_interface';

      // Detect if the AI is still generating — look for stop/streaming indicators
      const bodyText = normalize(doc.body?.innerText || '', 200);
      const stopBtn = doc.querySelector(
        'button[aria-label*="Stop"], button[data-testid*="stop"], [aria-label*="Stop generating"], .stop-button',
      );
      const streamingIndicator = doc.querySelector(
        '[data-testid="streaming-indicator"], .result-streaming, [class*="streaming"], [class*="generating"]',
      );
      // Heuristic: page title "ChatGPT" (not yet renamed to conversation topic) + very few response nodes
      const stillOnDefaultTitle = /^chatgpt$/i.test(title.trim());
      out.isGenerating = !!(stopBtn || streamingIndicator);

      // Extract the last assistant message — ChatGPT uses [data-message-author-role="assistant"]
      // Claude.ai uses [data-is-streaming], Gemini uses .model-response-text
      const assistantMsgSelectors = [
        '[data-message-author-role="assistant"]',
        '[data-testid*="conversation-turn"]:last-of-type',
        '.agent-turn',
        '.model-response-text',
        '[class*="AssistantMessage"]',
        '[class*="response-text"]',
      ];
      let lastMsgText = '';
      for (const sel of assistantMsgSelectors) {
        const nodes = Array.from(doc.querySelectorAll(sel)) as any[];
        if (!nodes.length) continue;
        const last = nodes[nodes.length - 1];
        const txt = normalize(last?.innerText || last?.textContent || '', 3000);
        if (txt.length > 60) { lastMsgText = txt; break; }
      }

      // Fallback: grab all paragraph text from main content area
      if (!lastMsgText) {
        const mainArea = doc.querySelector('main, [role="main"], #__next > div:nth-child(2)');
        if (mainArea) lastMsgText = normalize(mainArea?.innerText || '', 3000);
      }

      out.pageText = lastMsgText;
      // Put a short excerpt in textBlocks so existing advisor prompts that read textBlocks also work
      if (lastMsgText) out.textBlocks = [lastMsgText.slice(0, 1200)];
      return out;
    }

    const isX = /(^|\.)x\.com$/.test(host) || /(^|\.)twitter\.com$/.test(host);
    const isSearch = /(search|results|q=)/.test(url) || /(google|bing|duckduckgo|brave|yahoo)\./.test(host);

    if (isX) {
      // Smarter X.com page type detection — not all x.com pages are feed pages.
      // Compose, settings, notifications, and other interactive pages should be 'generic'
      // so the browser advisor treats them as interaction targets, not feed collectors.
      const xPathname = String((globalThis as any).location?.pathname || '');
      const isXComposePage = /^\/(compose|intent)/.test(xPathname);
      const isXSettingsPage = xPathname.startsWith('/settings') || xPathname.startsWith('/i/');
      const isXNotifications = xPathname.startsWith('/notifications');
      const isXHomeFeed = xPathname === '/' || xPathname === '/home' || xPathname === '';
      const isXProfileOrThread = /^\/[a-z0-9_]+(\/(status\/\d+)?)?$/i.test(xPathname) && !isXComposePage && !isXSettingsPage && !isXNotifications;

      if (isXComposePage || isXSettingsPage || isXNotifications) {
        // Interactive page — treat as generic so advisor uses ref-based interaction mode
        out.pageType = 'generic';
        return out;
      } else if (isXHomeFeed || isXProfileOrThread) {
        out.pageType = 'x_feed';
      } else {
        // Unknown x.com path — fall back to generic (safer for interaction)
        out.pageType = 'generic';
        return out;
      }

      const seen = new Set<string>();
      const tweets = Array.from(doc.querySelectorAll('article[data-testid="tweet"]')) as any[];
      for (const tw of tweets) {
        const text = normalize(
          Array.from(tw.querySelectorAll('[data-testid="tweetText"]'))
            .map((n: any) => n.innerText || n.textContent || '')
            .join(' '),
          1800,
        );
        const statusLink = tw.querySelector('a[href*="/status/"]') as any;
        const link = statusLink ? toAbs(statusLink.getAttribute('href') || '') : '';
        const idMatch = link.match(/\/status\/(\d+)/);
        const tweetId = idMatch ? idMatch[1] : '';
        const userNameNode = tw.querySelector('[data-testid="User-Name"]') as any;
        const author = normalize(
          userNameNode?.querySelector('span')?.textContent
            || tw.querySelector('a[role="link"] span')?.textContent
            || '',
          120,
        );
        let handle = '';
        const spans = userNameNode ? Array.from(userNameNode.querySelectorAll('span')) : [];
        for (const sp of spans) {
          const val = normalize((sp as any).textContent || '', 80);
          if (/^@[a-z0-9_]{1,30}$/i.test(val)) { handle = val; break; }
        }
        if (!handle) {
          const m = normalize(tw.innerText || '', 500).match(/@[a-z0-9_]{1,30}/i);
          handle = m ? m[0] : '';
        }

        const time = normalize((tw.querySelector('time') as any)?.getAttribute('datetime') || '', 80);
        const replies = normalize((tw.querySelector('[data-testid="reply"]') as any)?.innerText || '', 30);
        const reposts = normalize((tw.querySelector('[data-testid="retweet"]') as any)?.innerText || '', 30);
        const likes = normalize((tw.querySelector('[data-testid="like"]') as any)?.innerText || '', 30);
        const views = normalize((tw.querySelector('[data-testid="viewCount"]') as any)?.innerText || '', 30);

        if (!text && !link) continue;
        const key = tweetId || link || `${handle}|${text.slice(0, 120)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        out.extractedFeed.push({
          id: tweetId || undefined,
          author: author || undefined,
          handle: handle || undefined,
          time: time || undefined,
          text: text || undefined,
          link: link || undefined,
          source: 'x',
          metrics: {
            replies: replies || undefined,
            reposts: reposts || undefined,
            likes: likes || undefined,
            views: views || undefined,
          },
        });
        if (out.extractedFeed.length >= max) break;
      }
      return out;
    }

    if (isSearch) {
      out.pageType = 'search_results';
      const cards = Array.from(
        doc.querySelectorAll(
          'div.g, div[data-sokoban-container], li.b_algo, .result, .search-result, article, main section',
        ),
      ) as any[];
      const seen = new Set<string>();
      for (const card of cards) {
        const titleEl = card.querySelector('h3, h2');
        const linkEl = card.querySelector('a[href]');
        const snippetEl = card.querySelector('.VwiC3b, .IsZvec, p, span');
        const titleText = normalize(titleEl?.textContent || '', 220);
        const link = normalize(linkEl ? toAbs(linkEl.getAttribute('href') || '') : '', 500);
        const snippet = normalize(snippetEl?.textContent || '', 500);
        if (!titleText && !snippet) continue;
        const key = link || `${titleText}|${snippet.slice(0, 120)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.extractedFeed.push({
          title: titleText || undefined,
          link: link || undefined,
          snippet: snippet || undefined,
          source: host,
        });
        if (out.extractedFeed.length >= max) break;
      }
      return out;
    }

    // Generic article-ish content for research pages.
    const paras = Array.from(doc.querySelectorAll('article p, main p, p')) as any[];
    const blocks: string[] = [];
    for (const p of paras) {
      const text = normalize(p.innerText || p.textContent || '', 700);
      if (text.length < 80) continue;
      blocks.push(text);
      if (blocks.length >= max) break;
    }
    out.textBlocks = blocks;
    out.pageText = blocks.slice(0, 6).join(' ');
    if (
      /article|news|blog|post|story/i.test(title)
      || /(news|blog|substack|medium)\./.test(host)
      || blocks.length >= 4
    ) {
      out.pageType = 'article';
    }
    return out;
  }, Math.max(4, Math.min(maxItems, 60)));

  return {
    pageType: extracted.pageType,
    extractedFeed: dedupeFeedItems((extracted.extractedFeed || []) as BrowserFeedItem[]).slice(0, maxItems),
    textBlocks: (Array.isArray(extracted.textBlocks) ? extracted.textBlocks : []).map((s: any) => String(s || '')).filter(Boolean).slice(0, maxItems),
    pageText: String(extracted.pageText || ''),
    isGenerating: !!extracted.isGenerating,
  };
}

// How stale a cached snapshot is allowed to be before we re-scrape for the advisor.
// browser_open / click / fill / scroll all update session.lastSnapshot immediately, so
// in those flows the snapshot is always < 500 ms old. Only browser_wait paths might
// produce a snapshot that drifts, hence the 4-second ceiling.
const SNAPSHOT_CACHE_TTL_MS = 4000;

async function buildAdvisorPacketForSession(
  session: BrowserSession,
  options?: { maxItems?: number; snapshotElements?: number; cachedSnapshotMs?: number },
): Promise<BrowserAdvisorPacket> {
  const maxItems = Math.max(6, Math.min(Number(options?.maxItems || 24), 60));
  const snapshotElements = Math.max(80, Math.min(Number(options?.snapshotElements || 140), 280));

  const title = await session.page.title();
  const url = session.page.url();

  // Reuse the snapshot the tool handler already captured if it's fresh enough.
  // This avoids a second full DOM scrape immediately after browser_open / click / fill / scroll.
  const cacheAgeMs = options?.cachedSnapshotMs ?? SNAPSHOT_CACHE_TTL_MS;
  const snapshotAge = session.lastSnapshotAt ? Date.now() - session.lastSnapshotAt : Infinity;
  let snapshot: string;
  if (session.lastSnapshot && snapshotAge < cacheAgeMs) {
    snapshot = session.lastSnapshot;
  } else {
    snapshot = await takeSnapshot(session.page, snapshotElements);
    session.lastSnapshot = snapshot;
    session.lastSnapshotAt = Date.now();
  }

  // extractStructuredFromPage is a separate page.evaluate that does its own DOM walk.
  // We still need it for feed/article extraction which the compact snapshot doesn't capture.
  const structured = await extractStructuredFromPage(session.page, maxItems);

  const packet: BrowserAdvisorPacket = {
    page: {
      title: String(title || '').trim(),
      url: String(url || '').trim(),
      pageType: structured.pageType,
    },
    snapshot,
    snapshotElements: parseSnapshotElementCount(snapshot),
    extractedFeed: structured.extractedFeed,
    textBlocks: structured.textBlocks,
    pageText: structured.pageText,
    isGenerating: structured.isGenerating,
    contentHash: buildPacketHash({
      url,
      pageType: structured.pageType,
      snapshot,
      extractedFeed: structured.extractedFeed,
      textBlocks: structured.textBlocks,
      pageText: structured.pageText,
    }),
  };
  return packet;
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
    session.lastSnapshotAt = Date.now();
    return snapshot;
  } catch (err: any) {
    return `ERROR: Navigation failed: ${err.message}`;
  }
}

export async function browserSnapshot(sessionId: string): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return 'ERROR: No browser session. Use browser_open first.';
  try {
    // Wait for the DOM to settle before snapshotting — SPAs (like x.com) may still
    // be hydrating after domcontentloaded, leaving querySelectorAll with 0 results.
    // networkidle is best-effort; we proceed even if it times out.
    await session.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    // Additional settle time for React/Next/Vue hydration to mount interactive elements.
    await session.page.waitForTimeout(600);
    const snapshot = await takeSnapshot(session.page);
    session.lastSnapshot = snapshot;
    session.lastSnapshotAt = Date.now();
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
    session.lastSnapshotAt = Date.now();
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

    // After filling, find the submit button closest to the filled element in the DOM.
    // This lets us annotate the snapshot so the model clicks the RIGHT Post button
    // (the composer's) and not a Post button elsewhere on the page (e.g. in the feed).
    // Find the Post/Tweet submit button ref after filling.
    // Strategy: use X.com's stable data-testid first, then fall back to DOM walk.
    // We recount refs using the same filter logic as takeSnapshot to get the correct number.
    const submitHint = await session.page.evaluate((args: { ref: number; sel: string }) => {
      const doc = (globalThis as any).document as any;
      const openModal: any = (
        doc.querySelector('[role="dialog"][aria-modal="true"]')
        || doc.querySelector('[role="dialog"]:not([aria-hidden="true"])')
        || doc.querySelector('dialog[open]')
        || doc.querySelector('[data-testid="Dropdown"]')
        || doc.querySelector('[role="menu"]')
        || null
      );
      const searchRoot: any = openModal || doc.documentElement;

      // Build the same visible-element list as takeSnapshot so ref numbers match exactly
      const isVisible = (e: any): boolean => {
        const r = typeof e.getBoundingClientRect === 'function' ? e.getBoundingClientRect() : null;
        if (!r || (r.width === 0 && r.height === 0)) return false;
        const style = typeof (globalThis as any).getComputedStyle === 'function' ? (globalThis as any).getComputedStyle(e) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        return true;
      };
      const seen = new Set<any>();
      const all: any[] = [];
      for (const e of Array.from(searchRoot.querySelectorAll(args.sel))) {
        if (!seen.has(e)) { seen.add(e); all.push(e); }
      }
      // Filter same way as takeSnapshot
      const visible = all.filter((e: any) => {
        const tag = e.tagName.toLowerCase();
        const role = (e.getAttribute('role') || '').toLowerCase();
        const ce = e.getAttribute('contenteditable') === 'true';
        const isInput = ['input', 'textarea', 'select'].includes(tag) || ce || ['textbox', 'searchbox', 'combobox'].includes(role);
        const name = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || e.getAttribute('data-testid') || '').trim().slice(0, 80) || (ce ? 'editable' : '');
        if (!name && !isInput) return false;
        return isVisible(e);
      });

      // Strategy 1: X.com stable testid — tweetButtonInline is the in-timeline composer Post button
      const xPostBtn = doc.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
      if (xPostBtn && isVisible(xPostBtn)) {
        const btnRef = visible.indexOf(xPostBtn) + 1;
        if (btnRef > 0) {
          const label = (xPostBtn.getAttribute('aria-label') || xPostBtn.innerText || 'Post').trim();
          return { ref: btnRef, label, strategy: 'testid' };
        }
      }

      // Strategy 2: Find filled element, walk up DOM to find Post/Tweet button ancestor
      let filledEl: any = null;
      for (let i = 0; i < visible.length; i++) {
        if (i + 1 === args.ref) { filledEl = visible[i]; break; }
      }
      if (!filledEl) return null;

      let ancestor: any = filledEl.parentElement;
      const MAX_DEPTH = 14;
      for (let d = 0; d < MAX_DEPTH && ancestor; d++) {
        const buttons = Array.from(ancestor.querySelectorAll('button, [role="button"]')) as any[];
        for (const btn of buttons) {
          const label = (btn.getAttribute('aria-label') || btn.innerText || '').trim();
          if (/^(post|tweet)$/i.test(label) && isVisible(btn)) {
            const btnRef = visible.indexOf(btn) + 1;
            if (btnRef > 0) return { ref: btnRef, label, strategy: 'walk' };
          }
        }
        ancestor = ancestor.parentElement;
      }
      return null;
    }, { ref, sel: INTERACTIVE_SELECTOR }).catch(() => null);

    const snapshot = await takeSnapshot(session.page);
    session.lastSnapshot = snapshot;
    session.lastSnapshotAt = Date.now();

    // ── X.com composer: click Post button directly after a contenteditable fill ──
    // The ref-based hint is unreliable because X renders multiple "Post"-labelled
    // buttons (inline composer + toolbar) and the wrong one gets picked.
    // Strategy: try stable testids in order, fall back to text match.
    // We do this HERE so the model never has to guess the ref.
    if ((el as any).needsNativeType === true) {
      // Only auto-submit for contenteditable fills (the X.com composer case)
      const xPostSelectors = [
        '[data-testid="tweetButtonInline"]',   // home feed inline composer
        '[data-testid="tweetButton"]',          // full /compose modal
      ];
      let clicked = false;
      for (const sel of xPostSelectors) {
        try {
          const btn = session.page.locator(sel).first();
          if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
            await btn.click();
            clicked = true;
            console.log(`[Browser] Auto-clicked Post button via ${sel}`);
            break;
          }
        } catch { /* try next */ }
      }
      if (clicked) {
        // Wait for post to submit and feed to update
        await session.page.waitForTimeout(2000);
        await session.page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        const afterSnapshot = await takeSnapshot(session.page);
        session.lastSnapshot = afterSnapshot;
        session.lastSnapshotAt = Date.now();
        return `Filled composer and clicked Post button.\n\nTweet has been posted successfully.\n\n${afterSnapshot}`;
      }
    }

    // Fallback: show snapshot + hint for model to click manually
    let result = `Filled @${ref} (${el.role}: "${el.name}") with "${text.slice(0, 50)}"\n\n${snapshot}`;
    if (submitHint) {
      result += `\n\n⚠️ COMPOSER SUBMIT BUTTON: @${submitHint.ref} ("${submitHint.label}") — click THIS ref to post. Do NOT click any other @ref first. Do NOT take another snapshot first.`;
    }
    return result;
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
    session.lastSnapshotAt = Date.now();
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
    session.lastSnapshotAt = Date.now();
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

export async function browserScroll(sessionId: string, direction: 'down' | 'up', multiplier?: number): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) return 'ERROR: No browser session. Use browser_open first.';

  const clampedMult = Math.min(Math.max(multiplier || 1.0, 0.5), 4.0);

  try {
    await session.page.evaluate((mult: number) => {
      const pageGlobal = globalThis as any;
      pageGlobal.scrollBy(0, pageGlobal.innerHeight * mult);
    }, direction === 'up' ? -clampedMult : clampedMult);

    await session.page.waitForTimeout(1200); // X/Twitter needs ~1s for new articles to mount

    const snapshot = await takeSnapshot(session.page);
    session.lastSnapshot = snapshot;
    session.lastSnapshotAt = Date.now();
    return `Scrolled ${direction} ${clampedMult}x viewport\n\n${snapshot}`;
  } catch (err: any) {
    return `ERROR: Scroll failed: ${err.message}`;
  }
}

export async function getBrowserAdvisorPacket(
  sessionId: string,
  options?: { maxItems?: number; snapshotElements?: number },
): Promise<BrowserAdvisorPacket | null> {
  const session = sessions.get(sessionId);
  if (!session) return null;
  try {
    return await buildAdvisorPacketForSession(session, options);
  } catch {
    return null;
  }
}

// ─── Tool Definitions (for Ollama) ─────────────────────────────────────────────

export function getBrowserToolDefinitions(): any[] {
  return [
    {
      type: 'function',
      function: {
        name: 'browser_open',
        description: 'Open a URL in a Playwright-controlled Chrome browser (NOT your regular Chrome or Edge). This is the ONLY correct way to open URLs for browser automation — NEVER use run_command to open chrome/edge, as those windows are invisible to all other browser tools. Always use browser_open first to establish a session before using browser_snapshot, browser_click, etc. Returns a snapshot of interactive page elements with @ref numbers — read it immediately. Do NOT call browser_open again for a different URL within the same site — use browser_click on the link @ref instead. For searches, build a direct search URL (e.g. github.com/search?q=query). Elements marked [INPUT] can be filled. If element count looks low, call browser_wait to let JS finish loading.',
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
        description: 'Re-scan the current page and return an updated list of interactive elements with @ref numbers. ONLY call this when you do NOT already have a recent snapshot in context — do NOT call it twice in a row or after browser_open/browser_fill/browser_wait which already return a snapshot. If you just received a snapshot, ACT on it immediately (browser_click or browser_fill) instead of re-snapping. Repeated snapshot calls without acting = stall loop.',
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
        name: 'browser_scroll',
        description: 'Scroll the page by a multiple of the viewport height. Prefer this over browser_press_key(PageDown) on sites with infinite scroll or content virtualization. Use direction="down" with multiplier=1.75 on X/Twitter to reliably load new tweets past virtualization. Default multiplier=1.0.',
        parameters: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['down', 'up'], description: 'Scroll direction' },
            multiplier: { type: 'number', description: 'Viewport height multiplier. Use 1.75 for X/Twitter, 1.0 for most sites. Range: 0.5–4.0.' },
          },
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
