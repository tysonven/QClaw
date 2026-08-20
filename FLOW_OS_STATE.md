# Flow OS State

This is the canonical state doc. Charlie reads it at session start to know what's currently true across all business units. The doc is updated continuously — routine state changes by Charlie autonomously, significant changes after Tyson approval.

This file is the fourth canonical doc Charlie reads at session start, after `CEO_OPERATING_MODEL.md`, `CHARLIE_ROLE.md`, and `LOCATIONS.md`.

**Last updated:** 2026-08-20

## Maintenance rules

- **Charlie writes autonomously to:** routine state changes (lead status updates, content pipeline status, infrastructure snapshot, recent significant changes log, churn events)
- **Charlie surfaces for Tyson approval before writing:** new client onboarding, retainer scope changes, trust gradient promotions, new specialist additions, new business unit activity, cross-dimensional client identification
- **Tyson edits directly (with Claude (chat) help):** strategic direction, offer ladder changes, business unit additions or removals
- **Sensitive context** (full names, emails, business mappings, contract values where identifying) lives in `~/.quantumclaw/flow_os_state_private.md` on the qclaw server, never in the repo
- **Maintenance log** at the bottom of this doc captures all significant changes with dates

## Architectural principles for this doc

- **GHL is the canonical contact store** for every business unit. This doc references GHL pipelines rather than duplicating contact lists.
- **Stripe is the canonical payer record** for every business unit. This doc references Stripe rather than duplicating payment data.
- **This doc bridges them** with structural context: customer↔business mapping, cross-dimensional flagging, ownership routing.
- **Pseudonymisation:** first name + last initial only in this committed doc. Full mapping in private file.

---

## Section 1 — Active engagements

### Flow OS

**6 paid subscribers.** MRR **$1,182/mth at list price** ($1,275.63 actually
billed — 5 of 6 subscriptions carry a tax uplift). Verified against live Stripe
2026-08-19.

| Person | Plan | Started | Notes |
|---|---|---|---|
| Suze H. | $97 starter | Jul 2025 | |
| Rachael B. | $97 starter | Apr 2025 | |
| Lucy H. (acct 1) | $297 unlimited | Apr 2025 (upgraded 2026-07-16) | Cross-dimensional VIP — see Cross-dimensional clients section. Upgraded $97 → $297 via cancel-and-replace, so Stripe shows a new subscription from 2026-07-16. |
| Lucy H. (acct 2) | $97 starter | Jan 2026 | Cross-dimensional VIP — Lucy's personal brand account |
| Michael Y. | $297 unlimited | Sep 2025 | Co-runs business with Eliza J. (cross-dimensional). Has Shopify n8n workflow integration. |
| Wallis M.-M. | $297 unlimited | Nov 2025 | No workflow integrations yet |

**Recently churned** (kept visible so the roster's history is legible, and so
orphaned per-client infrastructure gets cleaned up rather than quietly left
running):

| Person | Plan | Churned | Notes |
|---|---|---|---|
| Georgia F. | $97 starter | 2026-05-20 | Also had the bundled free GHL Support Bot seat |
| Kayla N. | $297 unlimited | 2026-06-22 | Morning Light. GHL location deactivated 2026-06-22 (canonical churn date; the Stripe cancellation timestamp is earlier). Orphaned n8n refresher `02Dob9FCEkXZFDAs` deactivated 2026-08-19. |
| Angela S. | $97 starter | 2026-06-25 | |

**4 internal/non-charged users:** Emma Maidment, Crete Projects, SproutCode, Flow States Collective.

**Owner:** Tyson for all Flow OS engagements.

### Flow OS product line

Flow OS ships products alongside the subscription. **None currently generates
revenue.** As of 2026-08-05 their function is credibility for the Flow OS
offer, not a revenue line — surfaced on `flowos.tech/products` as evidence of
engineering capability. Treat scope and investment accordingly.

Delivery models differ per product and determine how each is sold and
supported:

**Source-available (pay once, buyer self-hosts):** buyer receives source code
and self-deploys. No hosting obligation, no per-seat pricing, support scoped to
documentation and delivery issues only.

**Hosted (recurring):** Flow OS runs the infrastructure, buyer subscribes.

**Done-for-you (service):** Flow OS installs and configures on the buyer's
infrastructure for a setup fee. No delivery pipeline required.

#### GHL Support Bot — hosted

Support AI trained on GoHighLevel documentation. $29/month.

- `support.flowos.tech` — Flow OS sub-account users
- `support.flowos.tech/ghl` — non-Flow OS GHL accounts (broader market entry point)

| Person | Status | Started | Notes |
|---|---|---|---|
| Bruce S. | Churned | Apr 2026 | Converted from trial 26 Apr; payment bounced, canceled 2026-08-09. The predicted cancellation happened. |
| Georgia F. | Ended | bundled | Was free with her Flow OS sub; ended when that churned 2026-05-20 |
| Helena K. | Trial | — | Payment details completed, never used the platform |
| Joemarie O. | Trial | — | Payment details completed, never used the platform |
| Murray M. | Trial | — | Payment details completed, never used the platform |
| Nexus Admin | Trial | — | Payment details completed, never used the platform |

**Effective paid subscribers: 0.** The single paid account is in payment
failure and expected to cancel. Four trials converted payment details but
never activated — a zero-activation rate across every trial taken. Treat this
as a product with no revenue and no demonstrated engagement, not as a $29/mth
line item.

**Owner:** Tyson.

#### SMS Gateway — source-available

Self-hosted SMS routing. GoHighLevel, Twilio-compatible CRMs, or any webhook
system via the generic `WebhookAdapter`. Buyer runs it on their own
infrastructure and pays wholesale carrier rates.

- **Status:** live, launched publicly 2026-07-27
- **Price:** $79 founding tier
- **Storefront:** `sms.flowos.tech`
- **Sales to date:** 0
- **Delivery pipeline:** Cloudflare Worker (`api.sms.flowos.tech`) → Supabase →
  R2 bucket `flowos-sms-releases` → buyer repo `tysonven/flowos-sms-gateway-buyers`
- **Repo:** `tysonven/flowos-sms-gateway`

