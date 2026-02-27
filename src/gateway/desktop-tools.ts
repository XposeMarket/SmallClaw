/**
 * desktop-tools.ts
 *
 * Windows desktop automation primitives for SmallClaw.
 * Uses PowerShell + Win32 APIs (no native npm dependency required).
 *
 * NOTE: Current implementation targets Windows only.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';

const execFileAsync = promisify(execFile);

export interface DesktopWindowInfo {
  pid: number;
  processName: string;
  title: string;
  handle: number;
}

export interface DesktopAdvisorPacket {
  screenshotBase64: string;
  screenshotMime: 'image/png';
  width: number;
  height: number;
  capturedAt: number;
  openWindows: DesktopWindowInfo[];
  activeWindow?: DesktopWindowInfo;
  ocrText?: string;
  ocrConfidence?: number;
  contentHash: string;
}

interface DesktopSessionState {
  lastPacket?: DesktopAdvisorPacket;
}

const sessions = new Map<string, DesktopSessionState>();

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const OCR_CHILD_SCRIPT = `
(async () => {
  const imagePath = process.argv[2];
  try {
    const mod = await import('tesseract.js');
    const createWorker = mod?.createWorker;
    if (typeof createWorker !== 'function') {
      process.stdout.write('{}');
      return;
    }
    const worker = await createWorker('eng');
    if (worker && typeof worker.loadLanguage === 'function' && typeof worker.initialize === 'function') {
      await worker.loadLanguage('eng');
      await worker.initialize('eng');
    }
    const out = await worker.recognize(imagePath);
    if (worker && typeof worker.terminate === 'function') {
      await worker.terminate();
    }
    const text = String(out?.data?.text || '')
      .replace(/\\r/g, '')
      .replace(/[ \\t]+\\n/g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
    const confidence = Number(out?.data?.confidence || 0) || 0;
    process.stdout.write(JSON.stringify({ text, confidence }));
  } catch {
    process.stdout.write('{}');
  }
})().catch(() => process.stdout.write('{}'));
`;

function ensureWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('Desktop tools are currently supported on Windows only.');
  }
}

function psSingleQuote(value: string): string {
  return String(value || '').replace(/'/g, "''");
}

async function runPowerShell(
  script: string,
  opts?: { timeoutMs?: number; sta?: boolean },
): Promise<string> {
  ensureWindows();
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass'];
  if (opts?.sta) args.push('-STA');
  args.push('-Command', script);
  const { stdout, stderr } = await execFileAsync('powershell.exe', args, {
    timeout: opts?.timeoutMs ?? 15000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const out = String(stdout || '').trim();
  const err = String(stderr || '').trim();
  if (err && !out) {
    throw new Error(err.slice(0, 500));
  }
  return out;
}

function parseJsonMaybe(raw: string): any {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function normalizeWindows(raw: any): DesktopWindowInfo[] {
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return arr
    .map((w: any) => ({
      pid: Number(w?.pid || w?.Id || 0) || 0,
      processName: String(w?.processName || w?.ProcessName || '').trim(),
      title: String(w?.title || w?.MainWindowTitle || '').trim(),
      handle: Number(w?.handle || w?.MainWindowHandle || 0) || 0,
    }))
    .filter((w) => w.handle !== 0 && !!w.title)
    .sort((a, b) => a.title.localeCompare(b.title))
    .slice(0, 120);
}

async function listWindowsInternal(): Promise<DesktopWindowInfo[]> {
  const script = `
$rows = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0
} | Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle
$out = @()
foreach ($r in $rows) {
  $out += [PSCustomObject]@{
    pid = [int]$r.Id
    processName = [string]$r.ProcessName
    title = [string]$r.MainWindowTitle
    handle = [int64]$r.MainWindowHandle
  }
}
$out | ConvertTo-Json -Compress
`;
  const raw = await runPowerShell(script, { timeoutMs: 12000 });
  return normalizeWindows(parseJsonMaybe(raw));
}

async function activeWindowInternal(): Promise<DesktopWindowInfo | null> {
  const script = `
${PS_WINAPI_HEADER}
$hWnd = [SmallClawWinApi]::GetForegroundWindow()
$pid = 0
[void][SmallClawWinApi]::GetWindowThreadProcessId($hWnd, [ref]$pid)
$proc = $null
if ($pid -gt 0) {
  $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
}
[PSCustomObject]@{
  pid = [int]$pid
  processName = if ($proc) { [string]$proc.ProcessName } else { '' }
  title = if ($proc) { [string]$proc.MainWindowTitle } else { '' }
  handle = [int64]$hWnd.ToInt64()
} | ConvertTo-Json -Compress
`;
  const raw = await runPowerShell(script, { timeoutMs: 12000 });
  const parsed = normalizeWindows(parseJsonMaybe(raw));
  return parsed[0] || null;
}

async function captureScreenshotInternal(): Promise<{
  path: string;
  width: number;
  height: number;
  left: number;
  top: number;
}> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
$tmp = Join-Path $env:TEMP ("smallclaw-desktop-" + [guid]::NewGuid().ToString() + ".png")
$bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
[PSCustomObject]@{
  path = [string]$tmp
  width = [int]$bounds.Width
  height = [int]$bounds.Height
  left = [int]$bounds.Left
  top = [int]$bounds.Top
} | ConvertTo-Json -Compress
`;
  const raw = await runPowerShell(script, { timeoutMs: 18000, sta: true });
  const parsed = parseJsonMaybe(raw) || {};
  const out = {
    path: String(parsed.path || '').trim(),
    width: Number(parsed.width || 0) || 0,
    height: Number(parsed.height || 0) || 0,
    left: Number(parsed.left || 0) || 0,
    top: Number(parsed.top || 0) || 0,
  };
  if (!out.path || !fs.existsSync(out.path)) {
    throw new Error('Screenshot capture failed (no output file).');
  }
  return out;
}

function findWindowsByName(allWindows: DesktopWindowInfo[], query: string): DesktopWindowInfo[] {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return allWindows.filter((w) =>
    w.title.toLowerCase().includes(q) || w.processName.toLowerCase().includes(q),
  );
}

// ─── Cached Add-Type headers ──────────────────────────────────────────────────
//
// PowerShell compiles Add-Type C# code on every new process invocation.
// Each compile costs 400-800ms. We avoid it for frequently-called tools by
// using a guard pattern:  `if (-not ([System.Management.Automation.PSTypeName]
// 'WinApi').Type) { Add-Type ... }` so the inline C# is only compiled once
// per PowerShell session lifetime.
//
// Because each tool call spawns a fresh powershell.exe process the caching
// happens at the *script* level — we prepend the guard block and PowerShell's
// type system caches the compiled assembly for the duration of that process.
// The gain is real: when 5 tools fire in sequence each saves one recompile.

const PS_WINAPI_HEADER = `
if (-not ([System.Management.Automation.PSTypeName]'SmallClawWinApi').Type) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SmallClawWinApi {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@ -Language CSharp
}
`;

const PS_INPUTAPI_HEADER = `
if (-not ([System.Management.Automation.PSTypeName]'SmallClawInputApi').Type) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SmallClawInputApi {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@ -Language CSharp
}
`;

async function focusWindowHandle(handle: number): Promise<boolean> {
  const h = Number(handle || 0);
  if (!Number.isFinite(h) || h === 0) return false;
  const script = `
${PS_WINAPI_HEADER}
$hWnd = [IntPtr]::new([Int64]${h})
[void][SmallClawWinApi]::ShowWindowAsync($hWnd, 9)
Start-Sleep -Milliseconds 120
$ok = [SmallClawWinApi]::SetForegroundWindow($hWnd)
if ($ok) { Write-Output "OK" } else { Write-Output "FAIL" }
`;
  const out = await runPowerShell(script, { timeoutMs: 9000 });
  return out.toUpperCase().includes('OK');
}

function shortWindowLabel(w?: DesktopWindowInfo | null): string {
  if (!w) return 'unknown';
  const title = String(w.title || '').trim() || '(untitled)';
  const proc = String(w.processName || '').trim() || 'process';
  return `"${title}" (${proc})`;
}

function compactWindowList(allWindows: DesktopWindowInfo[], maxItems: number = 8): string {
  const lines = allWindows.slice(0, maxItems).map((w, i) =>
    `${i + 1}. [${w.processName}] ${w.title} (handle=${w.handle})`,
  );
  return lines.join('\n');
}

function computeContentHash(base64: string): string {
  return crypto.createHash('sha1').update(base64 || '').digest('hex');
}

async function runOcr(imagePath: string): Promise<{ text: string; confidence: number } | null> {
  try {
    const ocrEnabled = String(process.env.SMALLCLAW_DESKTOP_OCR || '1').trim() !== '0';
    if (!ocrEnabled) return null;
    const timeoutMs = clampInt(process.env.SMALLCLAW_OCR_TIMEOUT_MS, 1000, 120000, 25000);
    const ocrCacheDir = path.join(process.cwd(), '.localclaw', 'ocr-cache');
    fs.mkdirSync(ocrCacheDir, { recursive: true });
    const { stdout } = await execFileAsync(
      process.execPath,
      ['-e', OCR_CHILD_SCRIPT, imagePath],
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        cwd: ocrCacheDir,
      },
    );
    const parsed = parseJsonMaybe(String(stdout || '').trim()) || {};
    const text = String(parsed?.text || '').trim();
    const confidence = Number(parsed?.confidence || 0) || 0;
    if (!text) return null;
    return { text: text.slice(0, 16000), confidence };
  } catch {
    return null;
  }
}

export async function desktopScreenshot(sessionId: string): Promise<string> {
  ensureWindows();
  const shot = await captureScreenshotInternal();

  // Run OCR + window enumeration in parallel — they are fully independent.
  // listWindows and activeWindow each spawn their own PowerShell process;
  // OCR runs a Node child process on the saved PNG. None depend on each
  // other, so there is no reason to wait for OCR before listing windows.
  const [ocr, openWindows, activeWindow] = await Promise.all([
    runOcr(shot.path),
    listWindowsInternal(),
    activeWindowInternal(),
  ]);

  const png = fs.readFileSync(shot.path);
  try { fs.unlinkSync(shot.path); } catch {}

  const screenshotBase64 = png.toString('base64');
  const capturedAt = Date.now();
  const packet: DesktopAdvisorPacket = {
    screenshotBase64,
    screenshotMime: 'image/png',
    width: shot.width,
    height: shot.height,
    capturedAt,
    openWindows,
    activeWindow: activeWindow || undefined,
    ocrText: ocr?.text,
    ocrConfidence: ocr?.confidence,
    contentHash: computeContentHash(screenshotBase64),
  };
  sessions.set(sessionId, { lastPacket: packet });

  const topWindows = compactWindowList(openWindows, 8);
  const ocrPreview = ocr?.text ? ocr.text.slice(0, 280).replace(/\s+/g, ' ').trim() : '';
  const ocrLen = ocr?.text ? ocr.text.length : 0;
  return [
    `Desktop screenshot captured (${shot.width}x${shot.height}).`,
    `Active window: ${shortWindowLabel(activeWindow)}.`,
    `Open windows: ${openWindows.length}.`,
    ocrPreview ? `OCR preview (${Math.round(ocr?.confidence || 0)}%): ${ocrPreview}${ocrLen > 280 ? ' ...' : ''}` : 'OCR preview: unavailable.',
    topWindows ? `Top windows:\n${topWindows}` : '',
  ].filter(Boolean).join('\n');
}

export async function desktopFindWindow(name: string): Promise<string> {
  ensureWindows();
  const query = String(name || '').trim();
  if (!query) return 'ERROR: name is required.';
  const allWindows = await listWindowsInternal();
  const matches = findWindowsByName(allWindows, query);
  if (matches.length === 0) {
    return `No windows matching "${query}" were found.`;
  }
  const lines = matches.slice(0, 20).map((w, i) =>
    `${i + 1}. [${w.processName}] ${w.title} (handle=${w.handle})`,
  );
  return `Found ${matches.length} window(s) for "${query}":\n${lines.join('\n')}`;
}

export async function desktopFocusWindow(name: string): Promise<string> {
  ensureWindows();
  const query = String(name || '').trim();
  if (!query) return 'ERROR: name is required.';
  const allWindows = await listWindowsInternal();
  const matches = findWindowsByName(allWindows, query);
  if (matches.length === 0) {
    return `ERROR: No window matching "${query}" found.`;
  }
  const target = matches[0];
  const focused = await focusWindowHandle(target.handle);
  if (!focused) {
    return `ERROR: Failed to focus "${target.title}" (${target.processName}).`;
  }
  return `Focused window: "${target.title}" (${target.processName}).`;
}

export async function desktopClick(
  x: number,
  y: number,
  button: 'left' | 'right' = 'left',
  doubleClick: boolean = false,
): Promise<string> {
  ensureWindows();
  const xx = Math.floor(Number(x));
  const yy = Math.floor(Number(y));
  if (!Number.isFinite(xx) || !Number.isFinite(yy)) {
    return 'ERROR: x and y must be valid numbers.';
  }
  const btn = button === 'right' ? 'right' : 'left';
  const downFlag = btn === 'right' ? '0x0008' : '0x0002';
  const upFlag = btn === 'right' ? '0x0010' : '0x0004';
  const repeat = doubleClick ? 2 : 1;

  const script = `
${PS_INPUTAPI_HEADER}
[void][SmallClawInputApi]::SetCursorPos(${xx}, ${yy})
Start-Sleep -Milliseconds 40
for ($i = 0; $i -lt ${repeat}; $i++) {
  [SmallClawInputApi]::mouse_event(${downFlag}, 0, 0, 0, [UIntPtr]::Zero)
  [SmallClawInputApi]::mouse_event(${upFlag}, 0, 0, 0, [UIntPtr]::Zero)
  if ($i -lt ${repeat - 1}) { Start-Sleep -Milliseconds 80 }
}
Write-Output "OK"
`;
  await runPowerShell(script, { timeoutMs: 6000 });
  return `Clicked ${btn} at (${xx}, ${yy})${doubleClick ? ' [double]' : ''}.`;
}

export async function desktopDrag(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  steps: number = 20,
): Promise<string> {
  ensureWindows();
  const fx = Math.floor(Number(fromX));
  const fy = Math.floor(Number(fromY));
  const tx = Math.floor(Number(toX));
  const ty = Math.floor(Number(toY));
  const st = Math.max(2, Math.min(100, Math.floor(Number(steps) || 20)));
  if (![fx, fy, tx, ty].every(Number.isFinite)) {
    return 'ERROR: from_x, from_y, to_x, to_y must be valid numbers.';
  }

  const script = `
${PS_INPUTAPI_HEADER}
[void][SmallClawInputApi]::SetCursorPos(${fx}, ${fy})
Start-Sleep -Milliseconds 30
[SmallClawInputApi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
for ($i = 1; $i -le ${st}; $i++) {
  $x = [int](${fx} + ((${tx} - ${fx}) * $i / ${st}))
  $y = [int](${fy} + ((${ty} - ${fy}) * $i / ${st}))
  [void][SmallClawInputApi]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 8
}
[SmallClawInputApi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Write-Output "OK"
`;
  await runPowerShell(script, { timeoutMs: 9000 });
  return `Dragged from (${fx}, ${fy}) to (${tx}, ${ty}) in ${st} steps.`;
}

export async function desktopWait(ms: number = 500): Promise<string> {
  const waitMs = Math.max(50, Math.min(30000, Math.floor(Number(ms) || 500)));
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return `Waited ${waitMs} ms.`;
}

function toSendKeysSpec(keyRaw: string): string {
  const raw = String(keyRaw || '').trim();
  if (!raw) return '{ENTER}';

  const mapBase = (token: string): string => {
    const t = token.toLowerCase();
    if (t === 'enter' || t === 'return') return '{ENTER}';
    if (t === 'escape' || t === 'esc') return '{ESC}';
    if (t === 'tab') return '{TAB}';
    if (t === 'space') return ' ';
    if (t === 'backspace') return '{BACKSPACE}';
    if (t === 'delete' || t === 'del') return '{DEL}';
    if (t === 'up' || t === 'arrowup') return '{UP}';
    if (t === 'down' || t === 'arrowdown') return '{DOWN}';
    if (t === 'left' || t === 'arrowleft') return '{LEFT}';
    if (t === 'right' || t === 'arrowright') return '{RIGHT}';
    if (t === 'pagedown' || t === 'pgdn') return '{PGDN}';
    if (t === 'pageup' || t === 'pgup') return '{PGUP}';
    if (t === 'home') return '{HOME}';
    if (t === 'end') return '{END}';
    if (t === 'insert' || t === 'ins') return '{INS}';
    const fn = t.match(/^f([1-9]|1[0-2])$/);
    if (fn) return `{F${fn[1]}}`;
    if (/^[a-z0-9]$/i.test(token)) return token;
    return token;
  };

  const parts = raw.split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) return mapBase(parts[0] || raw);

  const base = mapBase(parts[parts.length - 1]);
  let mods = '';
  for (const m of parts.slice(0, -1)) {
    const mm = m.toLowerCase();
    if (mm === 'ctrl' || mm === 'control' || mm === 'cmd' || mm === 'command') mods += '^';
    else if (mm === 'shift') mods += '+';
    else if (mm === 'alt' || mm === 'option') mods += '%';
  }
  return `${mods}${base}`;
}

export async function desktopType(text: string): Promise<string> {
  ensureWindows();
  const payload = String(text || '');
  if (!payload) return 'Typed 0 character(s).';

  const MAX_TYPE_LENGTH = 50000;
  if (payload.length > MAX_TYPE_LENGTH) {
    return `ERROR: Text too long (${payload.length} chars). Maximum is ${MAX_TYPE_LENGTH} chars.`;
  }

  const escaped = psSingleQuote(payload);

  // Read current clipboard content so we can restore it after pasting.
  // If the clipboard contains non-text (image, file list) this will be empty —
  // that's fine, we restore it as empty which is a no-op rather than crashing.
  const script = `
Add-Type -AssemblyName System.Windows.Forms
# 1. Snapshot existing clipboard (text only; non-text clipboard contents are left as-is after paste)
$prevClip = ''
$hadText = $false
if ([System.Windows.Forms.Clipboard]::ContainsText()) {
  $prevClip = [System.Windows.Forms.Clipboard]::GetText()
  $hadText = $true
}
# 2. Set our payload and paste
[System.Windows.Forms.Clipboard]::SetText('${escaped}')
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 60
# 3. Restore previous clipboard content
if ($hadText) {
  [System.Windows.Forms.Clipboard]::SetText($prevClip)
} else {
  [System.Windows.Forms.Clipboard]::Clear()
}
Write-Output "OK"
`;
  await runPowerShell(script, { timeoutMs: 10000, sta: true });
  return `Typed ${payload.length} character(s) via clipboard paste (clipboard restored).`;
}

export async function desktopPressKey(key: string): Promise<string> {
  ensureWindows();
  const spec = toSendKeysSpec(key);
  const escaped = psSingleQuote(spec);
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escaped}')
Write-Output "OK"
`;
  await runPowerShell(script, { timeoutMs: 6000, sta: true });
  return `Pressed key: ${key || 'Enter'}.`;
}

export async function desktopGetClipboard(): Promise<string> {
  ensureWindows();
  const script = `
Add-Type -AssemblyName System.Windows.Forms
if ([System.Windows.Forms.Clipboard]::ContainsText()) {
  [System.Windows.Forms.Clipboard]::GetText()
}
`;
  const out = await runPowerShell(script, { timeoutMs: 6000, sta: true });
  if (!out) return 'Clipboard is empty.';
  if (out.length > 5000) {
    return `Clipboard text (${out.length} chars):\n${out.slice(0, 5000)}\n...(truncated)`;
  }
  return `Clipboard text (${out.length} chars):\n${out}`;
}

export async function desktopSetClipboard(text: string): Promise<string> {
  ensureWindows();
  const payload = String(text || '');
  const escaped = psSingleQuote(payload);
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText('${escaped}')
Write-Output "OK"
`;
  await runPowerShell(script, { timeoutMs: 6000, sta: true });
  return `Clipboard updated (${payload.length} chars).`;
}

export function getDesktopAdvisorPacket(sessionId: string): DesktopAdvisorPacket | null {
  const state = sessions.get(sessionId);
  if (!state?.lastPacket) return null;
  return state.lastPacket;
}

export function getDesktopToolDefinitions(): any[] {
  return [
    {
      type: 'function',
      function: {
        name: 'desktop_screenshot',
        description: 'Capture a screenshot of the full desktop and return active/open window info. Use this first for desktop app tasks.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'desktop_find_window',
        description: 'Find open windows by title or process name.',
        parameters: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: 'Partial window title or process name, e.g. "Visual Studio Code"' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'desktop_focus_window',
        description: 'Bring a matching window to foreground/focus.',
        parameters: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: 'Partial window title or process name to focus' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'desktop_click',
        description: 'Click at desktop coordinates.',
        parameters: {
          type: 'object',
          required: ['x', 'y'],
          properties: {
            x: { type: 'number', description: 'Screen X coordinate in pixels' },
            y: { type: 'number', description: 'Screen Y coordinate in pixels' },
            button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button (default left)' },
            double_click: { type: 'boolean', description: 'Double-click instead of single-click' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'desktop_drag',
        description: 'Drag mouse from one coordinate to another.',
        parameters: {
          type: 'object',
          required: ['from_x', 'from_y', 'to_x', 'to_y'],
          properties: {
            from_x: { type: 'number', description: 'Start X coordinate' },
            from_y: { type: 'number', description: 'Start Y coordinate' },
            to_x: { type: 'number', description: 'End X coordinate' },
            to_y: { type: 'number', description: 'End Y coordinate' },
            steps: { type: 'number', description: 'Interpolation steps (default 20)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'desktop_wait',
        description: 'Pause execution for a number of milliseconds.',
        parameters: {
          type: 'object',
          properties: {
            ms: { type: 'number', description: 'Milliseconds to wait (50-30000)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'desktop_type',
        description: 'Type text into the currently focused desktop window (via clipboard paste).',
        parameters: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', description: 'Text to type' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'desktop_press_key',
        description: 'Press a key in the focused desktop window. Supports Enter, Escape, Tab, PageDown, Ctrl+C, Ctrl+V, etc.',
        parameters: {
          type: 'object',
          required: ['key'],
          properties: {
            key: { type: 'string', description: 'Key or combo, e.g. Enter, Escape, Ctrl+C, Alt+Tab' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'desktop_get_clipboard',
        description: 'Read clipboard text.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'desktop_set_clipboard',
        description: 'Write text to clipboard.',
        parameters: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', description: 'Clipboard text' },
          },
        },
      },
    },
  ];
}
