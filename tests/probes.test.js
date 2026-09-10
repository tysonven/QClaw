/**
 * Probe contract + timeout tests.
 *
 * Run: node tests/probes.test.js
 *
 * Each probe is exercised against the live infrastructure that QClaw
 * already depends on (n8n /healthz, Supabase /auth/v1/health, Cognee
 * /health, pm2 jlist, the Supabase SUPABASE_ANON_KEY). When upstream is
 * unavailable, the probe MUST surface ok=false with an error message
 * — never throw — so the bootstrap caller can keep going.
 *
 * Tests assert the result-shape contract is honoured (name, ok flag,
 * latency_ms, optional error / detail) regardless of pass/fail outcome.
 */

import { probe as probeN8n } from '../src/agents/probes/n8n.js';
import { probe as probeHeartbeat } from '../src/agents/probes/heartbeat-freshness.js';
import { probe as probePm2, parsePm2Output, evaluate as evaluatePm2 } from '../src/agents/probes/pm2.js';
import { probe as probeSupabase } from '../src/agents/probes/supabase.js';
import { probe as probeMemory } from '../src/agents/probes/memory-layer.js';

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

function assertShape(name, r) {
  check(`${name}: result.name correct`, r?.name === name);
  check(`${name}: ok is boolean`, typeof r?.ok === 'boolean');
  check(`${name}: latency_ms is finite number`,
    Number.isFinite(r?.latency_ms) && r.latency_ms >= 0);
  // Failure must carry an error string.
  if (r && r.ok === false) {
    check(`${name}: failure carries error string`, typeof r.error === 'string' && r.error.length > 0);
  }
  // Latency under 6s as a sanity check (per-probe Promise.race in bootstrap.js
  // caps at 5s; probes themselves should self-terminate inside that.)
  check(`${name}: latency_ms < 6000`, r?.latency_ms < 6000, `got ${r?.latency_ms}`);
}

