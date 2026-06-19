/**
 * Slice 6b — delegate_to tool (specialist routing surface).
 *
 * The ONLY tool Charlie uses to invoke a specialist. Enqueue-only, returns
 * immediately. In 6b every specialist is effectively a stub: the live dispatch
 * path is gated by the QCLAW_SPECIALIST_LIVE_IDS allowlist (EMPTY in 6b), so all
 * calls route back with { routed_back: true } and Charlie handles inline. The
 * live path is implemented in full so Slice 6d just adds the two intended ids to
 * the allowlist (Slice 6b audit U1-A).
 *
 * Gate-2 safety (mirrors claude-code-dispatch.js): hard failures THROW so the
 * tool's audit result_status is 'error' — a rejected/failed call can never be
 * treated by Gate 2 (gateDelegation) as a real dispatch. Only legitimate
 * outcomes RETURN a structured object: stub_routed_back, queued, sequential_only.
 *
 * Security: session_id is derived from the runtime turn context (channel:userId),
 * NOT from Charlie's args — he cannot spoof which session a dispatch belongs to.
 * Live writes use the service_role key; specialist_dispatches is RLS-locked.
 */

import { randomUUID as nodeRandomUUID } from 'crypto';
import { log } from '../core/logger.js';
import { getEnv } from '../core/env.js';
import { getSpecialist as defaultGetSpecialist } from '../agents/specialist-registry.js';

const TABLE = 'specialist_dispatches';
const DEFAULT_RATE = { perMinute: 2, perHour: 20 };

function parseLiveIds(env) {
  return new Set(String(env.QCLAW_SPECIALIST_LIVE_IDS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** Default Supabase REST surface (service_role). Injectable for tests. */
function makeSupabaseRest(env) {
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  async function rest(method, path, { body, prefer } = {}) {
    const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Supabase ${method} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  return {
    configured: () => !!(url && key),
    async findActiveBySession(session_id) {
      const rows = await rest('GET', `${TABLE}?session_id=eq.${encodeURIComponent(session_id)}&status=eq.in_progress&select=id`);
      return Array.isArray(rows) ? rows : [];
    },
    async insert(row) {
      const inserted = await rest('POST', TABLE, { prefer: 'return=representation', body: row });
      return Array.isArray(inserted) ? inserted[0] : inserted;
    },
  };
}

export function createDelegateToTool({
  audit,
  auditActor = 'charlie',
  env = getEnv(),
  getSpecialist = defaultGetSpecialist,
  supabase = null,
  randomUUID = nodeRandomUUID,
  liveIds = null,
  rateLimit = DEFAULT_RATE,
  now = () => Date.now(),
} = {}) {
  const LIVE = liveIds || parseLiveIds(env);
  const db = supabase || makeSupabaseRest(env);
  // Per-factory sliding-window rate state (persists for the tool's lifetime;
  // fresh per createDelegateToTool() call, so tests are isolated).
  const callTimes = [];

  function enforceRate() {
    const t = now();
    // prune > 1h
    while (callTimes.length && t - callTimes[0] > 3_600_000) callTimes.shift();
    const lastMinute = callTimes.filter((ts) => t - ts < 60_000).length;
    const lastHour = callTimes.length;
    if (lastMinute >= rateLimit.perMinute) {
      throw new Error(`delegate_to rate limit: max ${rateLimit.perMinute}/min — wait before delegating again.`);
    }
    if (lastHour >= rateLimit.perHour) {
      throw new Error(`delegate_to rate limit: max ${rateLimit.perHour}/hour — too many delegations this hour.`);
    }
    callTimes.push(t);
  }

  return {
    description:
      'Route a task to a Flow OS specialist (the canonical registry is FLOW_OS_SPECIALISTS.md). '
      + 'Enqueue-only: returns immediately. Most specialists are scaffolded stubs — for those the tool '
      + 'returns { routed_back: true } and you HANDLE THE TASK DIRECTLY (do not re-delegate). Live '
      + 'specialists return { status: "queued" } and the result is surfaced to you in a later turn. '
      + 'Do NOT claim a specialist "did" or "completed" anything until a result has been surfaced back.',
    inputSchema: {
      type: 'object',
      properties: {
        specialist: { type: 'string', description: 'Specialist id or display name (e.g. "content-studio-operator").' },
        task: { type: 'string', description: 'What the specialist should do (the core instruction).' },
        context: { type: 'string', description: 'Background the specialist needs.' },
      },
      required: ['specialist', 'task'],
    },
    fn: async (args = {}, ctx = {}) => {
      // Hard failures THROW (Gate-2 safety): status=error, never a real dispatch.
      const nameArg = String(args.specialist || '').trim();
      if (!nameArg) throw new Error('specialist is required.');
      const task = String(args.task || '').trim();
      if (!task) throw new Error('task is required.');

      const entry = getSpecialist(nameArg);
      if (!entry) {
        throw new Error(`no specialist "${nameArg}" in the registry; use a registered specialist id (see FLOW_OS_SPECIALISTS.md).`);
      }

      enforceRate();

      const session_id = `${ctx.channel || 'unknown'}:${ctx.userId ?? 'owner'}`;
      const takesLivePath = entry.isLive && LIVE.has(entry.id);

      // ── Stub path: synchronous, NO Supabase. Loop-break is Charlie's job. ──
      if (!takesLivePath) {
        return {
          task_id: randomUUID(),
          specialist: entry.id,
          status: 'stub_routed_back',
          routed_back: true,
          stub_result: {
            specialist: entry.id,
            status: 'stub',
            task,
            routed_back: true,
            message: 'Specialist not yet live. Charlie will handle directly.',
          },
        };
      }

      // ── Live path (gated; never fires in 6b — empty allowlist). ──
      if (!db.configured || !db.configured()) {
        throw new Error('specialist dispatch storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing); cannot queue.');
      }

      // Sequential enforcement: one in-flight specialist dispatch per turn.
      let active = [];
      try { active = await db.findActiveBySession(session_id); }
      catch (e) { log.warn(`delegate_to: sequential check failed (${e.message}) — proceeding`); }
      if (active.length > 0) {
        return {
          error: 'sequential_only',
          message: 'One specialist dispatch per turn. Wait for the current dispatch to complete.',
        };
      }

      let row;
      try {
        row = await db.insert({
          specialist_id: entry.id,
          status: 'queued',
          task,
          context: args.context ? String(args.context).trim() : null,
          session_id,
          created_by: auditActor,
        });
      } catch (e) {
        log.error(`delegate_to: insert failed: ${e.message}`);
        throw new Error(`could not queue the specialist dispatch (${e.message}).`);
      }
      const taskId = row?.task_id || row?.id;
      if (!taskId) throw new Error('specialist dispatch row did not return an id; not queued.');

      return { task_id: taskId, specialist: entry.id, status: 'queued', routed_back: false };
    },
  };
}
