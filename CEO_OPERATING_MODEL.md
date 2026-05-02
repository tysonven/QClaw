# CEO Operating Model — Flow OS and Flow States Collective

This document is the north star for Flow OS and Flow States Collective operations. It defines the target state in which Tyson operates as CEO — strategic decisions, building, family, outdoors — while an agent stack runs day-to-day operations. Every architecture decision in Charlie 2.0 and beyond is made in service of this model. If a design choice doesn't move the business toward this state, it's the wrong choice.

## Role split

**Tyson — CEO.** Sets strategy. Makes decisions only Tyson can make: financial commitments above threshold, hiring, scope changes on client work, brand voice on first instances of new content types, anything touching family or external relationships. Builds when he wants to build. Reviews and approves batched decisions at fixed times of day. Not on call for spot fires.

**Charlie — Chief of Staff.** Knows the current state of both businesses. Owns the daily rhythm. Routes work to specialists. Tracks status. Surfaces decisions that need Tyson, batched. Generates morning and evening digests. Dispatches overnight work after Tyson's end-of-day approval.

**Specialists — operators.** Each specialist owns a domain end-to-end (community, content studio, build, ads, retreats, trading, clipper, QA, lead handling). Each operates with a clear scope, a verification reflex, and a defined escalation path back to Charlie. No specialist acts on financial commitments or external comms without explicit pre-authorisation or human review.

**Claude (chat) — architect and advisor.** Phase-level design work. Strategic conversations. Drafting briefs that need judgement. Not in the daily operational loop — engaged when Tyson or Charlie needs deeper thinking.

**Claude Code — implementor.** Code-grounded execution. Audits before writing. Verifies after writing. Reports back with citations. Engaged by Charlie via the delegation bridge, not by Tyson manually.

## Daily rhythm

**Morning (06:00–08:00 local).** Tyson wakes to a morning digest delivered via Telegram and email. The digest contains four sections, each scannable in under 30 seconds:

1. *What ran overnight* — jobs completed, content published, leads received, errors caught and recovered. One line per item with a link to detail.
2. *What needs your attention today* — decisions, approvals, escalations, with proposed answers where Charlie has a recommendation. Tyson can reply yes/no/this-instead in a single message.
3. *What to watch for* — pending external responses, deadlines today, anomalies worth knowing about.
4. *Top of mind* — Charlie's read on what the most important thing for the day is, given current business state.

Tyson replies. Charlie parses and dispatches. Tyson moves on with his day.

**During the day (08:00–18:00).** Charlie operates in three modes:

- *Build mode* — Tyson is heads-down. Charlie holds non-urgent items in a queue and only interrupts for genuine urgency (defined below). Surfaces the queue at lunch, end of focus block, or on Tyson's signal.
- *Ops mode* — Tyson is making decisions. Charlie surfaces items as they come in, batched into small groups (3–5 at a time) with proposed answers.
- *Background mode* — Charlie is dispatching and tracking work, no Tyson interaction needed. Specialists running their domains. Status logged.

**Urgency criteria — interrupt build mode only when:**

1. Revenue at risk before EOD — a lead or invoice that needs Tyson's input today or income falls through (proposals expiring, payment links failing, contract decisions with same-day deadlines).
2. Client emergency support can't handle — Charlie tries to route to support first; only escalates to Tyson if support has confirmed they can't handle it.
3. Vital workflow silently broken — a business-critical automation has been failing without alerting. Charlie surfaces the workflow, the impact, and time-since-failure.

Everything else queues.

**Evening (18:00–20:00).** End-of-day digest mirroring morning, delivered via Telegram and email:

1. *What shipped today* — completed work with verification.
2. *What's still in flight* — work in progress with current state and next step.
3. *What's parked for tomorrow* — work intentionally deferred with reason.
4. *Overnight candidates* — work that could be progressed without Tyson, with explicit asks: "should X run overnight?"

Tyson approves or rejects each overnight candidate. Charlie dispatches approved work. Tyson signs off.

**Overnight (20:00–06:00).** Approved work runs. Specialists execute under their scope. Charlie monitors for failures and either recovers automatically (where pre-authorised) or holds the failure for the morning digest. No external comms overnight without explicit pre-authorisation. No financial actions ever overnight.

## Trust gradient

The autonomous lane expands over time. Five levels:

- **Level 0 — Tyson does it.** Strategic, financial, family-facing, new-territory.
- **Level 1 — Charlie drafts, Tyson approves and dispatches.** Default for new task types.
- **Level 2 — Specialist drafts, Charlie reviews, Tyson approves.** Tasks done before but still need eyes.
- **Level 3 — Specialist acts, Charlie reviews, Tyson sees in digest.** Pattern well-established, reversal cheap.
- **Level 4 — Specialist acts autonomously, logged but not surfaced unless anomaly.** Pattern bulletproof, error cost bounded.

A task type only moves up after a track record at its current level. Demotion on any failure, no negotiation. Registry of every task type and its current level kept in `flow_os_state.md` (or equivalent state doc).

**Level 4 task types from day one:**

- Scheduled Instagram reel publishing where content was pre-approved in a batch
- Buzzsprout episode upload from the content studio pipeline (after first 2–3 successful runs, currently Level 3)
- Workflow heartbeat monitoring and recovery for documented failure modes
- Log rotation, disk hygiene, routine PM2 process health
- Memory writes, build log updates, audit log entries

**Explicitly NOT Level 4 yet:** bug fixing of any kind, n8n workflow modifications, code commits, content editorial decisions on first-pass content (only pre-approved batches).

Principle: generation and publishing of pre-approved content is autonomous; modification of systems is not.

## Non-negotiable rules

1. **No external comms without human review** (or a schedule Tyson explicitly pre-authorised, e.g. the Instagram queue).
2. **No autonomous financial actions ever.** Payments, refunds, charges, ad spend changes — Tyson only.
3. **No autonomous high-risk infrastructure changes during sleep/unavailable windows** without explicit pre-authorisation for that specific operation.
4. **Every autonomous action reversible or logged in a way allowing manual reversal within 24 hours.** This is what makes the autonomous lane safe to expand.
5. **Every claim by every agent is verifiable.** "Done" means a tool result confirmed it. "Working" means a probe confirmed it. Without verification, no claim.
6. **Lane discipline enforced at the runtime level, not just the prompt level.** Charlie cannot edit code; specialists cannot send external comms; nothing can run financial actions. Tool-level guards, not just instructions.

## Success criteria

The operating model is working when:

- Tyson can take a full day off and return to a clean digest, no fires, no missed work.
- Morning and evening digests are accurate enough that Tyson trusts them without independently verifying.
- Specialist agents handle 80%+ of recurring operational tasks without Tyson involvement.
- New task types move up the trust gradient predictably — typically Level 1 to Level 3 within 2–4 weeks of clean execution.
- Calendar trajectory:
  - **Year 1:** 50% strategy/building, 30% family/outdoors/travel, 20% operational reviews
  - **Year 2+:** 30% strategy/building, 60% family/outdoors/travel, 10% operational reviews

The trajectory matters more than the snapshot. Family/outdoors/travel slice growing quarter over quarter is the metric that matters.

## What this is not

This is not "fully autonomous AI runs a business." Tyson is in the loop on every consequential decision. The model offloads operational *load*, not operational *judgement*. Tyson is not less involved — he is involved at the right level, on the right cadence, with the right information.

This is also not a 1-month build. The first working version is 3–6 months out. Trust calibration is ongoing forever. The reward is not an end state, it is a steadily improving operating system.
