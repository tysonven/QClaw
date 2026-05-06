/**
 * Probe: Supabase reachable.
 *
 * Cheap reachability check — anon-keyed HEAD against the project's
 * REST root. Does not depend on any specific table; succeeds whenever
 * PostgREST is up and accepts the apikey.
 */

import { getEnv } from '../../core/env.js';

export async function probe(_ctx = {}) {
  const t0 = Date.now();
  const env = getEnv();
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = env.SUPABASE_ANON_KEY || null;

  if (!url || !anonKey) {
    return {
      name: 'supabase_reachable',
      ok: false,
      latency_ms: Date.now() - t0,
      error: 'SUPABASE_URL or SUPABASE_ANON_KEY missing in /root/.quantumclaw/.env'
    };
  }

  // /auth/v1/health is the cheapest unauthenticated target on a Supabase
  // project that accepts the anon key — confirmed 2026-05-06 against
  // fdabygmromuqtysitodp. Returns the GoTrue version JSON. /rest/v1 returns
  // 401 "service_role only" for anon, so we deliberately don't probe there.
  try {
    const res = await fetch(`${url}/auth/v1/health`, {
      method: 'GET',
      headers: { apikey: anonKey }
    });
    const latency_ms = Date.now() - t0;
    return {
      name: 'supabase_reachable',
      ok: res.ok,
      latency_ms,
      detail: { status_code: res.status },
      ...(res.ok ? {} : { error: `HTTP ${res.status}` })
    };
  } catch (err) {
    return {
      name: 'supabase_reachable',
      ok: false,
      latency_ms: Date.now() - t0,
      error: err.message || String(err)
    };
  }
}
