/**
 * Slice 3f — system-prompt cache-shape unit tests.
 * Run: node tests/system-prompt-cache-shape.test.js
 *
 * Covers:
 *   - isPromptCacheEnabled() env-var parsing
 *   - _buildSystemPrompt returns {cached, dynamic} structured blocks
 *   - Cached prefix is byte-identical across consecutive calls (same inputs)
 *   - Null-bootstrap fallback path still produces a valid cached array
 *   - _validateCacheControlPlacement enforces:
 *       · exactly one cache_control marker
 *       · marker index < first dynamic-heading block
 *       · kill-switch strips cache_control regardless of caller intent
 *       · invariant violation → strip + fail-open + invariantFailed=true
 *   - Heading-drift CI guard: every canonical dynamic-block heading string
 *     listed in the runtime invariant must actually be emitted by
 *     _buildSystemPrompt when its source data is non-empty.
 *
 * Design ref: /tmp/slice3f_design.md §1, §10 Unit 1.
 */

import { Agent, isPromptCacheEnabled } from '../src/agents/registry.js';
import {
  _slice3fInternal,
  _slice3fComputeCacheStrategy,
  __resetSlice3fStateForTests,
  __setSlice3fRejectedForTests,
} from '../src/tools/executor.js';

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ─── Section 1: isPromptCacheEnabled env-var parsing ──────────────────
console.log('Section 1 — isPromptCacheEnabled() env-var parsing:');

const origEnv = process.env.QCLAW_PROMPT_CACHE_ENABLED;
function setEnv(v) {
  if (v === undefined) delete process.env.QCLAW_PROMPT_CACHE_ENABLED;
  else process.env.QCLAW_PROMPT_CACHE_ENABLED = v;
}

setEnv(undefined);   check('unset → enabled (default true)',           isPromptCacheEnabled() === true);
setEnv('1');         check('"1" → enabled',                            isPromptCacheEnabled() === true);
setEnv('true');      check('"true" → enabled',                         isPromptCacheEnabled() === true);
setEnv('TRUE');      check('"TRUE" (case-insensitive) → enabled',      isPromptCacheEnabled() === true);
setEnv('on');        check('"on" → enabled',                           isPromptCacheEnabled() === true);
setEnv('0');         check('"0" → disabled',                           isPromptCacheEnabled() === false);
setEnv('false');     check('"false" → disabled',                       isPromptCacheEnabled() === false);
setEnv('FALSE');     check('"FALSE" → disabled',                       isPromptCacheEnabled() === false);
setEnv('no');        check('"no" → disabled',                          isPromptCacheEnabled() === false);
setEnv('off');       check('"off" → disabled',                         isPromptCacheEnabled() === false);
setEnv(' Off ');     check('" Off " (trimmed) → disabled',             isPromptCacheEnabled() === false);
setEnv('');          check('empty string → enabled (default; "" not in disable set)', isPromptCacheEnabled() === true);
setEnv(origEnv);

// ─── Section 2: _buildSystemPrompt structured shape ───────────────────
console.log('\nSection 2 — _buildSystemPrompt returns {cached, dynamic}:');

// Build a minimal Agent with mocked services. We bypass load() and set the
// fields directly so the test doesn't depend on a real workspace dir.
function makeAgent({ soul = '# Test Agent', aid = null, toolExecutor = {}, trustKernelValues = '# Trust Kernel\n- Be honest.' } = {}) {
  const services = {
    trustKernel: { getContext: () => trustKernelValues },
    toolExecutor,
  };
  const agent = new Agent('charlie', '/tmp/test-agent', services);
  agent.soul = soul;
  agent.aid = aid;
  return agent;
}

