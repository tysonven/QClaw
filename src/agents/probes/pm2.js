/**
 * Probe: PM2 process roll-call.
 *
 * Wraps `pm2 jlist` and reports the four expected processes per the
 * Slice 1 design lock in CHARLIE_OVERHAUL.md. ok=true iff every
 * expected process is present AND status === 'online'.
 *
 * Live process names verified 2026-05-06 via `pm2 jlist`. The runtime
 * also includes `agex-hub` (online) which is reported as informational
 * but not required for ok=true.
 */

import { execSync } from 'child_process';

const EXPECTED = ['quantumclaw', 'trading-worker', 'clipper-worker', 'charlie-watcher'];

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
    parsed = JSON.parse(raw || '[]');
  } catch (err) {
    return {
      name: 'pm2_processes',
      ok: false,
      latency_ms: Date.now() - t0,
      error: `pm2 jlist returned non-JSON: ${err.message}`
    };
  }

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

  return {
    name: 'pm2_processes',
    ok: allOnline,
    latency_ms: Date.now() - t0,
    detail: { expected, extras, missing, offline }
  };
}
