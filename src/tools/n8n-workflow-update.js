/**
 * QuantumClaw — n8n_workflow_update tool
 *
 * Full GET → modify → PUT → activate → preserve-availableInMCP cycle for
 * an n8n workflow at webhook.flowos.tech. Every call requires inline
 * Telegram approval (writes to shared n8n are always sensitive).
 *
 * Accepts either:
 *   - { workflow_id, patch: {...} } — shallow merge into the workflow root
 *   - { workflow_id, node_updates: [{ node_name, parameter_path, new_value }] }
 *     — targeted node edits. parameter_path uses dot notation, with array
 *     indices as [N] (e.g. "parameters.bodyParameters.parameters[0].value").
 *
 * Strips n8n read-only fields before PUT. Re-activates if the workflow was
 * active pre-change. Preserves settings.availableInMCP. Returns a short
 * diff summary so the LLM can report cleanly.
 */

import { readFileSync } from 'fs';
import { log } from '../core/logger.js';

const N8N_BASE = 'https://webhook.flowos.tech/api/v1';
const REQ_TIMEOUT_MS = 30 * 1000;

// n8n rejects these on PUT. Stripped from the GET response before we write back.
const READ_ONLY_FIELDS = [
  'updatedAt', 'createdAt', 'id', 'shared', 'tags',
  'activeVersion', 'versionId', 'activeVersionId',
  'versionCounter', 'triggerCount', 'isArchived',
  'meta', 'pinData', 'staticData', 'description', 'active',
];

function readN8nApiKey() {
  const envText = readFileSync('/root/.quantumclaw/.env', 'utf-8');
  const match = envText.match(/^\s*N8N_API_KEY\s*=\s*(.+)\s*$/m);
  if (!match) throw new Error('N8N_API_KEY not found in /root/.quantumclaw/.env');
  return match[1].trim().replace(/^["']|["']$/g, '');
}

async function n8n(method, path, body) {
  const apiKey = readN8nApiKey();
  const res = await fetch(`${N8N_BASE}${path}`, {
    method,
    headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.slice(0, 300);
    throw new Error(`n8n ${method} ${path} → ${res.status}: ${snippet}`);
  }
  try { return JSON.parse(text); } catch { return text; }
}

// Parses a dotted / bracketed path into segments. "a.b[2].c" → ["a","b",2,"c"]
function parsePath(pathStr) {
  const segments = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(pathStr)) !== null) {
    segments.push(m[1] !== undefined ? m[1] : parseInt(m[2], 10));
  }
  return segments;
}

function setNested(obj, pathStr, value) {
  const segs = parsePath(pathStr);
  if (segs.length === 0) throw new Error(`Empty parameter_path`);
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    const nextIsIndex = typeof segs[i + 1] === 'number';
    if (cur[k] === undefined || cur[k] === null) {
      cur[k] = nextIsIndex ? [] : {};
    }
    cur = cur[k];
  }
  cur[segs[segs.length - 1]] = value;
}

