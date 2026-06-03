/**
 * Slice 3g Unit 2 — spend alerter.
 *
 * Reads the CHARLIE-attributed rollups (anthropic_spend_rollup, written by the
 * aggregator from cache-usage.log — Charlie main-loop only) and fires a
 * Telegram alert when Charlie's spend crosses a threshold. It deliberately
 * NEVER thresholds on anthropic_spend_daily (the org total: Step 0b showed it
 * is ~91% Claude Code / Sonnet-4.6, which would trip a $5 threshold every day).
 * Org-level alerting is a separate future slice (usage_report-by-api_key).
 *
 * Two tiers (defaults, tunable in /root/.quantumclaw/spend-thresholds.json):
 *   - soft: 24h Charlie spend ≥ $5  → visibility, breakdown, no action framing
 *   - hard: 1h  Charlie spend ≥ $3  → "≈ $X/day if sustained — investigate now"
 *
 * Anti-storm (design §4): per-class cooldown gated on last_attempt (so a
 * flapping Telegram can't post more than once per cooldown); only the
 * highest-severity class fires per run; the attempt is recorded BEFORE the
 * send. Cooldown state in ~/.quantumclaw/spend-alert-state.log (JSONL, 0600):
 *   absent          → allow (first run)
 *   partial garbage → skip bad lines, use last valid per-class entry
 *   total failure   → one-shot health meta-alert (sidecar-gated) + in-memory
 *                     cooldown (a real spike still fires once) + rewrite fresh
 *                     — NEVER permanent silent suppression.
 *
 * Runs as a standalone cron entrypoint (NOT in PM2), daily 00:06 UTC.
 * Always exits 0 — alerting failure must never break the cron chain.
 *
 * Design ref: /tmp/slice3g_design.md §4, §10.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, chmodSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readEnvFile } from '../core/env.js';

const OWNER_TELEGRAM_CHAT_ID = 1375806243; // mirrors src/tools/executor.js
const DEFAULTS = { soft_24h_usd: 5, hard_1h_usd: 3, cooldown_minutes: 60 };
const MODE = 0o600;

function thresholdsPath() { return process.env.QCLAW_SPEND_THRESHOLDS_PATH || join(homedir(), '.quantumclaw', 'spend-thresholds.json'); }
function statePath() { return process.env.QCLAW_SPEND_ALERT_STATE_PATH || join(homedir(), '.quantumclaw', 'spend-alert-state.log'); }
function healthPath() { return statePath() + '.health'; }

/** Load thresholds, falling back to baked defaults on missing/malformed file. */
export function loadThresholds(path = thresholdsPath()) {
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      soft_24h_usd: numOr(cfg.soft_24h_usd, DEFAULTS.soft_24h_usd),
      hard_1h_usd: numOr(cfg.hard_1h_usd, DEFAULTS.hard_1h_usd),
      cooldown_minutes: numOr(cfg.cooldown_minutes, DEFAULTS.cooldown_minutes),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Read cooldown state. Returns { entries, corrupt }.
 *   absent file          → { entries: [], corrupt: false }
 *   garbage lines mixed  → valid entries kept, corrupt: false
 *   file present but ZERO parseable lines → { entries: [], corrupt: true }
 */
export function readAlertState(path = statePath()) {
  if (!existsSync(path)) return { entries: [], corrupt: false };
  let text = '';
  try { text = readFileSync(path, 'utf-8'); } catch { return { entries: [], corrupt: true }; }
  const nonEmpty = text.split('\n').map(l => l.trim()).filter(Boolean);
  const entries = [];
  for (const line of nonEmpty) {
    try { const e = JSON.parse(line); if (e && e.class && e.ts) entries.push(e); } catch { /* skip */ }
  }
  const corrupt = nonEmpty.length > 0 && entries.length === 0;
  return { entries, corrupt };
}

/** Latest timestamp (ms) of any attempt/fired entry for a class, or -Infinity. */
export function lastActivityMs(entries, cls) {
  let max = -Infinity;
  for (const e of entries) {
    if (e.class === cls) { const t = Date.parse(e.ts); if (Number.isFinite(t) && t > max) max = t; }
  }
  return max;
}

/** In cooldown if the last attempt/fired for this class is within the window. */
export function inCooldown(entries, cls, nowMs, cooldownMinutes) {
  const last = lastActivityMs(entries, cls);
  if (last === -Infinity) return false;
  return (nowMs - last) < cooldownMinutes * 60_000;
}

/** Pick the single class to fire: hard supersedes soft; null if neither trips. */
export function evaluate({ usd24h, usd1h, thresholds }) {
  if (usd1h >= thresholds.hard_1h_usd) return { severity: 'hard', value: usd1h, threshold: thresholds.hard_1h_usd, window: '1h' };
  if (usd24h >= thresholds.soft_24h_usd) return { severity: 'soft', value: usd24h, threshold: thresholds.soft_24h_usd, window: '24h' };
  return null;
}

/** Build the alert message. `breakdown` is an array of {key, usd}. */
export function formatAlert(decision, breakdown = []) {
  const lines = [];
  const v = decision.value.toFixed(4);
  if (decision.severity === 'hard') {
    const perDay = (decision.value * 24).toFixed(2);
    lines.push(`🚨 Charlie spend HARD alert — $${v} in the last 1h (threshold $${decision.threshold}).`);
    lines.push(`At this rate that is ≈ $${perDay}/day if sustained — investigate now.`);
  } else {
    lines.push(`⚠️ Charlie spend soft alert — $${v} in the last 24h (threshold $${decision.threshold}). Visibility only.`);
  }
  const top = breakdown.filter(b => b.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, 6);
  if (top.length) {
    lines.push('Breakdown:');
    for (const b of top) lines.push(`  • ${b.key}: $${b.usd.toFixed(4)}`);
  }
  return lines.join('\n');
}

/** Fetch latest Charlie rollups: 24h total, 1h total, + 24h per-model/channel breakdown. */
export async function fetchRollups({ supabaseUrl, serviceKey, fetchImpl = fetch }) {
  const base = supabaseUrl.replace(/\/+$/, '');
  const hdr = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const one = async (wk, dim, key) => {
    const url = `${base}/rest/v1/anthropic_spend_rollup?window_kind=eq.${wk}&dimension=eq.${dim}` +
      (key ? `&dimension_key=eq.${key}` : '') + `&order=window_end.desc&limit=1&select=est_cost_usd,window_end`;
    const res = await fetchImpl(url, { headers: hdr });
    if (!res.ok) return null;
    const arr = await res.json().catch(() => []);
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  };
  const t24 = await one('24h', 'total', 'all');
  const t1 = await one('1h', 'total', 'all');
  // model breakdown for the latest 24h window_end
  let breakdown = [];
  if (t24) {
    const url = `${base}/rest/v1/anthropic_spend_rollup?window_kind=eq.24h&dimension=eq.model` +
      `&window_end=eq.${encodeURIComponent(t24.window_end)}&select=dimension_key,est_cost_usd`;
    const res = await fetchImpl(url, { headers: hdr });
    if (res.ok) {
      const arr = await res.json().catch(() => []);
      breakdown = (Array.isArray(arr) ? arr : []).map(r => ({ key: r.dimension_key, usd: Number(r.est_cost_usd) || 0 }));
    }
  }
  return { usd24h: t24 ? Number(t24.est_cost_usd) || 0 : 0, usd1h: t1 ? Number(t1.est_cost_usd) || 0 : 0, breakdown };
}

/** Best-effort Telegram send (raw fetch, mirrors notifyAnthropicCreditsExhausted). Returns ok:bool. */
export async function sendTelegram({ token, chatId, text, fetchImpl = fetch }) {
  if (!token) return { ok: false, reason: 'no token' };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return { ok: !!res.ok };
  } catch (e) {
    return { ok: false, reason: 'fetch threw' };
  }
}

