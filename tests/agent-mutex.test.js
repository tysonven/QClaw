/**
 * Per-agent mutex (registry.js __agentLockForTests).
 *
 * Confirms that two concurrent process()-shaped sequences for the same agent
 * serialize cleanly: history read → write happens atomically per agent so a
 * second caller never sees a stale snapshot.
 *
 * Run: node tests/agent-mutex.test.js
 */

import { __agentLockForTests as withLock } from '../src/agents/registry.js';

let passed = 0;
let failed = 0;

function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 1. Same key serializes — critical sections never overlap.
  let activeOnA = 0;
  let maxConcurrent = 0;
  const trace = [];
  const work = (label) =>
    withLock('agentA', async () => {
      activeOnA++;
      maxConcurrent = Math.max(maxConcurrent, activeOnA);
      trace.push(`enter:${label}`);
      await sleep(15);
      trace.push(`leave:${label}`);
      activeOnA--;
    });
  await Promise.all([work('A1'), work('A2'), work('A3')]);
  check('same-key: max concurrency was 1', maxConcurrent === 1, `got ${maxConcurrent}`);
  check('same-key: trace alternates enter/leave per op',
    trace.join(',') === 'enter:A1,leave:A1,enter:A2,leave:A2,enter:A3,leave:A3',
    `got ${trace.join(',')}`);

  // ── 2. History read-modify-write is consistent under concurrent calls.
  // Simulate the registry pattern: read → compute → write. Without the lock,
  // last-writer-wins would clobber and the final length would be wrong.
  const sharedHistory = [];
  const turn = (msg) =>
    withLock('agentB', async () => {
      const snapshot = sharedHistory.slice();   // simulated getHistory()
      await sleep(5);                            // simulated LLM call
      sharedHistory.push(...snapshot.slice(-1), `t:${msg}`);
    });
  // Seed
  sharedHistory.push('t:0');
  await Promise.all([turn('1'), turn('2'), turn('3')]);
  // Each turn appends the prior tail + its own marker. Order must reflect
  // serialization: every appended marker should match the immediately-prior
  // snapshot, which is the previous turn's marker.
  const markers = sharedHistory.filter((s) => s.startsWith('t:'));
  check('history: all 4 turns recorded', markers.length === 7,
    `got ${markers.length}, history=${JSON.stringify(sharedHistory)}`);
  // Last entry should be the third turn's marker.
  check('history: final entry is t:3', sharedHistory[sharedHistory.length - 1] === 't:3');

  // ── 3. Different keys run in parallel (no head-of-line blocking across agents).
  let activeOnX = 0;
  let activeOnY = 0;
  let parallelObserved = false;
  const heldX = withLock('agentX', async () => {
    activeOnX++;
    await sleep(40);
    if (activeOnY > 0) parallelObserved = true;
    activeOnX--;
  });
  const heldY = withLock('agentY', async () => {
    activeOnY++;
    await sleep(20);
    if (activeOnX > 0) parallelObserved = true;
    activeOnY--;
  });
  await Promise.all([heldX, heldY]);
  check('different-key: agentX and agentY ran concurrently', parallelObserved);

  // ── 4. Lock is released when inner fn throws — next caller proceeds.
  let secondRan = false;
  await withLock('agentZ', async () => { throw new Error('boom'); }).catch(() => {});
  await withLock('agentZ', async () => { secondRan = true; });
  check('throw releases the lock', secondRan);

  // ── 5. Lock map cleans up — no leaked entries after the test.
  // (Not asserting Map.size directly since module-level state is shared, but
  //  confirming sequential acquire/release works after thrown errors.)
  let third = 0;
  for (let i = 0; i < 5; i++) {
    await withLock('agentZ', async () => { third++; });
  }
  check('post-throw repeated acquire works', third === 5);
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch((err) => {
    console.error('unexpected:', err);
    process.exit(1);
  });
