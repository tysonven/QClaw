/**
 * Reflex-table confirmation safety + delegate_to retirement contract.
 * Run: node tests/reflex-confirmation-safety.test.js
 *
 * REGRESSION GUARD for the 2026-08-14 incident: 'yes' / 'no' / 'ok' were Tier 0
 * canned replies, so every confirmation Tyson gave Charlie was answered without
 * an LLM call, without any tool surface, and without persisting the turn. A
 * "have specialist X do Y" / "yes" exchange produced "Noted." and nothing else.
 *
 * These tests exercise the REAL ModelRouter.classify() and the REAL
 * Agent.process() reflex branch. If anyone re-adds a word that can answer a
 * question to REFLEX_RESPONSES, [1] and [3] fail.
 */
import { ModelRouter } from '../src/models/router.js';
import { Agent } from '../src/agents/registry.js';
import { createDelegateToTool } from '../src/tools/delegate-to.js';

let pass = 0, fail = 0;
const ck = (l, c, d = '') => { if (c) { console.log(`  PASS  ${l}`); pass++; } else { console.error(`  FAIL  ${l} ${d}`); fail++; } };

const cfg = {
  models: {
    primary: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fast: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    routing: { enabled: true },
  },
};
const router = new ModelRouter(cfg, { get: async () => 'k' });

console.log('\n[1] classify(): confirmations must NOT be reflex');
for (const w of ['yes', 'no', 'ok', 'Yes', 'YES', ' yes ', 'No', 'OK']) {
  const r = router.classify(w);
  ck(`"${w}" -> tier=${r.tier} (not reflex)`, r.tier !== 'reflex', `got ${JSON.stringify(r)}`);
  ck(`"${w}" routes to a real model`, !!r.model, 'no model attached');
}

console.log('\n[2] classify(): genuine pleasantries still reflex (unchanged)');
for (const [w, expect] of [['hello','Hey! What can I do for you?'],['hi','Hi! What do you need?'],['hey',"Hey! What's up?"],['thanks','No problem.'],['thank you',"You're welcome."],['cheers','No worries.'],['ta','Anytime.'],['bye','Catch you later.']]) {
  const r = router.classify(w);
  ck(`"${w}" still reflex`, r.tier === 'reflex' && r.response === expect, JSON.stringify(r));
}

console.log('\n[3] Agent.process(): "yes"/"no"/"ok" reach _processNonReflex (LLM + tools)');
{
  const audited = [];
  const services = { router, memory: null, trustKernel: null, audit: { log: (...a) => audited.push(a) } };
  for (const w of ['yes', 'no', 'ok']) {
    const a = new Agent('charlie', null, services);
    let reached = false;
    a._processNonReflex = async () => { reached = true; return { content: 'LLM PATH', tier: 'standard' }; };
    const out = await a.process(w, {});
    ck(`process("${w}") reached _processNonReflex`, reached === true);
    ck(`process("${w}") did NOT short-circuit as reflex`, out.tier !== 'reflex', JSON.stringify(out));
  }
  const a2 = new Agent('charlie', null, services);
  a2._processNonReflex = async () => ({ content: 'LLM PATH', tier: 'standard' });
  const hello = await a2.process('hello', {});
  ck('process("hello") still short-circuits as reflex', hello.tier === 'reflex');
}

console.log('\n[4] delegate_to: no false-success shape for the formerly-live ids');
{
  const tool = createDelegateToTool({
    audit: null, env: { QCLAW_SPECIALIST_LIVE_IDS: 'content-studio-operator,community-manager-fsc' },
    getSpecialist: (n) => ({ id: String(n).toLowerCase(), isLive: true, isStub: false, status: 'live' }),
  });
  const r = await tool.fn({ specialist: 'community-manager-fsc', task: 'draft a test post' }, { channel: 'telegram', userId: 1375806243 });
  ck('routes back even with allowlist env populated', r.routed_back === true && r.status === 'stub_routed_back', JSON.stringify(r));
  ck('never returns queued', r.status !== 'queued');
  ck('inner status = retired', r.stub_result.status === 'retired');
  console.log('       message: ' + JSON.stringify(r.stub_result.message).slice(0, 120) + '...');
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail > 0 ? 1 : 0);
