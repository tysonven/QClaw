/**
 * Probe: n8n reachable.
 *
 * Hits webhook.flowos.tech/healthz — unauthenticated, returns
 * {"status":"ok"} on a healthy instance. No JWT required.
 */

const HEALTHZ = 'https://webhook.flowos.tech/healthz';

export async function probe(_ctx = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(HEALTHZ, { method: 'GET' });
    const latency_ms = Date.now() - t0;
    if (!res.ok) {
      return { name: 'n8n_reachable', ok: false, latency_ms, error: `HTTP ${res.status}` };
    }
    let body = null;
    try { body = await res.json(); } catch { /* not json — still 200 */ }
    return {
      name: 'n8n_reachable',
      ok: true,
      latency_ms,
      detail: { status_code: res.status, body }
    };
  } catch (err) {
    return {
      name: 'n8n_reachable',
      ok: false,
      latency_ms: Date.now() - t0,
      error: err.message || String(err)
    };
  }
}