**Positioning decision (2026-08-05):** repositioned from active product launch
to portfolio asset. Zero sales across 265 emails, LinkedIn, and three Facebook
group posts — diagnosed as top-of-funnel message/market fit, not product or
pipeline failure. Product stays live and supported; no further outbound push.
Surfaced on `flowos.tech/products` for credibility and SEO, not as a revenue
line. Positioned broadly rather than GHL-agency-specific.

**Owner:** Tyson.

#### Call Intel (internal use, not a product)

**In active internal use. Not a product, and not on any public surface.**
Deliberately excluded from `flowos.tech/products` and it stays excluded. No page,
no card, no mention on the site. This entry's 2026-08-05 framing as a
release-blocked product was overtaken by events: it is a tool Tyson runs, and it
works.

Zoom (or GHL LC Phone) call → transcript → Claude analysis → CRM note, task, and
a follow-up email draft for the rep who ran the call. Every call is logged to
Supabase `call_intel_log`, success or failure, so nothing fails silently.

- **Repo:** `tysonven/call-intel`, private, confirmed not publicly reachable.
- **Runs on:** Vercel serverless. Nothing on qclaw. See `LOCATIONS.md`.
- **Real usage (read from `call_intel_log`, 2026-08-20):** 13 calls logged since
  2026-07-21. 8 success, 2 transport/API errors, 2 `claude_parse_error`, 1
  `contact_not_found`. 12 Zoom, 1 GHL LC Phone.

**Status of the five 2026-08-03 release blockers:**

1. **Call volume: progressed.** 6 calls since the soak test, 5 of them
   successful. Still short of the "2 to 4 weeks of production calls" bar, but no
   longer an empty dataset.
2. **`claude_parse_error` truncation: FIXED** (commit `9ef2411`). `max_tokens`
   raised 1500 to 4000, plus a field-truncation safety net. Both parse failures
   sit on 2026-08-03; every call since has parsed cleanly. **Caveat worth
   keeping:** the longest post-fix call is 83 minutes, and the 169-minute
   outlier that originally broke it has not recurred. So the raised ceiling is
   unproven at that length, and this entry's original objection (a fixed output
   ceiling cannot hold summaries from calls of arbitrary length) is not retired,
   only unexercised.
3. **GHL hardwiring: substantially progressed** (commit `3379383`). A CRM
   adapter layer now exists at `src/integrations/crm/`. `CRM_ADAPTER=ghl` is the
   default; `CRM_ADAPTER=webhook` POSTs the full structured analysis to any
   endpoint. Real movement toward CRM-agnostic, not a complete abstraction.
4. **Setup complexity: progressed.** `scripts/setup.js` is an interactive setup
   with live credential verification, replacing the manual checklist.
5. **Leak audit: still open**, and it only matters if the expansion direction
   below is ever actioned. Internal use carries no such requirement.

**Expansion intent, stated direction and not a committed plan.** Tyson has said
open-source or a paid offer is a real direction, "soon, once early soak bugs are
ironed out". There is no date, no committed scope, and no roadmap entry, so treat
this as intent rather than a plan. If it is actioned, the leak audit above is the
gating step and `flowos-sms-gateway` PR #6 is the template.

**No price has ever been set**, and that is deliberate. Three models were scoped
on 2026-08-03 (DFY setup; source-available with paid support; hosted SaaS) and
left open, so no figure is canonical and none should be quoted. Delivery model is
undecided for the same reason. If it ever does ship, the Astro `/products` layout
already takes a third card without restructuring.

**Owner:** Tyson.

### Flow States Collective

**9 confirmed active engagements** (~$4,152/mth recurring + one-offs), plus one
unconfirmed row flagged under the table.

| Client | Engagement | Started | Payment | Owner |
|---|---|---|---|---|
| Tracy R. | 1% Club payment plan | not recorded | $350/mth, **status unconfirmed** | Emma |
| Sarah H. | As Seen In (2-pay) | 1 May | 2 × $149 (1st paid) | Emma |
| Kylie F. | DFY content setup | 28 Apr | $1,400 AUD one-off | Tyson |
| Kylie F. | As Seen In | 22 Apr | $297 one-off | Emma |
| Elise C. | As Seen In | 22 Apr | $297 one-off | Emma |
| Katlen Q. | 1:1 mentoring | 18 Apr | $1,050.12/mth × 6 | Emma |
| Sinead Q. | 1:1 mentoring | 18 Apr | $1,058/mth × 6 | Emma |
| Eliza J. | 1:1 mentoring | 9 Apr | $919.07/mth × 6 | Emma |
| Natalie C. | 1:1 mentoring | 9 Apr | $1,125/mth × 5 | Emma |
| Lucy H. | 1:1 mentoring | 12 Apr | $5,850 PIF (next 6mo) | Emma |

**Tracy R. needs confirmation before she is counted either way.** This row carried
"cancels 21 Jul" from the May state; that date has now passed and the row was still
being counted as active. It could not be resolved from the payer record: there is no
Stripe customer under that name in the account the Flow OS subscriptions bill through
(checked 2026-08-20), and FSC payment plans do not appear to run through that account,
so the authoritative record sits with Emma. Confirm whether the plan completed,
cancelled, or is still running, then either restore her to the count or move her to a
churn note. The ~$4,152 recurring figure above **excludes** her $350 rather than
assuming an answer in either direction.

#### 1% Club: active, relaunched, taking leads

**The 1% Club is active and taking leads again**, with the near-term goal of driving
sales volume. The previous framing in this doc (winding down, with a payment-plan
client cancelling) described a May 2026 state and is retired.

- **Landing page:** `go.flowstatescollective.com/1-club-landing-page`
- **Focus:** brand plus lead management.
- **Delivery:** Emma.
- **Lead volume:** Ashley (setter and closer), with Emma also setting at present.

#### FSC team

- **Emma** delivers the 1% Club and the 1:1 mentoring tier. She is **currently also
  acting as a setter**, on top of delivery, while the team scales. Treat this as a
  temporary doubling-up rather than a permanent role change, and read it together
  with the capacity note below: the relaunch adds lead volume to the same person
  already carrying the delivery load.
