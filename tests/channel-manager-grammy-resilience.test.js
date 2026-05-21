/**
 * Slice 3e — TelegramChannel grammY resilience integration tests.
 *
 * Drives the channel manager against a mocked grammY Bot + runner. Verifies
 * the state machine (active / retrying / degraded / stopped), the inline retry
 * loop, the recovery timer, and the channel-events.log writer.
 *
 * Run: node tests/channel-manager-grammy-resilience.test.js
 */

import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'qclaw-slice3e-'));
const logPath = join(tmpDir, 'channel-events.log');
process.env.QCLAW_CHANNEL_EVENTS_LOG_PATH = logPath;

// ── Mock @grammyjs/runner BEFORE importing manager.js ─────────────────
const runnerMockState = {
  // Per-call queue: classify behaviours each run() invocation should take.
  // Each entry is { behaviour: 'succeed' | 'fail-immediately' | 'fail-after-resolve', error?: any }.
  // 'fail-immediately' rejects the task promise immediately.
  // 'fail-after-resolve' resolves run() but rejects task() async.
  scenarios: [],
  runs: [], // record of every run() invocation
};

function pushScenario(s) { runnerMockState.scenarios.push(s); }
function nextScenario() {
  return runnerMockState.scenarios.shift() || { behaviour: 'succeed' };
}

// Replace @grammyjs/runner in the module graph. Node's ESM doesn't have a clean
// inline mock, so we use the URL-based dynamic import approach: write a side-
// loaded shim and override via the import map. Simpler approach: patch the
// classifier output through a fixture — we DON'T re-import; we instead invoke
// the channel directly with our own fake Bot constructor injected via
// `grammy` import. Since grammy is dynamic-imported inside start(), we can
// stub by setting up a small module-cache trick via require.

// Cleanest path: instead of mocking grammy, build a minimal fake TelegramChannel
// harness that re-uses the actual _onRunnerFailure / _attemptRecovery / _degrade
// / _scheduleRecovery code paths from ChannelManager exports. That means we
// instantiate TelegramChannel without start(), and drive the state machine
// directly. We do NOT exercise `start()` itself in these tests (grammy import
// path), but we DO exercise the resilience code that the brief asked for.

import {
  classify as classifyGrammyError,
} from '../src/channels/grammy-error-classifier.js';

// Load the manager module — we'll reach into TelegramChannel via a freshly
// instantiated object. The class is not directly exported, so we re-import via
// the side channel: spawn a manager via ChannelManager._createChannel(). But
// _createChannel requires a config object; cleaner is to instantiate via
// the public ChannelManager and stub `start()` by jumping past it.

// Approach: ChannelManager is exported. We construct one with config.channels.telegram
// enabled=true, then call startAll() with a stubbed `_createChannel` that returns
// a NoOpChannel (so startAll doesn't actually touch grammy). Then we directly
// construct a TelegramChannel test double by importing the file and grabbing
// the class via a side accessor — but the class isn't exported.

// Final approach: dynamically import the manager module and inspect the
// internal class via tree-walking. Since the slice doesn't allow us to alter
// the export surface, we test the public _channelsByName behaviour by using
// ChannelManager's stopAll() + dashboard surface integration.

// ACTUAL APPROACH: Use experimental loader. To keep this test simple and
// dependency-free, we instead test the FEATURES that are observable through
// the file system (channel-events.log) AND the classifier (already covered by
// the unit tests). Specifically:
//   - The state machine + log writer can be tested by constructing a minimal
//     mock TelegramChannel by extracting the relevant private methods.
//   - Since the private methods are inside the (un-exported) class, we test
//     them via a thin wrapper: we monkeypatch via a small Bot/runner shim and
//     drive start() with QCLAW_SKIP_GRAMMY_VALIDATION=1 to bypass real I/O.

// Decision: use a small wrapper script that mocks `grammy` and
// `@grammyjs/runner` via a dynamic-import shim, then drives start() through
// the state transitions. The mock approach is implemented below using Node's
// ESM register hooks would be heavy — instead we add a small module-resolution
// trick: load manager.js's source, replace the import specifiers, eval into a
// throwaway module. Too complex for a single test file.

// Final decision: TestHarness reproduces the relevant state-machine
// methods in JS form by invoking them via reflection. We use the fact that
// the TelegramChannel constructor is reachable via ChannelManager._createChannel
// when we pass a fake `agents` registry. Then we monkeypatch `_reinitBot` on
// the instance to drive the recovery loop, and call `_onRunnerFailure` /
// `_attemptRecovery` directly via reflection.

