/**
 * Phase 5 Session 1 — CC write-scope + structured approval gate.
 * Run: node tests/cc-write-scope.test.js
 *
 * Tool side (createClaudeCodeDispatchTool): scope tiers, awaiting_authorisation
 * write, Telegram push, critical hard-block, audit/read_only unchanged.
 * Channel side (handleCcAuthReply): ✅/❌ lifecycle, clean errors, authz.
 */

import { createClaudeCodeDispatchTool } from '../src/tools/claude-code-dispatch.js';
import { handleCcAuthReply, CC_AUTH_REPLY_RE } from '../src/channels/manager.js';

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };
const ROW_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';

// Fake Supabase REST client for the tool: records POSTs, GET (enqueue-cap) → [].
function fakeRest() {
  const calls = [];
  const client = async (method, path, opts = {}) => {
    calls.push({ method, path, body: opts.body });
    if (method === 'GET') return [];                       // no active dispatches ahead
    if (method === 'POST') return [{ id: ROW_ID, created_at: '2026-07-01T00:00:00Z', status: opts.body.status }];
    return null;
  };
  return { client, calls, posts: () => calls.filter(c => c.method === 'POST') };
}
const toolCtx = { channel: 'telegram', userId: 1375806243 };

console.log('CC_AUTH_REPLY_RE — matches ✅/❌ + 8 hex only:');
check('matches "✅ 95181ea7"', CC_AUTH_REPLY_RE.test('✅ 95181ea7'));
check('matches "❌ aaaa1111"', CC_AUTH_REPLY_RE.test('❌ aaaa1111'));
check('does NOT match "✅ 37" (numeric approval id)', !CC_AUTH_REPLY_RE.test('✅ 37'));
check('does NOT match a 9-hex run (boundary)', !CC_AUTH_REPLY_RE.test('✅ 95181ea7f'));

console.log('write scope → awaiting_authorisation row + authorisation_required:true + Telegram push:');
{
  const { client, posts } = fakeRest();
  let pushed = null;
  const tool = createClaudeCodeDispatchTool({ env: {}, restClient: client, notify: async (t) => { pushed = t; return true; } });
  const out = JSON.parse(await tool.fn({ task: 'Bump the rate limit', mode: 'audit_then_implement', scope: 'write', fix: 'Raise API rate cap', risk: 'high', action: 'Edit config + redeploy' }, toolCtx));
  const body = posts()[0]?.body;
  check('one row inserted', posts().length === 1);
  check('row status = awaiting_authorisation', body?.status === 'awaiting_authorisation', JSON.stringify(body));
  check('row authorisation_required = true', body?.authorisation_required === true);
  check('returns status awaiting_authorisation', out.status === 'awaiting_authorisation');
  check('return does NOT claim queued/approved', out.authorisation_required === true && out.approval_pushed === true);
  check('Telegram push sent (approval message shape)',
    pushed && pushed.includes('Write-scope dispatch') && pushed.includes('Scope: write')
      && pushed.includes('Risk: high') && pushed.includes(`Task ID: ${ROW_ID.slice(0, 8)}`)
      && pushed.includes(`✅ ${ROW_ID.slice(0, 8)}`) && pushed.includes(`❌ ${ROW_ID.slice(0, 8)}`),
    JSON.stringify(pushed));
}

console.log('expected_paths renders into the brief (write-scope path guard):');
{
  const { client, posts } = fakeRest();
  const tool = createClaudeCodeDispatchTool({ env: {}, restClient: client, notify: async () => true });
  await tool.fn({ task: 'Bump rate limit', mode: 'audit_then_implement', scope: 'write', expected_paths: ['./src/dispatch/start.js', 'src/dispatch/start.js'] }, toolCtx);
  const brief = posts()[0]?.body?.brief || '';
  check('brief has an # Expected paths section', brief.includes('# Expected paths'));
  check('paths rendered as a JSON array, ./ stripped + de-duped', brief.includes('["src/dispatch/start.js"]'));
}
{
  const { client, posts } = fakeRest();
  const tool = createClaudeCodeDispatchTool({ env: {}, restClient: client, notify: async () => true });
  await tool.fn({ task: 'no paths declared', mode: 'audit_then_implement', scope: 'write' }, toolCtx);
  check('no expected_paths → no # Expected paths section in brief', !(posts()[0]?.body?.brief || '').includes('# Expected paths'));
}

console.log('infra scope also holds for approval:');
{
  const { client, posts } = fakeRest();
  const tool = createClaudeCodeDispatchTool({ env: {}, restClient: client, notify: async () => true });
  const out = JSON.parse(await tool.fn({ task: 'rotate nginx cert', mode: 'implement_with_audit_gate', scope: 'infra' }, toolCtx));
  check('infra → awaiting_authorisation', out.status === 'awaiting_authorisation' && posts()[0].body.status === 'awaiting_authorisation');
}

