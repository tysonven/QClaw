/**
 * Slice 3g Unit 2 — spend alerter tests.
 * Run: node tests/spend-alerter.test.js
 *
 * Covers: threshold load + defaults/malformed, three-case cooldown state
 * (absent/partial/total-failure), cooldown window + flapping last_attempt
 * ceiling, highest-severity selection, alert formatting, Telegram send
 * (no-token / ok / throw), rollup fetch parsing, and the orchestrator paths
 * incl. corrupt-state health meta-alert (never permanent silence).
 * Design ref: /tmp/slice3g_design.md §4, §10.
 */

import {
  loadThresholds, readAlertState, lastActivityMs, inCooldown, evaluate, formatAlert,
  fetchRollups, sendTelegram, runAlerter,
} from '../src/observability/spend-alerter.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label} ${detail}`); failed++; }
}
const dir = mkdtempSync(join(tmpdir(), 'alerter-'));
const tmp = (n) => join(dir, n);
// mock fetch routing on URL + telegram capture
function mkFetch({ usd24h = 0, usd1h = 0, breakdown = [], tgOk = true, tgThrow = false, capture = {} }) {
  return async (url, opts = {}) => {
    if (url.includes('api.telegram.org')) {
      if (tgThrow) throw new Error('network');
      capture.tgText = JSON.parse(opts.body).text;
      capture.tgCalls = (capture.tgCalls || 0) + 1;
      return { ok: tgOk, status: tgOk ? 200 : 500 };
    }
    if (url.includes('anthropic_spend_rollup')) {
      if (url.includes('window_kind=eq.24h') && url.includes('dimension=eq.total')) return { ok: true, json: async () => [{ est_cost_usd: usd24h, window_end: '2026-06-03T00:00:00.000Z' }] };
      if (url.includes('window_kind=eq.1h') && url.includes('dimension=eq.total')) return { ok: true, json: async () => [{ est_cost_usd: usd1h, window_end: '2026-06-03T00:00:00.000Z' }] };
      if (url.includes('dimension=eq.model')) return { ok: true, json: async () => breakdown };
      return { ok: true, json: async () => [] };
    }
    return { ok: false, status: 404, json: async () => [] };
  };
}
const baseEnv = { SUPABASE_URL: 'http://sb', SUPABASE_SERVICE_ROLE_KEY: 'srv', TELEGRAM_BOT_TOKEN: 'tok' };

console.log('loadThresholds:');
check('missing file → defaults', JSON.stringify(loadThresholds(tmp('none.json'))) === JSON.stringify({ soft_24h_usd: 5, hard_1h_usd: 3, cooldown_minutes: 60 }));
writeFileSync(tmp('t.json'), JSON.stringify({ soft_24h_usd: 9, hard_1h_usd: 4, cooldown_minutes: 30 }));
check('reads file values', loadThresholds(tmp('t.json')).soft_24h_usd === 9 && loadThresholds(tmp('t.json')).cooldown_minutes === 30);
writeFileSync(tmp('bad.json'), '{ not json');
check('malformed → defaults', loadThresholds(tmp('bad.json')).hard_1h_usd === 3);
writeFileSync(tmp('partial.json'), JSON.stringify({ soft_24h_usd: 7 }));
check('partial → fills missing defaults', loadThresholds(tmp('partial.json')).soft_24h_usd === 7 && loadThresholds(tmp('partial.json')).hard_1h_usd === 3);

console.log('readAlertState (three cases):');
check('absent → entries:[] corrupt:false', (() => { const s = readAlertState(tmp('absent.log')); return s.entries.length === 0 && s.corrupt === false; })());
writeFileSync(tmp('valid.log'), JSON.stringify({ ts: '2026-06-03T00:00:00Z', class: 'hard', event: 'fired' }) + '\n');
check('valid JSONL → entries', readAlertState(tmp('valid.log')).entries.length === 1);
writeFileSync(tmp('partial.log'), JSON.stringify({ ts: '2026-06-03T00:00:00Z', class: 'soft', event: 'fired' }) + '\nGARBAGE\n');
check('partial garbage → skip bad, corrupt:false', (() => { const s = readAlertState(tmp('partial.log')); return s.entries.length === 1 && s.corrupt === false; })());
writeFileSync(tmp('corrupt.log'), 'GARBAGE\nMORE GARBAGE\n');
check('all-garbage non-empty → corrupt:true', (() => { const s = readAlertState(tmp('corrupt.log')); return s.entries.length === 0 && s.corrupt === true; })());