- **Ashley** is the **setter and closer for the 1% Club**.
  - **GHL access:** the FSC sub-account and Emma's account.
  - **Access has been LIMITED, and the restriction is current.** Ashley made
    unauthorised changes to landing pages and funnels, so permissions were cut back
    to what the setting and closing role actually requires. Date of the restriction
    is not recorded here; add it if it matters later. **Widening this access is a
    Tyson decision, not a routine grant**, and any request to restore it should be
    surfaced rather than actioned.
  - Last initial not recorded. This doc's pseudonymisation convention is first name
    plus last initial, so add it when known.

**Offer ladder and funnel, current structure:**

1. **Entry, Emma-led:** the **Magnetic Authority webinar** and **Soulful Strategy
   Sessions**. Both feed into the 1% Club.
2. **1% Club, the group offer and volume layer:** brand plus lead management. Emma
   delivers. Ashley sets and closes, and Emma is setting as well at present.
3. **Automate to Elevate, Tyson:** a **separate entry point**, not a rung on the
   Emma-led ladder. Automation strategy guidance. **Tyson has deliberately pulled
   back from presenting or pitching Flow OS setup during these sessions.** Where a
   natural 1% Club fit surfaces he suggests it as a next step, as a soft suggestion
   and not a hard sell. The restraint is deliberate and is the point: the session
   stays about the client's automation problem.
4. **Custom setup work, Tyson:** the downstream option for clients who want deeper
   implementation. **Not the primary push.** Delivered by Tyson personally today,
   "hopefully a team in the future".
5. **1:1 mentoring, Emma:** remains the apex tier.

Lower-ticket entry products (As Seen In, AI PT Sessions) sit below the 1% Club.

**Strategic note:** all 4 active 1:1 monthly clients started 9 to 18 Apr 2026, so the
next 5 to 6 months are loaded with delivery work for Emma. Watch for capacity strain.
That risk is now higher than when this note was written, because Emma is also setting
for the relaunched 1% Club on top of the same delivery load.

### SproutCode

**Pre-revenue / beta + seed-stage.**

- Beta + trial users; contact list growing in SproutCode GHL sub-account
- In active development
- Actively seeking seed funding
- No paid customers yet

**Owner:** Tyson.

### Crete

**EOI-phase / pre-entity / land-sourcing.**

- Building interest from investors and members
- Actively sourcing land and buildings to renovate
- Business entity not yet officially set up — waiting on concrete EOIs first
- Crete GHL sub-account is the canonical contact store for leads and contractors
- QClaw runs content automation for Crete

**Owner:** Tyson.

### Kairos Wines

**Waitlist stage / pre-revenue.**

- Vineyard project: waitlist plus a sponsor-a-vine initiative
- Kairos GHL sub-account is the canonical contact store for waitlist and sponsor leads
- Site at `kairos-wines.com` (Astro + Vercel)
- No paid subscribers yet; treat as pre-revenue like Crete
- Charlie reaches it through the `ghl-kairos.md` skill. Note there is no GHL admin
  user scoped only to this location, so the skill runs on Tyson's personal account —
  be careful not to cross this brand with another.

**Owner:** Tyson.

### Personal

**The standalone trade engine is LIVE and ARMED** (`trading_enabled=true`, PM2
`trade-engine`). It owns scanner, analyst, approval gate, executor and position
monitor, and it moves real money on approved trades. This is not a
monitoring-only surface and has not been one since 2026-08-05. Check live state
at `GET http://127.0.0.1:4003/health` and `trading_config` rather than trusting
any number written here, including in this doc; the n8n trading workflows are
all retired, so their inactive state says nothing about whether money can move.
Detail in the `trading` skill.

No other personal-business engagements.

---

## Section 2 — Cross-dimensional clients

These are clients engaged across multiple business units. They are highest-value and highest-touch relationships. Charlie reads this section before any action involving these names so cross-engagement context is always considered.

### Lucy H. — VIP

- Flow OS sub × 2 (chiro practice + personal brand business)
- FSC 1:1 mentoring with Emma ($5,850 PIF, started 12 Apr 2026)
- **3 concurrent engagements with one person.** Highest-touch relationship in the portfolio.
- Charlie's rule: any Lucy H. interaction across any business unit factors in all three engagements.

### Eliza J. + Gutful

- Eliza on FSC 1:1 with Emma ($919/mth from 9 Apr 2026)
- Co-runs Gutful (Flow OS $297 sub) with Mikey
- Stripe payer for Gutful is Michael Y.; Eliza is operationally part of Gutful's reality
- Charlie's rule: Gutful conversations factor in Eliza's parallel 1:1 relationship.

### Kylie F.

- FSC As Seen In ($297 one-off, 22 Apr 2026)
- Tyson DFY content setup ($1,400 AUD, 28 Apr 2026)
- Potential Crete projects investor (warm conversation, no commitment yet)
- **Multi-engagement, growing relationship.** Charlie's rule: any Kylie F. action considers all three engagement contexts and her potential investor status.

---

## Section 3 — Active leads

Per the architectural principle, leads live in GHL sub-accounts. Charlie pulls current pipeline state via GHL operator tools rather than duplicating here. This section captures only:

- The location of each business unit's lead pipeline
- Named leads worth Charlie tracking by name beyond the GHL list
- Non-GHL lead sources

### Lead pipelines by business unit

- **Flow OS leads:** Flow OS GHL sub-account (read via Flow OS GHL Operator)
- **FSC leads:** FSC GHL sub-account (read via FSC GHL Operator)
- **SproutCode leads:** SproutCode GHL sub-account (read via SproutCode Operator)
- **Crete leads:** Crete GHL sub-account (read via Crete Operations Specialist)
- **GHL Support Bot leads:** Flow OS GHL sub-account, tagged for support bot product
- **Instagram DMs:** Direct to Tyson, not yet auto-routed to GHL — Charlie reads via Instagram tools

### Named leads (worth tracking by name beyond GHL pipeline)

- **Nate Puffalt / Prairie Rising** — Flow OS lead. Paid discovery proposal sent at $3,000 CAD. Status: parked but warm. Last contact: emailed week ending 2026-05-03 saying they're trying internally first; will reach back out if they want to go deeper. Charlie's rule: do not actively chase. If Nate or Prairie Rising contacts arrive, surface immediately to Tyson with full historical context.

### Dormant interest (low-priority watch list)

