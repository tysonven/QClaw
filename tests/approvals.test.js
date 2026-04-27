/**
 * ExecApprovals — orphan-callback safety + return shape.
 * Uses the JSON-fallback path so no SQLite dependency is required.
 * Run: node tests/approvals.test.js
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecApprovals } from '../src/security/approvals.js';

const dir = mkdtempSync(join(tmpdir(), 'qclaw-approvals-'));
let passed = 0;
let failed = 0;

function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

async function main() {
  const approvals = new ExecApprovals({ _dir: dir });
  approvals.attach(null); // force JSON path

  // ── 1. approve() resolves the pending Promise and returns alreadyResolved:false
  const p1 = approvals.request('charlie', 'shell_exec', 'whoami', 'low');
  check('request creates pending row', approvals.pending().length === 1);
  const id1 = approvals.pending()[0].id;

  const ret1 = approvals.approve(id1, 'tg:test');
  check('approve returns alreadyResolved:false', ret1?.alreadyResolved === false);

  const result1 = await p1;
  check('original Promise resolves with approved:true',
    result1.approved === true && result1.id === id1);

  // ── 2. approve() on an already-resolved row returns alreadyResolved:true
  const ret2 = approvals.approve(id1, 'tg:test');
  check('second approve returns alreadyResolved:true with status approved',
    ret2?.alreadyResolved === true && ret2.status === 'approved');

  // ── 3. approve() on nonexistent id throws "not found"
  let threw = false, msg = '';
  try { approvals.approve(99999, 'tg:test'); }
  catch (e) { threw = true; msg = e.message; }
  check('approve on nonexistent id throws "not found"',
    threw && msg === 'not found', `got threw=${threw} msg=${msg}`);

  // ── 4. deny() resolves Promise with approved:false
  const p2 = approvals.request('charlie', 'n8n_workflow_update', 'foo', 'high');
  const id2 = approvals.pending()[0].id;
  const retD = approvals.deny(id2, 'tg:test', 'Denied by user');
  check('deny returns alreadyResolved:false', retD?.alreadyResolved === false);
  const result2 = await p2;
  check('Promise resolves with approved:false and reason',
    result2.approved === false && result2.reason === 'Denied by user');

  // ── 5. orphan-callback path: row updates, no throw, no callback
  // Simulate a process restart between request and approval by clearing the
  // pendingCallbacks Map but leaving the row in JSON state.
  const p3 = approvals.request('charlie', 'shell_exec', 'orphan', 'low');
  const id3 = approvals.pending()[0].id;
  let p3State = 'pending';
  p3.then(() => { p3State = 'resolved'; }).catch(() => { p3State = 'rejected'; });

  approvals.pendingCallbacks.delete(id3); // simulate restart
  const retO = approvals.approve(id3, 'tg:test');
  check('orphan approve does not throw and returns alreadyResolved:false',
    retO?.alreadyResolved === false);

  const row = approvals._data.items.find(i => i.id === id3);
  check('orphan approve updates row to approved',
    row && row.status === 'approved' && row.resolved_by === 'tg:test');

  await new Promise(r => setTimeout(r, 10));
  check('orphan: original Promise stays pending (no fake resolution)',
    p3State === 'pending');

  // ── 6. deny() also handles orphan path
  const p4 = approvals.request('charlie', 'shell_exec', 'orphan2', 'low');
  const id4 = approvals.pending()[0].id;
  approvals.pendingCallbacks.delete(id4);
  const retOD = approvals.deny(id4, 'tg:test', 'why');
  check('orphan deny does not throw',
    retOD?.alreadyResolved === false);
  const row4 = approvals._data.items.find(i => i.id === id4);
  check('orphan deny updates row to denied',
    row4 && row4.status === 'denied' && row4.reason === 'why');

  // ── 7. deny() on nonexistent throws
  let threwD = false, msgD = '';
  try { approvals.deny(99999, 'tg:test', 'x'); }
  catch (e) { threwD = true; msgD = e.message; }
  check('deny on nonexistent throws "not found"',
    threwD && msgD === 'not found');
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    rmSync(dir, { recursive: true, force: true });
    if (failed > 0) process.exit(1);
  })
  .catch((err) => {
    console.error('unexpected:', err);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  });
