#!/usr/bin/env node
/**
 * Slice 3f — verify-cache-hits.js
 *
 * End-to-end verification that Anthropic prompt caching is working with the
 * exact request shape Slice 3f's _anthropicWithTools emits: system as an
 * array of content blocks with cache_control: {type:'ephemeral'} on the last
 * bootstrap-stable block.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/verify-cache-hits.js
 *
 * Cost: ~$0.025 per run for Claude Haiku 4.5
 *   - Turn 1 cache write: ~10K input tokens × 1.25× = $0.0125
 *   - Turn 2 cache read:  ~10K input tokens × 0.10× = $0.0010
 *   - Small dynamic + output on both turns: ~$0.005
 * Re-running burns API credit; treat as intentional.
 *
 * What the harness proves:
 *   - Turn 1 prefix ≥ 4096 tokens (Haiku 4.5 minimum cacheable size).
 *   - Turn 1 cache_creation_input_tokens > 0 (cache was written).
 *   - Turn 2 cache_read_input_tokens > 0 (cache was read).
 *   - Turn 2 cached fraction > 50% (cache marker is in the right place).
 *
 * Design ref: /tmp/slice3f_design.md §9.1.
 *
 * What it does NOT prove (covered by tests/system-prompt-cache-shape.test.js):
 *   - Charlie's _buildSystemPrompt produces the right block ordering.
 *   - Runtime invariant catches misplaced markers.
 *   - cache-usage.log writes the correct fields.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

function abort(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) abort('ANTHROPIC_API_KEY not set in env');

// Build a representative Charlie-shaped cached prefix from real canonical
// docs at the repo root. Mirrors the cached-block list in
// /tmp/slice3f_design.md §1.3 — SOUL, Charlie Role, CEO Operating Model,
// (Trust Kernel and skills are stubbed inline here since they live in
// runtime workspace paths not in the repo root).
function readDoc(name) {
  const path = join(REPO_ROOT, name);
  if (!existsSync(path)) abort(`canonical doc not found at ${path} — run from qclaw repo root`);
  return readFileSync(path, 'utf-8');
}

const charlieRole = readDoc('CHARLIE_ROLE.md');
const ceoModel = readDoc('CEO_OPERATING_MODEL.md');

// Per-run nonce defeats the Anthropic cache from any prior harness run.
// Without this, two consecutive harness invocations within the 5m cache
// window would both hit the cache on "turn 1", which masks whether cache
// CREATION works. The nonce changes bytes early in the cached prefix so
// each harness invocation is guaranteed a cold prime → warm read sequence.
const RUN_NONCE = `slice3f-verify-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// Cached prefix blocks — at least 4096 tokens combined to clear Haiku 4.5
// minimum. CHARLIE_ROLE.md (~16KB) + CEO_OPERATING_MODEL.md (~8KB) ≈ 6K
// tokens, comfortably above threshold.
const cached = [
  { type: 'text', text: `# Charlie [harness-run ${RUN_NONCE}]\nYou are Charlie, the chief of staff for Flow OS.` },
  { type: 'text', text: `\n## Charlie Role\n${charlieRole}` },
  { type: 'text', text: `\n## CEO Operating Model\n${ceoModel}` },
  { type: 'text', text: '\n## Trust Kernel\n- Cite or do not claim. Verify before claim. Audit before brief.' },
  { type: 'text', text: '\n## Always-on Skills\n### verification-reflexes\n- Every factual statement has a source.' },
  {
    type: 'text',
    text: '\n## Tool Execution\nYou have registered function-calling tools. When the user requests data or actions, invoke the tool directly.',
    cache_control: { type: 'ephemeral' },
  },
];

// Dynamic suffix — would normally carry on-demand skills + knowledgeContext
// + relevantKnowledge + graphContext. Keep tiny for the harness so the
// cached portion dominates the per-turn input.
const dynamicSuffix = [
  { type: 'text', text: '\n## What I Know About You\n- harness-mode verification turn' },
];

const system = [...cached, ...dynamicSuffix];

async function sendTurn(label, userText) {
  console.log(`\n→ ${label} — sending turn: "${userText.slice(0, 40)}…"`);
  const body = {
    model: MODEL,
    max_tokens: 50,
    system,
    messages: [{ role: 'user', content: userText }],
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    abort(`Anthropic ${res.status}: ${err}`);
  }
  const data = await res.json();
  const u = data.usage || {};
  const usage = {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    ephemeral_5m_input_tokens:
      u.cache_creation?.ephemeral_5m_input_tokens ?? u.ephemeral_5m_input_tokens ?? 0,
    ephemeral_1h_input_tokens:
      u.cache_creation?.ephemeral_1h_input_tokens ?? u.ephemeral_1h_input_tokens ?? 0,
  };
  console.log(`  model: ${data.model}`);
  console.log(`  stop_reason: ${data.stop_reason}`);
  console.log(`  usage: ${JSON.stringify(usage)}`);
  return { usage, model: data.model, content: data.content?.[0]?.text || '' };
}

function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    return true;
  }
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
  return false;
}

(async () => {
  console.log('Slice 3f verify-cache-hits harness');
  console.log('==================================');
  console.log(`model: ${MODEL}`);
  console.log(`cached blocks: ${cached.length}; dynamic blocks: ${dynamicSuffix.length}`);
  console.log(`cached total chars: ${cached.reduce((s, b) => s + b.text.length, 0)}`);

  let allGreen = true;

  const turn1 = await sendTurn('Turn 1 (prime)', 'Reply with the literal string OK followed by nothing else.');
  // STEP 1 — assert prefix ≥ 4096 tokens BEFORE caching assertions (distinguishes
  // prefix-too-small from caching-broken per /tmp/slice3f_design.md §9.1).
  const t1Total = turn1.usage.input_tokens + turn1.usage.cache_creation_input_tokens + turn1.usage.cache_read_input_tokens;
  allGreen &= assert(
    `Turn 1 prefix ≥ 4096 tokens (got ${t1Total})`,
    t1Total >= 4096,
    'Cached prefix below Haiku 4.5 minimum — caching cannot work; check that canonical docs populated'
  );
  // STEP 2 — assert cache write happened on turn 1.
  allGreen &= assert(
    'Turn 1 cache_creation_input_tokens > 0',
    turn1.usage.cache_creation_input_tokens > 0,
    `got ${turn1.usage.cache_creation_input_tokens}`
  );
  allGreen &= assert(
    'Turn 1 cache_read_input_tokens === 0',
    turn1.usage.cache_read_input_tokens === 0,
    `got ${turn1.usage.cache_read_input_tokens}`
  );

  const turn2 = await sendTurn('Turn 2 (read)', 'Reply OK again.');
  allGreen &= assert(
    'Turn 2 cache_read_input_tokens > 0',
    turn2.usage.cache_read_input_tokens > 0,
    `got ${turn2.usage.cache_read_input_tokens}`
  );
  // Turn 2 may write a small number of tokens past the cache marker as
  // Anthropic's API automatically extends the cache to cover new content
  // that grows beyond the explicit breakpoint. The assertion is "small
  // relative to the cached portion", not "exactly zero".
  const t2CreationRatio = turn2.usage.cache_creation_input_tokens / Math.max(1, turn2.usage.cache_read_input_tokens);
  allGreen &= assert(
    `Turn 2 cache_creation_input_tokens small vs cache_read (got ${turn2.usage.cache_creation_input_tokens} creation / ${turn2.usage.cache_read_input_tokens} read, ratio ${(t2CreationRatio * 100).toFixed(2)}%)`,
    t2CreationRatio < 0.05,
    'Cache marker may be in the wrong place; turn 2 is writing too much of the prefix'
  );

  // STEP 3 — cached fraction sanity check.
  const t2Total = turn2.usage.input_tokens + turn2.usage.cache_read_input_tokens + turn2.usage.cache_creation_input_tokens;
  const cachedFraction = t2Total > 0 ? turn2.usage.cache_read_input_tokens / t2Total : 0;
  allGreen &= assert(
    `Turn 2 cached fraction > 50% (got ${(cachedFraction * 100).toFixed(1)}%)`,
    cachedFraction > 0.5,
    'Cache marker may be in the wrong place; expected most of the input to be cached'
  );

  console.log('\n=== Verification ' + (allGreen ? 'PASS' : 'FAIL') + ' ===');
  console.log('\nPaste the following into the PR description verbatim:');
  console.log('```json');
  console.log('// Turn 1 usage:');
  console.log(JSON.stringify(turn1.usage, null, 2));
  console.log('// Turn 2 usage:');
  console.log(JSON.stringify(turn2.usage, null, 2));
  console.log('```');

  process.exit(allGreen ? 0 : 1);
})().catch(err => {
  console.error(`\n✗ harness crashed: ${err.stack || err.message}`);
  process.exit(1);
});
