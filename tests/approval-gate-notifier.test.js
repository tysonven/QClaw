/**
 * Approval gate — requestApproval must fire the notifier.
 *
 * Pre-fix: requestApproval called approvals.request() directly and bypassed
 * the notifier entirely. The executor (src/tools/executor.js) hits this path
 * for every tier-classified tool call, so production approvals from that
 * path timed out silently — no Telegram prompt was ever sent.
 *
 * Post-fix: requestApproval delegates to requestInlineApproval, sharing the
 * single notifier-firing approval-creation code path.
 *
 * Run: node tests/approval-gate-notifier.test.js
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecApprovals } from '../src/security/approvals.js';
import { ApprovalGate } from '../src/security/approval-gate.js';

const dir = mkdtempSync(join(tmpdir(), 'qclaw-gate-'));
let passed = 0;
let failed = 0;

function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// Let pending microtasks drain so the await chain inside requestInlineApproval
// reaches the notifier call before we assert.
const tick = () => new Promise((r) => setImmediate(r));

async function main() {
  const approvals = new ExecApprovals({ _dir: dir });
  approvals.attach(null); // JSON path so no SQLite dep

  const gate = new ApprovalGate(approvals);

  // ── 1. requestApproval fires the notifier with the right payload shape
  const calls = [];
  gate.setNotifier(async (payload) => { calls.push(payload); });

  const p1 = gate.requestApproval(
    'charlie',
    'shell_exec',
    { command: 'whoami' },
    'high',
  );
  // Wait for the notifier to be invoked (it's awaited inside requestInlineApproval).
  await tick();
  await tick();

  check('notifier fired exactly once', calls.length === 1,
    `got ${calls.length} calls`);
  check('notifier received agent="charlie"',
    calls[0]?.agent === 'charlie');
  check('notifier received tool="shell_exec"',
    calls[0]?.tool === 'shell_exec');
  check('notifier received numeric id',
    Number.isInteger(calls[0]?.id) && calls[0].id > 0);
  check('notifier received riskLevel="high"',
    calls[0]?.riskLevel === 'high');
  check('action string includes the tool name and args',
    typeof calls[0]?.action === 'string'
      && calls[0].action.includes('shell_exec')
      && calls[0].action.includes('whoami'));
  check('detail string includes agent name',
    typeof calls[0]?.detail === 'string'
      && calls[0].detail.includes('charlie'));

  // Resolve so the test can finish — requestApproval awaits the approval.
  approvals.approve(calls[0].id, 'tg:test');
  const result1 = await p1;
  check('returned promise resolves with approved:true',
    result1?.approved === true && result1?.id === calls[0].id);

  // ── 2. requestApproval still works when no notifier is wired
  const gate2 = new ApprovalGate(approvals);
  const p2 = gate2.requestApproval(
    'charlie',
    'n8n_workflow_update',
    { workflowId: 'abc' },
    'medium',
  );
  // Approve via the row id from pending() since no notifier captured it.
  await tick();
  const pendingNow = approvals.pending();
  const id2 = pendingNow[0]?.id;
  check('row was created even with no notifier',
    Number.isInteger(id2));
  approvals.approve(id2, 'tg:test');
  const result2 = await p2;
  check('no-notifier path still resolves correctly',
    result2?.approved === true && result2?.id === id2);

  // ── 3. notifier failure is non-fatal — approval still resolves
  const gate3 = new ApprovalGate(approvals);
  gate3.setNotifier(async () => { throw new Error('boom'); });

  const p3 = gate3.requestApproval(
    'charlie',
    'shell_exec',
    { command: 'ls' },
    'low',
  );
  await tick();
  await tick();
  const id3 = approvals.pending()[0]?.id;
  check('row created despite notifier throwing', Number.isInteger(id3));
  approvals.approve(id3, 'tg:test');
  const result3 = await p3;
  check('approval resolves even when notifier throws',
    result3?.approved === true);

  // ── 4. requestInlineApproval (existing callers: shell_exec, n8n) still
  //       fires the notifier — same code path, sanity check.
  const gate4 = new ApprovalGate(approvals);
  const calls4 = [];
  gate4.setNotifier(async (payload) => { calls4.push(payload); });
  const p4 = gate4.requestInlineApproval({
    agent: 'charlie',
    tool: 'shell_exec',
    action: 'shell_exec({"command":"id"})',
    detail: 'inline detail',
    riskLevel: 'medium',
  });
  await tick();
  await tick();
  check('requestInlineApproval still fires notifier',
    calls4.length === 1 && calls4[0].tool === 'shell_exec');
  approvals.approve(calls4[0].id, 'tg:test');
  await p4;
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    rmSync(dir, { recursive: true, force: true });
    // approvals.request() arms 10-min setTimeouts; exit explicitly.
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('unexpected:', err);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  });
