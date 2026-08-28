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
 * This PR covers the STORES: qclaw.db and the bootstrap workspace. No current
 * test reaches either without a dir, so the hole here is latent rather than
 * active, and closing it is cheap insurance on the two files whose contents the
 * gates treat as evidence.
 *
 * The append-only LOGS have the same defect and it is NOT latent: a full test
 * run writes to the production skill-load.log and tool-call.log today. That half
 * needs a different remedy (redirect, not throw, because those writers swallow
 * their own errors) and lands separately so isTestContext can be reviewed on its
 * own before anything depends on it more widely.
 *
 * The fix here is to make omission fail loudly under test instead of quietly
 * resolving to production. In production, behaviour is unchanged.
 */

import { join } from 'path';
import { homedir } from 'os';

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
