/**
 * Slice 5 U6 — claude-code-dispatcher pure helpers (no CC, no host).
 * The structural security invariants: scope validation, env scrub, read-only argv,
 * output secret-scrub, daily-spend sum.
 *
 * Run: node tests/cc-dispatcher.test.js
 */
import {
  validateScope, scrubChildEnv, buildCcArgv, scrubSecretsFromOutput,
  sumCostSince, summarise, parseEnvFile, resolveCcUser, workingTreeDirty,
  parseExpectedPaths, planWriteOutcome, briefTaskLine, changedFilesInClone,
  processOne,
} from '../src/dispatch/claude-code-dispatcher.js';

let passed = 0, failed = 0;
const check = (l, c) => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l}`); failed++; } };

console.log('scope validation (structural gate, never trusts the row):');
check('audit → ok', validateScope('audit').ok === true);
check('read_only → ok', validateScope('read_only').ok === true);
check('write → ok (Phase 5 Session 2)', validateScope('write').ok === true);
check('infra → rejected', validateScope('infra').ok === false);
check('critical → rejected', validateScope('critical').ok === false);
check('null → rejected (fail closed)', validateScope(null).ok === false);
check('unknown → rejected', validateScope('superuser').ok === false);

console.log('child env scrub (no inherited secrets):');
const child = scrubChildEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-xyz', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_URL: 'u', DASHBOARD_AUTH_TOKEN: 't' }, '/home/ccdispatch/work/abc');
check('keeps ANTHROPIC_API_KEY', child.ANTHROPIC_API_KEY === 'sk-ant-xyz');
check('HOME is the clone dir', child.HOME === '/home/ccdispatch/work/abc');
check('drops SUPABASE_SERVICE_ROLE_KEY', !('SUPABASE_SERVICE_ROLE_KEY' in child));
check('drops SUPABASE_URL', !('SUPABASE_URL' in child));
check('drops DASHBOARD_AUTH_TOKEN', !('DASHBOARD_AUTH_TOKEN' in child));
check('env has exactly the 4 allowed keys', Object.keys(child).sort().join(',') === 'ANTHROPIC_API_KEY,HOME,LANG,PATH');

console.log('read-only CC argv:');
const argv = buildCcArgv({ clonePath: '/home/ccdispatch/work/abc', settingsPath: '/s.json', budgetUsd: 2 });
check('runs headless print', argv.includes('-p'));
check('uses --bare (deterministic API-key auth)', argv.includes('--bare'));
check('plan mode', argv.join(' ').includes('--permission-mode plan'));
check('scopes --add-dir to the clone', argv.join(' ').includes('--add-dir /home/ccdispatch/work/abc'));
check('loads the deny-list settings', argv.join(' ').includes('--settings /s.json'));
check('disallows Edit/Write', argv.join(' ').includes('--disallowedTools Edit Write'));
check('json output', argv.join(' ').includes('--output-format json'));
check('budget bound present', argv.join(' ').includes('--max-budget-usd 2'));
check('brief is NOT in argv (passed via stdin)', !argv.join(' ').includes('# Task'));

console.log('output secret scrub (untrusted CC output):');
const scrubbed = scrubSecretsFromOutput('found key sk-ant-ABCDEFGH12345 and svc-role-secret-value and a jwt eyJabcdefghijklmnopqrst.uvwxyz123456.sig0987654321', ['svc-role-secret-value']);
check('redacts a known secret value', scrubbed.includes('[REDACTED]') && !scrubbed.includes('svc-role-secret-value'));
check('redacts sk-ant- key', scrubbed.includes('[REDACTED-KEY]') && !scrubbed.includes('sk-ant-ABCDEFGH12345'));
check('redacts a JWT', scrubbed.includes('[REDACTED-JWT]'));

console.log('daily spend sum:');
const day0 = Date.parse('2026-06-12T00:00:00Z');
const rows = [
  { cost_usd: 1.5, completed_at: '2026-06-12T03:00:00Z' },
  { cost_usd: 2.0, completed_at: '2026-06-12T09:00:00Z' },
  { cost_usd: 9.0, completed_at: '2026-06-11T23:00:00Z' }, // yesterday → excluded
  { cost_usd: null, completed_at: '2026-06-12T10:00:00Z' },
];
check('sums only today\'s rows', sumCostSince(rows, day0) === 3.5);

console.log('misc:');
check('parseEnvFile strips quotes + skips comments', (() => { const e = parseEnvFile('# c\nA="x"\nB=y\n'); return e.A === 'x' && e.B === 'y'; })());
check('summarise trims + caps', summarise('  a\r\nb  ', 3) === 'a\nb');
check('resolveCcUser returns null for an absent user (refuse-root invariant)', resolveCcUser('definitely-no-such-user-xyz') === null);
check('workingTreeDirty fails SAFE (dirty) when git cannot run', workingTreeDirty('/nonexistent-clone-xyz', { uid: 4294967, gid: 4294967 }, { warn(){} }) === true);

// ── Phase 5 Session 2 — write scope ─────────────────────────────────────────
console.log('write-scope child env (GH_TOKEN injected ONLY for write):');
const roEnv = scrubChildEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-x' }, '/h');
check('read-only env has NO GH_TOKEN', !('GH_TOKEN' in roEnv));
check('read-only env still exactly 4 keys', Object.keys(roEnv).sort().join(',') === 'ANTHROPIC_API_KEY,HOME,LANG,PATH');
const wEnv = scrubChildEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-x' }, '/h', 'ghp_writetoken');
check('write env injects GH_TOKEN', wEnv.GH_TOKEN === 'ghp_writetoken');
check('write env sets GIT_TERMINAL_PROMPT=0', wEnv.GIT_TERMINAL_PROMPT === '0');
check('write env keeps ANTHROPIC_API_KEY', wEnv.ANTHROPIC_API_KEY === 'sk-ant-x');
check('empty ghToken → no GH_TOKEN (falsy guard)', !('GH_TOKEN' in scrubChildEnv({ PATH: '/usr/bin' }, '/h', '')));

console.log('write-scope CC argv (actual execution, NOT plan mode):');
const wArgv = buildCcArgv({ clonePath: '/c', settingsPath: '/w.json', budgetUsd: 2, writeMode: true });
check('write argv is NOT plan mode', !wArgv.join(' ').includes('--permission-mode plan'));
check('write argv is acceptEdits', wArgv.join(' ').includes('--permission-mode acceptEdits'));
check('write argv does NOT disallow Edit/Write', !wArgv.join(' ').includes('--disallowedTools'));
check('write argv still headless + json + budget', wArgv.includes('-p') && wArgv.join(' ').includes('--output-format json') && wArgv.join(' ').includes('--max-budget-usd 2'));
check('read-only argv (default) is STILL plan mode + disallow', (() => { const a = buildCcArgv({ clonePath: '/c', settingsPath: '/s', budgetUsd: 1 }); return a.join(' ').includes('--permission-mode plan') && a.join(' ').includes('--disallowedTools Edit Write NotebookEdit'); })());

console.log('parseExpectedPaths (from the brief\'s # Expected paths section):');
check('absent section → null (skip validation)', parseExpectedPaths('# Task\ndo x\n# Repo\ntysonven/QClaw') === null);
check('JSON array on one line', JSON.stringify(parseExpectedPaths('# Task\nx\n# Expected paths\n["src/a.js","src/b.js"]\n# Deliverable\ny')) === '["src/a.js","src/b.js"]');
check('newline/bullet list', JSON.stringify(parseExpectedPaths('# Expected paths\n- src/a.js\n- src/b.js')) === '["src/a.js","src/b.js"]');
check('strips ./ and de-dupes', JSON.stringify(parseExpectedPaths('# Expected paths\n./src/a.js\nsrc/a.js')) === '["src/a.js"]');
check('empty section → [] (nothing may change)', JSON.stringify(parseExpectedPaths('# Expected paths\n\n# Deliverable\nx')) === '[]');

console.log('planWriteOutcome (path-validation decision):');
check('no changes → nochange (no push)', planWriteOutcome({ changedFiles: [], expectedPaths: ['src/a.js'] }).action === 'nochange');
check('all changes in scope → push', planWriteOutcome({ changedFiles: ['src/a.js'], expectedPaths: ['src/a.js', 'src/b.js'] }).action === 'push');
{
  const p = planWriteOutcome({ changedFiles: ['src/a.js', 'src/evil.js'], expectedPaths: ['src/a.js'] });
  check('out-of-scope change → abort', p.action === 'abort');
  check('abort names the unexpected file', p.unexpected.join(',') === 'src/evil.js');
}
{
  const p = planWriteOutcome({ changedFiles: ['src/a.js'], expectedPaths: null });
  check('no expected_paths + changes → push (skips validation)', p.action === 'push' && p.skippedValidation === true);
}
check('empty expected list + a change → abort (nothing allowed)', planWriteOutcome({ changedFiles: ['src/a.js'], expectedPaths: [] }).action === 'abort');

console.log('briefTaskLine (PR/commit one-liner) + changedFilesInClone parsing:');
check('extracts first line of # Task', briefTaskLine('# Task\nBump the rate limit\nmore\n# Repo\nx') === 'Bump the rate limit');
check('falls back when no # Task', briefTaskLine('just some text') === 'just some text');
check('changedFilesInClone parses porcelain (injected runner)', (() => {
  const fakeRunner = () => ' M src/a.js\n?? src/new.js\n';
  return JSON.stringify(changedFilesInClone('/c', { uid: 1, gid: 1 }, fakeRunner)) === '["src/a.js","src/new.js"]';
})());

// ── integration smoke: write-scope authorised row drives processOne, CC runs
//    WITHOUT plan mode, GH_TOKEN reaches the child, PR url is written back. ──
console.log('processOne write-scope smoke (injected deps — no host/CC):');
{
  const GH = 'ghp_smoketoken1234567890';
  const writes = [];
  const rest = async (method, path, opts = {}) => { writes.push({ method, path, body: opts.body }); return null; };
  const row = {
    id: 'abcd1234-eeee-ffff-0000-111122223333', scope: 'write',
    brief: '# Task\nRaise the API rate cap\n# Expected paths\n["src/dispatch/start.js"]',
    authorised_by: 'tyson', authorised_at: '2026-07-02T00:00:00Z',
    timeout_seconds: 600, attempts: 1, pinned_commit: null,
  };
  let ccOpts = null, pushOpts = null;
  const deps = {
    setup: () => ({ clonePath: '/fake/clone', homeDir: '/fake/clone.home' }),
    loadGhToken: async () => GH,
    runCc: async (o) => { ccOpts = o; return { ok: true, status: 'complete', resultText: `edited ${GH}`, error: null, exitCode: 0, costUsd: 0.1, ccSessionId: 'sess1', permissionDenials: [] }; },
    listChanged: () => ['src/dispatch/start.js'],
    pushPr: (o) => { pushOpts = o; return 'https://github.com/tysonven/QClaw/pull/99'; },
    cleanup: () => {},
    now: () => '2026-07-02T01:00:00Z',
  };
  await processOne({ ANTHROPIC_API_KEY: 'sk-ant-x' }, rest, row, { uid: 1000, gid: 1000 }, { info(){}, warn(){}, error(){} }, deps);
  check('CC invoked with writeMode=true (not plan mode)', ccOpts && ccOpts.writeMode === true);
  check('GH_TOKEN injected into the CC run', ccOpts && ccOpts.ghToken === GH);
  check('pushPr got branch cc/write-<8hex>', pushOpts && pushOpts.branch === 'cc/write-abcd1234');
  check('commit message is feat(dispatch): <one-liner>', pushOpts && pushOpts.commitMessage === 'feat(dispatch): Raise the API rate cap');
  check('PR title is the bare one-liner', pushOpts && pushOpts.title === 'Raise the API rate cap');
  const wb = writes[writes.length - 1].body;
  check('write-back status complete', wb.status === 'complete');
  check('PR url captured in result + metadata', wb.result.includes('pull/99') && wb.metadata.pr_url === 'https://github.com/tysonven/QClaw/pull/99');
  check('exit_code 0 on success', wb.exit_code === 0);
  check('GH_TOKEN scrubbed from result (never leaks)', !wb.result.includes(GH));
}

console.log('processOne write-scope guards (unauthorised + out-of-scope abort):');
{
  // unauthorised (fabricated queued+write row, no authorised_by/at) → rejected, no CC
  const writes = [];
  const rest = async (m, p, o = {}) => { writes.push(o.body); return null; };
  let ccCalled = false;
  await processOne({}, rest, { id: 'x1', scope: 'write', brief: '# Task\nx' }, { uid: 1, gid: 1 }, { warn(){}, info(){}, error(){} },
    { loadGhToken: async () => 'tok', runCc: async () => { ccCalled = true; return {}; }, setup: () => ({ clonePath: '/c', homeDir: '/h' }), cleanup: () => {} });
  check('unauthorised write → failed, CC never run', ccCalled === false && writes[0].status === 'failed' && /not authorised/.test(writes[0].error_message));
}
{
  // authorised, but CC changes a file outside expected_paths → abort, no push
  const writes = [];
  const rest = async (m, p, o = {}) => { writes.push(o.body); return null; };
  let pushed = false;
  const row = { id: 'y2', scope: 'write', brief: '# Task\nedit a\n# Expected paths\n["src/a.js"]', authorised_by: 'tyson', authorised_at: 't' };
  await processOne({}, rest, row, { uid: 1, gid: 1 }, { warn(){}, info(){}, error(){} }, {
    loadGhToken: async () => 'tok', setup: () => ({ clonePath: '/c', homeDir: '/h' }), cleanup: () => {},
    runCc: async () => ({ ok: true, status: 'complete', resultText: 'ok', exitCode: 0 }),
    listChanged: () => ['src/a.js', 'src/secret.js'],
    pushPr: () => { pushed = true; return 'url'; },
  });
  check('out-of-scope write → failed, NOT pushed', pushed === false && writes[0].status === 'failed' && /src\/secret\.js/.test(writes[0].error_message));
}
{
  // authorised, CC makes no changes → complete with note, no push
  const writes = [];
  const rest = async (m, p, o = {}) => { writes.push(o.body); return null; };
  let pushed = false;
  const row = { id: 'z3', scope: 'write', brief: '# Task\nno-op\n# Expected paths\n["src/a.js"]', authorised_by: 'tyson', authorised_at: 't' };
  await processOne({}, rest, row, { uid: 1, gid: 1 }, { warn(){}, info(){}, error(){} }, {
    loadGhToken: async () => 'tok', setup: () => ({ clonePath: '/c', homeDir: '/h' }), cleanup: () => {},
    runCc: async () => ({ ok: true, status: 'complete', resultText: 'nothing to do', exitCode: 0 }),
    listChanged: () => [], pushPr: () => { pushed = true; return 'url'; },
  });
  check('no-mutation write → complete, no push, note set', pushed === false && writes[0].status === 'complete' && writes[0].metadata.note === 'no mutations — CC found nothing to change');
}
{
  // write scope with GH token missing → failed cleanly, no CC
  const writes = [];
  const rest = async (m, p, o = {}) => { writes.push(o.body); return null; };
  let ccCalled = false;
  const row = { id: 'w4', scope: 'write', brief: '# Task\nx', authorised_by: 'tyson', authorised_at: 't' };
  await processOne({}, rest, row, { uid: 1, gid: 1 }, { warn(){}, info(){}, error(){} },
    { loadGhToken: async () => null, runCc: async () => { ccCalled = true; return {}; }, setup: () => ({ clonePath: '/c', homeDir: '/h' }), cleanup: () => {} });
  check('missing GH token → failed, CC never run', ccCalled === false && writes[0].status === 'failed' && /github_token/.test(writes[0].error_message));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
