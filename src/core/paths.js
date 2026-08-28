/**
 * QuantumClaw store-path resolution.
 *
 * One place decides where the agent's evidence store lives, so a test can never
 * fall into the production one by omission.
 *
 * The problem this closes. Every store path in the codebase resolved as
 * `config?._dir || join(homedir(), '.quantumclaw')`. That default is correct in
 * production and silently wrong under test: a caller that simply forgets to pass
 * a dir gets the LIVE store, and nothing says so. The live store is not scratch
 * space, it holds audit.db (the rows the verification gates read as evidence),
 * memory.db, and the append-only logs. A test writing there corrupts the
 * evidence trail the gates depend on, and would look exactly like real traffic.
 *
 * The STORES half landed first (resolveStoreDir). This adds the LOGS, which is
 * the half that was actually leaking: a full `npm test` on a machine with a real
 * ~/.quantumclaw writes to the production skill-load.log and tool-call.log on
 * every run. That is the same gap that put synthetic userIds (9999 / 8888 /
 * 7777 / integration-test) into the production skill-load.log on 2026-08-27,
 * interleaved with real Telegram traffic, because the per-log override is opt-in
 * and only 1 of ~40 test files sets it.
 *
 * Stores throw, logs redirect. The remedies differ because the failure modes do:
 * see resolveLogPath.
 */

import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { mkdtempSync } from 'fs';

/** The production store directory, honouring an explicit QCLAW_HOME override. */
export function qclawHome() {
  const override = process.env.QCLAW_HOME;
  return (override && String(override).trim()) || join(homedir(), '.quantumclaw');
}

/**
 * Are we running under a test?
 *
 * Anchored on argv[1], the entry script, rather than scanning all of argv: a
 * production invocation must never be misdetected as a test, because that would
 * turn a real boot into a thrown error. `node tests/x.test.js` and any runner
 * that sets NODE_ENV=test / VITEST / JEST_WORKER_ID are covered; `node
 * src/index.js` is not. QCLAW_TEST is the explicit escape hatch in both
 * directions ("1" forces test context, "0" forces production).
 */
export function isTestContext() {
  const forced = process.env.QCLAW_TEST;
  if (forced === '1' || forced === 'true') return true;
  if (forced === '0' || forced === 'false') return false;
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.VITEST || process.env.JEST_WORKER_ID != null) return true;
  const entry = String(process.argv?.[1] || '');
  return /\.test\.(?:js|mjs|cjs)$/.test(entry) || /(?:^|[/\\])tests?[/\\]/.test(entry);
}

/**
 * Resolve the directory a store should live in.
 *
 * - An explicit dir always wins, in every context. Production callers pass
 *   `config._dir` and are unaffected.
 * - With no explicit dir under test, and no QCLAW_HOME redirect, THROW. Silently
 *   using the live store is the failure mode this module exists to prevent, and
 *   fail-closed matches how the gates themselves behave.
 * - Otherwise fall back to the production store, exactly as before.
 *
 * @param {string|null|undefined} explicitDir  e.g. config?._dir
 * @param {string} label                       what is being opened, for the error
 */
export function resolveStoreDir(explicitDir, label = 'store') {
  if (explicitDir && String(explicitDir).trim()) return String(explicitDir);
  if (isTestContext() && !process.env.QCLAW_HOME) {
    throw new Error(
      `[paths] refusing to open the live ~/.quantumclaw ${label} from a test. ` +
      `Pass an explicit dir (config._dir = mkdtempSync(...)) or set QCLAW_HOME ` +
      `to a temp directory. The live store holds audit.db, memory.db and the ` +
      `append-only logs, which the verification gates read as evidence.`
    );
  }
  return qclawHome();
}

// Lazily-created scratch dir, one per test process, shared by every log writer
// that falls through to it. Created on first use so a production run never makes
// a temp directory it will not use.
let _scratch = null;
export function testScratchDir() {
  if (!_scratch) _scratch = mkdtempSync(join(tmpdir(), 'qclaw-test-logs-'));
  return _scratch;
}

/**
 * Resolve an append-only log path.
 *
 * Logs get a REDIRECT rather than the throw resolveStoreDir uses, because every
 * one of these writers is best-effort and swallows its own errors. A throw there
 * would be caught by the writer's own try/catch, the test would pass, and the
 * only visible effect would be a log line that silently went missing. Redirecting
 * to a per-process temp dir cannot break a caller and cannot reach production.
 *
 * This is the half that was actually leaking. `skill-load.log` and
 * `tool-call.log` are written on ordinary agent code paths that ~40 test files
 * exercise, while only ONE (skill-loader.test.js) sets the opt-in override. The
 * 2026-08-27 run that put synthetic userIds into the production skill-load.log
 * went through exactly this gap, and a full `npm test` on a dev machine with a
 * real ~/.quantumclaw still reproduces it.
 *
 * @param {string} envVar    the existing per-log override (kept, still wins)
 * @param {string} filename  e.g. 'gate.log'
 */
export function resolveLogPath(envVar, filename) {
  const explicit = envVar ? process.env[envVar] : null;
  if (explicit && String(explicit).trim()) return String(explicit);
  if (isTestContext() && !process.env.QCLAW_HOME) return join(testScratchDir(), filename);
  return join(qclawHome(), filename);
}
