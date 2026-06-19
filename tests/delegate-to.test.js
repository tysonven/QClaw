/**
 * Slice 6b Unit 2 — delegate_to tool contract tests.
 * Run: node tests/delegate-to.test.js
 *
 * Covers: stub routes back synchronously (no Supabase), unknown/bad args throw
 * (Gate-2 safe), live specialist writes a dispatch row, U1-A allowlist gate
 * (live-status but not allowlisted → stub), sequential enforcement, rate limit,
 * server-derived session_id, exact result shape.
 */

import { createDelegateToTool } from '../src/tools/delegate-to.js';

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };
async function throwsAsync(fn) { try { await fn(); return null; } catch (e) { return e; } }

// ── fakes ──
const SPECS = {
  'build-specialist':         { id: 'build-specialist',         isLive: false, isStub: true,  status: 'scaffolded' },
  'content-studio-operator':  { id: 'content-studio-operator',  isLive: true,  isStub: false, status: 'live' },
  'qa-operator':              { id: 'qa-operator',              isLive: true,  isStub: false, status: 'live' },
};
const fakeGet = (name) => SPECS[String(name).toLowerCase()] || null;

function fakeDb({ active = [], insertImpl } = {}) {
  const inserts = [];
  return {
    inserts,
    configured: () => true,
    findActiveBySession: async () => active,
    insert: async (row) => { inserts.push(row); return insertImpl ? insertImpl(row) : { task_id: 'tid-fixed', ...row }; },
  };
}

const baseOpts = () => ({
  audit: null, env: {}, getSpecialist: fakeGet,
  liveIds: new Set(['content-studio-operator']), // U1-A: only this id is live-enabled
  randomUUID: () => 'uuid-fixed',
  supabase: fakeDb(),
});

console.log('stub path (no Supabase, synchronous routed_back):');
{
  const db = fakeDb();
  const tool = createDelegateToTool({ ...baseOpts(), supabase: db });
  const r = await tool.fn({ specialist: 'build-specialist', task: 'check the thing' }, { channel: 'telegram', userId: 42 });
  check('routed_back true', r.routed_back === true);
  check('status stub_routed_back', r.status === 'stub_routed_back');
  check('task_id present', r.task_id === 'uuid-fixed');
  check('specialist is the id', r.specialist === 'build-specialist');
  check('stub_result shape exact', JSON.stringify(r.stub_result) === JSON.stringify({
    specialist: 'build-specialist', status: 'stub', task: 'check the thing',
    routed_back: true, message: 'Specialist not yet live. Charlie will handle directly.',
  }));
  check('top-level keys exact', JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['routed_back', 'specialist', 'status', 'stub_result', 'task_id']));
  check('NO Supabase insert for a stub', db.inserts.length === 0);
}

console.log('U1-A allowlist gate (live status but NOT allowlisted → stub):');
{
  const db = fakeDb();
  // qa-operator isLive:true but not in liveIds → must route back as a stub
  const tool = createDelegateToTool({ ...baseOpts(), supabase: db });
  const r = await tool.fn({ specialist: 'qa-operator', task: 't' }, { channel: 'telegram', userId: 1 });
  check('live-status-not-allowlisted routes back', r.routed_back === true && r.status === 'stub_routed_back');
  check('no Supabase write for non-allowlisted live', db.inserts.length === 0);
}

console.log('hard failures THROW (Gate-2 safe — status=error, no false dispatch):');
{
  const tool = createDelegateToTool(baseOpts());
  const e1 = await throwsAsync(() => tool.fn({ specialist: 'nope-not-real', task: 't' }, {}));
  check('unknown specialist throws', !!e1);
  check('unknown error names the specialist + registry', /nope-not-real/.test(e1.message) && /registry/.test(e1.message), e1?.message);
  const e2 = await throwsAsync(() => tool.fn({ specialist: 'build-specialist', task: '' }, {}));
  check('missing task throws', !!e2 && /task is required/.test(e2.message));
  const e3 = await throwsAsync(() => tool.fn({ specialist: '', task: 't' }, {}));
  check('missing specialist throws', !!e3 && /specialist is required/.test(e3.message));
}

console.log('live path (allowlisted + mocked Supabase writes a row):');
{
  const db = fakeDb({ active: [] });
  const tool = createDelegateToTool({ ...baseOpts(), supabase: db });
  const r = await tool.fn({ specialist: 'content-studio-operator', task: 'process ep 12', context: 'r2 key X' }, { channel: 'telegram', userId: 99 });
  check('queued (not routed back)', r.status === 'queued' && r.routed_back === false);
  check('task_id from inserted row', r.task_id === 'tid-fixed');
  check('result keys exact', JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['routed_back', 'specialist', 'status', 'task_id']));
  check('one Supabase insert', db.inserts.length === 1);
  check('row.specialist_id is the id', db.inserts[0].specialist_id === 'content-studio-operator');
  check('row.status queued', db.inserts[0].status === 'queued');
  check('row.session_id is server-derived (channel:userId)', db.inserts[0].session_id === 'telegram:99');
  check('row.context carried', db.inserts[0].context === 'r2 key X');
  check('row.created_by is auditActor', db.inserts[0].created_by === 'charlie');
}

console.log('session_id cannot be spoofed via args:');
{
  const db = fakeDb({ active: [] });
  const tool = createDelegateToTool({ ...baseOpts(), supabase: db });
  await tool.fn({ specialist: 'content-studio-operator', task: 't', session_id: 'telegram:1' /* spoof attempt */ }, { channel: 'dashboard', userId: 7 });
  check('session_id from ctx, ignores args', db.inserts[0].session_id === 'dashboard:7');
}

console.log('sequential enforcement (in_progress row this session → sequential_only):');
{
  const db = fakeDb({ active: [{ id: 'already-running' }] });
  const tool = createDelegateToTool({ ...baseOpts(), supabase: db });
  const r = await tool.fn({ specialist: 'content-studio-operator', task: 't' }, { channel: 'telegram', userId: 5 });
  check('returns sequential_only', r.error === 'sequential_only');
  check('sequential message present', /One specialist dispatch per turn/.test(r.message));
  check('no insert when sequential-blocked', db.inserts.length === 0);
}

console.log('rate limit (perMinute) throws:');
{
  let t = 1_000_000;
  const tool = createDelegateToTool({ ...baseOpts(), now: () => t, rateLimit: { perMinute: 2, perHour: 20 } });
  await tool.fn({ specialist: 'build-specialist', task: 'a' }, {});
  await tool.fn({ specialist: 'build-specialist', task: 'b' }, {});
  const e = await throwsAsync(() => tool.fn({ specialist: 'build-specialist', task: 'c' }, {}));
  check('3rd call within a minute throws', !!e && /rate limit/.test(e.message), e?.message);
  // after a minute it recovers
  t += 61_000;
  const r = await tool.fn({ specialist: 'build-specialist', task: 'd' }, {});
  check('recovers after the window', r.routed_back === true);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
