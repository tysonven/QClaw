/**
 * Slice 6b Unit 4 — specialist stub loop-break detection tests.
 * Run: node tests/specialist-loop-break.test.js
 *
 * Covers the pure typed-check helpers used by _processNonReflex: routed_back
 * detection (typed, not string match), no re-delegation (scan is side-effect
 * free), and sequential_only surfacing.
 */

import { isStubRoutedBack, isSequentialOnly, scanSpecialistResults } from '../src/tools/delegate-to.js';

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };

// Shape mirrors what the executor surfaces: { id, name, result(RAW object|string), error }.
const stubTR = {
  id: 'c1', name: 'delegate_to', error: false,
  result: {
    task_id: 'u1', specialist: 'build-specialist', status: 'stub_routed_back', routed_back: true,
    stub_result: { specialist: 'build-specialist', status: 'stub', task: 'check the thing', routed_back: true, message: 'x' },
  },
};
const queuedTR = { id: 'c2', name: 'delegate_to', error: false, result: { task_id: 't', specialist: 'content-studio-operator', status: 'queued', routed_back: false } };
const seqTR = { id: 'c3', name: 'delegate_to', error: false, result: { error: 'sequential_only', message: 'One specialist dispatch per turn.' } };
const otherTR = { id: 'c4', name: 'shell_exec', error: false, result: 'ok' };
const stringTR = { id: 'c5', name: 'delegate_to', error: false, result: 'routed_back true stub_routed_back' }; // string decoy

console.log('isStubRoutedBack (typed, not string match):');
check('true for a stub routed_back', isStubRoutedBack(stubTR) === true);
check('false for queued (live)', isStubRoutedBack(queuedTR) === false);
check('false for sequential_only', isStubRoutedBack(seqTR) === false);
check('false for a string decoy containing the words', isStubRoutedBack(stringTR) === false);
check('false for non-delegate tool', isStubRoutedBack(otherTR) === false);
check('false for null/garbage', isStubRoutedBack(null) === false && isStubRoutedBack({}) === false);

console.log('isSequentialOnly:');
check('true for sequential_only', isSequentialOnly(seqTR) === true);
check('false for stub', isSequentialOnly(stubTR) === false);
check('false for queued', isSequentialOnly(queuedTR) === false);

console.log('scanSpecialistResults (the _processNonReflex consumer):');
{
  const scan = scanSpecialistResults([otherTR, stubTR, queuedTR]);
  check('stubRoutedBack flag set', scan.stubRoutedBack === true);
  check('routedBack carries specialist + task', scan.routedBack.length === 1
    && scan.routedBack[0].specialist === 'build-specialist'
    && scan.routedBack[0].task === 'check the thing');
  check('queued (live) does NOT set stubRoutedBack alone', !scan.routedBack.some(r => r.specialist === 'content-studio-operator'));
}
{
  const scan = scanSpecialistResults([seqTR]);
  check('sequentialOnly surfaced cleanly', scan.sequentialOnly === true && scan.stubRoutedBack === false);
}
{
  // a turn with no delegate_to results → nothing flagged
  const scan = scanSpecialistResults([otherTR]);
  check('no specialist results → all flags false', scan.stubRoutedBack === false && scan.sequentialOnly === false && scan.routedBack.length === 0);
  const empty = scanSpecialistResults(undefined);
  check('undefined toolResults → safe empty scan', empty.stubRoutedBack === false && empty.routedBack.length === 0);
}

console.log('no re-delegation (scan is side-effect free / pure):');
{
  const input = [stubTR, queuedTR];
  const snapshot = JSON.stringify(input);
  scanSpecialistResults(input);
  check('input not mutated (no dispatch, no re-invoke)', JSON.stringify(input) === snapshot);
  // multiple stubs in one turn are all reported, none re-dispatched
  const two = scanSpecialistResults([stubTR, { ...stubTR, result: { ...stubTR.result, specialist: 'qa-operator', stub_result: { ...stubTR.result.stub_result, specialist: 'qa-operator', task: 'other' } } }]);
  check('multiple stubs all reported', two.routedBack.length === 2);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
