/**
 * Phase 5 Session 5 — Skill HTTP write approval gate
 *
 * Covers the gate that routes skill-parsed HTTP write tools
 * (POST/PUT/PATCH/DELETE) through requestApproval, closing the gap where
 * GHL write tools (create_notes, create_contacts, …) executed autonomously.
 *
 * Three seams:
 *   1. ToolRegistry.getSkillToolMethod() — HTTP verb lookup for skill
 *      tools (null for builtins / non-skill presets / unknown names).
 *   2. ApprovalGate.check() skill HTTP write gate — gates ANY skill tool
 *      whose HTTP method mutates, keyed on the method (not the agent-name
 *      prefix), evaluated BEFORE the destructive-verb and skill-dir bypass
 *      steps, backward-compatible with the existing two-arg signature.
 *      Includes adversarial regressions: non-charlie agents (echo /
 *      specialists), skill-dir path-arg smuggling, and method robustness.
 *   3. Integration — the executor seam (getSkillToolMethod feeding
 *      check() with { httpMethod }) actually routes a create_notes
 *      call to approval inside ToolExecutor.run().
 *
 * Run: node tests/approval-gate.test.js
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecApprovals } from '../src/security/approvals.js';
import { ApprovalGate } from '../src/security/approval-gate.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutor } from '../src/tools/executor.js';

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// A registry with the live GHL write/read tool shapes registered the same
// way registerSkillTool does in production (skill: preset + toolDef.method).
function buildRegistry() {
  const r = new ToolRegistry({}, {});
  const skill = (name) => ({ baseUrl: 'https://example.invalid', headers: {}, name });
  const def = (name, method) => ({
    name,
    method,
    path: '/x/',
    description: `${method} ${name}`,
    inputSchema: { type: 'object', properties: {} },
  });
  // Flow OS GHL — write tools (POST/PUT) + a read tool (GET)
  r.registerSkillTool('charlie', 'ghl', skill('ghl'), def('ghl__create_notes', 'POST'));
  r.registerSkillTool('charlie', 'ghl', skill('ghl'), def('ghl__update_contacts_id', 'PUT'));
  r.registerSkillTool('charlie', 'ghl', skill('ghl'), def('ghl__get_contacts_locationid_id_limit_25', 'GET'));
  // FSC GHL — read-only (GET)
  r.registerSkillTool('charlie', 'ghl-fsc', skill('ghl-fsc'), def('ghl-fsc__get_contacts', 'GET'));
  // A NON-charlie agent's write tool (echo is the code's default agent name;
  // specialists register under their own names). Its verb must be discoverable
  // exactly like charlie's — the gate keys on method, not the name prefix.
  r.registerSkillTool('echo', 'ghl', skill('ghl'), def('ghl__create_notes', 'POST'));
  // A skill tool with no explicit method (mirrors the `|| 'GET'` default)
  r.registerSkillTool('charlie', 'ghl', skill('ghl'), { name: 'ghl__ping', path: '/p/', description: 'ping', inputSchema: { type: 'object', properties: {} } });
  // A builtin — must be invisible to getSkillToolMethod
  r.registerBuiltin('read_file', { description: 'read', fn: async () => 'ok', scope: 'shared' });
  // A non-skill API preset entry — lives in _apiTools but preset.name is a
  // display name, not "skill:…" — must also be invisible.
  r._apiTools.set('NewsAPI__get_headlines', {
    preset: { name: 'NewsAPI', type: 'api' },
    toolDef: { name: 'get_headlines', method: 'GET' },
    scope: 'shared',
  });
  return r;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'qclaw-approval-gate-'));

  // ── 1. ToolRegistry.getSkillToolMethod ──────────────────────
  const registry = buildRegistry();
  check('getSkillToolMethod: POST write tool -> "POST"',
    registry.getSkillToolMethod('charlie__ghl__ghl__create_notes') === 'POST',
    `got ${registry.getSkillToolMethod('charlie__ghl__ghl__create_notes')}`);
  check('getSkillToolMethod: PUT write tool -> "PUT"',
    registry.getSkillToolMethod('charlie__ghl__ghl__update_contacts_id') === 'PUT');
  check('getSkillToolMethod: GET read tool -> "GET"',
    registry.getSkillToolMethod('charlie__ghl-fsc__ghl-fsc__get_contacts') === 'GET');
  check('getSkillToolMethod: method-less skill tool defaults to "GET"',
    registry.getSkillToolMethod('charlie__ghl__ghl__ping') === 'GET');
  check('getSkillToolMethod: builtin -> null',
    registry.getSkillToolMethod('read_file') === null,
    `got ${registry.getSkillToolMethod('read_file')}`);
  check('getSkillToolMethod: non-skill API preset -> null',
    registry.getSkillToolMethod('NewsAPI__get_headlines') === null,
    `got ${registry.getSkillToolMethod('NewsAPI__get_headlines')}`);
  check('getSkillToolMethod: unknown name -> null',
    registry.getSkillToolMethod('does__not__exist') === null);
  check('getSkillToolMethod: NON-charlie agent write tool -> "POST" (agent-agnostic)',
    registry.getSkillToolMethod('echo__ghl__ghl__create_notes') === 'POST',
    `got ${registry.getSkillToolMethod('echo__ghl__ghl__create_notes')}`);

  // ── 2. ApprovalGate.check() skill HTTP write gate ───────────
  const approvals = new ExecApprovals({ _dir: dir });
  approvals.attach(null);
  const gate = new ApprovalGate(approvals);

  const postRes = await gate.check('charlie__ghl__ghl__create_notes', { body: 'hi' }, { httpMethod: 'POST' });
  check('check: create_notes POST -> requiresApproval:true',
    postRes.requiresApproval === true, JSON.stringify(postRes));
  check('check: create_notes POST -> riskLevel:medium',
    postRes.riskLevel === 'medium', JSON.stringify(postRes));

  const getRes = await gate.check('charlie__ghl-fsc__ghl-fsc__get_contacts', {}, { httpMethod: 'GET' });
  check('check: FSC get_contacts GET -> requiresApproval:false',
    getRes.requiresApproval === false, JSON.stringify(getRes));

  const putRes = await gate.check('charlie__ghl__ghl__update_contacts_id', { id: '1' }, { httpMethod: 'PUT' });
  check('check: update PUT -> requiresApproval:true riskLevel:medium',
    putRes.requiresApproval === true && putRes.riskLevel === 'medium', JSON.stringify(putRes));

  const patchRes = await gate.check('charlie__ghl__ghl__patch_thing', {}, { httpMethod: 'patch' });
  check('check: PATCH (lower-case) -> gated, riskLevel:medium',
    patchRes.requiresApproval === true && patchRes.riskLevel === 'medium', JSON.stringify(patchRes));

  const delRes = await gate.check('charlie__ghl__ghl__delete_thing', {}, { httpMethod: 'DELETE' });
  check('check: DELETE -> requiresApproval:true riskLevel:high',
    delRes.requiresApproval === true && delRes.riskLevel === 'high', JSON.stringify(delRes));

  // Backward compatibility: two-arg call (no context) must still work.
  const legacyRes = await gate.check('charlie__ghl__ghl__create_notes', { body: 'hi' });
  check('check: two-arg (no context) is backward-compatible -> not gated',
    legacyRes.requiresApproval === false, JSON.stringify(legacyRes));

  // ── S3 regression: the gate keys on the HTTP method, not the agent-name
  // prefix. getSkillToolMethod yields a verb ONLY for skill tools, so a write
  // verb from ANY agent (echo, a specialist, a renamed primary) must gate.
  // Pre-fix these bypassed because the name wasn't `charlie__`-prefixed.
  const echoRes = await gate.check('echo__ghl__ghl__create_notes', { data: 'n' }, { httpMethod: 'POST' });
  check('check: NON-charlie skill write (echo) POST -> requiresApproval:true medium',
    echoRes.requiresApproval === true && echoRes.riskLevel === 'medium', JSON.stringify(echoRes));
  const specialistRes = await gate.check('qa-operator__ghl__ghl__delete_thing', {}, { httpMethod: 'DELETE' });
  check('check: NON-charlie specialist DELETE -> gated, riskLevel:high',
    specialistRes.requiresApproval === true && specialistRes.riskLevel === 'high', JSON.stringify(specialistRes));

  // ── S1 regression: a crafted path/cwd/destination arg resolving into the
  // skill-edit allowlist must NOT short-circuit the write gate. The write gate
  // now runs BEFORE _isSkillDirOperation, so the skill-dir bypass can't be
  // abused to smuggle an ungated CRM write.
  const skillDirArgs = [
    { data: 'n', path: '/root/QClaw/src/agents/skills/' },
    { data: 'n', cwd: '/root/QClaw/src/agents/skills/ghl.md' },
    { data: 'n', destination: '/root/QClaw/src/agents/skills/evil' },
  ];
  for (const args of skillDirArgs) {
    const res = await gate.check('charlie__ghl__ghl__create_notes', args, { httpMethod: 'POST' });
    check(`check: skill-dir arg [${Object.keys(args).filter(k => k !== 'data')}] does NOT bypass write gate`,
      res.requiresApproval === true, JSON.stringify({ args, res }));
  }

  // ── S2 regression: whitespace-padded method still gates (trim); a
  // non-string method must not throw (String() guard) and must not gate.
  const wsRes = await gate.check('charlie__ghl__ghl__create_notes', { data: 'n' }, { httpMethod: 'POST\n' });
  check('check: whitespace-padded method "POST\\n" -> still gated',
    wsRes.requiresApproval === true, JSON.stringify(wsRes));
  let threw = false;
  let objRes;
  try { objRes = await gate.check('charlie__ghl__ghl__create_notes', { data: 'n' }, { httpMethod: {} }); }
  catch { threw = true; }
  check('check: non-string method ({}) does not throw and does not gate',
    threw === false && objRes?.requiresApproval === false, `threw=${threw} res=${JSON.stringify(objRes)}`);

  // A charlie__ tool with a GET method is not gated by the write gate.
  const charlieGetRes = await gate.check('charlie__ghl__ghl__get_drafts_by_status', {}, { httpMethod: 'GET' });
  check('check: charlie__ GET tool -> NOT gated',
    charlieGetRes.requiresApproval === false, JSON.stringify(charlieGetRes));

  // Existing rules still intact: shell_exec stays gated (defence-in-depth,
  // via its own bypass/gatedTools path) and Stripe charge still critical.
  const stripeRes = await gate.check('stripe_charge', { action: 'charge' });
  check('check: stripe charge still gated (unchanged)',
    stripeRes.requiresApproval === true && stripeRes.riskLevel === 'critical', JSON.stringify(stripeRes));

  // ── 3. Integration — executor routes create_notes to approval ─
  // Real registry + real gate through the exact executor seam
  // (getSkillToolMethod → check({ httpMethod })). Only the model turn and
  // the human approval decision (external I/O) are stubbed.
  const intRegistry = buildRegistry();
  const intApprovals = new ExecApprovals({ _dir: dir });
  intApprovals.attach(null);
  const intGate = new ApprovalGate(intApprovals);

  let approvalRequestedFor = null;
  intGate.requestApproval = async (agent, toolName, toolArgs, riskLevel) => {
    approvalRequestedFor = { toolName, riskLevel };
    return { approved: false, reason: 'denied-by-test' };
  };

  const router = { primary: { provider: 'anthropic', model: 'test' } };
  const executor = new ToolExecutor(router, intRegistry, { approvalGate: intGate });

  // Stub the model turn: emit the create_notes call once, then terminate.
  let turn = 0;
  executor._completionWithTools = async () => {
    turn++;
    if (turn === 1) {
      return {
        content: '',
        toolCalls: [{ id: 't1', name: 'charlie__ghl__ghl__create_notes', args: { body: 'hi' } }],
        usage: {},
        model: 'test',
      };
    }
    return { content: 'done', toolCalls: [], usage: {}, model: 'test' };
  };
  // Keep message reconstruction out of scope for this smoke.
  executor._appendAnthropicToolLoop = (msgs) => msgs;

  const out = await executor.run([{ role: 'user', content: 'add a note' }], {});

  check('integration: create_notes routed to approval',
    approvalRequestedFor?.toolName === 'charlie__ghl__ghl__create_notes',
    JSON.stringify(approvalRequestedFor));
  check('integration: approval requested at riskLevel medium (POST)',
    approvalRequestedFor?.riskLevel === 'medium',
    JSON.stringify(approvalRequestedFor));
  const noteResult = out.toolResults.find(r => r.name === 'charlie__ghl__ghl__create_notes');
  check('integration: denied approval -> tool errors (POST never executed)',
    noteResult?.error === true && /denied/i.test(noteResult.result),
    JSON.stringify(noteResult));

  rmSync(dir, { recursive: true, force: true });
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('unexpected:', err);
    process.exit(2);
  });
