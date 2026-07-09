/**
 * Phase 5 Session 5 — Skill HTTP write approval gate
 *
 * Covers the gate that routes skill-parsed HTTP write tools
 * (charlie__<skill>__<skill>__<endpoint> using POST/PUT/PATCH/DELETE)
 * through requestApproval, closing the gap where GHL write tools
 * (create_notes, create_contacts, …) executed autonomously.
 *
 * Three seams:
 *   1. ToolRegistry.getSkillToolMethod() — HTTP verb lookup for skill
 *      tools (null for builtins / non-skill presets / unknown names).
 *   2. ApprovalGate.check() step 2b — gates charlie__ prefixed skill
 *      tools whose HTTP method mutates, backward-compatible with the
 *      existing two-arg signature.
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

  // ── 2. ApprovalGate.check() step 2b ─────────────────────────
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
  check('check: two-arg (no context) is backward-compatible -> not gated by step 2b',
    legacyRes.requiresApproval === false, JSON.stringify(legacyRes));

  // Non-skill tool with a write method must NOT be gated by step 2b
  // (the charlie__ prefix is required). shell_exec is still gated by its
  // own rule; use a neutral name to isolate step 2b.
  const nonSkillRes = await gate.check('some_random_tool', {}, { httpMethod: 'POST' });
  check('check: non-charlie tool with POST -> NOT gated by step 2b',
    nonSkillRes.requiresApproval === false, JSON.stringify(nonSkillRes));

  // A charlie__ tool with a GET method is not gated by step 2b.
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
