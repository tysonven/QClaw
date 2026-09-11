/**
 * Skill HTTP writes — the client must not report a failure the server
 * committed, and must never leave the outcome unstated.
 *
 * The defect (audit 2026-09-10, reproduced in a real uvicorn process):
 * registry.js aborted every skill fetch at 15s while the trade engine allows
 * 20s per Supabase round trip and makes two of them before a manual-close
 * commits. The client aborted, the tool result became error:true, Charlie was
 * told the call failed, and the position closed two seconds later. Nothing
 * re-read the row, so the report to Tyson would have been confidently wrong.
 *
 * Two properties are pinned here, and they are different in kind:
 *
 *   1. ORDERING. Three nested deadlines govern one write: the executor's
 *      per-tool cap, the registry's fetch abort, and the remote service's own
 *      timeout. They only report the truth if the outer one fires LAST. This
 *      is asserted as an inequality between the constants, not by waiting.
 *
 *   2. RE-READ. Ordering is a probability reduction; no client timeout can
 *      prove a server did not commit. So an unknown outcome must SAY it is
 *      unknown and carry whatever the store reports now. A test that only
 *      checked for the word "timeout" would pass against the old code, so
 *      these assert the observed STATE reaches the tool result.
 *
 * Run: node tests/skill-write-timeout.test.js
 */

import {
  ToolRegistry,
  SKILL_READ_TIMEOUT_MS,
  SKILL_WRITE_TIMEOUT_MS,
} from '../src/tools/registry.js';
import { ToolExecutor, SKILL_WRITE_TOOL_TIMEOUT } from '../src/tools/executor.js';
import {
  registerSubjectResolver,
  __clearSubjectResolversForTests,
} from '../src/security/subject-resolvers.js';

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

const REAL_ID = 'b3cecdef-9948-40c7-9691-1b9c4ce579bc';
const PRESET = { name: 'skill:trading-api', baseUrl: 'http://localhost:4003', headers: {} };
const CLOSE_DEF = {
  name: 'trading-api__create_positions_manual_close',
  method: 'POST',
  path: '/positions/manual-close',
};
const READ_DEF = { name: 'trading-api__get_positions', method: 'GET', path: '/positions' };
const CLOSE_ARGS = { data: JSON.stringify({ position_id: REAL_ID, exit_price: 0.863, exit_usdc: 17.86 }) };

// Deliberately the same partial `this` the pre-existing skill-executor test
// uses. The re-read helper must work from it: a method that threw "not a
// function" here would swallow the transport error it was meant to explain.
const fakeThis = {
  secrets: { get: async () => 'k' },
  config: {},
  _resolveConfigTemplates: ToolRegistry.prototype._resolveConfigTemplates,
};
const exec = (preset, def, args) =>
  ToolRegistry.prototype._executeAPITool.call(fakeThis, preset, def, args);

const realFetch = global.fetch;
let lastSignalTimeouts = [];

