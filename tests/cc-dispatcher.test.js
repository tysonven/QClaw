/**
 * Slice 5 U6 — claude-code-dispatcher pure helpers (no CC, no host).
 * The structural security invariants: scope validation, env scrub, read-only argv,
 * output secret-scrub, daily-spend sum.
 *
 * Run: node tests/cc-dispatcher.test.js
 */
import {
  validateScope, scrubChildEnv, buildCcArgv, scrubSecretsFromOutput,
  sumCostSince, summarise, parseEnvFile, resolveCcUser,
} from '../src/dispatch/claude-code-dispatcher.js';

let passed = 0, failed = 0;
const check = (l, c) => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l}`); failed++; } };

console.log('scope validation (structural gate, never trusts the row):');
check('audit → ok', validateScope('audit').ok === true);
check('read_only → ok', validateScope('read_only').ok === true);
check('write → rejected', validateScope('write').ok === false);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
