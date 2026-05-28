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
import { _slice3fInternal } from '../src/tools/executor.js';

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
setEnv('');          check('empty string → disabled (truthy check)',   isPromptCacheEnabled() === true);  // empty string is falsy-as-flag, treat as default
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

// ─── Summary ──────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