console.log('cooldown:');
const now = Date.parse('2026-06-03T12:00:00Z');
const recent = [{ ts: new Date(now - 10 * 60000).toISOString(), class: 'hard', event: 'attempt' }];
const old = [{ ts: new Date(now - 120 * 60000).toISOString(), class: 'hard', event: 'fired' }];
check('lastActivityMs finds latest', lastActivityMs(recent, 'hard') === now - 10 * 60000);
check('within 60m window → in cooldown', inCooldown(recent, 'hard', now, 60) === true);
check('outside window → not in cooldown', inCooldown(old, 'hard', now, 60) === false);
check('no prior → not in cooldown', inCooldown([], 'hard', now, 60) === false);
check('cooldown is per-class', inCooldown(recent, 'soft', now, 60) === false);

console.log('evaluate (highest severity):');
check('1h over hard → hard', evaluate({ usd24h: 0, usd1h: 5, thresholds: { soft_24h_usd: 5, hard_1h_usd: 3 } }).severity === 'hard');
check('24h over soft only → soft', evaluate({ usd24h: 6, usd1h: 1, thresholds: { soft_24h_usd: 5, hard_1h_usd: 3 } }).severity === 'soft');
check('both over → hard supersedes', evaluate({ usd24h: 100, usd1h: 50, thresholds: { soft_24h_usd: 5, hard_1h_usd: 3 } }).severity === 'hard');
check('neither → null', evaluate({ usd24h: 1, usd1h: 1, thresholds: { soft_24h_usd: 5, hard_1h_usd: 3 } }) === null);

console.log('formatAlert:');
check('hard has $/day projection', formatAlert({ severity: 'hard', value: 3.5, threshold: 3 }, []).includes('/day if sustained'));
check('soft says visibility', formatAlert({ severity: 'soft', value: 6, threshold: 5 }, []).toLowerCase().includes('visibility'));
check('includes breakdown', formatAlert({ severity: 'hard', value: 3.5, threshold: 3 }, [{ key: 'claude-haiku-4-5', usd: 3.5 }]).includes('claude-haiku-4-5'));

console.log('sendTelegram:');
check('no token → ok:false', (await sendTelegram({ token: null, chatId: 1, text: 'x', fetchImpl: async () => ({ ok: true }) })).ok === false);
check('ok response → ok:true', (await sendTelegram({ token: 't', chatId: 1, text: 'x', fetchImpl: async () => ({ ok: true }) })).ok === true);
check('fetch throws → ok:false (no throw)', (await sendTelegram({ token: 't', chatId: 1, text: 'x', fetchImpl: async () => { throw new Error('net'); } })).ok === false);

console.log('fetchRollups:');
const fr = await fetchRollups({ supabaseUrl: 'http://sb', serviceKey: 'k', fetchImpl: mkFetch({ usd24h: 6, usd1h: 2, breakdown: [{ dimension_key: 'claude-haiku-4-5', est_cost_usd: 6 }] }) });
check('parses 24h/1h totals', fr.usd24h === 6 && fr.usd1h === 2);
check('parses model breakdown', fr.breakdown[0].key === 'claude-haiku-4-5' && fr.breakdown[0].usd === 6);

console.log('runAlerter:');
const cap1 = {};
const under = await runAlerter({ env: baseEnv, nowMs: now, fetchImpl: mkFetch({ usd24h: 1, usd1h: 0.5, capture: cap1 }), paths: { state: tmp('r1.log'), health: tmp('r1.health'), thresholds: tmp('none.json') } });
check('under thresholds → fired:null', under.fired === null);
check('under thresholds → no telegram', !cap1.tgCalls);

