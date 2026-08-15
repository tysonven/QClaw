/**
 * Trading Room UI — regression cover for the two blocking findings from the
 * 2026-08-14 adversarial review. Run: node tests/trading-room-ui.test.js
 *
 * There was no test of ANY ui.html trading function despite this being the
 * highest-risk slice of the PR (L1). Rather than duplicate the logic here, this
 * extracts the real Trading Room block out of src/dashboard/ui.html and
 * evaluates it against stubbed globals, so the assertions run against shipped
 * code and drift with it.
 *
 * C1: GET /api/trading/config used to answer 200 with FABRICATED limits
 *     (25/25/50) on every upstream failure. The client could not tell that from
 *     a real read and would write those numbers back, widening every trading
 *     limit. Covered: error bodies, non-2xx, and a fabricated-looking 200 body
 *     with no primary key must all leave the config UNLOADED and unwritable.
 * H1: the disable path toasted success and flipped the toggle to OFF on ANY
 *     HTTP status, because fetch() only rejects on network failure. A 500/401/
 *     403 therefore reported "Trading disabled" while trading stayed ARMED.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI = join(__dirname, '..', 'src', 'dashboard', 'ui.html');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ─── Extract the shipped Trading Room block ──────────────────────────────
const html = readFileSync(UI, 'utf-8');
const START = '/* ─── Trading Room ─────────────────────────────────────── */'.slice(0, 24);
const startIdx = html.indexOf(START);
const endIdx = html.indexOf('/* ─── Crete Marketing', startIdx);
if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
  console.error('FATAL: could not locate the Trading Room block in ui.html');
  process.exit(1);
}
const source = html.slice(startIdx, endIdx);

// Guard the extraction itself: if the markers move and we silently grab the
// wrong span, every assertion below becomes meaningless.
for (const fn of ['function trLoadConfig', 'async function trPostConfig', 'function trDisableFailed', 'const trEsc']) {
  if (!source.includes(fn)) {
    console.error(`FATAL: extracted block is missing ${fn} — extraction is wrong, not the code`);
    process.exit(1);
  }
}

// ─── Harness ─────────────────────────────────────────────────────────────
function makeEnv({ fetchImpl } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= {
    id, value: '', textContent: '', innerHTML: '', disabled: false,
    className: '', style: {}, focus() {},
  });
  const toasts = [];
  const ctx = {
    console: { log() {}, error() {}, warn() {} },
    $: el,
    API: (p) => p,
    fetch: fetchImpl,
    toast: (msg, kind) => toasts.push({ msg, kind }),
    setInterval: () => 0,
    clearInterval: () => {},
    Date, Number, Math, JSON, String, Array, Object, parseFloat, parseInt, isNaN,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // `function` declarations attach to the context global, but `let`/`const`
  // (trEsc, _trConfigLoaded, _trConfig) stay in the script's lexical scope and
  // are otherwise unreachable. This shim exposes them for assertions WITHOUT
  // altering the shipped source above it.
  const EXPOSE = `
    ;globalThis.trEsc = trEsc;
    globalThis.trAgo = trAgo;
    Object.defineProperty(globalThis, '_trConfigLoaded', { get: () => _trConfigLoaded, configurable: true });
    Object.defineProperty(globalThis, '_trConfig', { get: () => _trConfig, configurable: true });
  `;
  vm.runInContext(source + EXPOSE, ctx);
  return { ctx, els, el, toasts };
}

const okRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ─── C1 ──────────────────────────────────────────────────────────────────
console.log('C1: a fabricated or failed config read must never become live config');
{
  // The exact pre-fix server behaviour: 200, no error field, invented limits.
  const FABRICATED = { trading_enabled: false, max_position_usdc: 25, min_edge_threshold: 25, daily_loss_limit: 50 };
  const { ctx, el, toasts } = makeEnv({ fetchImpl: async () => okRes(FABRICATED) });
  await ctx.trLoadConfig();
  check('fabricated 200 (no row id) is rejected', ctx._trConfigLoaded === false);
  check('inputs left blank, not populated with 25/25/50',
    el('tr-max-position').value === '' && el('tr-min-edge').value === '' && el('tr-loss-limit').value === '',
    `${el('tr-max-position').value}/${el('tr-min-edge').value}/${el('tr-loss-limit').value}`);
  check('limit inputs disabled', el('tr-max-position').disabled === true);
  check('toggle shows unknown, not OFF', el('tr-trading-toggle').textContent === '?', el('tr-trading-toggle').textContent);

  // And the write path must refuse outright.
  let posted = null;
  ctx.fetch = async (u, o) => { posted = { u, o }; return okRes({}); };
  await ctx.trSaveConfig();
  check('trSaveConfig performs NO write after a rejected read', posted === null, JSON.stringify(posted));
  check('user is told why', toasts.some(t => t.kind === 'err' && /not loaded/i.test(t.msg)), JSON.stringify(toasts));
}

