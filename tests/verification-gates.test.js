/**
 * Slice 4 Unit 1 — substrate + framework + Gate 4 tests.
 * Run: node tests/verification-gates.test.js
 *
 * Covers: audit.js ISO-UTC timestamp + parseAuditTs (legacy + ISO) +
 * result_status capture + toolEventsSince time-window; gates.js detection
 * (sentence split, code-span strip, suppression), entity extraction +
 * correlatePairs + matchEvidence (entity backs / unrelated same-tool success
 * does NOT / no-entity fallback), Gate 4 (phantom caught, real passes,
 * code-fenced not flagged), runGates (kill-switch, fail-closed on throw);
 * gate-log unanchored scrub + shape.
 * Design ref: /tmp/slice4_design.md §1, §2, §2.5, §3, §8.
 */

import { AuditLog, parseAuditTs } from '../src/security/audit.js';
import {
  splitSentences, stripCodeSpans, isSuppressed, extractEntities, correlatePairs,
  matchEvidence, gateToolReference, runGates,
} from '../src/agents/gates.js';
import { appendGateLog } from '../src/observability/gate-log.js';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label} ${detail}`); failed++; }
}
const dir = mkdtempSync(join(tmpdir(), 'gates-'));

console.log('audit.js substrate:');
const audit = new AuditLog({ _dir: dir });
audit.log('tool', 'deploy', '{"id":"Qf39NEOEgz2W0uls"}');               // call row
audit.log('tool', 'deploy', 'Workflow updated', { resultStatus: 'success' }); // result row
audit.log('tool', 'probe', '{"x":1}', { resultStatus: 'error' });
const recent = audit.recent(10);
check('timestamp stored as ISO (has T)', recent[0].timestamp.includes('T'));
check('result_status captured (success)', recent.some(r => r.action === 'deploy' && r.result_status === 'success'));
check('result_status captured (error)', recent.some(r => r.action === 'probe' && r.result_status === 'error'));
check('call row has null result_status', recent.some(r => r.action === 'deploy' && r.result_status == null));
check('parseAuditTs ISO', parseAuditTs('2026-06-04T08:42:32.000Z') === Date.parse('2026-06-04T08:42:32.000Z'));
check('parseAuditTs legacy space-format → UTC', parseAuditTs('2026-06-04 08:42:32') === Date.parse('2026-06-04T08:42:32Z'));
check('parseAuditTs junk → NaN', Number.isNaN(parseAuditTs('not a date')));
check('toolEventsSince includes recent', audit.toolEventsSince(new Date(Date.now() - 60000).toISOString()).length >= 3);
check('toolEventsSince excludes future cutoff', audit.toolEventsSince(new Date(Date.now() + 60000).toISOString()).length === 0);

console.log('detection helpers:');
check('splitSentences splits on . and newline', splitSentences('Done. It works.\nNext thing').length === 3);
check('stripCodeSpans removes fenced', !stripCodeSpans('text ```charlie__nope__x``` more').includes('nope'));
check('stripCodeSpans removes inline code', !stripCodeSpans('use `charlie__nope__x` now').includes('nope'));
check('suppressed: interrogative ?', isSuppressed('is it working?') === true);
check('suppressed: interrogative open', isSuppressed('Did I deploy it') === true);
check('suppressed: negation', isSuppressed('this is not done') === true);
check('suppressed: future', isSuppressed("I'll deploy it now") === true);
check('suppressed: once-conditional', isSuppressed('once X is deployed we ship') === true);
check('suppressed: quoted', isSuppressed('"it is done"') === true);
check('NOT suppressed: plain assertion', isSuppressed('the workflow is deployed') === false);

console.log('entity + evidence matching:');
check('extractEntities long id', extractEntities('deployed Qf39NEOEgz2W0uls now').includes('Qf39NEOEgz2W0uls'));
check('extractEntities file path', extractEntities('fixed /root/QClaw/src/x.js').some(e => e.includes('x.js')));
check('extractEntities none in vague', extractEntities('it is done').filter(e => e.length >= 12).length === 0);
// id-DESC events (result row higher id → precedes call row); detail embeds the call id.
const evNow = new Date().toISOString();
const events = [
  { action: 'deploy', detail: '{"id":"toolu_1","result":"Workflow updated"}', result_status: 'success', timestamp: evNow },
  { action: 'deploy', detail: '{"id":"toolu_1","args":{"id":"Qf39NEOEgz2W0uls"}}', result_status: null, timestamp: evNow },
];
check('correlatePairs pairs result+call by id', correlatePairs(events).length === 1);
check('matchEvidence: entity in call args → backed', matchEvidence('deployed Qf39NEOEgz2W0uls', events, { requireStatus: 'success' }).backed === true);
check('matchEvidence: UNRELATED entity, same tool success → NOT backed', matchEvidence('deployed WkXX0000zz9988yy', events, { requireStatus: 'success' }).backed === false);
check('matchEvidence: error-only row → not backed for success', matchEvidence('deployed Qf39NEOEgz2W0uls', [
  { action: 'deploy', detail: '{"id":"toolu_2","result":"boom"}', result_status: 'error', timestamp: evNow },
  { action: 'deploy', detail: '{"id":"toolu_2","args":{"id":"Qf39NEOEgz2W0uls"}}', result_status: null, timestamp: evNow },
], { requireStatus: 'success' }).backed === false);
check('matchEvidence: no-entity this-turn fallback → backed weak', (() => {
  const r = matchEvidence('it is done', events, { requireStatus: 'success', turnStartMs: Date.now() - 120000 });
  return r.backed === true && r.weak === true;
})());
check('matchEvidence: no-entity, evidence pre-dates turn → not backed', matchEvidence('it is done', events, { requireStatus: 'success', turnStartMs: Date.now() + 60000 }).backed === false);
// P1-2: interleaved cross-agent rows — id correlation must pair correctly (errored claim not success-backed)
const interleaved = [
  { action: 'deploy', detail: '{"id":"BB","result":"boom"}', result_status: 'error', timestamp: evNow },
  { action: 'deploy', detail: '{"id":"AA","result":"ok"}', result_status: 'success', timestamp: evNow },
  { action: 'deploy', detail: '{"id":"BB","args":{"id":"WorkflowBB990000"}}', result_status: null, timestamp: evNow },
  { action: 'deploy', detail: '{"id":"AA","args":{"id":"WorkflowAA110000"}}', result_status: null, timestamp: evNow },
];
check('interleaved: errored BB claim NOT success-backed', matchEvidence('deployed WorkflowBB990000', interleaved, { requireStatus: 'success' }).backed === false);
check('interleaved: AA success claim backed', matchEvidence('deployed WorkflowAA110000', interleaved, { requireStatus: 'success' }).backed === true);
// P2: common English word must NOT be treated as an entity that spuriously backs a claim
const cfgEvents = [
  { action: 'set_config', detail: '{"id":"C1","result":"configuration saved"}', result_status: 'success', timestamp: evNow },
  { action: 'set_config', detail: '{"id":"C1","args":{"configuration":"x"}}', result_status: null, timestamp: evNow },
];
check('common word "configuration" not a spurious entity', matchEvidence('the configuration is fixed', cfgEvents, { requireStatus: 'success', turnStartMs: Date.now() + 60000 }).backed === false);

console.log('Gate 4 (tool reference):');
const reg = { has: (n) => ['charlie__ghl__get_contacts', 'web_fetch'].includes(n) };
check('phantom tool → fired hard', (() => { const g = gateToolReference('I used charlie__nope__doit to fix it', { toolRegistry: reg }); return g.fired && g.severity === 'hard'; })());
check('real tool → not fired', gateToolReference('I used charlie__ghl__get_contacts', { toolRegistry: reg }).fired === false);
check('phantom in code fence → NOT flagged (Gate 4 strips code)', gateToolReference('example: ```charlie__nope__doit```', { toolRegistry: reg }).fired === false);

console.log('runGates framework:');
check('kill-switch QCLAW_GATES_ENABLED=0 → pass+disabled', (() => {
  process.env.QCLAW_GATES_ENABLED = '0';
  const r = runGates('I used charlie__nope__doit', audit, reg, {});
  delete process.env.QCLAW_GATES_ENABLED;
  return r.result === 'pass' && r.disabled === true;
})());
check('enabled: phantom → hard_fail', runGates('used charlie__nope__doit', audit, reg, {}).result === 'hard_fail');
check('clean response → pass', runGates('all good, nothing to verify here', audit, reg, {}).result === 'pass');
check('fail-closed: throwing registry → hard_fail (no throw out)', (() => {
  const badReg = { has: () => { throw new Error('boom'); } };
  const r = runGates('used charlie__x__y', audit, badReg, {});
  return r.result === 'hard_fail';
})());

console.log('gate-log:');
process.env.QCLAW_GATE_LOG_PATH = join(dir, 'gate.log');
appendGateLog({ gate: 'completion', claim: 'done; key sk-ant-admin01-SECRET123 here', result: 'hard_fail', action: 'reprompt', attempt: 1, verified: false });
const gl = readFileSync(join(dir, 'gate.log'), 'utf-8').trim();
const glRow = JSON.parse(gl);
check('gate.log JSONL shape', glRow.gate === 'completion' && glRow.result === 'hard_fail' && glRow.attempt === 1);
check('gate.log scrubs mid-string sk-ant key', !gl.includes('SECRET123') && gl.includes('<scrubbed>'));
check('gate.log mode 0600', (statSync(join(dir, 'gate.log')).mode & 0o777) === 0o600);
delete process.env.QCLAW_GATE_LOG_PATH;

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
