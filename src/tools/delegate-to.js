/**
 * delegate_to: specialist routing surface (RETIRED 2026-08-14).
 *
 * ── Why this is a stub ───────────────────────────────────────────────────────
 * The specialist-spawning layer was never wired end to end. `delegate_to` was a
 * complete PRODUCER with no CONSUMER: the live path inserted a `queued` row into
 * `specialist_dispatches`, and nothing ever claimed, executed, or surfaced it.
 * There are no claim/reap RPCs, no worker process, and no results-surfacing
 * module (contrast `src/dispatch/claude-code-dispatcher.js` + `agents/cc-results.js`,
 * which have all three and work).
 *
 * Evidence at retirement: 2 invocations in ~6 weeks, both on 2026-07-01, same
 * task. The single row written that day was still `status='queued', attempts=0,
 * surfaced_at=null` 44 days later. Zero completed loops, ever. Meanwhile the
 * skill-based pattern (Charlie loading a skill and calling its tools directly)
 * carried effectively all real specialist-shaped work: 166 Stripe calls, 227 GHL,
 * 203 n8n-api over the same period.
 *
 * The live path was actively HARMFUL, not merely dead: for allowlisted ids it
 * returned a success-shaped `{status:'queued', routed_back:false}`, which reads
 * as "the specialist has the task" and is exactly the substrate for a fabricated
 * completion claim. The stub path was honest by contrast.
 *
 * ── What this file does now ──────────────────────────────────────────────────
 * Every call routes back. No allowlist read, no Supabase client, no INSERT, so
 * false-success path is GONE from the code, so `QCLAW_SPECIALIST_LIVE_IDS` is no
 * longer load-bearing (it is also emptied on the host; both, deliberately).
 *
 * The tool stays REGISTERED on purpose. `agents/gates.js` uses the presence of a
 * `delegate_to` event as a Gate 2 evidence predicate (`isSpecialistDispatch`);
 * deleting the tool would silently weaken a security control as a side effect of
 * retiring a feature. Keeping it also means a reach for `delegate_to` returns a
 * clear instruction instead of an unknown-tool error.
 *
 * The return shape is UNCHANGED from the old stub path (same five keys, same
 * `status: 'stub_routed_back'`), so the typed loop-break in `_processNonReflex`
 * and the Gate 2 predicates keep working untouched. Only the human-readable
 * message changed.
 *
 * Route specialist-shaped work through the relevant SKILL instead (see
 * `FLOW_OS_SPECIALISTS.md` for scope definitions, which remain accurate as
 * documentation). Heavy async/code work goes to `claude_code_dispatch`.
 *
 * Gate-2 safety (unchanged): hard failures THROW so the tool's audit
 * result_status is 'error', so a rejected call can never be read as a real
 * dispatch. Only legitimate outcomes RETURN.
 */

import { randomUUID as nodeRandomUUID } from 'crypto';
import { getEnv } from '../core/env.js';
import { getSpecialist as defaultGetSpecialist } from '../agents/specialist-registry.js';

const DEFAULT_RATE = { perMinute: 2, perHour: 20 };

const RETIRED_MESSAGE =
  'Specialist spawning is retired: there is no runtime that executes specialist '
  + 'dispatches. Handle this yourself using the relevant skill directly (the pattern '
  + 'that actually works), or use claude_code_dispatch for code/infra work. Do NOT '
  + 'say this was delegated, queued, or handed off. You are doing the work.';

export function createDelegateToTool({
  audit,
  auditActor = 'charlie',
  env = getEnv(),
  getSpecialist = defaultGetSpecialist,
  randomUUID = nodeRandomUUID,
  rateLimit = DEFAULT_RATE,
  now = () => Date.now(),
} = {}) {
  // Per-factory sliding-window rate state. Retained post-retirement purely as a
  // cheap loop guard: a confused agent retrying delegate_to in a tight loop burns
  // tokens, and the throw is Gate-2 safe.
  const callTimes = [];

  function enforceRate() {
    const t = now();
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
      'RETIRED: specialist spawning is not implemented; nothing executes specialist '
      + 'dispatches. Every call routes the task straight back to you. Prefer handling the '
      + 'task yourself with the relevant skill (e.g. the stripe or ghl skill), which is the '
      + 'working pattern, or use claude_code_dispatch for code and infrastructure work. '
      + 'This tool never queues, assigns, or hands off anything: NEVER tell the user a '
      + 'specialist "has" a task, is "working on" it, or that anything was delegated.',
    inputSchema: {
      type: 'object',
      properties: {
        specialist: { type: 'string', description: 'Specialist id or display name (e.g. "content-studio-operator"). Validated against the registry; the task still routes back to you.' },
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

      // Unconditional route-back. No allowlist, no Supabase, no INSERT: there is
      // no live path left to take. Shape is byte-identical to the pre-retirement
      // stub path so the loop-break scan and Gate 2 predicates are unaffected.
      return {
        task_id: randomUUID(),
        specialist: entry.id,
        status: 'stub_routed_back',
        routed_back: true,
        stub_result: {
          specialist: entry.id,
          status: 'retired',
          task,
          routed_back: true,
          message: RETIRED_MESSAGE,
        },
      };
    },
  };
}

// ── Loop-break detection helpers (Slice 6b Unit 4) ─────────────────────────
// Pure, typed checks over the executor's surfaced tool results. Used by
// _processNonReflex to detect a routed-back delegation (Charlie handles inline).
// These inspect the RAW result object (executor stores it pre-stringify), so NO
// JSON.parse and NO string matching, just a typed check.
//
// Post-retirement every delegate_to call is a route-back, so isStubRoutedBack is
// now the only reachable outcome. isSequentialOnly is retained (pure, exported,
// tested) because it guarded the removed live path and costs nothing to keep;
// it can no longer fire from this tool.

/** True iff a tool-result entry is a delegate_to route-back. */
export function isStubRoutedBack(toolResult) {
  const r = toolResult && toolResult.result;
  return !!(r && typeof r === 'object' && r.routed_back === true && r.status === 'stub_routed_back');
}

/** True iff a tool-result entry is a delegate_to sequential_only rejection.
 *  Unreachable from the retired tool; kept for shape-compat with stored results. */
export function isSequentialOnly(toolResult) {
  const r = toolResult && toolResult.result;
  return !!(r && typeof r === 'object' && r.error === 'sequential_only');
}

/**
 * Scan an executor toolResults array for specialist loop-break signals.
 * Returns { stubRoutedBack, routedBack:[{specialist, task}], sequentialOnly }.
 * Pure — performs NO dispatch (so it can never re-invoke delegate_to).
 */
export function scanSpecialistResults(toolResults = []) {
  const routedBack = [];
  let sequentialOnly = false;
  for (const tr of (Array.isArray(toolResults) ? toolResults : [])) {
    if (!tr || tr.name !== 'delegate_to') continue;
    if (isStubRoutedBack(tr)) {
      routedBack.push({ specialist: tr.result.specialist, task: tr.result.stub_result?.task ?? null });
    } else if (isSequentialOnly(tr)) {
      sequentialOnly = true;
    }
  }
  return { stubRoutedBack: routedBack.length > 0, routedBack, sequentialOnly };
}
