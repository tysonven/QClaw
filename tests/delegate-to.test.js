/**
 * delegate_to tool contract tests, post-retirement (2026-08-14).
 * Run: node tests/delegate-to.test.js
 *
 * The specialist-spawning layer is retired: there is no live path, no allowlist
 * read, no Supabase client and no INSERT in the tool. Every call routes back.
 * These tests pin that contract, including the negative guarantees that matter
 * most (no false-success shape can be produced, and no DB write can occur).
 */

import { createDelegateToTool } from '../src/tools/delegate-to.js';

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };
async function throwsAsync(fn) { try { await fn(); return null; } catch (e) { return e; } }

// ── fakes ──
// Deliberately includes ids that USED to take the live path (status 'live'), to
// prove status/allowlist no longer influences the outcome.
const SPECS = {
  'build-specialist':        { id: 'build-specialist',        isLive: false, isStub: true,  status: 'scaffolded' },
  'content-studio-operator': { id: 'content-studio-operator', isLive: true,  isStub: false, status: 'live' },
  'community-manager-fsc':   { id: 'community-manager-fsc',   isLive: true,  isStub: false, status: 'live' },
  'qa-operator':             { id: 'qa-operator',             isLive: true,  isStub: false, status: 'live' },
};
const fakeGet = (name) => SPECS[String(name).toLowerCase()] || null;

const baseOpts = () => ({
  audit: null, env: {}, getSpecialist: fakeGet, randomUUID: () => 'uuid-fixed',
});

const EXPECTED_KEYS = JSON.stringify(['routed_back', 'specialist', 'status', 'stub_result', 'task_id']);

console.log('every call routes back (no live path exists):');
{
  const tool = createDelegateToTool(baseOpts());
  const r = await tool.fn({ specialist: 'build-specialist', task: 'check the thing' }, { channel: 'telegram', userId: 42 });
  check('routed_back true', r.routed_back === true);
  check('status stub_routed_back', r.status === 'stub_routed_back');
  check('task_id present', r.task_id === 'uuid-fixed');
  check('specialist is the id', r.specialist === 'build-specialist');
  check('top-level keys unchanged from pre-retirement shape', JSON.stringify(Object.keys(r).sort()) === EXPECTED_KEYS);
  check('inner status marks retirement', r.stub_result.status === 'retired');
  check('inner task carried', r.stub_result.task === 'check the thing');
  check('message tells Charlie to handle it', /Handle this yourself/.test(r.stub_result.message));
  check('message forbids a delegation claim', /Do NOT say this was delegated/.test(r.stub_result.message));
}

console.log('formerly-live specialists ALSO route back (the false-success path is gone):');
for (const id of ['content-studio-operator', 'community-manager-fsc', 'qa-operator']) {
  const tool = createDelegateToTool(baseOpts());
  const r = await tool.fn({ specialist: id, task: 't' }, { channel: 'telegram', userId: 1 });
  check(`${id} routes back`, r.routed_back === true && r.status === 'stub_routed_back');
  check(`${id} never returns queued`, r.status !== 'queued');
  check(`${id} has no task/queue id leak`, JSON.stringify(Object.keys(r).sort()) === EXPECTED_KEYS);
}

console.log('no false-success shape is reachable for ANY registered specialist:');
{
  // fresh tool per call: the rate limiter is per-factory and would otherwise trip
  for (const id of Object.keys(SPECS)) {
    const tool = createDelegateToTool(baseOpts());
    const r = await tool.fn({ specialist: id, task: 't' }, {});
    if (r.status === 'queued' || r.routed_back === false || r.error === 'sequential_only') {
      check(`${id} produced a non-routed-back outcome`, false, JSON.stringify(r));
    }
  }
  check('all registered specialists route back', true);
}

console.log('the tool holds no Supabase/allowlist surface at all:');
{
  const src = await (await import('node:fs/promises')).readFile(new URL('../src/tools/delegate-to.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function createDelegateToTool'));
  check('no SUPABASE_URL reference in code body', !/SUPABASE_URL/.test(body));
  check('no SERVICE_ROLE key reference in code body', !/SERVICE_ROLE/.test(body));
  check('no specialist_dispatches table write in code body', !/specialist_dispatches/.test(body));
  check('no QCLAW_SPECIALIST_LIVE_IDS read in code body', !/QCLAW_SPECIALIST_LIVE_IDS/.test(body));
  check('no fetch/insert call in code body', !/\bfetch\(/.test(body) && !/\.insert\(/.test(body));
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

console.log('description warns the model off delegation claims:');
{
  const tool = createDelegateToTool(baseOpts());
  check('description marked RETIRED', /RETIRED/.test(tool.description));
  check('description forbids "has the task" claims', /NEVER tell the user a specialist/.test(tool.description));
  check('description points at skills + claude_code_dispatch', /skill/.test(tool.description) && /claude_code_dispatch/.test(tool.description));
}

console.log('rate limit (loop guard) still throws:');
{
  let t = 1_000_000;
  const tool = createDelegateToTool({ ...baseOpts(), now: () => t, rateLimit: { perMinute: 2, perHour: 20 } });
  await tool.fn({ specialist: 'build-specialist', task: 'a' }, {});
  await tool.fn({ specialist: 'build-specialist', task: 'b' }, {});
  const e = await throwsAsync(() => tool.fn({ specialist: 'build-specialist', task: 'c' }, {}));
  check('3rd call within a minute throws', !!e && /rate limit/.test(e.message), e?.message);
  t += 61_000;
  const r = await tool.fn({ specialist: 'build-specialist', task: 'd' }, {});
  check('recovers after the window', r.routed_back === true);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