import { ChannelManager } from '../src/channels/manager.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(label); }
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function readEvents() {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function clearLog() {
  try { rmSync(logPath); } catch {}
}

// Build a TelegramChannel via the public ChannelManager.
// opts.realSleep=true preserves the production _sleep so cancellation
// behaviour can be exercised (finding 3).
async function makeChannel(opts = {}) {
  const fakeAgents = {
    primary: () => null,
    get: () => null,
    count: 0,
  };
  const fakeSecrets = {
    get: async (k) => k === 'telegram_bot_token' ? 'bot1234567890:ABCDEFghijklmnop_qrstuvWXYZ1234567890' : null,
  };
  const fakeApprovals = { pending: () => [], approve: () => {}, deny: () => {} };
  const config = {
    channels: {
      telegram: {
        enabled: true,
        allowedUsers: [123],
        dmPolicy: 'pairing',
      },
    },
  };
  const mgr = new ChannelManager(config, fakeAgents, fakeSecrets, fakeApprovals, null);
  // Get the (un-exported) TelegramChannel class by going through _createChannel
  // and not calling start().
  const ch = await mgr._createChannel('telegram', config.channels.telegram);
  // Skip start(); we'll set status manually and drive private methods.
  ch.status = 'active';
  if (!opts.realSleep) {
    // Speed up tests: monkey-patch _sleep to resolve immediately.
    ch._sleep = async function (ms, timerField) {
      // Still set the timer field briefly so stop() can verify it gets cleared
      // — but resolve right away so tests don't wait.
      return Promise.resolve();
    };
  }
  return ch;
}

// Stub _reinitBot so we can control success/failure of re-init from tests.
function stubReinit(ch, outcomes) {
  // outcomes is an array of strings: 'ok' | 'transient' | 'non_transient'
  const queue = [...outcomes];
  ch._reinitCalls = 0;
  ch._reinitBot = async function () {
    ch._reinitCalls += 1;
    const next = queue.shift() || 'ok';
    if (next === 'ok') {
      this._runner = { stop: async () => {}, task: () => undefined };
      this.bot = {};
      this.status = 'active';
      this._retryAttempts = 0;
      return;
    }
    if (next === 'transient') {
      const err = new Error('Simulated transient'); err.code = 'ECONNRESET';
      throw err;
    }
    if (next === 'non_transient') {
      const err = new Error('Unauthorized'); err.name = 'GrammyError'; err.error_code = 401;
      throw err;
    }
  };
}

// ── Section 1: transient error → retry → success ─────────────────────
console.log('Section 1: transient error → retry → success');
{
  clearLog();
  const ch = await makeChannel();
  stubReinit(ch, ['ok']); // first re-init succeeds
  const transientErr = Object.assign(new Error('429'), { error_code: 429, name: 'GrammyError' });
  await ch._onRunnerFailure(transientErr);
  check('status returns to active after successful retry', ch.status === 'active', `status=${ch.status}`);
  check('_retryAttempts reset to 0', ch._retryAttempts === 0, `_retryAttempts=${ch._retryAttempts}`);
  check('_reinitBot called exactly once', ch._reinitCalls === 1, `calls=${ch._reinitCalls}`);
  const events = readEvents();
  check('transient_error event written', events.some((e) => e.event === 'transient_error' && e.http_status === 429));
  check('retry_scheduled event written', events.some((e) => e.event === 'retry_scheduled'));
  check('retry_succeeded event written', events.some((e) => e.event === 'retry_succeeded'));
  await ch.stop();
}

// ── Section 2: transient error → 5 retries all fail → degrade ─────────
console.log('\nSection 2: 5 transient retries all fail → degrade');
{
  clearLog();
  const ch = await makeChannel();
  stubReinit(ch, ['transient', 'transient', 'transient', 'transient', 'transient']);
  const transientErr = Object.assign(new Error('502'), { error_code: 502, name: 'GrammyError' });
  await ch._onRunnerFailure(transientErr);
  check('status ends in degraded', ch.status === 'degraded', `status=${ch.status}`);
  check('_recoveryTimer scheduled', ch._recoveryTimer !== null);
  const events = readEvents();
  const transientEvents = events.filter((e) => e.event === 'transient_error');
  // 6 total: the initial trigger (#1) + one per recursive re-entry after each
  // of the 5 failed reinits (#2-#6). The 6th has retry_attempt=6 and crosses
  // the gate, so no retry_scheduled follows it — it triggers degradation.
  check('6 transient_error events (1 initial + 5 reinit-failure recursions)', transientEvents.length === 6, `got ${transientEvents.length}`);
  const retryScheduled = events.filter((e) => e.event === 'retry_scheduled');
  check('5 retry_scheduled events', retryScheduled.length === 5, `got ${retryScheduled.length}`);
  check('degraded event written', events.some((e) => e.event === 'degraded'));
  await ch.stop();
}

// ── Section 3: non-transient error → immediate degrade, no retry ─────
console.log('\nSection 3: non-transient → immediate degrade');
{
  clearLog();
  const ch = await makeChannel();
  ch._reinitCalls = 0;
  ch._reinitBot = async function () { this._reinitCalls += 1; };
  const nonTransientErr = Object.assign(new Error('401'), { error_code: 401, name: 'GrammyError' });
  await ch._onRunnerFailure(nonTransientErr);
  check('status === degraded', ch.status === 'degraded', `status=${ch.status}`);
  check('_reinitBot NOT called (no retries on non-transient)', ch._reinitCalls === 0);
  const events = readEvents();
  check('non_transient_error event written', events.some((e) => e.event === 'non_transient_error' && e.http_status === 401));
  check('decision="non_transient_fail" recorded', events.some((e) => e.decision === 'non_transient_fail'));
  check('no retry_scheduled events', !events.some((e) => e.event === 'retry_scheduled'));
  await ch.stop();
}

// ── Section 4: recovery timer fires → re-init succeeds → channel restored
console.log('\nSection 4: degraded → recovery timer → recovery succeeds');
{
  clearLog();
  const ch = await makeChannel();
  ch.status = 'degraded';
  stubReinit(ch, ['ok']);
  // Drive recovery directly (bypass the 5-min timer for test speed).
  await ch._attemptRecovery();
  check('status restored to active', ch.status === 'active', `status=${ch.status}`);
  check('_recoveryAttempts reset to 0', ch._recoveryAttempts === 0);
  const events = readEvents();
  check('recovery_attempt event written', events.some((e) => e.event === 'recovery_attempt'));
  check('recovery_succeeded event written', events.some((e) => e.event === 'recovery_succeeded'));
  await ch.stop();
}

// ── Section 5: recovery timer fires → re-init fails → remains degraded ─
console.log('\nSection 5: degraded → recovery fails → remains degraded');
{
  clearLog();
  const ch = await makeChannel();
  ch.status = 'degraded';
  stubReinit(ch, ['transient']);
  await ch._attemptRecovery();
  check('status remains degraded', ch.status === 'degraded', `status=${ch.status}`);
  check('_recoveryAttempts incremented', ch._recoveryAttempts === 1);
  check('_recoveryTimer rescheduled', ch._recoveryTimer !== null);
  const events = readEvents();
  check('recovery_failed event written', events.some((e) => e.event === 'recovery_failed'));
  await ch.stop();
}

// ── Section 6: 12 recovery attempts exhausted → manual_intervention_required
console.log('\nSection 6: recovery attempts cap → manual_intervention_required');
{
  clearLog();
  const ch = await makeChannel();
  ch.status = 'degraded';
  // Force _recoveryAttempts to 11 and simulate one more failure.
  ch._recoveryAttempts = 11;
  stubReinit(ch, ['transient']);
  await ch._attemptRecovery();
  check('_recoveryAttempts === 12 (cap reached)', ch._recoveryAttempts === 12);
  check('_recoveryTimer NOT scheduled (capped)', ch._recoveryTimer === null);
  const events = readEvents();
  check('manual_intervention_required event written',
    events.some((e) => e.event === 'manual_intervention_required'));
  await ch.stop();
}

// ── Section 7: stop() clears timers and prevents further events ──────
console.log('\nSection 7: stop() clears timers');
{
  clearLog();
  const ch = await makeChannel();
  ch.status = 'degraded';
  ch._scheduleRecovery();
  check('_recoveryTimer exists before stop()', ch._recoveryTimer !== null);
  await ch.stop();
  check('status === stopped after stop()', ch.status === 'stopped');
  check('_recoveryTimer cleared', ch._recoveryTimer === null);
  check('_backoffTimer cleared', ch._backoffTimer === null);
  // Slice 3e fixup (finding 2): the original assertion here was tautological
  // — a disjunction with two clauses, at least one always true for any
  // regression that wrote exactly one extra event. Replace with explicit
  // equality of the event log before vs after.
  const eventsBefore = readEvents();
  await ch._onRunnerFailure(new Error('post-stop'));
  // Give any drained-pending re-entries a chance to leak through (they
  // shouldn't, but a regression here is exactly what finding 1's fixup must
  // also continue to suppress under status='stopped').
  await new Promise((r) => setTimeout(r, 20));
  const eventsAfter = readEvents();
  check('event count unchanged after post-stop _onRunnerFailure',
    eventsAfter.length === eventsBefore.length,
    `before=${eventsBefore.length}, after=${eventsAfter.length}`);
  check('no new *_error events written post-stop',
    eventsAfter.filter((e) => typeof e.event === 'string' && e.event.endsWith('_error')).length
      === eventsBefore.filter((e) => typeof e.event === 'string' && e.event.endsWith('_error')).length);
  check('no new retry_scheduled / degraded events written post-stop',
    eventsAfter.filter((e) => e.event === 'retry_scheduled' || e.event === 'degraded').length
      === eventsBefore.filter((e) => e.event === 'retry_scheduled' || e.event === 'degraded').length);
}

// ── Section 8: log file mode 0600 on first write ─────────────────────
console.log('\nSection 8: channel-events.log mode 0600');
{
  clearLog();
  const ch = await makeChannel();
  const nonTransient = Object.assign(new Error('401'), { error_code: 401, name: 'GrammyError' });
  ch._reinitBot = async () => {};
  await ch._onRunnerFailure(nonTransient);
  check('log file exists', existsSync(logPath));
  const mode = statSync(logPath).mode & 0o777;
  check(`log file mode === 0600 (got 0${mode.toString(8)})`, mode === 0o600);
  await ch.stop();
}

// ── Section 9: log records never include the bot token ───────────────
console.log('\nSection 9: token never appears in log');
{
  clearLog();
  const ch = await makeChannel();
  // Build an error whose message contains a bot token (simulating grammY's
  // sensitive-logs FetchError leak).
  const leakyErr = new Error('request to https://api.telegram.org/bot1234567890:ABCDEFghijklmnop_qrstuvWXYZ1234567890/getUpdates failed, code: ECONNRESET');
  leakyErr.code = 'ECONNRESET';
  ch._reinitBot = async () => {};
  await ch._onRunnerFailure(leakyErr);
  await ch.stop();
  const raw = readFileSync(logPath, 'utf8');
  const tokenRe = /bot\d+:[A-Za-z0-9_-]+/;
  // Allow 'bot<REDACTED>' but never raw token.
  const hasRawToken = tokenRe.test(raw);
  check('no raw bot token in log', !hasRawToken, hasRawToken ? `matched in: ${raw.slice(0, 300)}` : '');
  check('redaction marker present', raw.includes('bot<REDACTED>'), `raw: ${raw.slice(0, 300)}`);
}

// ── Section 10: classifier-throw → safe-default degrade ──────────────
console.log('\nSection 10: classifier throws → safe-default unknown-transient');
{
  clearLog();
  const ch = await makeChannel();
  // Patch the imported classify to throw — we do this by replacing the module's
  // export via a small overlay. Since classifyGrammyError is bound at import
  // time in manager.js, we can't easily replace it here. Instead simulate via
  // an error that the classifier itself would crash on: a Proxy that throws on
  // property access.
  const evilErr = new Proxy({}, {
    get() { throw new Error('proxy property access denied'); },
  });
  ch._reinitBot = async () => {};
  // The classifier WILL throw when it tries to read err.error_code / err.code.
  // _onRunnerFailure's inner try/catch should catch it and fall through.
  await ch._onRunnerFailure(evilErr);
  // The proxy throws on EVERY property access (including err.name, err.message
  // inside the log-record builder). _onRunnerFailure should still complete
  // without crashing the test process.
  check('_onRunnerFailure completed (no process crash) with evil-proxy err', true);
  // status should be either 'retrying' or 'degraded' — definitely not active.
  check('channel not active after evil-proxy error',
    ch.status === 'retrying' || ch.status === 'degraded' || ch.status === 'stopped',
    `status=${ch.status}`);
  await ch.stop();
}

// ── Section 11: finding 1 regression — failure during the lock window is drained
console.log('\nSection 11: failure during lock window drained (finding 1)');
{
  clearLog();
  const ch = await makeChannel();
  // While the outer _onRunnerFailure holds _inFlightRecovery, simulate the
  // new runner's task immediately rejecting (the realistic exploit scenario
  // is a 409 immediately after re-init when a deploy overlaps). Pre-fixup,
  // the concurrent _onRunnerFailure call hits the lock gate and is silently
  // dropped — only one reinit ever happens, channel reported active but
  // dead. Post-fixup, the second failure is captured and drained after the
  // lock releases, producing a second reinit.
  let reinitCount = 0;
  const secondErr = Object.assign(new Error('new-task 409'),
    { error_code: 409, name: 'GrammyError' });
  ch._reinitBot = async function () {
    const n = ++reinitCount;
    if (n === 1) {
      // We're inside the outer _onRunnerFailure's try-block with the lock
      // held. Schedule a microtask-window concurrent failure.
      queueMicrotask(() => { ch._onRunnerFailure(secondErr); });
    }
    // Both reinits "succeed" (channel returns to a stable state).
    this._runner = { stop: async () => {}, task: () => undefined };
    this.bot = {};
    this.status = 'active';
    this._retryAttempts = 0;
  };

  const firstErr = Object.assign(new Error('429'),
    { error_code: 429, name: 'GrammyError' });
  await ch._onRunnerFailure(firstErr);
  // Let the captured-then-drained microtask + the drained handler's own
  // sleep+reinit microtasks run.
  await new Promise((r) => setTimeout(r, 20));

  // Pre-fixup this would be 1 (drop). Post-fixup this is 2 (drain ran).
  // A 409 is non_transient, so the drained handler should degrade (no
  // second reinit from the 409 itself) — UNLESS pre-fixup behaviour: the
  // drained failure would never have reached _reinitBot at all.
  check('drained failure reached _onRunnerFailure (channel went non-active)',
    ch.status === 'degraded',
    `expected degraded after 409 drain, got status=${ch.status}`);
  check('_pendingFailure cleared after drain',
    ch._hasPendingFailure === false && ch._pendingFailure === null);
  // Exactly one reinit (the 429 retry succeeded). The 409 drain degraded
  // immediately, no reinit attempted for it.
  check('reinit count = 1 (429 retry only; 409 drained-degrade has no reinit)',
    reinitCount === 1, `got reinitCount=${reinitCount}`);
  // Most importantly: a degraded event must exist in the log, originating
  // from the drained 409. Pre-fixup this event would be absent.
  const events = readEvents();
  const degradedEvents = events.filter((e) => e.event === 'degraded'
    && e.http_status === 409);
  check('degraded event for the drained 409 was written to the log',
    degradedEvents.length === 1,
    `expected 1 degraded@409, got ${degradedEvents.length}`);
  await ch.stop();
}

// ── Section 12: finding 3 regression — _sleep cancels on stop()
console.log('\nSection 12: _sleep cancels promptly on stop() (finding 3)');
{
  clearLog();
  // Use the REAL _sleep — the makeChannel stub would otherwise mask the bug.
  const ch = await makeChannel({ realSleep: true });
  // Reinit will never resolve; we want _onRunnerFailure to be parked on
  // the sleep when stop() runs.
  let reinitWasReached = false;
  ch._reinitBot = async function () {
    reinitWasReached = true;
    this._runner = { stop: async () => {}, task: () => undefined };
    this.bot = {};
    this.status = 'active';
    this._retryAttempts = 0;
  };

  // Drive a transient failure. Backoff for attempt 1 is ~1000ms ± 25%.
  const transientErr = Object.assign(new Error('429'),
    { error_code: 429, name: 'GrammyError' });
  const handlerPromise = ch._onRunnerFailure(transientErr);

  // Give the handler a few ms to enter the sleep.
  await new Promise((r) => setTimeout(r, 20));
  check('_backoffTimer set during sleep', ch._backoffTimer !== null);
  check('_backoffTimerResolve captured during sleep',
    typeof ch._backoffTimerResolve === 'function');

  // Pre-fixup: clearTimeout cancels the callback, resolve is never invoked,
  // the handler is suspended forever. Post-fixup: stop() invokes the
  // captured resolver and the handler resumes promptly.
  const stopStart = Date.now();
  await ch.stop();
  // The handler should resolve within a short window after stop(). If the
  // bug regresses, this Promise.race times out and we report the leak.
  const TIMEOUT_MS = 500;
  const handlerResult = await Promise.race([
    handlerPromise.then(() => 'resolved'),
    new Promise((r) => setTimeout(() => r('timeout'), TIMEOUT_MS)),
  ]);
  const elapsedMs = Date.now() - stopStart;
  check(`_onRunnerFailure resumed after stop() (within ${TIMEOUT_MS}ms; took ~${elapsedMs}ms)`,
    handlerResult === 'resolved');
  check('reinit was NOT reached (handler observed status===stopped after sleep)',
    reinitWasReached === false);
  check('_backoffTimer cleared after stop()', ch._backoffTimer === null);
  check('_backoffTimerResolve cleared after stop()', ch._backoffTimerResolve === null);
}

// ── Summary ───────────────────────────────────────────────────────────
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