console.log('critical scope hard-blocks (throws, NO row written):');
{
  const { client, posts } = fakeRest();
  const tool = createClaudeCodeDispatchTool({ env: {}, restClient: client, notify: async () => true });
  let threw = false;
  try { await tool.fn({ task: 'rm stuff', mode: 'audit_only', scope: 'critical' }, toolCtx); }
  catch { threw = true; }
  check('critical throws', threw);
  check('no row inserted for critical', posts().length === 0);
}

console.log('audit/read_only unchanged (queued, no auth required, no Telegram push):');
{
  const { client, posts } = fakeRest();
  let pushed = false;
  const tool = createClaudeCodeDispatchTool({ env: {}, restClient: client, notify: async () => { pushed = true; return true; } });
  const out = JSON.parse(await tool.fn({ task: 'audit the gate', mode: 'audit_only', scope: 'audit' }, toolCtx));
  check('audit → queued', out.status === 'queued' && posts()[0].body.status === 'queued');
  check('audit → authorisation_required false', posts()[0].body.authorisation_required === false);
  check('no Telegram push for audit scope', pushed === false);
}

console.log('audit scope rejects an implement mode (read-only run):');
{
  const { client } = fakeRest();
  const tool = createClaudeCodeDispatchTool({ env: {}, restClient: client, notify: async () => true });
  let threw = false;
  try { await tool.fn({ task: 'x', mode: 'audit_then_implement', scope: 'audit' }, toolCtx); } catch { threw = true; }
  check('audit + implement mode throws', threw);
}

// ── Channel handler ──────────────────────────────────────────────────────
const OWNER = 1375806243;
function fakeCtx(text, verb, prefix, fromId = OWNER) {
  const replies = [];
  return {
    from: { id: fromId, username: 'tyson' },
    match: [text, verb, prefix],
    message: { text },
    reply: async (t) => { replies.push(t); },
    _replies: replies,
  };
}
function fakeDb() {
  const ev = { authorised: null, cancelled: null, findCalls: 0 };
  return {
    ev,
    findAwaiting: async () => { ev.findCalls++; return [{ id: ROW_ID }]; },
    authorise: async (id, at) => { ev.authorised = { id, at }; },
    cancel: async (id) => { ev.cancelled = { id }; },
  };
}

console.log('✅ <8hex> → row authorised (queued) + authorised_by/at set:');
{
  const ctx = fakeCtx('✅ aaaa1111', '✅', 'aaaa1111');
  const db = fakeDb();
  await handleCcAuthReply(ctx, { allowedUsers: [OWNER], db, now: () => '2026-07-01T12:00:00Z' });
  check('db.authorise called with row id + timestamp', db.ev.authorised?.id === ROW_ID && db.ev.authorised?.at === '2026-07-01T12:00:00Z', JSON.stringify(db.ev));
  check('owner told approved', ctx._replies.some(r => /Approved/.test(r)));
}

console.log('❌ <8hex> → row cancelled:');
{
  const ctx = fakeCtx('❌ aaaa1111', '❌', 'aaaa1111');
  const db = fakeDb();
  await handleCcAuthReply(ctx, { allowedUsers: [OWNER], db });
  check('db.cancel called with row id', db.ev.cancelled?.id === ROW_ID);
  check('owner told cancelled', ctx._replies.some(r => /Cancelled/.test(r)));
}

console.log('invalid 8-char prefix → clean error, NO Supabase query:');
{
  const ctx = fakeCtx('✅ zzzzzzzz', '✅', 'zzzzzzzz');
  const db = fakeDb();
  await handleCcAuthReply(ctx, { allowedUsers: [OWNER], db });
  check('no findAwaiting query on garbage', db.ev.findCalls === 0);
  check('clean error reply', ctx._replies.some(r => /8-character hex/.test(r)));
}

console.log('no matching awaiting row → clean not-found (no mutation):');
{
  const ctx = fakeCtx('✅ deadbeef', '✅', 'deadbeef');
  const db = { ...fakeDb(), findAwaiting: async () => [] };
  await handleCcAuthReply(ctx, { allowedUsers: [OWNER], db });
  check('told no awaiting dispatch matches', ctx._replies.some(r => /No write-scope dispatch awaiting approval/.test(r)));
}

console.log('non-owner reply is ignored (authz):');
{
  const ctx = fakeCtx('✅ aaaa1111', '✅', 'aaaa1111', 999);
  const db = fakeDb();
  await handleCcAuthReply(ctx, { allowedUsers: [OWNER], db });
  check('no db call + no reply for non-owner', db.ev.findCalls === 0 && ctx._replies.length === 0);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