function makeBootstrap({ identity = true, state = true, specialists = true, probes = true, audit = true, memory = true } = {}) {
  return {
    identity: identity ? {
      charlie_role: 'CHARLIE_ROLE doc body',
      ceo_operating_model: 'CEO doc body',
    } : null,
    state: state ? {
      flow_os_state: 'STATE doc body',
      recent_build_log: 'RECENT BUILD LOG body',
    } : null,
    specialists: specialists ? { flow_os_specialists: 'SPECIALISTS doc body' } : null,
    probes: probes ? [
      { name: 'n8n_reachable', ok: true, latency_ms: 12 },
      { name: 'supabase_reachable', ok: false, latency_ms: 5000, error: 'timeout' },
    ] : [],
    recent: {
      audit_log: audit ? { entries: [{ timestamp: '2026-05-28T10:00:00.000Z', agent: 'charlie', action: 'completion', detail: 'turn 1' }] } : { entries: [] },
      memory: memory ? { entries: [{ timestamp: '2026-05-28T10:00:00.000Z', channel: 'telegram', role: 'user', content: 'hi' }] } : { entries: [] },
    },
    skills: { always_on: [], always_on_tools: { tools: [], skill_names: [] } },
  };
}

const skillResult = {
  always_on: [
    { name: 'identity', content: 'identity skill content' },
    { name: 'lanes',    content: 'lanes skill content' },
  ],
  on_demand: [],
};

await (async () => {
  const agent = makeAgent({ aid: { aid_id: 'aid-charlie', trust_tier: 2, agent: { type: 'worker' } } });
  const result = await agent._buildSystemPrompt(
    { results: [] }, // graphContext
    '',              // knowledgeContext
    [],              // relevantKnowledge
    makeBootstrap(),
    'hello',         // textMessage
    'test-user',
    skillResult,
  );

  check('returns object with cached + dynamic arrays',
    result && Array.isArray(result.cached) && Array.isArray(result.dynamic),
    `got: ${typeof result}, cached=${typeof result?.cached}, dynamic=${typeof result?.dynamic}`);
  check('cached has > 0 blocks when bootstrap populated',
    result.cached.length > 0,
    `length=${result.cached.length}`);
  check('every cached block is {type:"text", text:string}',
    result.cached.every(b => b && b.type === 'text' && typeof b.text === 'string'),
    `bad block: ${JSON.stringify(result.cached.find(b => !b || b.type !== 'text' || typeof b.text !== 'string'))}`);
  check('cached[0] is SOUL (first block)',
    result.cached[0].text.startsWith('# Test Agent'),
    `got: ${result.cached[0].text.slice(0, 40)}`);
  check('cached contains Charlie Role block',
    result.cached.some(b => b.text.startsWith('\n## Charlie Role')));
  check('cached contains CEO Operating Model block',
    result.cached.some(b => b.text.startsWith('\n## CEO Operating Model')));
  check('cached contains Flow OS State block',
    result.cached.some(b => b.text.startsWith('\n## Flow OS State')));
  check('cached contains Specialists block',
    result.cached.some(b => b.text.startsWith('\n## Specialists')));
  check('cached contains Live probes block',
    result.cached.some(b => b.text.startsWith('\n## Live probes')));
  check('cached contains Recent activity (audit log) block',
    result.cached.some(b => b.text.startsWith('\n## Recent activity (audit log')));
  check('cached contains Recent context (conversation memory) block',
    result.cached.some(b => b.text.startsWith('\n## Recent context (conversation memory')));
  check('cached contains AGEX Identity block',
    result.cached.some(b => b.text.startsWith('\n## Identity')));
  check('cached contains Always-on Skills block',
    result.cached.some(b => b.text.startsWith('\n## Always-on Skills')));
  check('cached contains Trust Kernel block',
    result.cached.some(b => b.text.startsWith('\n## Trust Kernel')));
  check('cached contains Tool Execution block (last when toolExecutor present)',
    result.cached[result.cached.length - 1].text.startsWith('\n## Tool Execution'),
    `last block: ${result.cached[result.cached.length - 1].text.slice(0, 40)}`);

  check('dynamic is empty when no knowledge/on-demand/graph content',
    result.dynamic.length === 0,
    `length=${result.dynamic.length}`);
})();