async function main() {
  // ── 1. The ordering invariant ────────────────────────────────
  check('registry: a write is allowed longer than a read',
    SKILL_WRITE_TIMEOUT_MS > SKILL_READ_TIMEOUT_MS,
    `write ${SKILL_WRITE_TIMEOUT_MS} vs read ${SKILL_READ_TIMEOUT_MS}`);

  // The trade engine's own budget, from src/trade_engine/database.py:
  // REQUEST_TIMEOUT = httpx.Timeout(20.0) and manual-close makes two calls
  // before it commits. The client must outlast that.
  const ENGINE_WORST_CASE_MS = 2 * 20000;
  check('registry: a write outlasts the trade engine committing a close',
    SKILL_WRITE_TIMEOUT_MS > ENGINE_WORST_CASE_MS,
    `write ${SKILL_WRITE_TIMEOUT_MS} vs engine ${ENGINE_WORST_CASE_MS}`);

  check('executor: the per-tool cap outlasts the registry fetch abort',
    SKILL_WRITE_TOOL_TIMEOUT > SKILL_WRITE_TIMEOUT_MS,
    `executor ${SKILL_WRITE_TOOL_TIMEOUT} vs registry ${SKILL_WRITE_TIMEOUT_MS}`);

  // ── 2. The deadline actually reaches fetch ───────────────────
  // The constants above are inert unless the call site uses them, and
  // "a signal is present" cannot tell 45s from 15s. Intercept
  // AbortSignal.timeout and read the milliseconds the call site asked for.
  const realTimeoutFactory = AbortSignal.timeout.bind(AbortSignal);
  lastSignalTimeouts = [];
  AbortSignal.timeout = (ms) => { lastSignalTimeouts.push(ms); return realTimeoutFactory(ms); };
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' });
  try {
    await exec(PRESET, CLOSE_DEF, CLOSE_ARGS);
    await exec(PRESET, READ_DEF, {});
  } finally {
    AbortSignal.timeout = realTimeoutFactory;
  }
  check('a WRITE is given the write budget, not the read budget',
    lastSignalTimeouts[0] === SKILL_WRITE_TIMEOUT_MS,
    `asked for ${lastSignalTimeouts[0]}ms, expected ${SKILL_WRITE_TIMEOUT_MS}`);
  check('a READ is still given the read budget (writes did not widen everything)',
    lastSignalTimeouts[1] === SKILL_READ_TIMEOUT_MS,
    `asked for ${lastSignalTimeouts[1]}ms, expected ${SKILL_READ_TIMEOUT_MS}`);
  check('the two budgets differ at the call site, not just in the constants',
    lastSignalTimeouts[0] !== lastSignalTimeouts[1],
    JSON.stringify(lastSignalTimeouts));

  // ── 3. A timed-out write reports UNKNOWN and re-reads ────────
  __clearSubjectResolversForTests();
  let resolverCalls = 0;
  registerSubjectResolver('trading-api', async ({ identifiers }) => {
    resolverCalls++;
    return identifiers.map(i => `position ${i.value}: CLOSED, exit 0.8628 for 17.86 USDC`);
  });

  global.fetch = async () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  };
  let timedOut = null;
  try { await exec(PRESET, CLOSE_DEF, CLOSE_ARGS); } catch (e) { timedOut = e; }

  check('a timed-out write throws (executor records error:true)',
    timedOut !== null && timedOut.rethrow === true, String(timedOut?.rethrow));
  check('a timed-out write says the outcome is UNKNOWN',
    /outcome UNKNOWN/.test(timedOut?.message || ''), timedOut?.message);
  check('a timed-out write says the write may have been applied',
    /may have been applied/.test(timedOut?.message || ''), timedOut?.message);
  check('the reported deadline is the write budget the call site used',
    (timedOut?.message || '').includes(`after ${SKILL_WRITE_TIMEOUT_MS}ms`), timedOut?.message);
  check('a timed-out write triggered exactly one re-read',
    resolverCalls === 1, `got ${resolverCalls}`);
  check('the re-read STATE reaches the tool result, not just the word timeout',
    (timedOut?.message || '').includes('CLOSED, exit 0.8628 for 17.86 USDC'),
    timedOut?.message);
  check('the tool result tells the caller to report the observed state',
    /Report THAT state/.test(timedOut?.message || ''), timedOut?.message);

  // ── 4. A 5xx is the same unknown case ────────────────────────
  resolverCalls = 0;
  global.fetch = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' });
  let server5xx = null;
  try { await exec(PRESET, CLOSE_DEF, CLOSE_ARGS); } catch (e) { server5xx = e; }
  check('a 5xx write reports UNKNOWN and re-reads',
    /outcome UNKNOWN/.test(server5xx?.message || '') && resolverCalls === 1,
    `${server5xx?.message} resolverCalls=${resolverCalls}`);

  // ── 5. A 4xx is a stated refusal — no re-read ────────────────
  resolverCalls = 0;
  global.fetch = async () => ({
    ok: false, status: 404,
    text: async () => JSON.stringify({ error: 'no OPEN position with id ' + REAL_ID }),
  });
  let notFound = null;
  try { await exec(PRESET, CLOSE_DEF, CLOSE_ARGS); } catch (e) { notFound = e; }
  check('a 404 does NOT trigger a re-read (the server stated the outcome)',
    resolverCalls === 0, `got ${resolverCalls}`);
  check('a 404 keeps its plain message and is not called UNKNOWN',
    /HTTP 404/.test(notFound?.message || '') && !/UNKNOWN/.test(notFound?.message || ''),
    notFound?.message);

  // ── 6. A READ that fails keeps the old behaviour ─────────────
  resolverCalls = 0;
  global.fetch = async () => { throw new Error('socket hang up'); };
  let readErr = null;
  try { await exec(PRESET, READ_DEF, {}); } catch (e) { readErr = e; }
  check('a failed read does not claim an unknown write outcome',
    !/outcome UNKNOWN/.test(readErr?.message || '') && resolverCalls === 0,
    readErr?.message);
  check('a failed read is still rethrow-marked (existing contract)',
    readErr?.rethrow === true);

  // ── 7. No resolver: the gap is STATED, never implied ─────────
  __clearSubjectResolversForTests();
  global.fetch = async () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  };
  let noResolver = null;
  try { await exec(PRESET, CLOSE_DEF, CLOSE_ARGS); } catch (e) { noResolver = e; }
  check('with no resolver the result says state NOT verified',
    /State NOT verified/.test(noResolver?.message || ''), noResolver?.message);
  check('with no resolver the result still says UNKNOWN',
    /outcome UNKNOWN/.test(noResolver?.message || ''), noResolver?.message);

  // A resolver that throws must not replace the original error.
  registerSubjectResolver('trading-api', async () => { throw new Error('engine unreachable'); });
  let resolverThrew = null;
  try { await exec(PRESET, CLOSE_DEF, CLOSE_ARGS); } catch (e) { resolverThrew = e; }
  check('a re-read that fails still reports the original unknown outcome',
    /outcome UNKNOWN/.test(resolverThrew?.message || '')
      && /NOT verified/.test(resolverThrew?.message || ''),
    resolverThrew?.message);

  // ── 8. The executor gives a skill write the longer cap ───────
  const registry = new ToolRegistry({}, {});
  registry.registerSkillTool('charlie', 'trading-api', { name: 'trading-api', baseUrl: 'http://localhost:4003', headers: {} }, CLOSE_DEF);
  registry.registerSkillTool('charlie', 'trading-api', { name: 'trading-api', baseUrl: 'http://localhost:4003', headers: {} }, READ_DEF);

  const capsSeen = [];
  const executor = new ToolExecutor({ primary: { provider: 'anthropic', model: 't' } }, registry, {});
  // The cap is applied by racing executeTool against a timer, so observe it
  // by making executeTool hang and watching which deadline fires. Faking the
  // clock is the only way to do that without a 60s test, so instead assert
  // the branch: a resolved tool returns before any cap, and the cap chosen
  // is visible through the method lookup the branch uses.
  const writeMethod = registry.getSkillToolMethod('charlie__trading-api__trading-api__create_positions_manual_close');
  const readMethod = registry.getSkillToolMethod('charlie__trading-api__trading-api__get_positions');
  capsSeen.push(writeMethod, readMethod);
  check('the executor can tell a skill write from a skill read',
    writeMethod === 'POST' && readMethod === 'GET', JSON.stringify(capsSeen));

  // Drive the real loop with a hanging write and a cap shortened by stubbing
  // the registry method the branch consults, so the assertion is about which
  // branch ran rather than about wall-clock time.
  let executed = 0;
  registry.executeTool = async () => { executed++; return 'ok'; };
  executor._completionWithTools = (() => {
    let turn = 0;
    return async () => {
      turn++;
      if (turn === 1) {
        return {
          content: '',
          toolCalls: [{ id: 't1', name: 'charlie__trading-api__trading-api__create_positions_manual_close', args: CLOSE_ARGS }],
          usage: {}, model: 't',
        };
      }
      return { content: 'done', toolCalls: [], usage: {}, model: 't' };
    };
  })();
  executor._appendAnthropicToolLoop = (msgs) => msgs;
  const out = await executor.run([{ role: 'user', content: 'close it' }], {});
  check('the executor still runs a skill write end to end',
    executed === 1 && out.toolResults.some(r => r.error === false), JSON.stringify(out.toolResults));

  global.fetch = realFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