- **Sally and Dani** — both expressed interest in Automate to Elevate (FSC offering). Given the link, parked while they think. Not active leads. Charlie's rule: don't chase. If either re-engages, surface to Emma.

---

## Section 4 — Content pipeline state

### FSC — Emma's podcast pipeline (Content Studio)

- **Status:** Active
- **Last episode:** Shipped via Claude Code direct upload (bypassed dashboard due to file size)
- **Known issue:** Large file upload fails through Content Studio dashboard. Workaround: Claude Code direct upload. Resolution pending in Phase 5+.
- **Test episodes:** Deleted from Buzzsprout (per session 2026-04 work). Pipeline is clean for Emma's use.

### Flow OS GHL Marketing — Support Bot content

- **Status:** Live, automated
- **Cadence:** ~3× per week

### Flow OS — Infographics

- **Status:** Live (separate automation from Support Bot)
- **Scope:** Flow OS marketing only

### Flow OS — Blog posting

- **Status:** Live (separate workflow from Support Bot and Infographics)
- **Scope:** Flow OS marketing only

### Crete Marketing

- **Status:** Live, dashboard-driven workflow
- **Distribution:** IG, Facebook, LinkedIn
- **Cadence:** 3-4× per week

### Instagram reel engine — Tyson personal brand

- **Status:** Active
- **Current batch:** Batch 2 (posts 251-500) underway. Performance and analytics improved versus Batch 1.
- **Cadence:** 4-5 reels per day (reduced from earlier higher volume)
- **ICA archetypes:** "Sophie" (overwhelmed wellness entrepreneur) and "Tom" (ex-corporate performance-focused founder)
- **Themes for Batch 2:** Revenue Leakage, Offer Clarity, AI + Automation for Operators, Founder Operating Rhythm, Scaling Without Breaking

### SproutCode content

- **Status:** Manual
- **Process:** Tyson creates and schedules content via GHL social planner
- **Automation:** Not yet built (potential Phase 5+ work)

---

## Section 5 — Infrastructure snapshot

This is a point-in-time snapshot. Charlie probes at session bootstrap (Layer 5 of bootstrap mechanism) and either confirms freshness or flags drift.

**Last verified:** 2026-08-19

| Component | Status | Location | Notes |
|---|---|---|---|
| QClaw server | Live | `138.68.138.214`, port 4000 | PM2 manages 6 processes: quantumclaw, trade-engine, claude-code-dispatcher, agex-hub, trading-worker, clipper-worker. `charlie-watcher` was decommissioned with Slice 5. `trading-worker` (Monte Carlo, :4001) is still load-bearing — the trade engine calls it for simulations. |
| Trade engine | Live, ARMED | `127.0.0.1:4003` | PM2 `trade-engine`. Scanner, analyst, approval gate, executor, position monitor. `trading_enabled=true` — real money. Check `/health`, never assume from n8n state. |
| n8n server | Live | `157.230.216.158` | Docker Compose |
| Dashboard | Live | `agentboardroom.flowos.tech` | Per Phase 2 audit, API layer healthy on localhost |
| Supabase | Live | project `fdabygmromuqtysitodp` | "Supabase FSC" credential in n8n |
| Cloudflare R2 | Live | per-bucket scope | Used by Clipper, Content Studio, Crete Marketing, Flow OS GHL Marketing |
| Cognee + Qdrant | Live | localhost:8000 | Memory layer probe green; `recentEntries` returning 12-14 conversation entries per bootstrap fire (verified 2026-05-06). Entities/relationships table fullness not re-verified since Phase 2 audit. |
| Heartbeats | Live | 08:00 Athens daily morning brief; trading scanner heartbeat with error workflow `7kpNnMtnuDWXgWcX` | |

---

## Section 6 — Trust gradient registry

Per the operating model, every task type sits at one of five trust levels. Tasks move up only with track record; demoted on any failure.

### Level 4 — autonomous, logged, surfaced only on anomaly

- Pre-approved Instagram reel publishing (where content was approved in batch)
- Workflow heartbeat monitoring + recovery for documented failure modes
- Log rotation, disk hygiene, routine PM2 process health
- Memory writes, build log updates, audit log entries
- Trading scanner monitoring (read-only)

### Level 3 — specialist acts, Charlie reviews, Tyson sees in digest

- Buzzsprout episode upload (Content Studio Operator) — candidate for Level 4 after 2-3 successful runs; currently held at Level 3 due to large-file upload issue

### Level 2 — specialist drafts, Charlie reviews, Tyson approves

- Most Content Studio distribution steps (LinkedIn drafts, Substack drafts, WordPress drafts)
- GHL Operator pipeline moves outside pre-authorised rules
- Email drafts for client comms

### Level 1 — Charlie drafts, Tyson approves and dispatches

- Bug fixing of any kind (always via Claude Code dispatch with audit-first)
- n8n workflow modifications (always via Claude Code dispatch with audit-first)
- Code commits (always via Claude Code dispatch with audit-first)
- New task types not yet categorised

### Level 0 — Tyson does it; never autonomous

- Trade execution
- Position changes
- Capital allocation decisions
- Financial actions of any kind (charges, refunds, payouts, ad spend changes, subscription changes)
- External comms send (drafts only by agents, sent by humans or pre-authorised schedules)
- Content editorial decisions on first-pass content (Tyson + Emma only)
- Strategic decisions (offer ladder, business unit changes)
- Identity-layer doc edits (`CEO_OPERATING_MODEL.md`, `CHARLIE_ROLE.md`)

### Promotion candidates (next review)

- **Buzzsprout episode upload** Level 3 → Level 4 after 2-3 successful runs and large-file upload fix
- Any task type that demonstrates clean execution at current level for 2-4 weeks without failure

---

## Section 7 — Known issues

Stuff currently broken, suboptimal, or pending. Charlie reads this section to know what to surface in digests and what not to retry blindly.

### Memory layer

- Cognee entities/relationships tables empty (Phase 2 audit). Degradation level 1 of 5. Functional but not at full capacity. Resolution: pending.

### Tool surface