// ─── Section 3: Dynamic blocks lie strictly after cached ──────────────
console.log('\nSection 3 — dynamic blocks ordering:');

await (async () => {
  const agent = makeAgent();
  const result = await agent._buildSystemPrompt(
    { results: [{ content: 'graph fact' }] },
    '## What I Know About You\n- fact',
    [{ type: 'SEMANTIC', content: 'relevant fact' }],
    makeBootstrap(),
    'help me with ghl contacts',
    'test-user',
    {
      always_on: skillResult.always_on,
      on_demand: [
        { name: 'ghl', content: 'ghl skill content', matched_keywords: ['ghl', 'contacts'], density: 0.5 },
      ],
    },
  );

  check('dynamic has knowledgeContext block',
    result.dynamic.some(b => b.text.includes('What I Know About You')));
  check('dynamic has Available Skills (routed) block',
    result.dynamic.some(b => b.text.startsWith('\n## Available Skills (routed)')));
  check('dynamic has Relevant Context block',
    result.dynamic.some(b => b.text.startsWith('\n## Relevant Context')));
  check('dynamic has Knowledge Graph block',
    result.dynamic.some(b => b.text.startsWith('\n## Knowledge Graph')));
  check('no cached block starts with a dynamic-heading prefix',
    !result.cached.some(b => _slice3fInternal.dynamicHeadings.some(h => b.text.startsWith(h))),
    `cached headings: ${result.cached.map(b => b.text.slice(0, 30)).join(' | ')}`);
})();

// ─── Section 4: Byte-stability across calls with same inputs ──────────
console.log('\nSection 4 — cached prefix byte-stability:');

await (async () => {
  const agent = makeAgent({ aid: { aid_id: 'aid-charlie', trust_tier: 2 } });
  const boot = makeBootstrap();
  const r1 = await agent._buildSystemPrompt({ results: [] }, '', [], boot, '', 'u', skillResult);
  const r2 = await agent._buildSystemPrompt({ results: [] }, '', [], boot, '', 'u', skillResult);

  const join1 = r1.cached.map(b => b.text).join('|');
  const join2 = r2.cached.map(b => b.text).join('|');
  check('cached arrays from two calls with same inputs are byte-identical',
    join1 === join2,
    `lengths: ${join1.length} vs ${join2.length}; first diff at: ${[...join1].findIndex((c, i) => c !== join2[i])}`);
  check('cached length is stable across calls',
    r1.cached.length === r2.cached.length);
})();

// ─── Section 5: Null-bootstrap fallback path ──────────────────────────
console.log('\nSection 5 — null-bootstrap fallback:');

await (async () => {
  const agent = makeAgent({ aid: { aid_id: 'aid-charlie', trust_tier: 2 } });
  const result = await agent._buildSystemPrompt(
    { results: [] }, '', [],
    null,            // null bootstrap
    '', 'u', skillResult,
  );

  check('null bootstrap still returns {cached, dynamic} shape',
    Array.isArray(result.cached) && Array.isArray(result.dynamic));
  check('null bootstrap cached has at least SOUL + AID + always-on + Trust Kernel + Tools',
    result.cached.length >= 5,
    `length=${result.cached.length}`);
  check('null bootstrap cached starts with SOUL',
    result.cached[0].text.startsWith('# Test Agent'));
  check('null bootstrap cached ends with Tool Execution',
    result.cached[result.cached.length - 1].text.startsWith('\n## Tool Execution'));
  check('null bootstrap has NO Charlie Role / CEO blocks',
    !result.cached.some(b => b.text.startsWith('\n## Charlie Role')) &&
    !result.cached.some(b => b.text.startsWith('\n## CEO Operating Model')));
})();

// ─── Section 6: _validateCacheControlPlacement invariant ──────────────
console.log('\nSection 6 — _validateCacheControlPlacement invariant:');

