/**
 * QuantumClaw — claude_code_dispatch tool (Slice 5, Component 6 v1)
 *
 * Charlie queues an AUDIT-ONLY or AUDIT-THEN-IMPLEMENT brief for Claude Code (CC),
 * a second autonomous agent run by the `claude-code-dispatcher` PM2 worker. This
 * tool ONLY enqueues a row in Supabase `claude_code_dispatches`; it never invokes
 * CC. The dispatcher claims the row, runs CC read-only as the unprivileged
 * `ccdispatch` user, and writes the result back.
 *
 * Lane discipline (v1): only `audit` and `read_only` scopes, and only the
 * `audit_only` mode, exist in this tool. write / infra / critical scopes and the
 * `audit_then_implement` / `implement_with_audit_gate` modes are ABSENT (not
 * present-but-blocked) — they require write-scope/Tyson and land in steps 6+. The
 * dispatcher independently re-validates scope, so a row that somehow carries a
 * disallowed scope is rejected there too (defence in depth).
 *
 * Security notes:
 *  - `session_id` is derived from the runtime turn context (channel:userId),
 *    NOT from Charlie's args — he cannot spoof which session a dispatch belongs to
 *    (the gates and the read-path scope on it).
 *  - the brief is stored as text and later handed to CC as a file/stdin by the
 *    dispatcher; it is never shell-interpolated.
 *  - writes use the service_role key; the table is RLS-locked to service_role.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from '../core/logger.js';
import { getEnv } from '../core/env.js';

const execFileP = promisify(execFile);

const V1_SCOPES = ['audit', 'read_only'];
// v1 ships audit_only only. Both v1 scopes run CC read-only, so audit_then_implement
// would add the expectation of an implementation without the capability — it is
// introduced at write-scope (steps 6+) to avoid a silent semantics flip. The schema
// column still permits all three modes so that later step needs no migration.
const V1_MODES = ['audit_only'];
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const DEFAULT_REPO = 'tysonven/QClaw';
const ENQUEUE_CAP_PER_SESSION = 10; // max active (queued+in_progress) dispatches per session
const PER_TASK_ESTIMATE_MS = 120_000;

export function createClaudeCodeDispatchTool({
  audit,
  auditActor = 'charlie',
  // The app loads creds via core/env.js (getEnv), NOT into process.env — so default
  // to getEnv() or the tool would see undefined SUPABASE_* and fail to queue.
  env = getEnv(),
  repoPath = process.env.QCLAW_REPO_PATH || '/root/QClaw',
} = {}) {
  const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';

  async function pinnedCommit() {
    try {
      const { stdout } = await execFileP('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { timeout: 5000 });
      return stdout.trim() || null;
    } catch {
      return null; // dispatcher falls back to current HEAD if unpinned
    }
  }

  async function rest(method, path, { body, prefer } = {}) {
    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Supabase ${method} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  function assembleBrief(args, repo, mode) {
    return [
      `# Task\n${String(args.task).trim()}`,
      `\n# Repo\n${repo}`,
      `\n# Mode\n${mode}`,
      args.business_unit ? `\n# Business unit\n${String(args.business_unit).trim()}` : '',
      args.context ? `\n# Context\n${String(args.context).trim()}` : '',
      args.audit_scope ? `\n# Audit scope\n${String(args.audit_scope).trim()}` : '',
      args.acceptance_criteria ? `\n# Acceptance criteria\n${String(args.acceptance_criteria).trim()}` : '',
      args.constraints ? `\n# Constraints\n${String(args.constraints).trim()}` : '',
      args.deliverable ? `\n# Deliverable\n${String(args.deliverable).trim()}` : '',
    ].filter(Boolean).join('\n');
  }

  return {
    description:
      'Dispatch an AUDIT-ONLY brief to Claude Code (a second autonomous agent that '
      + 'inspects this repo READ-ONLY and reports back). Use for audits and read-only investigations you want '
      + 'Claude Code to perform. It only QUEUES the work and returns a task_id immediately; the result is '
      + 'surfaced to you in a later reply once Claude Code finishes. You cannot make it change files in v1 — '
      + 'it audits and reports only. Author the brief via the delegation '
      + 'skill template (Task, Repo, Mode, Business unit, Context, Audit scope, Acceptance criteria, '
      + 'Constraints, Deliverable). Do NOT claim Claude Code "completed" or "found" anything until its result '
      + 'has actually been surfaced back to you.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What Claude Code should do (the core instruction).' },
        mode: { type: 'string', enum: V1_MODES, description: 'audit_only = audit and report (read-only). Implementation modes require Tyson and are unavailable in v1.' },
        scope: { type: 'string', enum: V1_SCOPES, description: 'audit = read-only audit of code/state; read_only = read-only investigation. No mutating scopes are available in v1.' },
        repo: { type: 'string', description: `Target repo as owner/name (default ${DEFAULT_REPO}).` },
        business_unit: { type: 'string', description: 'Owning brand/unit, if relevant.' },
        context: { type: 'string', description: 'Background Claude Code needs.' },
        audit_scope: { type: 'string', description: 'Exactly what Claude Code may inspect / the boundary of the audit.' },
        acceptance_criteria: { type: 'string', description: 'What a good result looks like.' },
        constraints: { type: 'string', description: 'Hard limits Claude Code must respect.' },
        deliverable: { type: 'string', description: 'The shape of the expected output.' },
        priority: { type: 'integer', description: '1–10, higher runs first (default 5).' },
      },
      required: ['task', 'mode', 'scope'],
    },
    fn: async (args = {}, ctx = {}) => {
      // Hard failures THROW (not return) so the tool's audit result_status is
      // 'error', and Gate 2 never treats a rejected dispatch as a real dispatch.
      if (!SUPABASE_URL || !SERVICE_KEY) {
        throw new Error('dispatcher storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing); cannot queue.');
      }

      const task = String(args.task || '').trim();
      if (!task) throw new Error('task is required.');
      const mode = String(args.mode || '');
      if (!V1_MODES.includes(mode)) throw new Error(`mode must be one of ${V1_MODES.join(', ')}. Implementation modes require Tyson and are not available in v1.`);
      const scope = String(args.scope || '');
      if (!V1_SCOPES.includes(scope)) throw new Error(`scope must be one of ${V1_SCOPES.join(', ')}. write/infra/critical scopes are not dispatchable in v1.`);
      const repo = args.repo ? String(args.repo).trim() : DEFAULT_REPO;
      if (!REPO_RE.test(repo)) throw new Error('repo must be of the form "owner/name".');
      let priority = Number.isInteger(args.priority) ? args.priority : 5;
      priority = Math.max(1, Math.min(10, priority));

      // Server-derived session id — Charlie cannot set or spoof this.
      const session_id = `${ctx.channel || 'unknown'}:${ctx.userId ?? 'owner'}`;

      // Enqueue-side cap: bound runaway fan-out per session.
      let activeAhead = 0;
      try {
        const active = await rest('GET', `claude_code_dispatches?session_id=eq.${encodeURIComponent(session_id)}&status=in.(queued,in_progress)&select=id`);
        activeAhead = Array.isArray(active) ? active.length : 0;
      } catch (e) {
        log.warn(`claude_code_dispatch: enqueue-cap check failed (${e.message}) — proceeding`);
      }
      if (activeAhead >= ENQUEUE_CAP_PER_SESSION) {
        throw new Error(`too many active dispatches (${activeAhead}/${ENQUEUE_CAP_PER_SESSION}) for this session; wait for some to finish before queueing more.`);
      }

      const brief = assembleBrief(args, repo, mode);
      const pinned = await pinnedCommit();

      let row;
      try {
        const inserted = await rest('POST', 'claude_code_dispatches', {
          prefer: 'return=representation',
          body: {
            status: 'queued',
            scope,
            mode,
            priority,
            repo,
            brief,
            pinned_commit: pinned,
            business_unit: args.business_unit ? String(args.business_unit).trim() : null,
            session_id,
            created_by: auditActor,
            authorisation_required: false,
          },
        });
        row = Array.isArray(inserted) ? inserted[0] : inserted;
      } catch (e) {
        log.error(`claude_code_dispatch: insert failed: ${e.message}`);
        throw new Error(`could not queue the dispatch (${e.message}).`);
      }
      if (!row?.id) throw new Error('dispatch row did not return an id; not queued.');

      const estimated_completion = new Date(Date.now() + (activeAhead + 1) * PER_TASK_ESTIMATE_MS).toISOString();

      return JSON.stringify({
        task_id: row.id,
        status: row.status,
        dispatched_at: row.created_at,
        estimated_completion,
        authorisation_required: false,
        authorisation_note: null,
      });
    },
  };
}
