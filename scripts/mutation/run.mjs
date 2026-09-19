#!/usr/bin/env node
/**
 * Mutation harness: apply one mutant at a time, run the tests, restore.
 *
 *   node scripts/mutation/run.mjs <mutant-list.mjs> [--repo <path>] [--allow-main-worktree]
 *
 * WHY THIS IS COMMITTED. Until 2026-09-19 the mutant lists behind "25/56/79
 * mutants, all killed" in #184 lived in a session scratchpad. A cold reviewer
 * could not rerun them, so each count was a verification claim nobody could
 * check. The lists are here so a count in a PR body can be reproduced from the
 * commit it names: check that commit out in a worktree and run its list.
 *
 * A mutant keeps the code's shape and changes only its substance. Each list
 * exports `mutants` as [label, file, find, replace] and `tests` as the test
 * files that must go red. A mutant is KILLED when any of those tests fails.
 *
 * Safety, each learned the hard way:
 *   - Refuses a dirty tree. Restoring uses `git checkout -- <file>`, which
 *     discards uncommitted work (it did, twice, in the trade-engine work).
 *   - Refuses a repository's MAIN checkout unless --allow-main-worktree:
 *     /root/QClaw is the live deploy and ~/QClaw is shared by sessions. Run it
 *     in a worktree of your own.
 *   - Points QCLAW_TOOL_CALL_LOG_PATH at a temp file for every test run, so no
 *     mutant writes fixture registrations into the live tool-call.log (#182).
 *   - A mutant whose find string does not match EXACTLY once is NOT APPLIED,
 *     and any NOT APPLIED fails the run. It is never counted as killed.
 *   - Verifies the tree is clean after every restore, and stops if it is not.
 *
 * Exit code 0 only when every mutant applied and every mutant was killed.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const args = process.argv.slice(2);
const listPath = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--repo');
const repoArg = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : process.cwd();
if (!listPath) { console.error('usage: node scripts/mutation/run.mjs <mutant-list.mjs> [--repo <path>] [--allow-main-worktree]'); process.exit(2); }

const git = (...a) => execFileSync('git', a, { cwd: repoArg, encoding: 'utf8' }).trim();
const repo = git('rev-parse', '--show-toplevel');
const gitDir = resolve(repo, git('rev-parse', '--git-dir'));
const commonDir = resolve(repo, git('rev-parse', '--git-common-dir'));
if (gitDir === commonDir && !args.includes('--allow-main-worktree')) {
  console.error(`REFUSING: ${repo} is a main checkout, not a worktree. Mutating it would break anyone else using it. Run in a worktree of your own, or pass --allow-main-worktree if you are certain.`);
  process.exit(2);
}
const dirty = () => git('status', '--porcelain');
if (dirty()) { console.error(`REFUSING: the tree is dirty; restoring would discard it.\n${dirty()}`); process.exit(2); }

const list = await import(pathToFileURL(resolve(listPath)).href);
const mutants = list.mutants ?? list.default;
const tests = list.tests;
if (!Array.isArray(mutants) || !Array.isArray(tests) || tests.length === 0) {
  console.error('the list must export `mutants` (or a default array) and a non-empty `tests`'); process.exit(2);
}

const logDir = mkdtempSync(join(tmpdir(), 'qclaw-mutation-'));
const env = { ...process.env, QCLAW_TOOL_CALL_LOG_PATH: join(logDir, 'tool-call.log') };
console.log(`mutation run at ${git('rev-parse', '--short', 'HEAD')} in ${repo}: ${mutants.length} mutants, tests: ${tests.join(', ')}`);

let killed = 0; let survived = 0; let notApplied = 0;
try {
  for (const [label, file, find, repl] of mutants) {
    const path = join(repo, file);
    const src = readFileSync(path, 'utf8');
    const count = src.split(find).length - 1;
    if (count !== 1) { console.log(`NOT APPLIED  ${label}: target matched ${count} times`); notApplied++; continue; }
    writeFileSync(path, src.replace(find, repl));
    let red = null;
    for (const t of tests) {
      const r = spawnSync('node', [t], { cwd: repo, encoding: 'utf8', env });
      if (r.status !== 0) {
        const first = `${r.stdout}\n${r.stderr}`.split('\n').find((l) => l.includes('✗') || /Error/.test(l)) || `exit ${r.status}`;
        red = `${t}: ${first.trim().slice(0, 160)}`;
        break;
      }
    }
    execFileSync('git', ['checkout', '--', file], { cwd: repo });
    if (dirty()) { console.error(`RESTORE FAILED after ${label}; stopping.\n${dirty()}`); process.exit(3); }
    if (red) { console.log(`KILLED       ${label}\n             ${red}`); killed++; }
    else { console.log(`SURVIVED     ${label}`); survived++; }
  }
} finally {
  rmSync(logDir, { recursive: true, force: true });
}
console.log(`\n${mutants.length} mutants: ${killed} killed, ${survived} survived, ${notApplied} not applied`);
process.exit(survived === 0 && notApplied === 0 ? 0 : 1);