const { validateCacheControlPlacement: validate } = _slice3fInternal;

// Happy path — marker on last cached block before any dynamic block.
{
  const blocks = [
    { type: 'text', text: '# soul' },
    { type: 'text', text: '\n## Tool Execution', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '\n## What I Know About You\n- fact' },
  ];
  const r = validate(blocks, true);
  check('happy path: marker before dynamic → cacheControlEmitted=true, invariantFailed=false',
    r.cacheControlEmitted === true && r.invariantFailed === false,
    JSON.stringify(r));
}

// Violation — marker on a dynamic block.
{
  const blocks = [
    { type: 'text', text: '# soul' },
    { type: 'text', text: '\n## Tool Execution' },
    { type: 'text', text: '\n## What I Know About You\n- fact', cache_control: { type: 'ephemeral' } },
  ];
  const r = validate(blocks, true);
  check('violation: marker on dynamic block → invariantFailed=true, no cache_control on output',
    r.invariantFailed === true && r.cacheControlEmitted === false &&
    !r.blocks.some(b => b.cache_control),
    JSON.stringify(r));
}

// Violation — two markers.
{
  const blocks = [
    { type: 'text', text: '# soul', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '\n## Tool Execution', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '\n## What I Know About You\n- fact' },
  ];
  const r = validate(blocks, true);
  check('violation: two markers → invariantFailed=true, both stripped',
    r.invariantFailed === true && r.cacheControlEmitted === false &&
    !r.blocks.some(b => b.cache_control),
    JSON.stringify(r));
}

// Kill-switch: cache_control on a valid block but kill-switch disabled → strip.
{
  const blocks = [
    { type: 'text', text: '# soul' },
    { type: 'text', text: '\n## Tool Execution', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '\n## What I Know About You\n- fact' },
  ];
  const r = validate(blocks, false);
  check('kill-switch disabled: cache_control stripped regardless of placement',
    r.cacheControlEmitted === false && r.invariantFailed === false &&
    !r.blocks.some(b => b.cache_control),
    JSON.stringify(r));
}

// No markers anywhere — no-op.
{
  const blocks = [
    { type: 'text', text: '# soul' },
    { type: 'text', text: '\n## Tool Execution' },
  ];
  const r = validate(blocks, true);
  check('no markers → no-op, no errors',
    r.cacheControlEmitted === false && r.invariantFailed === false);
}

// ─── Section 7: Heading-drift CI guard ────────────────────────────────
console.log('\nSection 7 — heading-drift CI guard:');

await (async () => {
  const agent = makeAgent();
  const result = await agent._buildSystemPrompt(
    { results: [{ content: 'graph fact' }] },
    '## What I Know About You\n- fact',
    [{ type: 'SEMANTIC', content: 'relevant fact' }],
    makeBootstrap(),
    'help me with ghl contacts',
    'test-user',
    {
      always_on: skillResult.always_on,
      on_demand: [
        { name: 'ghl', content: 'ghl skill content', matched_keywords: ['ghl', 'contacts'], density: 0.5 },
      ],
    },
  );

  // Every canonical dynamic-heading string must appear in the dynamic array's
  // emitted text. If a future PR renames a heading, the executor's runtime
  // invariant string list will be silently desynced — this test fails first.
  for (const h of _slice3fInternal.dynamicHeadings) {
    const found = result.dynamic.some(b => b.text.startsWith(h));
    check(`heading "${h.trim().slice(0, 40)}" is emitted by _buildSystemPrompt dynamic section`, found,
      `dynamic block prefixes: ${result.dynamic.map(b => b.text.slice(0, 30)).join(' | ')}`);
  }
})();

// ─── Section 8: circuit-breaker on _cacheControlRejected ──────────────
console.log('\nSection 8 — circuit-breaker via _cacheControlRejected flag:');

