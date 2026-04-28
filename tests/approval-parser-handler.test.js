/**
 * Inline approval-reply parser + handler input matrix.
 * Drives handleApprovalReply against a faked grammY ctx and a real
 * ExecApprovals on the JSON-fallback path.
 *
 * Run: node tests/approval-parser-handler.test.js
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPROVAL_REPLY_RE,
  handleApprovalReply,
} from '../src/channels/manager.js';
import { ExecApprovals } from '../src/security/approvals.js';

const dir = mkdtempSync(join(tmpdir(), 'qclaw-parser-'));
let passed = 0;
let failed = 0;

function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// Build a fake ctx that mirrors the slice of grammY's Context the handler reads.
function fakeCtx(text, userId = 1375806243, username = 'tysonven') {
  const m = text.match(APPROVAL_REPLY_RE);
  const replies = [];
  return {
    message: { text },
    from: { id: userId, username },
    match: m,
    matched: !!m,
    reply: async (s) => { replies.push(s); },
    _replies: replies,
  };
}

// ── Section 1: regex input matrix ─────────────────────────────────────
console.log('Regex matrix:');
const regexCases = [
  // [input, expectedVerbLower, expectedId]
  ['✅ 37',         '✅', '37'],
  ['✅37',          '✅', '37'],
  ['✅ 37 thanks',  '✅', '37'],
  [' ✅ 37 ',       null, null],   // leading whitespace not allowed by ^
  ['✅ 37',    '✅', '37'],   // NBSP between emoji and id
  ['✅ 37\n',       '✅', '37'],
  ['✅ #37',        '✅', '37'],   // optional # before id
  ['❌ 37',         '❌', '37'],
  ['❌37',          '❌', '37'],
  ['approve 37',    'approve', '37'],
  ['APPROVE 37',    'approve', '37'],   // case-insensitive
  ['deny 37',       'deny', '37'],
  ['yes 37',        'yes', '37'],
  ['no 37',         'no', '37'],
  ['hello ✅ 37',   null, null],   // mid-message rejected
  ['✅',            null, null],   // emoji with no id
  ['✅ abc',        null, null],   // non-numeric id
  ['/approve 37',   null, null],   // slash command not matched here
];

for (const [input, expectedVerb, expectedId] of regexCases) {
  const m = input.match(APPROVAL_REPLY_RE);
  if (expectedId === null) {
    check(`reject ${JSON.stringify(input)}`, !m);
  } else {
    const verbLower = m && m[1].toLowerCase();
    const id = m && m[2];
    check(
      `match ${JSON.stringify(input)} → verb=${verbLower}, id=${id}`,
      m && verbLower === expectedVerb && id === expectedId,
      `got ${JSON.stringify(m && [verbLower, id])}`,
    );
  }
}

// ── Section 2: handler behaviour against a real ExecApprovals ─────────
console.log('\nHandler behaviour:');

const approvals = new ExecApprovals({ _dir: dir });
approvals.attach(null);

const ALLOWED = [1375806243];
const NOT_ALLOWED = [1375806243];   // doesn't include the rogue id below

async function run() {
  // 2a. happy-path approve — pending row, allowed user, ✅ <id>
  const p1 = approvals.request('charlie', 'shell_exec', 'whoami', 'low');
  const id1 = approvals.pending()[0].id;
  const ctx1 = fakeCtx(`✅ ${id1}`);
  await handleApprovalReply(ctx1, { allowedUsers: ALLOWED, approvals });
  check('approve: ctx.reply was called with success message',
    ctx1._replies.length === 1 && ctx1._replies[0] === `✅ Approved [${id1}].`);
  const r1 = await p1;
  check('approve: original Promise resolved approved:true',
    r1.approved === true && r1.id === id1);

  // 2b. approve again — already-resolved branch
  const ctx1b = fakeCtx(`✅ ${id1}`);
  await handleApprovalReply(ctx1b, { allowedUsers: ALLOWED, approvals });
  check('approve again: warns "already approved"',
    ctx1b._replies[0] === `⚠️ Approval [${id1}] was already approved.`);

  // 2c. happy-path deny — pending row, allowed user, ❌ <id> with reason tail
  const p2 = approvals.request('charlie', 'shell_exec', 'rm -rf', 'high');
  const id2 = approvals.pending()[0].id;
  const ctx2 = fakeCtx(`❌ ${id2} too risky`);
  await handleApprovalReply(ctx2, { allowedUsers: ALLOWED, approvals });
  check('deny: ctx.reply with denied message',
    ctx2._replies[0] === `❌ Denied [${id2}].`);
  const r2 = await p2;
  check('deny: Promise resolved approved:false with tail as reason',
    r2.approved === false && r2.reason === 'too risky');

  // 2d. deny without tail — falls back to default reason
  const p3 = approvals.request('charlie', 'shell_exec', 'foo', 'low');
  const id3 = approvals.pending()[0].id;
  const ctx3 = fakeCtx(`❌ ${id3}`);
  await handleApprovalReply(ctx3, { allowedUsers: ALLOWED, approvals });
  const r3 = await p3;
  check('deny without tail: default reason "denied by owner"',
    r3.reason === 'denied by owner');

  // 2e. unauthorized user — silent ignore (no reply, no DB change)
  const p4 = approvals.request('charlie', 'shell_exec', 'bar', 'low');
  const id4 = approvals.pending()[0].id;
  const ctx4 = fakeCtx(`✅ ${id4}`, /* userId */ 99999, 'rando');
  await handleApprovalReply(ctx4, { allowedUsers: ALLOWED, approvals });
  check('unauthorized user: no reply emitted',
    ctx4._replies.length === 0);
  check('unauthorized user: row still pending',
    approvals.pending().some((p) => p.id === id4));

  // 2f. nonexistent id — friendly NOT_FOUND reply, not an Error stack
  const ctx5 = fakeCtx('✅ 99999');
  await handleApprovalReply(ctx5, { allowedUsers: ALLOWED, approvals });
  check('nonexistent id: replies "No pending approval with ID …"',
    ctx5._replies[0] === 'No pending approval with ID 99999.');

  // 2g. reflex aliases route correctly
  const p5 = approvals.request('charlie', 'shell_exec', 'baz', 'low');
  const id5 = approvals.pending()[0].id;
  const ctx6 = fakeCtx(`yes ${id5}`);
  await handleApprovalReply(ctx6, { allowedUsers: ALLOWED, approvals });
  check('verb "yes" approves',
    ctx6._replies[0] === `✅ Approved [${id5}].`);
  await p5;

  const p6 = approvals.request('charlie', 'shell_exec', 'qux', 'low');
  const id6 = approvals.pending()[0].id;
  const ctx7 = fakeCtx(`no ${id6}`);
  await handleApprovalReply(ctx7, { allowedUsers: ALLOWED, approvals });
  check('verb "no" denies',
    ctx7._replies[0] === `❌ Denied [${id6}].`);
  await p6;
}

run()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    rmSync(dir, { recursive: true, force: true });
    // Each request() arms a 10-min setTimeout that keeps the event loop
    // alive. Exit explicitly so the test process terminates promptly.
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('unexpected:', err);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  });
