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

// Phase 5 Session 1 — scope tiers:
//   RUN_SCOPES  : dispatched straight to 'queued'; the dispatcher runs CC READ-ONLY.
//   WRITE_SCOPES : write/infra — NOT dispatched directly. The tool writes an
//                  'awaiting_authorisation' row + pushes a structured Telegram
//                  approval request; the owner's ✅ reply flips it to 'queued'.
//   'critical'   : hard-blocked here (throws, never writes a row).
// NOTE (write-execution gap): approving a write/infra row flips it to 'queued', but
// the dispatcher's own validateScope still only runs audit/read_only and executes
// CC read-only — so an APPROVED write task will currently be claimed and fail at the
// dispatcher. Dispatcher write-execution (ALLOWED_SCOPES + a non-read-only runner)
// is a deliberate FUTURE session; this unit builds only the approval gate + lifecycle.
const RUN_SCOPES = ['audit', 'read_only'];
const WRITE_SCOPES = ['write', 'infra'];
const ALL_SCOPES = [...RUN_SCOPES, ...WRITE_SCOPES, 'critical'];
// RUN scopes run read-only ⇒ audit_only only. WRITE scopes may carry an implement
// mode (the DB CHECK already permits all three; execution is a future session).
const RUN_MODES = ['audit_only'];
const ALL_MODES = ['audit_only', 'audit_then_implement', 'implement_with_audit_gate'];
const RISK_LEVELS = ['low', 'medium', 'high'];
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
  // Phase 5: async (text)->boolean that pushes a write-scope approval request to the
  // owner's Telegram. Injected by index.js (reuses the proven direct-fetch notifier —
  // bot.api.sendMessage drops inside the runner). null in tests/CLI (send is skipped).
  notify = null,
  // Test seam: inject a REST client (method, path, {body,prefer}) -> parsed JSON.
  // Defaults to the env-configured Supabase service_role client below.
  restClient = null,
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

  async function _defaultRest(method, path, { body, prefer } = {}) {
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
  const rest = restClient || _defaultRest;

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
      'Dispatch a brief to Claude Code (a second autonomous agent working in this repo). '
      + 'audit/read_only scopes QUEUE immediately and run READ-ONLY (audit + report); the result is surfaced '
      + 'to you in a later reply. write/infra scopes are NOT dispatched directly — they require Tyson\'s '
      + 'approval: the tool records the request and pushes a structured approval prompt to Telegram, and '
      + 'returns status "awaiting_authorisation". Do NOT claim the work is queued/approved until Tyson approves. '
      + 'critical scope is never dispatchable. Author the brief via the delegation skill template. Do NOT claim '
      + 'Claude Code "completed" or "found" anything until its result has actually been surfaced back to you.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What Claude Code should do (the core instruction).' },
        mode: { type: 'string', enum: ALL_MODES, description: 'audit_only = audit and report (read-only; required for audit/read_only scope). audit_then_implement / implement_with_audit_gate are only valid with write/infra scope.' },
        scope: { type: 'string', enum: ALL_SCOPES, description: 'audit/read_only = read-only, queued immediately. write/infra = mutating, requires Tyson approval (awaiting_authorisation). critical = never dispatchable.' },
        repo: { type: 'string', description: `Target repo as owner/name (default ${DEFAULT_REPO}).` },
        business_unit: { type: 'string', description: 'Owning brand/unit, if relevant.' },
        context: { type: 'string', description: 'Background Claude Code needs.' },
        audit_scope: { type: 'string', description: 'Exactly what Claude Code may inspect / the boundary of the audit.' },
        acceptance_criteria: { type: 'string', description: 'What a good result looks like.' },
        constraints: { type: 'string', description: 'Hard limits Claude Code must respect.' },
        deliverable: { type: 'string', description: 'The shape of the expected output.' },
        priority: { type: 'integer', description: '1–10, higher runs first (default 5).' },
        // write/infra approval-prompt fields (ignored for audit/read_only):
        fix: { type: 'string', description: 'One-line description of the fix (shown in the Telegram approval prompt). Defaults to the first line of task.' },
        risk: { type: 'string', enum: RISK_LEVELS, description: 'Risk level for the approval prompt (write/infra). Defaults to medium.' },
        action: { type: 'string', description: 'Exact summary of what CC will do (approval prompt). Defaults to deliverable or task.' },
      },
      required: ['task', 'mode', 'scope'],
    },
    fn: async (args = {}, ctx = {}) => {
      // Hard failures THROW (not return) so the tool's audit result_status is
      // 'error', and Gate 2 never treats a rejected dispatch as a real dispatch.
      if (!restClient && (!SUPABASE_URL || !SERVICE_KEY)) {
        throw new Error('dispatcher storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing); cannot queue.');
      }

      const task = String(args.task || '').trim();
      if (!task) throw new Error('task is required.');
      const scope = String(args.scope || '');
      // critical: hard-blocked — THROW before any row is written.
      if (scope === 'critical') throw new Error('critical scope is never dispatchable to Claude Code.');
      if (!ALL_SCOPES.includes(scope)) throw new Error(`scope must be one of ${ALL_SCOPES.join(', ')}.`);
      const isWrite = WRITE_SCOPES.includes(scope);
      const mode = String(args.mode || '');
      // RUN scopes run read-only ⇒ audit_only only. WRITE scopes may carry an implement mode.
      const allowedModes = isWrite ? ALL_MODES : RUN_MODES;
      if (!allowedModes.includes(mode)) {
        throw new Error(isWrite
          ? `mode must be one of ${ALL_MODES.join(', ')} for write/infra scope.`
          : `mode must be ${RUN_MODES.join(', ')} for audit/read_only scope (read-only run).`);
      }
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

      // write/infra hold in 'awaiting_authorisation' until the owner approves via
      // Telegram; audit/read_only go straight to 'queued' (dispatcher runs them).
      const initialStatus = isWrite ? 'awaiting_authorisation' : 'queued';

      let row;
      try {
        const inserted = await rest('POST', 'claude_code_dispatches', {
          prefer: 'return=representation',
          body: {
            status: initialStatus,
            scope,
            mode,
            priority,
            repo,
            brief,
            pinned_commit: pinned,
            business_unit: args.business_unit ? String(args.business_unit).trim() : null,
            session_id,
            created_by: auditActor,
            authorisation_required: isWrite,
          },
        });
        row = Array.isArray(inserted) ? inserted[0] : inserted;
      } catch (e) {
        log.error(`claude_code_dispatch: insert failed: ${e.message}`);
        throw new Error(`could not queue the dispatch (${e.message}).`);
      }
      if (!row?.id) throw new Error('dispatch row did not return an id; not queued.');

      // ── Write-scope approval gate: push a structured request to Telegram. ──
      if (isWrite) {
        const task8 = String(row.id).slice(0, 8);
        const fix = (args.fix ? String(args.fix) : task).trim().split('\n')[0].slice(0, 200);
        const risk = RISK_LEVELS.includes(String(args.risk || '').toLowerCase())
          ? String(args.risk).toLowerCase() : 'medium';
        const action = (args.action ? String(args.action)
          : args.deliverable ? String(args.deliverable) : task).trim().slice(0, 400);
        const approvalMsg =
          `⚠️ Write-scope dispatch — approval required\n\n`
          + `Fix: ${fix}\n`
          + `Scope: ${scope}\n`
          + `Risk: ${risk}\n`
          + `Action: ${action}\n`
          + `Task ID: ${task8}\n\n`
          + `Reply ✅ ${task8} to approve\n`
          + `Reply ❌ ${task8} to cancel`;
        // Fail-open on notify: the row is the source of truth. A dropped push must
        // not lose the request (it can be re-surfaced); log loudly instead.
        let notified = false;
        if (typeof notify === 'function') {
          try { notified = !!(await notify(approvalMsg)); }
          catch (e) { log.warn(`claude_code_dispatch: approval push failed (${e.message}); row ${task8} awaits approval`); }
        } else {
          log.warn(`claude_code_dispatch: no notify wired; row ${task8} awaits approval with no Telegram push`);
        }
        return JSON.stringify({
          task_id: row.id,
          status: 'awaiting_authorisation',
          authorisation_required: true,
          approval_pushed: notified,
          message: 'Approval required — check Telegram. This is NOT queued or approved yet; do not claim it is.',
        });
      }

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