for (const [label, res] of [
  ['RLS / auth error body', okRes({ error: 'config_unavailable' }, 502)],
  ['404 config_row_missing', okRes({ error: 'config_row_missing' }, 404)],
  ['500 with a body', okRes({ error: 'config_unavailable' }, 500)],
  ['200 carrying an error field', okRes({ error: 'boom' }, 200)],
  ['200 with an array body', okRes([], 200)],
]) {
  const { ctx, el } = makeEnv({ fetchImpl: async () => res });
  await ctx.trLoadConfig();
  check(`${label} -> config not loaded`, ctx._trConfigLoaded === false);
  check(`${label} -> no limits populated`, el('tr-max-position').value === '');
}

{
  const { ctx, el } = makeEnv({
    fetchImpl: async () => okRes({ id: 1, trading_enabled: true, max_position_usdc: 10, min_edge_threshold: 7, daily_loss_limit: 20 }),
  });
  await ctx.trLoadConfig();
  check('a genuine row (has id) IS accepted', ctx._trConfigLoaded === true);
  check('real limits populated', el('tr-max-position').value === 10 && el('tr-min-edge').value === 7 && el('tr-loss-limit').value === 20);
  check('inputs re-enabled', el('tr-max-position').disabled === false);
  check('toggle reflects enabled', el('tr-trading-toggle').textContent === 'ON');
}

{
  // M2: a genuine row missing a column must omit that key, not invent or null it.
  const { ctx, el } = makeEnv({ fetchImpl: async () => okRes({ id: 1, trading_enabled: true, max_position_usdc: 10 }) });
  await ctx.trLoadConfig();
  let body = null;
  ctx.fetch = async (u, o) => { body = JSON.parse(o.body); return okRes({}); };
  el('tr-min-edge').value = '';
  el('tr-loss-limit').value = '';
  await ctx.trSaveConfig();
  check('M2: absent columns omitted from the write, not sent as null',
    body !== null && 'max_position_usdc' in body && !('min_edge_threshold' in body) && !('daily_loss_limit' in body),
    JSON.stringify(body));
}

// ─── H1 ──────────────────────────────────────────────────────────────────
console.log('H1: a disable that did not succeed must never report success');
for (const status of [500, 401, 403, 503]) {
  const { ctx, el, toasts } = makeEnv({
    fetchImpl: async () => okRes({ id: 1, trading_enabled: true, max_position_usdc: 10, min_edge_threshold: 7, daily_loss_limit: 20 }),
  });
  await ctx.trLoadConfig();                       // armed: toggle ON
  ctx.fetch = async () => okRes({ error: 'nope' }, status);   // disable fails
  await ctx.trToggleTrading();

  check(`HTTP ${status}: no success toast`,
    !toasts.some(t => t.kind === 'ok' && /disabled|cancelled/i.test(t.msg)), JSON.stringify(toasts));
  check(`HTTP ${status}: warns trading may still be ARMED`,
    toasts.some(t => t.kind === 'err' && /ARMED/.test(t.msg)), JSON.stringify(toasts));
  check(`HTTP ${status}: toggle does NOT show OFF`,
    el('tr-trading-toggle').textContent !== 'OFF', el('tr-trading-toggle').textContent);
}

{
  // The same hole existed on the config-unreadable branch, which is the one
  // that matters most: it is the kill switch during a backend outage.
  const { ctx, el, toasts } = makeEnv({ fetchImpl: async () => okRes({ error: 'config_unavailable' }, 502) });
  await ctx.trLoadConfig();
  check('config unreadable -> not loaded', ctx._trConfigLoaded === false);
  ctx.fetch = async () => okRes({ error: 'nope' }, 500);
  await ctx.trToggleTrading();
  check('kill-switch path: failed disable does not claim success',
    !toasts.some(t => t.kind === 'ok'), JSON.stringify(toasts));
  check('kill-switch path: toggle not shown OFF', el('tr-trading-toggle').textContent !== 'OFF');
}

{
  const { ctx, el, toasts } = makeEnv({
    fetchImpl: async () => okRes({ id: 1, trading_enabled: true, max_position_usdc: 10, min_edge_threshold: 7, daily_loss_limit: 20 }),
  });
  await ctx.trLoadConfig();
  let sent = null;
  ctx.fetch = async (u, o) => { sent = JSON.parse(o.body); return okRes({ ok: true }); };
  await ctx.trToggleTrading();
  check('a genuinely successful disable DOES report success',
    toasts.some(t => t.kind === 'ok' && /disabled/i.test(t.msg)), JSON.stringify(toasts));
  check('disable sends trading_enabled:false', sent && sent.trading_enabled === false, JSON.stringify(sent));
  check('toggle shows OFF', el('tr-trading-toggle').textContent === 'OFF');
}

// ─── XSS ─────────────────────────────────────────────────────────────────
console.log('trEsc: market titles are attacker-influenced text');
{
  const { ctx } = makeEnv({ fetchImpl: async () => okRes([]) });
  check('escapes angle brackets', ctx.trEsc('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', ctx.trEsc('<img>'));
  check('escapes quotes (title= attribute breakout)', ctx.trEsc('a" onmouseover="x') === 'a&quot; onmouseover=&quot;x');
  check('escapes ampersand and apostrophe', ctx.trEsc("&'") === '&amp;&#39;');
  check('null/undefined render empty', ctx.trEsc(null) === '' && ctx.trEsc(undefined) === '');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
