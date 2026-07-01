/**
 * QuantumClaw — n8n_workflow_list tool (Phase 5 Session 1).
 *
 * The n8n public API's GET /workflows returns FULL workflow objects (nodes,
 * connections, settings, staticData, pinData) — ~18 KB each, ~1.9 MB for the ~80
 * live workflows in one page. That blob overruns the tool-result / context budget
 * and truncates (measured 2026-07-01). There is no count or field-projection param
 * in the n8n API, so this builtin fetches the list (paginated) and PROJECTS each
 * workflow to {id, name, active} tool-side — a few KB instead of ~2 MB.
 *
 * Read-only. Auth mirrors n8n-workflow-update.js: N8N_API_KEY from
 * /root/.quantumclaw/.env, X-N8N-API-KEY header against webhook.flowos.tech.
 */

import { readFileSync } from 'fs';

const N8N_BASE = 'https://webhook.flowos.tech/api/v1';
const REQ_TIMEOUT_MS = 30 * 1000;
const PAGE_LIMIT = 250;
const MAX_PAGES = 20; // backstop: 20 × 250 = 5000 workflows before we stop paging

function defaultReadApiKey() {
  const envText = readFileSync('/root/.quantumclaw/.env', 'utf-8');
  const match = envText.match(/^\s*N8N_API_KEY\s*=\s*(.+)\s*$/m);
  if (!match) throw new Error('N8N_API_KEY not found in /root/.quantumclaw/.env');
  return match[1].trim().replace(/^["']|["']$/g, '');
}

export function createN8nWorkflowListTool({ readApiKey = defaultReadApiKey, fetchPage = null } = {}) {
  // fetchPage(cursor) -> { data: [...workflow objects], nextCursor: string|null }.
  // Default hits the real n8n API; tests inject a fake.
  const realFetchPage = async (cursor) => {
    const apiKey = readApiKey();
    const q = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) q.set('cursor', cursor);
    const res = await fetch(`${N8N_BASE}/workflows?${q.toString()}`, {
      headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`n8n GET /workflows → ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    return { data: Array.isArray(json.data) ? json.data : [], nextCursor: json.nextCursor || null };
  };
  const page = fetchPage || realFetchPage;

  return {
    description:
      'List all n8n workflows as a lightweight array of {id, name, active} plus a count. '
      + 'Use this — NOT the full get_workflows list — whenever you only need to find a workflow by name, '
      + 'get its id, or check whether it is active. The full GET /workflows response is ~2 MB (entire node '
      + 'graphs) and truncates; this returns a few KB. Fetch the full workflow (get_workflows_id) only once '
      + 'you have the id and need the node config.',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', description: 'If true, return only active workflows.' },
        name_contains: { type: 'string', description: 'Case-insensitive substring filter on the workflow name.' },
      },
    },
    fn: async (args = {}) => {
      const projected = [];
      let cursor = null;
      let pages = 0;
      do {
        const { data, nextCursor } = await page(cursor);
        for (const w of data) projected.push({ id: w.id, name: w.name, active: !!w.active });
        cursor = nextCursor;
        pages += 1;
      } while (cursor && pages < MAX_PAGES);

      let workflows = projected;
      if (args.active_only) workflows = workflows.filter((w) => w.active);
      if (args.name_contains) {
        const needle = String(args.name_contains).toLowerCase();
        workflows = workflows.filter((w) => String(w.name || '').toLowerCase().includes(needle));
      }
      // truncated=true means we hit the page backstop with more rows remaining —
      // surfaced (never silently capped) so the caller knows the list is partial.
      return JSON.stringify({ count: workflows.length, truncated: !!cursor, workflows });
    },
  };
}