- (Resolved 2026-05-14, Slice 3a) Filesystem MCP preset removed from `PRESET_SERVERS`; the dashboard `POST /api/agents/spawn` endpoint and the `spawn_agent` built-in are both gone; the `Supabase:execute_sql` reference in `archive/charlie-cto.md` corrected to `supabase_select`. The `supabase_select` tool itself is still not registered (no Supabase preset in `PRESET_SERVERS`) — Slice 3b decides whether to add the preset or drop the always-on prose reference in `delegation.md`.

### Skill files

- 6 load-bearing skill files not symlinked into Charlie's workspace (trading, build, architecture-pillars, qa, task-queue, security). Pending Phase 4 Slice 2 reconciliation.
- `trading.md` config values may drift from live `trading_config` table after Apr 29 trading-fix commit. Reconcile in Phase 4 Slice 2.
- `content-studio.md` is a 440-byte stub. Rebuild from `FLOW_OS_SPECIALISTS.md` in Phase 4 Slice 2.
- `community-manager.md` (both Flow OS and FSC) does not exist. Create in Phase 4 Slice 2.
- Files to archive: `charlie-cto.md` (superseded by `CHARLIE_ROLE.md`), `agent-coordination.md` (frozen Echo agent), `n8n-api.md.backup.*` (stale backup).
- **HIGH (2026-05-14, Slice 3b.1 verification) — `ghl.md` keyword coverage gap.**
  - Symptom: "what leads do we have right now" did not route `ghl.md` (tool-call.log entry 19:08:45Z showed `routed_on_demand_skills:[]` and `active_set_size:6`).
  - Root cause: `ghl.md` frontmatter keywords don't include "leads", "contacts", or "pipeline" — the most natural words a user would use to ask about GHL data.
  - Fix shape: add keywords to `ghl.md` frontmatter. Likely a 5-minute dispatch.
  - Priority HIGH — Charlie can't reach GHL tools through natural phrasing, will keep falling back to `shell_exec` which 3c will block.
- **LOW (2026-05-14, Slice 3b.1 verification) — Trading API 401 even when tools activated.**
  - Symptom: "status of trading" routed `trading-api` correctly (tool-call.log entry 19:09:13Z showed 4 `trading-api` tools activated), but Charlie reported all three trading endpoints returning 401 Unauthorised.
  - Root cause: pre-existing auth wiring bug in the `trading-api` skill — either `secrets.dashboard_auth_token` is missing/expired or the trading-worker is genuinely down. Separate from 3b.
  - Fix shape: separate diagnostic dispatch on `trading-api` auth wiring + trading-worker process state.
  - Priority LOW — trading cluster is deactivated per 2026-05-13; auth fix only useful after Polymarket funds and worker diagnostic resolve.
- **LOW (2026-05-14, Slice 3b.1 verification) — Trading skill self-awareness gap.**
  - Symptom: Charlie correctly recalled from bootstrap that trading cluster is deactivated, then tried `trading-api` tools anyway, reported 401 as a fix-worthy bug.
  - Root cause: `trading-api.md` skill has no instruction like "if trading cluster is deactivated per state doc, do not attempt tool calls; report deactivation state and offer reactivation path."
  - Fix shape: skill content edit, one paragraph. Out of any current slice scope — file as standalone followup.
  - Priority LOW — cosmetic; tools will fail-loud anyway via the 401, no system impact.
- **LOW (2026-05-15, Slice 3c.1 audit) — `Agent: unknown` in approval prompts for `shell_exec`.**
  - Symptom: Slice 3c live smoke test 2026-05-15 17:00 Athens produced approval prompt with `Agent: unknown`. `src/tools/executor.js` line 135 uses `options.agent || 'unknown'` when calling `approvalGate.requestApproval`. `src/agents/registry.js` line 391 does NOT pass `agent` in the options object to `toolExecutor.run(messages, {model, system})`.
  - Root cause: the agent context flow from `agent.process()` → `toolExecutor.run()` is missing the agent name. The executor knows what tool is being called but not which agent asked.
  - Fix shape: thread `agent: this.name` (or equivalent) through the `toolExecutor.run` options. Small dispatch (single file, single line, plus a test).
  - Priority LOW — cosmetic in the prompt only; audit log records `auditActor` correctly because that's wired at tool-construction time.
- **MEDIUM (2026-05-15, Slice 3c.1 audit) — `_matchDestructivePattern` future-greediness watch.**
  - Symptom: brief 3c.1 speculated `_matchDestructivePattern` was catching `pm2 list`. Audit found it was actually step 3 (gatedTools) that caught it; the destructive verb-scoped patterns correctly distinguish `pm2 stop/delete/restart` from `pm2 list/logs`. Not a current bug.
  - Watch shape: when Slice 6 adds per-specialist read-only tools, the destructive verb list should be reviewed against the new verb surfaces. If anyone adds e.g. `git push` as an allowlisted form, the gate's `_matchDestructivePattern` would still gate `git push --force`, which is the correct second-line behaviour — but the interaction between allowlist and gate destructive patterns is now load-bearing. Document the interaction in the inline comment near `_matchDestructivePattern`.
  - Fix shape: documentation-only at present; revisit when Slice 6 expands the allowlist surface.
  - Priority MEDIUM — no functional issue today, but the layered defences now depend on each other in a non-obvious way; a future expansion of either layer needs to consider both.
- **RESOLVED 2026-05-16, Slice 3d — `awk -i inplace` executes; no DISALLOWED_FLAGS entry for awk.**
  - Structurally rejected by Slice 3d: `awk` is not in the v1 verb surface (`ls`, `cat`, `git status`, `git log`, `pm2 list`). `shell_exec({command:"awk -i inplace …"})` returns `{error:'unknown_verb'}` at schema dispatch. The DISALLOWED_FLAGS table itself no longer exists — replaced by per-verb whitelisted-flag schemas, which is an enumeration-free flag-validation surface. Followup closed.
- **RESOLVED 2026-05-16, Slice 3d — `pm2 restart` / `pm2 reload` documentation drift.**
  - Resolved by `src/tools/shell-exec.js` rewrite in Slice 3d Unit 2 and the `CHARLIE_ROLE.md` rewrite in Unit 3. The legacy comment is gone (the entire DENY_PATTERNS / DESTRUCTIVE_PATTERNS / QUANTUMCLAW_DIR_RE block was deleted). New surface is structurally clear: only `pm2 list` (and `pm2 ls` alias) is in v1. `pm2 restart`, `pm2 reload`, `pm2 stop`, `pm2 delete` all reject as `unknown_verb` at the parser. `DEFAULT_DESTRUCTIVE_PATTERNS` in approval-gate.js is unreachable for `shell_exec` (the early-bypass returns `requiresApproval:false`) — retained for other tools. Followup closed.
