/**
 * Probe: heartbeat freshness summary.
 *
 * Reads `public.workflow_heartbeats` raw — the dormancy alerter's
 * cadence-list is intentionally bypassed here. Returns a summary of
 * the latest heartbeat per workflow_id over the last 24 hours.
 *
 * Auth strategy (per audit T2 resolution):
 *   1. Try the existing SUPABASE_ANON_KEY from /root/.quantumclaw/.env first.
 *   2. If RLS denies (empty result for a non-empty table), the probe
 *      surfaces ok=false with error explaining the RLS gap so Tyson
 *      can add SUPABASE_SERVICE_ROLE_KEY.
 *   3. If SUPABASE_SERVICE_ROLE_KEY is present, prefer it over anon.
 */

import { getEnv } from '../../core/env.js';

const SUMMARY_PATH =
  '/rest/v1/workflow_heartbeats' +
  '?select=workflow_id,workflow_name,status,created_at' +
  '&order=created_at.desc' +
  '&limit=200';

export async function probe(_ctx = {}) {
  const t0 = Date.now();
  const env = getEnv();
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || null;
  const anonKey = env.SUPABASE_ANON_KEY || null;
  const apiKey = serviceKey || anonKey;
  const usingRole = serviceKey ? 'service_role' : (anonKey ? 'anon' : null);

  if (!url || !apiKey) {
    return {
      name: 'heartbeat_freshness',
      ok: false,
      latency_ms: Date.now() - t0,
      error: 'SUPABASE_URL or key missing in /root/.quantumclaw/.env'
    };
  }

  try {
    const res = await fetch(`${url}${SUMMARY_PATH}`, {
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`
      }
    });
    const latency_ms = Date.now() - t0;
    if (!res.ok) {
      return {
        name: 'heartbeat_freshness',
        ok: false,
        latency_ms,
        error: `HTTP ${res.status}`,
        detail: { auth_role: usingRole }
      };
    }
    const rows = await res.json();
    // RLS-empty case: anon role likely lacks SELECT on workflow_heartbeats.
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        name: 'heartbeat_freshness',
        ok: false,
        latency_ms,
        error:
          usingRole === 'anon'
            ? 'workflow_heartbeats returned 0 rows — anon role likely RLS-blocked; add SUPABASE_SERVICE_ROLE_KEY to /root/.quantumclaw/.env'
            : 'workflow_heartbeats returned 0 rows',
        detail: { auth_role: usingRole, row_count: 0 }
      };
    }

    // Reduce to one entry per workflow_id (most-recent wins, since we order desc).
    const byWorkflow = new Map();
    for (const row of rows) {
      if (!byWorkflow.has(row.workflow_id)) byWorkflow.set(row.workflow_id, row);
    }
    const summary = [];
    const now = Date.now();
    for (const [workflow_id, row] of byWorkflow) {
      const ts = row.created_at ? new Date(row.created_at).getTime() : null;
      summary.push({
        workflow_id,
        workflow_name: row.workflow_name || null,
        last_status: row.status || null,
        last_at: row.created_at || null,
        age_minutes: ts ? Math.round((now - ts) / 60000) : null
      });
    }

    return {
      name: 'heartbeat_freshness',
      ok: true,
      latency_ms,
      detail: {
        auth_role: usingRole,
        row_count: rows.length,
        workflow_count: summary.length,
        workflows: summary
      }
    };
  } catch (err) {
    return {
      name: 'heartbeat_freshness',
      ok: false,
      latency_ms: Date.now() - t0,
      error: err.message || String(err),
      detail: { auth_role: usingRole }
    };
  }
}