function appendState(path, entry) {
  try {
    appendFileSync(path, JSON.stringify(entry) + '\n', { mode: MODE });
    chmodSync(path, MODE);
  } catch { /* best-effort */ }
}

/**
 * Orchestrator. Returns a summary describing what happened (for tests + logs).
 * `nowMs` injectable; fetchImpl injectable for both Supabase + Telegram.
 */
export async function runAlerter({ env, nowMs = Date.now(), fetchImpl = fetch, paths = {} }) {
  const sp = paths.state || statePath();
  const hp = paths.health || healthPath();
  const thresholds = loadThresholds(paths.thresholds);
  const { usd24h, usd1h, breakdown } = await fetchRollups({
    supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl,
  });
  const decision = evaluate({ usd24h, usd1h, thresholds });
  if (!decision) return { fired: null, usd24h, usd1h };

  // Cooldown state — three cases.
  const { entries, corrupt } = readAlertState(sp);
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = numOr(env.SPEND_ALERT_CHAT_ID, OWNER_TELEGRAM_CHAT_ID);
  const cooldownMs = thresholds.cooldown_minutes * 60_000;

  if (corrupt) {
    // Health meta-alert (sidecar-gated so it can't storm), then proceed with
    // an in-memory cooldown so a real spike still fires once this run.
    const healthAgeOk = !existsSync(hp) || (nowMs - safeMtimeMs(hp)) >= cooldownMs;
    if (healthAgeOk) {
      await sendTelegram({ token, chatId, text: '🩺 spend-alert-state unreadable — using in-memory cooldown; manual check needed.', fetchImpl });
      try { writeFileSync(hp, String(nowMs), { mode: MODE }); } catch { /* best-effort */ }
    }
    try { writeFileSync(sp, '', { mode: MODE }); } catch { /* rewrite fresh */ } // reset corrupt file
    // in-memory cooldown = no prior entries → not in cooldown → fall through to fire
  } else if (inCooldown(entries, decision.severity, nowMs, thresholds.cooldown_minutes)) {
    return { fired: null, suppressed: 'cooldown', severity: decision.severity, usd24h, usd1h };
  }

  // Record the ATTEMPT before sending (flapping ceiling: advances cooldown even if send fails).
  const ts = new Date(nowMs).toISOString();
  appendState(sp, { ts, class: decision.severity, event: 'attempt', window_value_usd: decision.value, threshold_usd: decision.threshold });
  const text = formatAlert(decision, breakdown);
  const sent = await sendTelegram({ token, chatId, text, fetchImpl });
  if (sent.ok) appendState(sp, { ts: new Date(nowMs).toISOString(), class: decision.severity, event: 'fired', window_value_usd: decision.value, threshold_usd: decision.threshold });
  return { fired: decision.severity, sent: sent.ok, value: decision.value, usd24h, usd1h, message: text };
}

function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function safeMtimeMs(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

// ── Live CLI entrypoint (cron) ────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (process.env.pm_id !== undefined) {
    console.error('[spend-alerter] refusing to run inside PM2 (pm_id set) — cron-only');
    process.exit(2);
  }
  const env = { ...readEnvFile(), ...process.env };
  runAlerter({ env })
    .then(r => { console.log(`[spend-alerter] fired=${r.fired ?? 'none'} 24h=$${(r.usd24h ?? 0).toFixed(4)} 1h=$${(r.usd1h ?? 0).toFixed(4)}${r.suppressed ? ' (suppressed: ' + r.suppressed + ')' : ''}`); process.exit(0); })
    .catch(err => { console.error(`[spend-alerter] error (non-fatal): ${err?.message || err}`); process.exit(0); }); // always 0
}