export function createN8nWorkflowUpdateTool({ approvalGate, audit, auditActor = 'charlie' }) {
  return {
    description: 'Update an n8n workflow at https://webhook.flowos.tech. Always requires Telegram approval. Handles the GET → modify → PUT → reactivate dance and preserves availableInMCP. Pass either `patch` (shallow merge at workflow root) or `node_updates` (targeted node edits).',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'n8n workflow ID (short alphanumeric).' },
        patch: {
          type: 'object',
          description: 'Shallow merge into the workflow root — e.g. { name: "new name" } or { nodes: [...] }.',
        },
        node_updates: {
          type: 'array',
          description: 'Targeted node edits. Each item: { node_name, parameter_path, new_value }. parameter_path supports dot + [N] (e.g. "parameters.bodyParameters.parameters[0].value").',
          items: {
            type: 'object',
            properties: {
              node_name: { type: 'string' },
              parameter_path: { type: 'string' },
              new_value: {},
            },
            required: ['node_name', 'parameter_path', 'new_value'],
          },
        },
      },
      required: ['workflow_id'],
    },
    longRunning: true,
    fn: async (args) => {
      const workflowId = args?.workflow_id;
      if (!workflowId) return { error: 'workflow_id required' };
      const patch = args?.patch;
      const nodeUpdates = Array.isArray(args?.node_updates) ? args.node_updates : [];
      if (!patch && nodeUpdates.length === 0) {
        return { error: 'Provide either patch or node_updates' };
      }

      // 1. GET current state
      let wf;
      try { wf = await n8n('GET', `/workflows/${encodeURIComponent(workflowId)}`); }
      catch (err) { return { error: `GET failed: ${err.message}` }; }

      const previous_version_id = wf.versionId || null;
      const wasActive = !!wf.active;
      const wantMcp = wf.settings?.availableInMCP !== false; // preserve true/undefined

      // 2. Apply changes
      const changes = [];
      if (patch && typeof patch === 'object') {
        for (const [k, v] of Object.entries(patch)) {
          wf[k] = v;
          changes.push(`patch:${k}`);
        }
      }
      for (const u of nodeUpdates) {
        const node = (wf.nodes || []).find(n => n.name === u.node_name);
        if (!node) return { error: `Node "${u.node_name}" not found in workflow ${workflowId}` };
        try { setNested(node, u.parameter_path, u.new_value); }
        catch (err) { return { error: `Failed to set ${u.node_name}.${u.parameter_path}: ${err.message}` }; }
        changes.push(`${u.node_name}.${u.parameter_path}`);
      }

      // 3. Approval — always, writes to n8n are sensitive
      const decision = await approvalGate.requestInlineApproval({
        agent: auditActor,
        tool: 'n8n_workflow_update',
        action: `Update workflow ${workflowId} (${wf.name})`,
        detail: `Changes: ${changes.join(', ')}`.slice(0, 800),
        riskLevel: 'high',
      });
      if (!decision?.approved) {
        audit?.log?.(auditActor, 'n8n_workflow_update_denied', workflowId, {
          approval_id: decision?.id,
          reason: decision?.reason || 'denied',
          changes,
        });
        return {
          error: 'Approval denied',
          approval_id: decision?.id,
          reason: decision?.reason || 'denied',
          workflow_id: workflowId,
        };
      }

      // 4. Build PUT body (strip read-only, preserve MCP flag)
      const putBody = {};
      for (const k of Object.keys(wf)) {
        if (!READ_ONLY_FIELDS.includes(k)) putBody[k] = wf[k];
      }
      putBody.settings = { ...(wf.settings || {}), availableInMCP: wantMcp };

      // 5. PUT
      try { await n8n('PUT', `/workflows/${encodeURIComponent(workflowId)}`, putBody); }
      catch (err) {
        audit?.log?.(auditActor, 'n8n_workflow_update_error', workflowId, {
          stage: 'put', error: err.message, changes,
        });
        return { error: `PUT failed: ${err.message}`, workflow_id: workflowId };
      }

      // 6. Re-activate if it was active pre-change
      let activated = false;
      if (wasActive) {
        try {
          await n8n('POST', `/workflows/${encodeURIComponent(workflowId)}/activate`);
          activated = true;
        } catch (err) {
          log.warn(`n8n re-activate failed for ${workflowId}: ${err.message}`);
        }
      }

      // 7. Verify
      let new_version_id = null;
      let mcp_enabled = wantMcp;
      try {
        const after = await n8n('GET', `/workflows/${encodeURIComponent(workflowId)}`);
        new_version_id = after.versionId || null;
        mcp_enabled = after.settings?.availableInMCP !== false;
      } catch { /* best-effort verification */ }

      const diff_summary = changes.join(', ') || '(none)';
      audit?.log?.(auditActor, 'n8n_workflow_update', workflowId, {
        previous_version_id, new_version_id, activated, mcp_enabled, diff_summary,
      });

      return {
        workflow_id: workflowId,
        previous_version_id,
        new_version_id,
        activated,
        mcp_enabled,
        diff_summary,
      };
    },
  };
}
