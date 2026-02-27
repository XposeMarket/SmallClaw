import assert from 'assert';

import {
  FileOpProgressWatchdog,
  buildFailureSignature,
  buildPatchSignature,
  canPrimaryApplyFileTool,
  classifyFileOpType,
  clearFileOpCheckpoint,
  isSmallSuggestedFix,
  loadFileOpCheckpoint,
  resolveFileOpSettings,
  saveFileOpCheckpoint,
  shouldVerifyFileTurn,
} from '../src/orchestration/file-op-v2';

function run() {
  const settings = resolveFileOpSettings({
    file_ops: {
      enabled: true,
      primary_create_max_lines: 80,
      primary_create_max_chars: 3500,
      primary_edit_max_lines: 12,
      primary_edit_max_chars: 800,
      primary_edit_max_files: 1,
      verify_create_always: true,
      verify_large_payload_lines: 25,
      verify_large_payload_chars: 1200,
      watchdog_no_progress_cycles: 3,
      checkpointing_enabled: true,
    },
  });

  // Classifier coverage
  assert.equal(classifyFileOpType('Analyze this repo and explain bug root cause').type, 'FILE_ANALYSIS');
  assert.equal(classifyFileOpType('Create a new file template in this codebase').type, 'FILE_CREATE');
  assert.equal(classifyFileOpType('Edit this config file and fix the value').type, 'FILE_EDIT');
  assert.equal(classifyFileOpType('Open github.com and click issues').type, 'BROWSER_OP');
  assert.equal(classifyFileOpType('Is VS Code done yet?').type, 'DESKTOP_OP');
  assert.equal(classifyFileOpType('hello there').type, 'CHAT');

  // Primary create OR-gate
  const createSmallChars = canPrimaryApplyFileTool({
    tool_name: 'create_file',
    args: { filename: 'a.txt', content: 'x\n'.repeat(120) },
    message: 'create file',
    touched_files: new Set<string>(),
    settings,
  });
  assert.equal(createSmallChars.allowed, true);

  const createLarge = canPrimaryApplyFileTool({
    tool_name: 'create_file',
    args: { filename: 'a.txt', content: 'x'.repeat(6000) + '\n'.repeat(200) },
    message: 'create file',
    touched_files: new Set<string>(),
    settings,
  });
  assert.equal(createLarge.allowed, false);

  // Primary edit AND-gate + refactor guard + touched files guard
  const editSmall = canPrimaryApplyFileTool({
    tool_name: 'replace_lines',
    args: { filename: 'a.txt', new_content: 'ok\nvalue' },
    message: 'edit file quickly',
    touched_files: new Set<string>(),
    settings,
  });
  assert.equal(editSmall.allowed, true);

  const editRefactor = canPrimaryApplyFileTool({
    tool_name: 'replace_lines',
    args: { filename: 'a.txt', new_content: 'modular rewrite' },
    message: 'refactor this module',
    touched_files: new Set<string>(),
    settings,
  });
  assert.equal(editRefactor.allowed, false);

  const editTooManyFiles = canPrimaryApplyFileTool({
    tool_name: 'replace_lines',
    args: { filename: 'b.txt', new_content: 'tiny' },
    message: 'edit file',
    touched_files: new Set<string>(['a.txt']),
    settings,
  });
  assert.equal(editTooManyFiles.allowed, false);

  // Verify trigger contract
  const verifyNone = shouldVerifyFileTurn({
    had_create: false,
    user_requested_full_template: false,
    primary_write_lines: 2,
    primary_write_chars: 40,
    had_tool_failure: false,
    touched_files: [],
    high_stakes_touched: false,
  }, settings);
  assert.equal(verifyNone.verify, false);

  const verifyCreate = shouldVerifyFileTurn({
    had_create: true,
    user_requested_full_template: false,
    primary_write_lines: 2,
    primary_write_chars: 40,
    had_tool_failure: false,
    touched_files: ['index.html'],
    high_stakes_touched: false,
  }, settings);
  assert.equal(verifyCreate.verify, true);

  const verifyHighRisk = shouldVerifyFileTurn({
    had_create: false,
    user_requested_full_template: false,
    primary_write_lines: 2,
    primary_write_chars: 40,
    had_tool_failure: false,
    touched_files: ['auth.ts'],
    high_stakes_touched: true,
  }, settings);
  assert.equal(verifyHighRisk.verify, true);

  // Suggested-fix sizing
  assert.equal(isSmallSuggestedFix({
    verdict: 'FAIL',
    reasons: [],
    findings: [],
    suggested_fix: {
      estimated_lines_changed: 10,
      estimated_chars: 400,
      files_touched: 1,
    },
  }, settings), true);
  assert.equal(isSmallSuggestedFix({
    verdict: 'FAIL',
    reasons: [],
    findings: [],
    suggested_fix: {
      estimated_lines_changed: 20,
      estimated_chars: 400,
      files_touched: 1,
    },
  }, settings), false);

  // Watchdog signatures and no-progress detection
  const failure = buildFailureSignature({
    verdict: 'FAIL',
    reasons: ['Missing pricing section'],
    findings: [{ filename: 'landing.html', type: 'MISSING_SECTION', expected: 'pricing', observed: 'none' }],
    suggested_fix: { estimated_lines_changed: 10, estimated_chars: 500, files_touched: 1 },
  });
  const patchA = buildPatchSignature([{ tool: 'replace_lines', args: { filename: 'landing.html', start_line: 1, end_line: 3, new_content: 'A' } }]);
  const patchB = buildPatchSignature([{ tool: 'replace_lines', args: { filename: 'landing.html', start_line: 1, end_line: 3, new_content: 'B' } }]);
  assert.ok(failure.length > 0);
  assert.ok(patchA.length > 0 && patchB.length > 0 && patchA !== patchB);

  const watchdog = new FileOpProgressWatchdog(3);
  assert.equal(watchdog.record({ failure_signature: failure, patch_signature: patchA, large_patch: true }).no_progress, false);
  assert.equal(watchdog.record({ failure_signature: failure, patch_signature: patchA, large_patch: true }).no_progress, false);
  assert.equal(watchdog.record({ failure_signature: failure, patch_signature: patchA, large_patch: true }).no_progress, true);

  const watchdogOsc = new FileOpProgressWatchdog(3);
  watchdogOsc.record({ failure_signature: failure, patch_signature: patchA, large_patch: false });
  watchdogOsc.record({ failure_signature: failure, patch_signature: patchB, large_patch: false });
  const oscillating = watchdogOsc.record({ failure_signature: failure, patch_signature: patchA, large_patch: false });
  assert.equal(oscillating.no_progress, true);

  // Checkpoint roundtrip
  const sessionId = `file-op-v2-test-${Date.now()}`;
  clearFileOpCheckpoint(sessionId);
  saveFileOpCheckpoint(sessionId, {
    goal: 'create landing page',
    phase: 'plan',
    owner: 'secondary',
    operation: 'FILE_CREATE',
    tasks: ['draft', 'verify'],
    files_changed: ['landing.html'],
    patch_history_signatures: [patchA],
    next_action: 'run secondary patch',
  });
  const loaded = loadFileOpCheckpoint(sessionId);
  assert.ok(loaded);
  assert.equal(loaded?.goal, 'create landing page');
  assert.equal(loaded?.owner, 'secondary');
  assert.equal(loaded?.operation, 'FILE_CREATE');
  assert.deepEqual(loaded?.files_changed, ['landing.html']);
  clearFileOpCheckpoint(sessionId);
  assert.equal(loadFileOpCheckpoint(sessionId), null);

  console.log('file-op-v2: all checks passed');
}

run();