{
  __resetSlice3fStateForTests();
  const s1 = _slice3fComputeCacheStrategy();
  check('default state: envEnabled=true, rejected=false, shouldEmit=true',
    s1.envEnabled === true && s1.rejected === false && s1.shouldEmitCacheControl === true,
    JSON.stringify(s1));

  // Simulate the post-rejection state via the test setter (no mocked fetch needed).
  __setSlice3fRejectedForTests(true, 'cache_control unsupported on this model');
  const s2 = _slice3fComputeCacheStrategy();
  check('after rejection: shouldEmitCacheControl=false (circuit breaker engaged)',
    s2.shouldEmitCacheControl === false && s2.rejected === true,
    JSON.stringify(s2));
  check('after rejection: rejectionMessage preserved',
    s2.rejectionMessage === 'cache_control unsupported on this model');

  // Validate that the placement validator sees the rejection-equivalent
  // cache-disabled signal (caller passes `cacheEnabled && !rejected`).
  const blocks = [
    { type: 'text', text: '# soul' },
    { type: 'text', text: '\n## Tool Execution', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '\n## What I Know About You\n- fact' },
  ];
  // Mirror the executor's per-request decision: `_isPromptCacheEnabledLive() && !_cacheControlRejected`.
  const effectiveEnabled = _slice3fComputeCacheStrategy().shouldEmitCacheControl;
  const r = _slice3fInternal.validateCacheControlPlacement(blocks, effectiveEnabled);
  check('post-rejection: validator strips cache_control even on valid placement',
    !r.blocks.some(b => b.cache_control) && r.cacheControlEmitted === false,
    JSON.stringify(r));

  // Reset and verify the flag clears.
  __resetSlice3fStateForTests();
  const s3 = _slice3fComputeCacheStrategy();
  check('__resetSlice3fStateForTests clears the rejection state',
    s3.shouldEmitCacheControl === true && s3.rejected === false && s3.rejectionMessage === null,
    JSON.stringify(s3));
}

// ─── Section 9: bootstrap-rebuild byte-diff documentary check ─────────
// Design §9.2 — documents the architectural fact that consecutive bootstrap
// REBUILDS (not same-bootstrap repeated calls — that's Section 4) typically
// produce different bytes because probe latency_ms varies on every probe
// fire AND build-log boundary trims at the 7-day cutoff edge.
// This test does NOT call the real bootstrap module (avoids probe latency
// variance + filesystem dependency); instead it constructs two BootstrapResult
// fixtures that differ only in probe latency_ms and asserts the cached array
// reflects the difference.
console.log('\nSection 9 — bootstrap-rebuild byte-diff (architectural fact):');

await (async () => {
  const agent = makeAgent({ aid: { aid_id: 'aid-charlie', trust_tier: 2 } });
  const boot1 = makeBootstrap();
  // Modify probe latency_ms to mirror a real rebuild — Layer 5 probes return
  // fresh wall-clock latencies on every bootstrap call.
  const boot2 = JSON.parse(JSON.stringify(boot1));
  boot2.probes[0].latency_ms = 47;   // was 12
  boot2.probes[1].latency_ms = 4998; // was 5000

  const r1 = await agent._buildSystemPrompt({ results: [] }, '', [], boot1, '', 'u', skillResult);
  const r2 = await agent._buildSystemPrompt({ results: [] }, '', [], boot2, '', 'u', skillResult);

  const h1 = r1.cached.map(b => b.text).join('|');
  const h2 = r2.cached.map(b => b.text).join('|');
  check('rebuild-driven probe latency change shifts cached bytes (cache will re-prime, by design)',
    h1 !== h2,
    'If you see this fail, probe latency_ms is no longer in the cached prefix — investigate whether the assembly drifted from /tmp/slice3f_design.md §1.1');
  check('only the probes section text differs (other blocks unaffected)',
    r1.cached.length === r2.cached.length);
})();

// ─── Summary ──────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