async function main() {
  // ─── n8n
  const r1 = await probeN8n();
  assertShape('n8n_reachable', r1);

  // ─── heartbeat freshness (may be ok or fail-with-RLS-message; both valid)
  const r2 = await probeHeartbeat();
  assertShape('heartbeat_freshness', r2);

  // ─── pm2
  const r3 = await probePm2();
  assertShape('pm2_processes', r3);
  if (r3.ok) {
    check('pm2: detail.expected has 6 entries',
      Array.isArray(r3.detail?.expected) && r3.detail.expected.length === 6);
  }

  // ─── pm2 parse helper: tolerates leading non-JSON lines (regression for
  //     2026-05-06T12:10:19Z ghost fire — pm2 jlist occasionally prepends
  //     a Node deprecation warning before the JSON array).
  const withWarningHeader =
    '(node:12345) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. ' +
    'Please use a userland alternative instead.\n' +
    '(Use `node --trace-deprecation ...` to show where the warning was created)\n' +
    '[{"pid":2498133,"name":"agex-hub","pm2_env":{"status":"online"}}]';
  let parsedWithHeader;
  try { parsedWithHeader = parsePm2Output(withWarningHeader); } catch (e) { parsedWithHeader = e; }
  check('pm2 parse: deprecation-warning header is stripped',
    Array.isArray(parsedWithHeader) && parsedWithHeader[0]?.name === 'agex-hub');

  // ─── pm2 parse helper: empty / no-JSON-line input falls back to []
  let parsedEmpty;
  try { parsedEmpty = parsePm2Output(''); } catch (e) { parsedEmpty = e; }
  check('pm2 parse: empty input → []', Array.isArray(parsedEmpty) && parsedEmpty.length === 0);

  // ─── pm2 parse helper: clean JSON still parses
  let parsedClean;
  try { parsedClean = parsePm2Output('[{"name":"x","pm2_env":{"status":"online"}}]'); } catch (e) { parsedClean = e; }
  check('pm2 parse: clean JSON parses', Array.isArray(parsedClean) && parsedClean[0]?.name === 'x');

  // ─── pm2 evaluate: the branch neither environment reaches
  //
  // The probe's clean-parse return is only taken when pm2 is INSTALLED. CI has
  // no pm2, so execSync throws and the catch path runs; that path always set an
  // error and always passed. A developer machine has pm2 but none of the six
  // processes, which does reach this branch, which is why the suite disagreed
  // with CI. Neither environment ran the branch under test, so it is driven
  // directly here and the fixtures are the same in both.
  const ALL = [
    'agex-hub', 'quantumclaw', 'trading-worker',
    'trade-engine', 'clipper-worker', 'claude-code-dispatcher',
  ];
  const rows = (over = {}) => ALL.map((name) => ({
    name, pid: 1, pm2_env: { status: over[name] || 'online', pm_uptime: Date.now() - 1000, restart_time: 0 },
  })).filter((p) => over[p.name] !== '__absent__');

  const healthy = evaluatePm2(rows(), 12);
  check('pm2 evaluate: all six online -> ok:true', healthy.ok === true, JSON.stringify(healthy.detail?.offline));
  check('pm2 evaluate: a healthy result carries no error key',
    !('error' in healthy), JSON.stringify(healthy.error));

  // One process stopped. This is the state the probe exists to report, and
  // the state in which it previously returned ok:false with error undefined.
  const stopped = evaluatePm2(rows({ 'clipper-worker': 'stopped' }), 12);
  check('pm2 evaluate: one stopped -> ok:false', stopped.ok === false);
  check('pm2 evaluate: one stopped carries an error string',
    typeof stopped.error === 'string' && stopped.error.length > 0, JSON.stringify(stopped.error));
  check('pm2 evaluate: the error NAMES the stopped process',
    (stopped.error || '').includes('clipper-worker'), stopped.error);
  check('pm2 evaluate: the error names its status, not just the process',
    (stopped.error || '').includes('stopped'), stopped.error);

  // A process absent from jlist entirely is a different fault and must also
  // be named. Pinned separately because `missing` and `offline` are separate
  // lists and an error built from only one of them would pass the test above.
  const gone = evaluatePm2(rows({ 'trade-engine': '__absent__' }), 12);
  check('pm2 evaluate: a missing process -> ok:false with an error',
    gone.ok === false && typeof gone.error === 'string' && gone.error.length > 0);
  check('pm2 evaluate: the error NAMES the missing process',
    (gone.error || '').includes('trade-engine'), gone.error);

  // Both fault kinds at once, so a fix that handled only the first is caught.
  const both = evaluatePm2(rows({ 'clipper-worker': 'stopped', 'agex-hub': '__absent__' }), 12);
  check('pm2 evaluate: stopped AND missing are both named',
    (both.error || '').includes('clipper-worker') && (both.error || '').includes('agex-hub'), both.error);

  // The consumer in bootstrap.js renders `p.error || 'no detail'`. Pin what it
  // now produces, because "no detail" at the moment a process is down was the
  // whole defect and it lived in the rendering, not only in the probe.
  check('pm2 evaluate: bootstrap would no longer render "no detail"',
    `probe ${stopped.name} failed: ${stopped.error || 'no detail'}`.includes('clipper-worker=stopped'),
    `probe ${stopped.name} failed: ${stopped.error || 'no detail'}`);

  // detail must survive the refactor: it is what the dashboard reads.
  check('pm2 evaluate: detail still carries the structured lists',
    Array.isArray(stopped.detail?.offline) && stopped.detail.offline.includes('clipper-worker=stopped')
      && Array.isArray(gone.detail?.missing) && gone.detail.missing.includes('trade-engine'));

  // ─── supabase
  const r4 = await probeSupabase();
  assertShape('supabase_reachable', r4);

  // ─── memory layer
  const r5 = await probeMemory({ cogneeUrl: 'http://localhost:8000' });
  assertShape('memory_layer', r5);

  // ─── A clearly-broken target must still produce an ok=false result, never throw.
  const broken = await probeMemory({ cogneeUrl: 'http://127.0.0.1:1' });
  check('memory_layer: broken target → ok=false', broken.ok === false);
  check('memory_layer: broken target → error present', typeof broken.error === 'string' && broken.error.length > 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
