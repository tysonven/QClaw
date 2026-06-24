/**
 * Slice 6c Unit 6 — typed observation tools (read-only, scope-isolated).
 * Run: node tests/specialist-observation.test.js
 *
 * Covers: read_file/grep_repo/list_dir path + pattern bounds; git_status fixed
 * repo (no path arg); all four registered under specialist agentNames (the
 * dynamic roster), never 'charlie'/'shared'. Uses a /tmp git fixture + DI
 * repoRoot (Rule 5 CI-parity — no hardcoded /root on the happy path).
 */

import child_process from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createObservationTools, registerObservationTools } from '../src/tools/observation.js';

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };
async function throwsAsync(fn) { try { await fn(); return null; } catch (e) { return e; } }

// ── /tmp repo fixture ──
const repoRoot = mkdtempSync(join(tmpdir(), '6c-obs-'));
mkdirSync(join(repoRoot, 'src'), { recursive: true });
mkdirSync(join(repoRoot, 'docs'), { recursive: true });
mkdirSync(join(repoRoot, 'secrets-dir'), { recursive: true });
writeFileSync(join(repoRoot, 'src', 'foo.js'), 'const needle = 42;\nexport default needle;\n');
writeFileSync(join(repoRoot, 'docs', 'bar.md'), '# Bar\nneedle in docs too\n');
writeFileSync(join(repoRoot, 'secret.txt'), 'TOP SECRET at repo root, outside src/docs\n');
// git init so git_status has a real repo (commit everything → clean tree).
child_process.spawnSync('git', ['init', '-q', repoRoot]);
child_process.spawnSync('git', ['-C', repoRoot, 'add', '-A']);
child_process.spawnSync('git', ['-C', repoRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);

const [read_file, grep_repo, list_dir, git_status] = createObservationTools({ repoRoot });

console.log('Unit 6 — read_file bounds');
{
  const ok = await read_file.fn({ path: 'src/foo.js' });
  check('reads a file under src/', ok.content.includes('needle') && ok.lines >= 2);
  const okDoc = await read_file.fn({ path: 'docs/bar.md' });
  check('reads a file under docs/', okDoc.content.includes('Bar'));
  check('rejects file at repo root (outside src/docs)', !!(await throwsAsync(() => read_file.fn({ path: 'secret.txt' }))));
  check('rejects traversal escape', !!(await throwsAsync(() => read_file.fn({ path: '../../../etc/passwd' }))));
  check('rejects absolute path outside repo', !!(await throwsAsync(() => read_file.fn({ path: '/etc/hostname' }))));
}

console.log('Unit 6 — grep_repo pattern + bounds');
{
  const r = await grep_repo.fn({ pattern: 'needle' });
  check('finds matches under src/ (default dir)', r.matches.length >= 1 && r.matches.every(m => m.file.includes('src')));
  check('rejects ";" shell metacharacter', !!(await throwsAsync(() => grep_repo.fn({ pattern: 'needle; rm -rf /' }))));
  check('rejects "$(...)" command substitution', !!(await throwsAsync(() => grep_repo.fn({ pattern: '$(whoami)' }))));
  check('rejects backtick', !!(await throwsAsync(() => grep_repo.fn({ pattern: '`id`' }))));
  check('rejects pipe', !!(await throwsAsync(() => grep_repo.fn({ pattern: 'a | b' }))));
}

console.log('Unit 6 — list_dir bounds');
{
  const r = await list_dir.fn({ path: '.' });
  check('lists repo root entries (names/types/sizes)', r.entries.some(e => e.name === 'src' && e.type === 'dir'));
  check('rejects path outside repo root', !!(await throwsAsync(() => list_dir.fn({ path: '/etc' }))));
}

console.log('Unit 6 — git_status fixed repo, no path arg');
{
  const r = await git_status.fn({});
  check('returns branch', typeof r.branch === 'string' && r.branch.length > 0, r.branch);
  check('returns clean=true after commit', r.clean === true, JSON.stringify(r.changes));
  check('changes is an array', Array.isArray(r.changes));
  check('inputSchema accepts no path (additionalProperties:false)', git_status.inputSchema.additionalProperties === false);
}

console.log('Unit 6 — registration scope is the dynamic specialist roster');
{
  const calls = [];
  const fakeReg = { registerBuiltin: (name, def) => calls.push({ name, def }) };
  const roster = ['qa-operator', 'build-specialist', 'content-studio-operator'];
  const names = registerObservationTools(fakeReg, roster, { repoRoot });
  check('registers all four tools', names.length === 4 && ['read_file', 'grep_repo', 'list_dir', 'git_status'].every(n => names.includes(n)));
  check('scope is exactly the passed roster', calls.every(c => JSON.stringify(c.def.scope) === JSON.stringify(roster)));
  check('scope is NOT charlie', calls.every(c => !c.def.scope.includes('charlie')));
  check('scope is NOT "shared"', calls.every(c => c.def.scope !== 'shared'));

  const empty = registerObservationTools(fakeReg, [], { repoRoot });
  check('empty roster registers nothing (no hardcoded fallback)', empty.length === 0);
}

rmSync(repoRoot, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