const cap2 = {};
const fired = await runAlerter({ env: baseEnv, nowMs: now, fetchImpl: mkFetch({ usd24h: 10, usd1h: 5, breakdown: [{ dimension_key: 'claude-haiku-4-5', est_cost_usd: 5 }], capture: cap2 }), paths: { state: tmp('r2.log'), health: tmp('r2.health'), thresholds: tmp('none.json') } });
check('over hard → fired hard', fired.fired === 'hard' && fired.sent === true);
check('hard alert telegram sent', cap2.tgCalls === 1 && cap2.tgText.includes('HARD'));
check('state file has attempt + fired', (() => { const s = readAlertState(tmp('r2.log')); return s.entries.some(e => e.event === 'attempt') && s.entries.some(e => e.event === 'fired'); })());

// cooldown suppresses a second immediate run
const cap3 = {};
const supp = await runAlerter({ env: baseEnv, nowMs: now + 60000, fetchImpl: mkFetch({ usd24h: 10, usd1h: 5, capture: cap3 }), paths: { state: tmp('r2.log'), health: tmp('r2.health'), thresholds: tmp('none.json') } });
check('second run within cooldown → suppressed', supp.fired === null && supp.suppressed === 'cooldown');
check('suppressed run sends no telegram', !cap3.tgCalls);

// flapping: telegram fails, attempt still recorded → next run suppressed
const cap4 = {};
const flap = await runAlerter({ env: baseEnv, nowMs: now, fetchImpl: mkFetch({ usd24h: 10, usd1h: 5, tgOk: false, capture: cap4 }), paths: { state: tmp('r4.log'), health: tmp('r4.health'), thresholds: tmp('none.json') } });
check('telegram-fail run: fired severity but sent:false', flap.fired === 'hard' && flap.sent === false);
check('flap recorded attempt (no fired)', (() => { const s = readAlertState(tmp('r4.log')); return s.entries.some(e => e.event === 'attempt') && !s.entries.some(e => e.event === 'fired'); })());
const flap2 = await runAlerter({ env: baseEnv, nowMs: now + 60000, fetchImpl: mkFetch({ usd24h: 10, usd1h: 5, capture: {} }), paths: { state: tmp('r4.log'), health: tmp('r4.health'), thresholds: tmp('none.json') } });
check('flap ceiling: next run suppressed by attempt', flap2.suppressed === 'cooldown');

// corrupt state → health meta-alert + still fires + rewrites fresh
writeFileSync(tmp('r5.log'), 'TOTAL GARBAGE\nNOT JSON\n');
const cap5 = {};
const cor = await runAlerter({ env: baseEnv, nowMs: now, fetchImpl: mkFetch({ usd24h: 10, usd1h: 5, capture: cap5 }), paths: { state: tmp('r5.log'), health: tmp('r5.health'), thresholds: tmp('none.json') } });
check('corrupt state → still fires (no permanent silence)', cor.fired === 'hard');
check('corrupt state → health meta-alert sent', cap5.tgCalls === 2 && (readFileSync(tmp('r5.health'), 'utf-8').length > 0));
check('corrupt state file rewritten fresh (valid entries only)', readAlertState(tmp('r5.log')).corrupt === false);

// P1: unwritable state dir → suppress noisy spend alert (can't track cooldown),
// but still emit the one-shot health nag (never a silent storm).
const unwritableDir = join(dir, 'nonexistent-subdir', 'deeper'); // parent missing → writes fail
const cap6 = {};
const unw = await runAlerter({ env: baseEnv, nowMs: now, fetchImpl: mkFetch({ usd24h: 10, usd1h: 5, capture: cap6 }), paths: { state: join(unwritableDir, 's.log'), health: join(unwritableDir, 's.health'), thresholds: tmp('none.json') } });
check('unwritable state → spend alert suppressed (no storm)', unw.fired === null && unw.suppressed === 'state_unpersistable');
check('unwritable state → health nag still sent (not silent)', cap6.tgCalls === 1 && cap6.tgText.includes('unwritable'));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
