import assert from 'assert';

import {
  getDesktopToolDefinitions,
  desktopWait,
  desktopScreenshot,
  getDesktopAdvisorPacket,
} from '../src/gateway/desktop-tools';

async function run() {
  const defs = getDesktopToolDefinitions();
  const names = defs.map((d: any) => String(d?.function?.name || ''));
  const expected = [
    'desktop_screenshot',
    'desktop_find_window',
    'desktop_focus_window',
    'desktop_click',
    'desktop_drag',
    'desktop_wait',
    'desktop_type',
    'desktop_press_key',
    'desktop_get_clipboard',
    'desktop_set_clipboard',
  ];
  for (const name of expected) {
    assert.ok(names.includes(name), `missing tool definition: ${name}`);
  }

  const waitMsg = await desktopWait(120);
  assert.ok(/Waited/i.test(waitMsg));

  if (process.platform === 'win32') {
    const sessionId = `desktop_test_${Date.now()}`;
    const snapMsg = await desktopScreenshot(sessionId);
    assert.ok(/Desktop screenshot captured/i.test(snapMsg));

    const packet = getDesktopAdvisorPacket(sessionId);
    assert.ok(packet, 'missing desktop advisor packet');
    assert.ok((packet?.width || 0) > 0, 'invalid screenshot width');
    assert.ok((packet?.height || 0) > 0, 'invalid screenshot height');
    assert.ok((packet?.screenshotBase64 || '').length > 1000, 'screenshot base64 too small');
    assert.ok((packet?.contentHash || '').length >= 20, 'missing content hash');
    // OCR is best-effort; may be unavailable on some machines/configurations.
    assert.equal(typeof packet?.ocrText === 'string' || packet?.ocrText === undefined, true);
  }

  console.log('desktop-tools: checks passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