- **LOW (2026-05-17, Slice 3d.1 verification) — VERB_SCHEMAS docstring missing `spawnArgvPrefix`.**
  - Symptom: `src/tools/shell-exec-verb-schemas.js` file-header docstring lists VERB_BINARY / SAFE_ENV / DENY_PREFIXES / ALLOW_PREFIXES as structural properties but does not mention `spawnArgvPrefix` (added in Slice 3d.1).
  - Fix shape: add one line to the docstring listing `spawnArgvPrefix` in the same enumeration, with a brief description: "argv prepended to user-validated argv before spawn; never mutable from user input."
  - Priority LOW — future maintainer signal only.

### Content pipelines

- Content Studio dashboard fails on large file uploads. Workaround: Claude Code direct upload. Resolution pending.
- YouTube auto-publish carparked. Awaiting Emma to test pipeline end-to-end.

### Ad Agency

- Rex sub-role is a UI placeholder with no backing workflow.
- chatId hardcoded to Tyson — Em can't see FSC-side ad activity directly.
- Flow States Retreats account (`act_464237024205104`) currently dormant but still hardcoded in Ledger Ad Creation workflow.

### Infrastructure / process

- n8n root SSH disable is parked. DigitalOcean console auth broken — too risky to proceed currently.
- Process risk: ad-hoc commits getting tangled across Charlie sessions. Mitigated by `CLAUDE_CODE_OPERATING_RULES.md` (committed today). Watch for re-occurrence.
- SproutCode content automation not yet built. Currently fully manual.
- **RESOLVED 2026-05-21, Slice 3e — grammY runner unhandled rejection causing quantumclaw restart loops.**
  - Closed by wrapping the runner's `task()` promise in `src/channels/manager.js` `_onRunnerFailure` (Slice 3e Unit 1). Classifier (`src/channels/grammy-error-classifier.js`) routes 429/502/503/504 + standard net codes to bounded inline retry (5 attempts, 1/2/4/8/16s ± 25% jitter); 401/403/409 + any other HTTP code to immediate degrade. Degraded channel attempts re-init via a 5-min recovery timer, capped at 12 attempts before requiring manual intervention. Process never crashes from runner-loop errors. All transitions logged JSONL to `~/.quantumclaw/channel-events.log` (mode 0600, token-scrubbed). PR #TBD (cc/slice3e-grammy-runner-hardening-20260521-1531). Post-merge 72h observation by Tyson; success threshold ≤2 restarts/72h.
- **RESOLVED 2026-05-22 — 2026-05-14 SIGINT source investigation.**
  - SIGINT spike during 2026-05-14 dashboard-offline diagnosis was operator-initiated `pm2 restart quantumclaw` calls during normal session work (auth.log cross-reference confirms timestamps match every `channel-events.log` `event:"stopped"` entry). Pattern surfaced cleanly only after Slice 3e's `channel-events.log` provided structured visibility distinguishing operator restarts from grammY-driven recoveries from external signals. Future SIGINT spikes should be cross-referenced against auth.log + pm2.log before being treated as anomalous. Original followup at `QCLAW_BUILD_LOG.md` line 9953.
- **LOW (2026-05-17, Slice 3d.1 verification) — Slice 3d.1 build log paraphrased verbatim error.**
  - Symptom: Slice 3d.1 build log entry describes the dubious-ownership symptom in Tyson's words rather than capturing the raw git stderr output.
  - Root cause: CC paraphrased the user-facing report instead of the original git error text from `quantumclaw-error.log`.
  - Fix shape: edit `QCLAW_BUILD_LOG.md` Slice 3d.1 entry to include the verbatim git stderr line if recoverable from the log archive, OR add a footnote noting the verbatim text is not captured.
  - Priority LOW — cosmetic; memory hygiene rule is the principle.

---

## Section 8 — Recent significant changes

Rolling list of recent significant changes. Most recent at top. `QCLAW_BUILD_LOG.md`
is the detailed record; entries here are pointers.

### 2026-08-20

- **FSC 1% Club relaunched and Ashley onboarded.** The 1% Club is active and taking
  leads again (landing page `go.flowstatescollective.com/1-club-landing-page`), not
  winding down as the May state recorded. Ashley joined as setter and closer; her GHL
  access to the FSC and Emma accounts was subsequently **limited** after unauthorised
  changes to landing pages and funnels. Emma is setting as well as delivering while
  the team scales. Funnel restructured in Section 1: Magnetic Authority and Soulful
  Strategy Sessions as entry, 1% Club as the volume layer, Automate to Elevate as a
  separate Tyson-led entry point with a soft-suggest path in, custom builds downstream.
- **Call Intel reframed from release-blocked product to active internal tool.** The
  `claude_parse_error` truncation bug is fixed (`max_tokens` 1500 to 4000 plus a
  field-truncation safety net) and a CRM adapter layer landed, so it is no longer
  GHL-only. 6 calls processed since the soak test, 5 successful. Open-source or
  paid-offer expansion remains stated intent with no date attached. Detail lives in
  the call-intel repo's own README and history, not here.

### 2026-08-19

- **Estate audit (Pass 1) + Kayla churn cleanup.** Full read-only sweep of n8n, canonical docs, secrets and business state; found doc/reality drift across most canonical docs. Orphaned Morning Light token refresher `02Dob9FCEkXZFDAs` deactivated after blast-radius verification (Gutful runs off a separate `highlevel_tokens` row, unaffected). `CHARLIE_ROLE.md` corrected. See `QCLAW_BUILD_LOG.md`.

### 2026-08-15

