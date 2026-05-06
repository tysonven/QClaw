/**
 * Probe: memory layer reachable.
 *
 * Hits Cognee's /api/v1/health endpoint at the URL the runtime would
 * otherwise dial (defaults to http://localhost:8000, env-overridable
 * via config.memory.cognee.url at MemoryManager construction).
 */

const DEFAULT_URL = 'http://localhost:8000';

export async function probe(ctx = {}) {
  const t0 = Date.now();
  const url = (ctx.cogneeUrl || DEFAULT_URL).replace(/\/+$/, '');
  // /health is the unauthenticated transport-level reachability check —
  // confirmed 2026-05-06 against the localhost:8000 Cognee docker. The
  // authenticated /api/v1/health endpoint is what MemoryManager dials with
  // a bearer token; bootstrap deliberately does the cheaper transport-only
  // check so it doesn't require a live Cognee session token.
  try {
    const res = await fetch(`${url}/health`, { method: 'GET' });
    const latency_ms = Date.now() - t0;
    let body = null;
    try { body = await res.json(); } catch { /* tolerate non-json */ }
    return {
      name: 'memory_layer',
      ok: res.ok,
      latency_ms,
      detail: { url, status_code: res.status, body },
      ...(res.ok ? {} : { error: `HTTP ${res.status}` })
    };
  } catch (err) {
    return {
      name: 'memory_layer',
      ok: false,
      latency_ms: Date.now() - t0,
      error: err.message || String(err),
      detail: { url }
    };
  }
}
