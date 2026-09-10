/**
 * QuantumClaw Subject Resolvers
 *
 * A resolver turns the identifiers in a tool call into lines that say what
 * they point at: for a position id, the market and whether it is open or
 * closed. The approval prompt prints those lines under "Subject:" so the
 * operator recognises what is being approved instead of matching a UUID by
 * eye, and the post-error re-read (fix 4 of the 2026-09-10 audit) uses the
 * same lookup to say what state a write left behind.
 *
 * Registration is by skill name, wired in src/index.js next to the approval
 * notifier. This is deliberately NOT a skill-file convention: how a skill
 * declares its identifiers and what resolves them is the subject of a
 * separate design (fix 2 of the audit), and the one resolver registered
 * today (trading-api position ids) is a stopgap that design replaces.
 *
 * Fail-VISIBLE, not fail-closed: a resolver that throws or times out yields a
 * "subject lookup failed" line and the prompt is still shown. Refusing to
 * prompt when the subject cannot be resolved belongs to the gate change in
 * fix 2, where it can be applied consistently across every declared
 * identifier rather than only where a resolver happens to exist.
 */

import { log } from '../core/logger.js';

const DEFAULT_TIMEOUT_MS = 5000;

const resolvers = new Map(); // skillName -> async ({ ...ctx }) => string[]

export function registerSubjectResolver(skillName, fn) {
  if (typeof skillName !== 'string' || !skillName) {
    throw new Error('registerSubjectResolver: skillName must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new Error(`registerSubjectResolver(${skillName}): fn must be a function`);
  }
  resolvers.set(skillName, fn);
}

export function hasSubjectResolver(skillName) {
  return resolvers.has(skillName);
}

// Test-only. Production code never clears the table.
export function __clearSubjectResolversForTests() {
  resolvers.clear();
}

/**
 * Resolve the subject for one tool call.
 *
 * @param {{ skill?: string|null, toolName: string, method?: string|null,
 *           path?: string|null, identifiers: Array<{name,value,source}>,
 *           args: object, baseUrl?: string|null }} ctx
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ lines: string[], status: 'resolved'|'empty'|'failed'|'no_resolver'|'no_identifiers' }>}
 */
export async function resolveSubject(ctx, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const skill = ctx?.skill;
  const fn = skill ? resolvers.get(skill) : null;
  if (!fn) return { lines: [], status: 'no_resolver' };
  if (!Array.isArray(ctx.identifiers) || ctx.identifiers.length === 0) {
    return { lines: [], status: 'no_identifiers' };
  }

  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`resolver timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const out = await Promise.race([fn(ctx), timeout]);
    const lines = Array.isArray(out) ? out.filter(l => typeof l === 'string' && l.length > 0) : [];
    return { lines, status: lines.length > 0 ? 'resolved' : 'empty' };
  } catch (err) {
    const msg = err?.message || String(err);
    log.warn(`subject resolver for ${skill} failed: ${msg}`);
    return { lines: [`subject lookup failed: ${msg}`], status: 'failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolver for trading-api position ids. Reads GET /positions/{id} on the
 * trade engine (any status; 404 when the value is not a position) and
 * renders one line per position_id identifier.
 *
 * Exported so index.js can register it and tests can drive it against a
 * stub fetch. `fetchImpl` defaults to global fetch.
 */
export function makeTradingApiPositionResolver({ fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return async function resolveTradingApiSubject({ identifiers, baseUrl }) {
    const lines = [];
    if (!baseUrl) return ['subject lookup skipped: trading-api has no base URL'];
    for (const ident of identifiers) {
      if (ident.name !== 'position_id') continue;
      const id = String(ident.value);
      const url = `${baseUrl.replace(/\/$/, '')}/positions/${encodeURIComponent(id)}`;
      let res;
      try {
        res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        lines.push(`position ${id}: lookup failed (${err?.message || err})`);
        continue;
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      if (res.status === 404) {
        lines.push(`position ${id}: NOT FOUND in the trade engine (${json?.error || text.slice(0, 120)})`);
        continue;
      }
      if (!res.ok) {
        lines.push(`position ${id}: lookup failed (HTTP ${res.status})`);
        continue;
      }
      const p = json?.position || {};
      const status = String(json?.status || p.status || 'unknown').toUpperCase();
      const question = json?.question || 'market unknown';
      const parts = [
        `position ${id}: ${status}`,
        `${p.direction || '?'} on "${question}"`,
        `opened ${p.opened_at || '?'}`,
        `entry ${p.entry_price ?? '?'} x ${p.shares ?? '?'} shares for ${p.usdc_amount ?? '?'} USDC`,
      ];
      if (status === 'CLOSED') {
        parts.push(`closed ${p.closed_at || '?'} at ${p.exit_price ?? '?'} for ${p.exit_usdc ?? '?'} USDC (pnl ${p.pnl ?? '?'})`);
      }
      const alerts = json?.unresolved_alert_count;
      parts.push(alerts === null || alerts === undefined ? 'live alerts unknown' : `${alerts} live alert(s)`);
      lines.push(parts.join(', '));
    }
    return lines;
  };
}