- **Dashboard Trading Room rebuilt against the trade engine** (PR #91), orphan execute route removed. See `QCLAW_BUILD_LOG.md`.

### 2026-08-14

- **Specialist framework retired** (PR #90). `delegate_to` was a producer with no consumer — 2 invocations in ~6 weeks, zero completed dispatches. Specialist-shaped work is now Charlie loading the matching skill and calling its tools directly. `FLOW_OS_SPECIALISTS.md` remains canonical for scope and boundaries, not for runtime capability.
- **Charlie fabrication fixes** (PRs #88-89): identifier-provenance gate (Gate 5) and soft-hedge consolidation, closing incidents where Charlie produced confident unverified claims. See `QCLAW_BUILD_LOG.md`.

### 2026-08-06

- **Kairos Wines onboarded as a business unit.** GHL sub-account, per-brand secrets, and the `ghl-kairos.md` skill live — the fifth per-brand GHL skill alongside Flow OS, FSC, Crete and SproutCode.

### 2026-08-05 to 2026-08-11

- **Standalone trade engine LIVE** (Sessions 1-6, PRs #78-91). Python/FastAPI on `:4003`, PM2 `trade-engine`, owning scanner, analyst, approval gate, executor and position monitor. All four n8n trading workflows retired. First real-money positions placed 2026-08-11. Polymarket execution runs through an AMS3 relay because qclaw's LON1 IP is geoblocked. See `QCLAW_BUILD_LOG.md` and the `trading` skill.

### 2026-06-18

- **Slice 5 (Claude Code delegation bridge) v1 LIVE.** Charlie can now dispatch AUDIT-ONLY / read_only briefs to Claude Code via the `claude_code_dispatch` tool; the `claude-code-dispatcher` PM2 worker runs them READ-ONLY as the unprivileged `ccdispatch` user and surfaces results back into Charlie's next reply (gated by Gate 1/2). Decommissioned the insecure `charlie-watcher` predecessor. Multi-target liveness (`dispatcher-liveness`) + secrets-dir hardening (`/root/.quantumclaw` 750, files 600). All 4 acceptance scenarios passed live. Write/infra/critical scopes + authorisation flow + digests deferred to Phase 5. See `CHARLIE_OVERHAUL.md` Component 6, `QCLAW_BUILD_LOG.md`, `LOCATIONS.md`.

### 2026-05-03

- **Charlie Overhaul Phase 1, 2, 2.5, 3 design complete.** Foundation docs committed: `CEO_OPERATING_MODEL.md`, `CHARLIE_OVERHAUL.md`, `LOCATIONS.md`, `KEYWORD_REFERENCE.md`, `CLAUDE_CODE_OPERATING_RULES.md`, `CLAUDE_CODE_INVENTORY.md`, `CHARLIE_ROLE.md`, `FLOW_OS_SPECIALISTS.md`, this file.
- **Phase 4 implementation pre-slice in progress.** Two pre-slice docs remaining: this file (in flight) and `N8N_WORKFLOW_INDEX.md` (planned next session).
- **Touch-up commit** on `CLAUDE_CODE_OPERATING_RULES.md` to fix code-fence artefacts from initial paste.

### 2026-04-29

- Trading scanner fix committed (`ca41c2c`). Sat unpushed in main briefly — flagged as a process risk; mitigated by new Claude Code operating rules.
- Crete-related FSC credential additions (`add74af`).

### 2026-04-28

- Crete pipeline planning revisited.

### 2026-04-26

- Bruce S. converted GHL Support Bot trial → paid ($29/mth).

### 2026-04 — FSC 1:1 cohort onboarding wave

- 5 active 1:1 mentoring clients onboarded between 9-18 April: Eliza J., Natalie C., Lucy H., Katlen Q., Sinead Q.
- This cohort represents a major delivery commitment for Emma over the next 5-6 months. Watch for capacity strain.

### 2026-04 — FSC As Seen In conversions

- Kylie F., Elise C. converted As Seen In ($297 each).

### 2026-04 — Tyson DFY build

- Kylie F. DFY content setup ($1,400 AUD).

### 2026-04 — FSC payment plan onboarding

- Tracy R. onboarded 1% Club payment plan ($350/mth, cancels 21 July).

---

## Section 9 — Upcoming engagement events

Forward-looking events Charlie should surface before they hit. Generated from the engagement schedule in Section 1.

### Within next 30 days

- **2026-05-08 (approx)** — Sarah H. As Seen In second payment of $149 due
- **2026-05** — FSC 1:1 monthly recurring continues for Eliza J., Natalie C. (next charge 9 May), Katlen Q., Sinead Q. (next charge 18 May)
- **2026-05** — Flow OS sub renewals continue across all 9 paid subs

### Within next 90 days

- **2026-07-21** — Tracy R. 1% Club payment plan cancellation. Surface for retention conversation.
- **2026-09-09** — Eliza J. and Natalie C. 6-month 1:1 mentoring concludes. Renewal/follow-on conversation needed.
- **2026-09-18** — Katlen Q. and Sinead Q. 6-month 1:1 mentoring concludes. Renewal/follow-on conversation needed.
- **2026-10-12** — Lucy H. 1:1 mentoring renewal point (PIF for 6 months from 12 Apr).

---

## Section 10 — Known unknowns / TBD

Things this v1 doc doesn't capture that should be filled in over time.

- **Stripe MRR independent verification.** Calculated MRR ($1,541 Flow OS + $4,502 FSC = $6,043) is from this session's data. Charlie should reconcile against Stripe directly via the Stripe read tools and surface any drift in the morning digest.
- **GHL pipeline-state per business unit at session start.** Charlie pulls current state via GHL operators; this doc references rather than duplicates.
- **SproutCode beta user count** (lives in SproutCode GHL).
- **Crete EOI count** (lives in Crete GHL).
- **Active investor conversations for SproutCode** (currently Tyson tracks personally; not yet structured for Charlie surface).

---

## Maintenance log

This section captures changes to the state doc over time. New entries appended at top.

- **2026-08-20 - FSC section corrected for the 1% Club relaunch.** The section
  described a May 2026 state: 1% Club winding down, no team beyond Tyson and Emma,
  and a funnel that no longer matched the offer structure. Rewritten to current
  reality per Tyson: 1% Club active and taking leads, Ashley onboarded as setter and
  closer with her GHL access limited after unauthorised landing-page and funnel
  changes, Emma setting as well as delivering, and the funnel restructured around
  Magnetic Authority plus Soulful Strategy Sessions as entry with Automate to Elevate
  as a separate Tyson-led entry point. **Tracy R. flagged rather than resolved:** her
  "cancels 21 Jul" note was a month stale and still counted as active, but the FSC
  payer record is not in the Stripe account reachable from qclaw, so the row is marked
  unconfirmed and excluded from the recurring total ($4,502 to $4,152, 10 engagements
  to 9 confirmed) instead of being guessed either way. Confirmation owed from Emma.

- **2026-08-20 - Call Intel corrected and documented.** The `#### Call Intel`
  entry described a release-blocked product with five open blockers, which had
  been true on 2026-08-03 and was stale by three weeks. Reframed as what it
  actually is: a tool in active internal use, deliberately not a product. Two of
  the five blockers are closed or substantially closed (the `claude_parse_error`
  truncation fix `9ef2411`, and the CRM adapter layer `3379383` that ends GHL
  hardwiring), and two more have progressed. Usage restated from the live
  `call_intel_log` table rather than from the 2026-08-03 soak snapshot: 13 calls
  since 2026-07-21, 8 successful. The parse fix is recorded **with** its caveat,
  that no call near the original 169-minute failure has run since, so the raised
  ceiling is untested at that length. Expansion is recorded as stated intent, not
  as a roadmap item, because no date or scope exists. Call Intel was also added to
  `LOCATIONS.md`, where it had never appeared.

- **2026-08-19 — Reconciliation pass against live systems.** Section 1 Flow OS
  roster corrected against live Stripe: 9 documented subscribers reduced to the 6
  actually active, with Georgia F. (2026-05-20), Kayla N. (2026-06-22 canonical)
  and Angela S. (2026-06-25) moved to a new "Recently churned" table rather than
  deleted, so orphaned per-client infrastructure stays discoverable. Lucy H.
  (acct 1) recorded as upgraded $97 → $297 on 2026-07-16 (cancel-and-replace,
  previously undocumented). MRR restated as $1,182 list / $1,275.63 billed, which
  now reconciles with the table's own rows; the previous ~$1,541 figure did not
  reconcile even before the churn corrections. Support Bot table: Bruce S. marked
  churned (2026-08-09, the predicted cancellation happened), Georgia F.'s bundled
  seat marked ended. Section 5 infrastructure snapshot re-verified against live
  `pm2 status`: `charlie-watcher` removed (decommissioned with Slice 5),
  `trade-engine`, `claude-code-dispatcher` and `agex-hub` added, trade engine given
  its own row. Section 8 backfilled from 2026-06-18 through 2026-08-19 with
  pointers, not a duplicate changelog. New `### Kairos Wines` business unit added
  under Section 1. The `### Personal` section's "Trading scanner monitoring only"
  claim was false in the dangerous direction (live execution is armed) and has been
  corrected to point at `/health` rather than a hardcoded snapshot — the same fix
  already applied to `trading.md` and `CHARLIE_ROLE.md`.

  **Flagged, not actioned:** the private companion file
  `~/.quantumclaw/flow_os_state_private.md`, referenced in this doc's own
  maintenance rules and in `QCLAW_BUILD_LOG.md`, **does not exist** anywhere on
  qclaw or Tyson's Mac. It was specified at design time (2026-05-03) and never
  created, so the pseudonymisation scheme has no backing store. Whether it should
  exist at all is a standing decision for Tyson.

- **2026-08-05 — Flow OS product line section added.** New `### Flow OS
  product line` grouping under Section 1 covering GHL Support Bot, SMS Gateway,
  and Call Intel. **No product currently generates revenue** — the line is
  positioned as credibility for the Flow OS subscription, not as a revenue
  stream.

  GHL Support Bot demoted to a subsection; entry corrected from the stale
  2026-05-03 table. Effective paid subscribers now 0 — the single paid account
  (Bruce S.) is in payment failure and expected to cancel. All four trials
  completed payment details and never activated: zero activation rate.
  Signup-to-first-use failure flagged for investigation.

  SMS Gateway added — live since 2026-05-12, public launch 2026-07-27, $79
  founding tier, 0 sales. Repositioned 2026-08-05 from active launch to
  portfolio asset after zero conversion across 265 emails + LinkedIn + 3 FB
  group posts; diagnosed as top-of-funnel message/market fit, not product or
  pipeline failure.

  Call Intel logged as **work in progress, not a product** — deliberately
  excluded from `flowos.tech/products` until complete. 5 calls logged, 3
  successful, 2 failed on `claude_parse_error` (max_tokens truncation, open
  defect). Repo private and confirmed not publicly reachable. Pricing and
  delivery model deferred, not decided. Blockers to release recorded in full.

  Authored by Tyson + Claude (chat).

  **Doc staleness flagged:** prior substantive update was 2026-05-03. Sections
  1–7 have not been reconciled against the build log through Phase 5, the SMS
  Gateway launch, or current FSC engagement state. The Support Bot correction
  in this patch is evidence the stale data was materially wrong, not merely
  old. Full reconciliation pass recommended as a standalone task.

- **2026-05-13 — Slice 2c Task 8 rate-claim audit (Section 7 — Known issues).** Reviewed every bullet under Memory layer, Tool surface, Skill files, Content pipelines, Ad Agency, and Infrastructure / process. No rate-claim language found that lacks a time series. Closest pattern is `Filesystem MCP fails to start every restart` — conditional ("on every restart"), not a rate-over-time claim, and left as-is. Canonical bad-pattern reference from Slice 2b hotfix ("PM2 process heavy churn (53+ restarts / 13m)") is absent from the current section. No rewrites. **Tyson review required** before merging the PR carrying this audit (per CHARLIE_OVERHAUL.md maintenance rule that state-doc edits touching known-issues need human sign-off).
- **2026-05-03 — v1 created.** Initial population covering 9 paid Flow OS subs, 4 internal users, 1 paid + 1 free + 4 trial GHL Support Bot users, 10 active FSC engagements, 3 cross-dimensional clients (Lucy H. VIP, Eliza J. + Gutful, Kylie F.), SproutCode pre-revenue beta + seed-stage, Crete EOI-phase, Trading Operator only on Personal. Authored by Tyson + Claude (chat) per Phase 3 Component 2.
