/**
 * Probe: PM2 process roll-call.
 *
 * Wraps `pm2 jlist` and reports the six expected processes per the
 * Slice 1 design lock in CHARLIE_OVERHAUL.md. ok=true iff every
 * expected process is present AND status === 'online'.
 *
 * Live process names verified 2026-05-06 via `pm2 jlist`. `agex-hub`
 * is the @agexhq/hub-lite AGEX identity/security hub started by
 * scripts/install.sh:561 and saved in /root/.pm2/dump.pm2.
 */

import { execSync } from 'child_process';

const EXPECTED = [
  'agex-hub',          // @agexhq/hub-lite — AGEX identity/security hub (port 4891)
  'quantumclaw',
  'trading-worker',   // src/trading/monte_carlo.py — Monte Carlo sim worker (:4001).
                      // NOT the trade engine; trade-engine calls it for simulations.
  'trade-engine',     // src/trade_engine/main.py — standalone trading system (:4003),
                      // live since 2026-08-05. Was missing from this list until
                      // 2026-08-19, so the probe reported the estate's most
                      // consequential process as an unexpected extra on every run.
  'clipper-worker',
  // Slice 5: charlie-watcher decommissioned (insecure --dangerously-skip-permissions
  // predecessor); claude-code-dispatcher is the secure replacement. PM2 roster changes
  // MUST update this list (same discipline as `pm2 save`).
  'claude-code-dispatcher'
];

// PM2 occasionally prepends non-JSON lines (e.g. Node deprecation warnings)
// to `pm2 jlist` stdout. Skip leading lines until one starts with `[` or `{`.
export function parsePm2Output(raw) {
  const text = raw || '';
  const lines = text.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      startIdx = i;
      break;
    }
  }
  const cleaned = startIdx === -1 ? '[]' : lines.slice(startIdx).join('\n');
  return JSON.parse(cleaned);
}

/**
 * Turn a parsed `pm2 jlist` array into the probe result.
 *
 * Separated from probe() so the not-all-online branch can be tested. It could
 * not be before: the branch is only reached when pm2 is INSTALLED and a
 * process is DOWN, and neither environment produces that state. CI has no pm2,
 * so `execSync` throws and the catch path runs; a developer machine has pm2 but
 * none of the six processes, which does reach this branch and is why the suite
 * disagreed with CI. Neither was running the branch under test.
 *
 * Exported for tests. probe() is the only production caller.
 */
export function evaluate(parsed, latency_ms) {
  const byName = new Map();
  for (const p of parsed) {
    if (!p || !p.name) continue;
    byName.set(p.name, {
      name: p.name,
      status: p.pm2_env?.status || 'unknown',
      pid: p.pid || null,
      uptime_ms: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
      restarts: p.pm2_env?.restart_time ?? null
    });
  }

  const expected = EXPECTED.map((name) => {
    const found = byName.get(name);
    if (!found) return { name, status: 'missing' };
    return found;
  });
  const extras = [...byName.values()]
    .filter((p) => !EXPECTED.includes(p.name))
    .map((p) => p.name);

  const allOnline = expected.every((p) => p.status === 'online');
  const missing = expected.filter((p) => p.status === 'missing').map((p) => p.name);
  const offline = expected
    .filter((p) => p.status !== 'online' && p.status !== 'missing')
    .map((p) => `${p.name}=${p.status}`);

  // An `error` string on every not-ok return, matching the idiom the other
  // probes already use. Without it this return carried ok:false and no error
  // in exactly the condition the probe exists to detect, and the consumer in
  // bootstrap.js rendered "probe pm2_processes failed: no detail" while the
  // name of the stopped process sat unread in detail.offline. A monitoring
  // probe that cannot say what is down at the moment something is down is
  // worse than no probe, because it reads as working.
  const faults = [...offline, ...missing.map((n) => `${n}=missing`)];

  return {
    name: 'pm2_processes',
    ok: allOnline,
    latency_ms,
    detail: { expected, extras, missing, offline },
    ...(allOnline ? {} : { error: `${faults.length} of ${EXPECTED.length} expected processes not online: ${faults.join(', ')}` })
  };
}

export async function probe(_ctx = {}) {
  const t0 = Date.now();
  let raw;
  try {
    raw = execSync('pm2 jlist 2>/dev/null', { timeout: 4500, encoding: 'utf-8' });
  } catch (err) {
    return {
      name: 'pm2_processes',
      ok: false,
      latency_ms: Date.now() - t0,
      error: `pm2 jlist failed: ${err.message || String(err)}`
    };
  }

  let parsed;
  try {
    parsed = parsePm2Output(raw);
  } catch (err) {
    return {
      name: 'pm2_processes',
      ok: false,
      latency_ms: Date.now() - t0,
      error: `pm2 jlist returned non-JSON: ${err.message}`
    };
  }

  return evaluate(parsed, Date.now() - t0);
}
