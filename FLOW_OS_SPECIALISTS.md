# Flow OS Specialists

This is the canonical specialist registry. Charlie reads this at session start to know who he can delegate to and what each specialist can and cannot do. The registry covers all five business contexts: Flow OS, Flow States Collective, SproutCode, Crete, and Personal — plus a Shared category for specialists that span multiple business units.

This file is the fifth canonical doc Charlie reads at session start, after `CEO_OPERATING_MODEL.md`, `CHARLIE_ROLE.md`, `LOCATIONS.md`, and `FLOW_OS_STATE.md`.

## How to read this file

Every specialist entry has the same fields:

- **Belongs to** — which business unit owns this specialist
- **Runs on** — what infrastructure it executes on
- **Status** — `live` (in operation), `scaffolded` (setup exists, not yet a formal specialist), or `deferred` (named but not built)
- **Domain** — what the specialist owns
- **Scope** — what it does
- **Out of scope** — what it explicitly does not do
- **Verification reflex** — how it verifies its own work before claiming completion
- **Escalation path** — what it does when something is out of scope or fails
- **Tools** — current tool surface (full registry detailed in Phase 4 Slice 3)
- **Trust levels** — per task type; populated as task types emerge
- **Last reviewed** — date of last review by Tyson

## Maintenance

Changes to this registry require Tyson approval. Charlie surfaces proposed changes; Tyson approves before any write. Identity-layer changes never happen autonomously.

---

## Flow OS

Tyson's automation business. Specialists serve clients and internal infrastructure.

### Build Specialist

- **Belongs to:** Flow OS
- **Runs on:** QClaw — coordinates with Claude Code via dispatch bridge
- **Status:** scaffolded
- **Domain:** All code and infrastructure work across QClaw, n8n workflows, Supabase schemas, and any Flow OS deliverable that requires implementation.
- **Scope:**
  - Receives implementation tasks from Charlie
  - Writes briefs for Claude Code following the audit-first template
  - Tracks dispatch results
  - Reports back to Charlie when work is complete and verified
  - Coordinates the 7 Pillars framework on every build (Frontend, Backend, Databases, Authentication, Payments, Security, Infrastructure)
  - Runs the security gate checklist before every build log commit
- **Out of scope:**
  - Writing code directly — all code work goes via Claude Code dispatch
  - Architectural decisions — those go to Tyson + Claude (chat)
  - Financial actions of any kind
  - Skipping the audit-first reflex
- **Verification reflex:** Every dispatch returns with verification steps taken. Build Specialist confirms: tests passed, smoke checks green, security gate cleared, build log entry written. No completion claim without these.
- **Escalation path:** Architectural questions → Charlie → Tyson + Claude (chat). Security gate failures → Charlie → Tyson immediately. Out-of-scope requests → Charlie.
- **Tools:** `claude_code_dispatch`, read-only observation tools, build log write access. Full registry in Phase 4 Slice 3.
- **Trust levels:** TBD — populated as task types emerge.
- **Last reviewed:** 2026-05-03

### QA Operator

- **Belongs to:** Flow OS
- **Runs on:** QClaw
- **Status:** live
- **Domain:** Quality assurance across all QClaw deliverables — code changes, n8n workflows, content pipelines, infrastructure changes.
- **Scope:**
  - Pre-deployment audits of any change before it ships
  - Smoke testing after any deploy
  - Verification probes following Component 5 verification reflexes
  - Reports green/red back to Charlie with cited evidence
- **Out of scope:**
  - Making changes — QA only verifies, never modifies
  - Approving deploys — recommendation only, Tyson approves
  - Skipping audits because something looks fine
- **Verification reflex:** QA's own claims are subject to the same cite-or-don't-claim rule. Every "passed" claim includes the probe or test that confirmed it.
- **Escalation path:** Failed audits → Charlie immediately with cited evidence. Ambiguous results → Tyson for adjudication.
- **Tools:** Read-only observation tools, test runners, probe tools.
- **Trust levels:** TBD.
- **Last reviewed:** 2026-05-03

### Lead Handler — Flow OS

- **Belongs to:** Flow OS
- **Runs on:** QClaw + Flow OS GHL sub-account
- **Status:** scaffolded
- **Domain:** Inbound leads to Flow OS from Instagram, email, GHL, and any other lead source.
- **Scope:**
  - Pulls new leads from all channels
  - Summarises lead context (where they came from, what they asked, prior history if any)
  - Classifies lead intent (AI PT Session, A2E, custom DFY, lead magnet, general inquiry)
  - Routes to Em (initial conversation) or surfaces to Tyson for high-value or unusual leads
  - Drafts initial replies for Em or Tyson to review and send
- **Out of scope:**
  - Sending replies directly — drafts only
  - Scope changes on existing engagements
  - Pricing decisions on custom work
- **Verification reflex:** Every lead summary cites the source (Instagram message ID, email message ID, GHL contact ID). Every classification cites the keywords or context that drove it.
- **Escalation path:** High-value leads → Tyson directly. Unusual or unclear intent → Tyson with summary. Repeat unresponsive leads (>2 follow-ups) → close per Tyson's stated policy.
- **Tools:** GHL read tools (Flow OS scope only), Instagram message read, email read, draft tools.
- **Trust levels:** TBD.
- **Last reviewed:** 2026-05-03

### Flow OS GHL Operator

- **Belongs to:** Flow OS
- **Runs on:** Flow OS GHL sub-account
- **Status:** scaffolded
- **Domain:** All operations within the Flow OS GHL sub-account — contacts, opportunities, pipelines, tasks, conversations.
- **Scope:**
  - Reads contact and pipeline state autonomously
  - Drafts replies and follow-up sequences for review
  - Pre-authorised pipeline moves only (Tyson defines per-account rules)
  - Tag updates and internal notes
  - Scheduled task creation
- **Out of scope:**
  - Sending external comms — drafts only, sent by humans or pre-authorised schedules
  - Cross-account operations — scoped to Flow OS GHL only
  - Financial actions of any kind
  - Deleting records
  - Scope changes on opportunities
- **Verification reflex:** Every action cites the GHL contact/opportunity ID and the rule that authorised it. Pipeline moves outside pre-authorised rules are surfaced for Tyson approval before execution.
- **Escalation path:** Out-of-scope requests → Charlie. Cross-account questions → Charlie → Tyson.
- **Tools:** GHL contact/pipeline/conversation read tools, draft tools, tag/note tools — all scoped to `account=flow_os`.
- **Trust levels:** TBD per task type.
- **Last reviewed:** 2026-05-03

### GHL Support Bot

- **Belongs to:** Flow OS
- **Runs on:** Flow OS GHL sub-account (Flow OS product)
- **Status:** live
- **Domain:** Support queries from Flow OS GHL users.
- **Scope:**
  - Triages incoming support queries
  - Provides documentation answers for known questions
  - Routes complex queries to Tyson or Em
  - Logs query patterns for product improvement
- **Out of scope:**
  - Account-level changes (billing, subscriptions, access)
  - Custom build requests
  - Refunds or credits
- **Verification reflex:** Every answer cites the documentation or knowledge base entry it drew from. No invented features or capabilities.
- **Escalation path:** Complex queries → Em or Tyson. Bug reports → Build Specialist via Charlie.
- **Tools:** GHL conversation tools (Flow OS scope), documentation read access.
- **Trust levels:** TBD.
- **Last reviewed:** 2026-05-03

### Flow OS GHL Marketing

- **Belongs to:** Flow OS
- **Runs on:** QClaw — content creation + distribution, separate setup from Content Studio
- **Status:** scaffolded — load-bearing detail in existing `ghl-marketing.md` skill file to be reconciled in Phase 4 Slice 2
- **Domain:** Content creation and distribution for Flow OS GHL marketing channels.
- **Scope:**
  - Generates content per the QClaw GHL Marketing tab pattern
  - Distributes to platforms after approval
  - Maintains content rotation rules
  - Tracks performance metrics
- **Out of scope:**
  - Other business units' content (Crete, FSC, SproutCode each have their own)
  - Direct send without approval
  - Brand voice changes — Tyson approves voice direction
- **Verification reflex:** Every piece of content cites the brand kit, content theme, and approval status before publishing. Failed distributions surface immediately.
- **Escalation path:** Approval needed → Tyson. Brand voice questions → Tyson. Distribution failures → Build Specialist via Charlie.
- **Tools:** R2 (Flow OS GHL Marketing bucket scope), distribution tools (per platform), content generation tools.
- **Trust levels:** TBD.
- **Last reviewed:** 2026-05-03

### Community Manager — Flow OS

- **Belongs to:** Flow OS
- **Runs on:** `portal.flowos.tech`
- **Status:** scaffolded — drafted from scratch in v1; no prior skill file exists. Phase 4 Slice 2 creates the skill file.
- **Domain:** Community engagement, member retention, and content rhythm for the Flow OS community portal.
- **Scope:**
  - Member welcome sequences
  - Engagement post drafting (review-required)
  - Live event planning support
  - Member health monitoring (engagement metrics, retention signals)
  - Community announcements drafting
  - Gamification recommendations
- **Out of scope:**
  - Direct posting without review — drafts only
  - Member account-level changes (access, billing)
  - Cross-portal actions (FSC portal is a different specialist)
- **Verification reflex:** Every engagement metric cites its source query. Every recommendation cites the engagement data that prompted it.
- **Escalation path:** Member issues → Tyson. Strategy questions → Tyson + Claude (chat). Cross-portal questions → Charlie.
- **Tools:** Flow OS portal read/draft tools, engagement metrics queries.
- **Trust levels:** TBD.
- **Last reviewed:** 2026-05-03

---

## Flow States Collective

Emma's coaching business. Specialists serve Emma's audience, podcast pipeline, and community.

### Content Studio Operator

- **Belongs to:** Flow States Collective
- **Runs on:** QClaw — Emma's podcast pipeline only. Clipper as internal sub-component.
- **Status:** live
- **Domain:** End-to-end podcast distribution from upload to scheduled multi-channel publishing.
- **Scope:**
  - Receives uploaded podcast episode
  - Buzzsprout upload
  - WordPress HTML draft generation
  - Substack draft generation
  - LinkedIn post drafts via Blotato
  - Unlisted YouTube upload
  - Captioned 9:16 clip generation (via Clipper sub-component)
  - Telegram completion notification with all artefact URLs
- **Out of scope:**
  - Any business unit's content other than Emma's podcast
  - Editorial decisions on first-pass content (only pre-approved batches publish autonomously)
  - YouTube auto-publish (currently parked, awaiting Emma's pipeline test)
  - Any financial action
  - Brand voice changes — Tyson and Emma approve
- **Verification reflex:** Every distribution step cites its platform-specific success indicator (Buzzsprout episode ID, WordPress draft ID, Substack draft URL, LinkedIn post ID via Blotato, YouTube video ID, clip URLs in R2). Pipeline completion claim requires all steps confirmed.
- **Escalation path:** Pipeline failures → Build Specialist via Charlie. Editorial questions → Emma + Tyson. Brand questions → Emma + Tyson.
- **Tools:** Buzzsprout API, WordPress API, Substack API, Blotato API, YouTube API (read-only currently), AssemblyAI, FFmpeg, R2 (Content Studio bucket scope), Clipper sub-component.
- **Sub-component — Clipper:**
  - Generates 9:16 vertical clips from Emma's podcast with SRT word-by-word captions (Montserrat Bold, gold highlights, platform-safe margins)
  - FastAPI microservice on port 4002, PM2-managed `clipper-worker`
  - Phase 2 (face detection via OpenCV DNN for rule-of-thirds reframing) is pending — not yet active
  - Scoped strictly to Content Studio until bugs resolved; not exposed as standalone specialist
- **Trust levels:** Buzzsprout upload at Level 3 currently, candidate for Level 4 after 2-3 successful runs. All other distribution steps at Level 2 or 3 depending on platform.
- **Last reviewed:** 2026-05-03

### Community Manager — FSC

- **Belongs to:** Flow States Collective
- **Runs on:** `https://fsc.app.clientclub.net/home`
- **Status:** live — community runs on ClientClub. No prior skill file exists. Phase 4 Slice 2 creates the skill file.
- **Domain:** Community engagement, member retention, and content rhythm for the FSC community on ClientClub.
- **Scope:**
  - Member welcome sequences
  - Engagement post drafting (review-required)
  - Live event planning support for FSC events
  - Member health monitoring (engagement metrics, retention signals)
  - Community announcements drafting
  - Gamification recommendations specific to FSC's member journey
- **Out of scope:**
  - Direct posting without review — drafts only
  - Member account-level changes (access, billing)
  - Cross-portal actions (Flow OS portal is a different specialist)
  - Coaching content or program decisions — Emma owns those
- **Verification reflex:** Every engagement metric cites its source query. Every recommendation cites the engagement data that prompted it.
- **Escalation path:** Member issues → Emma or Tyson. Coaching content → Emma. Strategy questions → Emma + Tyson. Cross-portal questions → Charlie.
- **Tools:** FSC ClientClub portal read/draft tools, engagement metrics queries.
- **Trust levels:** TBD.
- **Last reviewed:** 2026-05-03

### FSC GHL Operator

- **Belongs to:** Flow States Collective
- **Runs on:** FSC GHL sub-account
- **Status:** scaffolded
- **Domain:** All operations within the FSC GHL sub-account.
- **Scope:** Same as Flow OS GHL Operator, scoped to FSC.
- **Out of scope:** Same as Flow OS GHL Operator. Particularly: cross-account operations are forbidden.
- **Verification reflex:** Same as Flow OS GHL Operator.
- **Escalation path:** Out-of-scope requests → Charlie. Coaching-related contact decisions → Emma → Tyson.
- **Tools:** GHL contact/pipeline/conversation read tools, draft tools, tag/note tools — all scoped to `account=fsc`.
- **Trust levels:** TBD.
- **Last reviewed:** 2026-05-03

---

## SproutCode

Separate codebase and product. Specialists serve SproutCode-specific operations.

### SproutCode Operator

- **Belongs to:** SproutCode
- **Runs on:** SproutCode infra + SproutCode GHL sub-account; coordinates with Claude Code for code work
- **Status:** scaffolded
- **Domain:** SproutCode operations across infrastructure, GHL operations, and product support.
- **Scope:**
  - Reads SproutCode product state and infrastructure status
  - Drafts replies for SproutCode GHL contacts
  - Coordinates with Claude Code for code changes via Charlie's dispatch
  - Reports on SproutCode metrics for digest inclusion
- **Out of scope:**
  - Code changes directly — via Claude Code dispatch only
  - Cross-product operations (SproutCode is its own product, not a Flow OS extension)
  - Financial actions
  - Architectural changes — Tyson + Claude (chat)
- **Verification reflex:** Every state report cites the SproutCode service or environment it queried. Every dispatch result is confirmed before claiming completion.
- **Escalation path:** Architectural questions → Tyson + Claude (chat). Code changes → Charlie → Build Specialist → Claude Code.
- **Tools:** SproutCode infra read tools, SproutCode GHL read/draft tools (sub-account scope).
- **Trust levels:** TBD.
- **Last reviewed:** 2026-05-03

---

## Crete

Village development project and personal-business automations.

### Crete Operations Specialist

- **Belongs to:** Crete
- **Runs on:** QClaw + n8n + Crete GHL sub-account
- **Status:** scaffolded
- **Domain:** Crete project automations, n8n workflows, and Crete GHL operations.
- **Scope:**
  - Maintains Crete-specific n8n automations
  - Reads Crete GHL contact and pipeline state
  - Drafts Crete-specific comms for review
  - Reports on Crete project status for digest inclusion
- **Out of scope:**
  - Direct comms send — drafts only
  - Investment or financial decisions — Tyson only
  - Cross-business-unit operations
- **Verification reflex:** Every status update cites the workflow execution or GHL record source.
- **Escalation path:** Investment/financial questions → Tyson. Out-of-scope requests → Charlie.
- **Tools:** n8n workflow tools (Crete scope), Crete GHL tools (sub-account scope).
- **Trust levels:** TBD.
- **Last reviewed:** 2026-05-03

### Crete Marketing Operator

- **Belongs to:** Crete
- **Runs on:** QClaw — content creation + distribution for Crete projects
- **Status:** scaffolded — load-bearing detail in existing `crete-marketing.md` skill file (R2 paths, content-rotation rules, KPI rules) to be reconciled in Phase 4 Slice 2
- **Domain:** Content creation and distribution for Crete projects (village development updates, blog posts, investor updates).
- **Scope:**
  - Generates content per the QClaw Crete Marketing tab pattern
  - Distributes to platforms after approval
  - Maintains content rotation rules
  - Tracks performance metrics
- **Out of scope:**
  - Other business units' content
  - Direct send without approval
  - Brand voice changes — Tyson approves
  - Investor-facing decisions — Tyson only
- **Verification reflex:** Every piece of content cites the brand kit, content theme, and approval status before publishing.
- **Escalation path:** Approval needed → Tyson. Investor-facing questions → Tyson. Distribution failures → Build Specialist via Charlie.
- **Tools:** R2 (Crete Marketing bucket scope), distribution tools (per platform), content generation tools.
- **Trust levels:** TBD.
- **Last reviewed:** 2026-05-03

---

## Personal

Tyson's own setups, not part of any business unit.

### Trading Operator

- **Belongs to:** Personal (Tyson's own setup)
- **Runs on:** QClaw — monitoring scoped, no execution
- **Status:** live — known reconciliation needed in Phase 4 Slice 2 skill audit (existing `trading.md` config values may be out of sync with live `trading_config` table after Apr 29 trading-fix commit)
- **Domain:** Trading scanner monitoring and reporting.
- **Scope:**
  - Reads trading scanner state
  - Reports on positions, P&L, anomalies
  - Surfaces alerts for unusual activity
  - Maintains trading-related n8n workflow heartbeats
- **Out of scope:**
  - Trade execution — never, hard-disabled at the tool level
  - Position changes
  - Capital allocation decisions
  - Any financial action
- **Verification reflex:** Every reported number cites the trading_config or position source. Heartbeat misses surface immediately.
- **Escalation path:** Anomalies → Tyson immediately. Heartbeat failures → Build Specialist via Charlie. Strategy questions → Tyson.
- **Tools:** Read-only trading tools (positions, P&L, scanner state), n8n workflow read tools.
- **Trust levels:** Monitoring at Level 4 (autonomous, surface anomalies). Anything beyond monitoring is Level 0.
- **Last reviewed:** 2026-05-03

---

## Shared

Specialists that span multiple business contexts.

### Ad Agency Operator

- **Belongs to:** Shared (primary scope: FSC and Emma Maidment Business; secondary scope: Flow OS read-only)
- **Runs on:** QClaw dashboard ("Ad Agency" tab) + n8n workflows + Meta Ads API. Five sub-roles internally orchestrated:
  - **Rex (Strategist)** — currently a stub, "Strategy builder coming soon" per `ui.html:531`. Reconcile in Phase 4 Slice 2.
  - **Scout (Researcher)** — Competitor Research workflow `QnCEES9T7WxW5vVR`, no hardcoded accounts (dynamic via webhook)
  - **Penny (Copywriter)** — Copy Agent workflow `0sIugM5o5wTwpflq`, no hardcoded accounts (dynamic via webhook)
  - **Frame (Creative Director)** — Creative Brief Agent workflow `TtSUyKpvE5f9iQZg`, no hardcoded accounts (dynamic via webhook)
  - **Ledger (Media Buyer)** — Ad Creation workflow `lrGcirtmOHb1xTq8`. Hardcoded to Emma Maidment Business (`act_1426936257455201`) and Flow States Retreats (`act_464237024205104`). Flow OS NOT in this workflow — ad creation for Flow OS not currently supported.
- **Status:** scaffolded — Rex sub-role is a placeholder UI, awaiting implementation. Other four sub-roles are live.
- **Domain:** End-to-end ad strategy, research, copy, creative, and media buying for Emma Maidment Business and Flow States Retreats. Flow OS reporting/optimisation only via Optimisation workflow.
- **Scope:**
  - Strategy formation (Rex — stub) → Research (Scout) → Copy (Penny) → Creative brief (Frame) → Ad creation/buying (Ledger)
  - Account routing handled server-side via `creator` field (`tyson` or `emma`) and chatId
  - Optimisation reporting for all three accounts (Flow OS, Emma Maidment Business, Flow States Retreats) via workflow `lf955LDteJ512RQi`
  - Surfaces ad performance data and anomalies for digest inclusion
- **Out of scope:**
  - Ad creation for Flow OS account (`act_414785961683125`) — not currently supported by Ledger workflow; Flow OS is reporting-only
  - Spend changes — Tyson only
  - Approving ad creative for live publish — Emma + Tyson approve
  - New campaign creation autonomously — Emma + Tyson approve briefs first
  - Any financial action
  - Cross-business-unit account operations beyond what's already wired
- **Verification reflex:** Every account-scoped action cites the workflow ID and the account it ran against. Every reported number cites the date range and metric source. Anomaly flags cite the threshold that triggered them. No claim of "ad created" without a confirmation from the Ad Creation workflow's webhook response.
- **Escalation path:**
  - Anomalies in spend or performance → Tyson immediately
  - Strategy questions (especially Rex stub limitations) → Tyson + Claude (chat)
  - Creative direction questions → Emma + Tyson
  - Sub-role workflow failures → Build Specialist via Charlie
  - New account additions or workflow scope expansion → Tyson + Build Specialist
- **Tools:** Meta Ads read tools (all three accounts), Ad Agency dashboard tools, n8n workflow read tools for the five sub-role workflows, Telegram routing (Ledger).
- **Trust levels:** TBD per task type — particularly: optimisation reporting could move to Level 4 quickly; ad creation stays at Level 1 or 2 (Tyson approves briefs).
- **Last reviewed:** 2026-05-03
- **Caveats and known gaps:**
  - Rex sub-role is a UI placeholder with no backing workflow — `ui.html:531` shows "Strategy builder coming soon"
  - chatId hardcoded to Tyson (`1375806243`) — Em cannot see FSC-side ad activity directly through this channel; routing to Em requires Tyson's involvement currently
  - Flow States Retreats account (`act_464237024205104`) is currently dormant per `LOCATIONS.md:73` but still hardcoded in the Ad Creation workflow (`lrGcirtmOHb1xTq8`) — pending cleanup in Phase 4
  - The Phase 3 design's two-row split (Ads Operator — Flow OS and Ads Operator — Emma Maidment Business in `CHARLIE_OVERHAUL.md`) does not match the running architecture and is reconciled here as a single specialist

---

## Deferred specialists

Named in the v1 conversation but not yet built. Re-promote when the trigger conditions are met.

### Retreat Planner — FSC

- **Trigger to build:** When Emma resumes retreat planning. The Flow States Retreats Meta ad account (`act_464237024205104`) is currently dormant.
- **Anticipated scope:** Retreat planning support, attendee comms drafts, logistics tracking, marketing coordination with Ad Agency Operator.

### Stripe Operator

- **Trigger to build:** When Stripe reporting volume justifies a separate specialist. Currently rolled into Charlie's direct read-only capability.
- **Anticipated scope:** Read-only reporting only. Never any write operations — Tyson controls all Stripe writes manually.

### FSC Ads Operator

- **Trigger to build:** When FSC runs its own Meta ad campaigns separate from Emma Maidment Business. Currently consolidated under Ad Agency Operator.
- **Anticipated scope:** May not be needed as a separate specialist if the Ad Agency Operator's multi-account scope continues to serve.

---

## Phase 4 reconciliation tasks

Skills audit (Phase 4 Slice 2) will reconcile these registry entries against existing skill files:

- **Community Manager (both Flow OS and FSC)** — both drafted from scratch in this spec; no prior skill file exists. Phase 4 Slice 2 creates the skill files.
- **Trading Operator** — known config drift between `trading.md` and live `trading_config` table; reconcile or update.
- **Crete Marketing Operator** — preserve load-bearing operational detail (R2 paths, content rotation, KPIs) from existing `crete-marketing.md`.
- **Flow OS GHL Marketing** — preserve load-bearing detail from existing `ghl-marketing.md`.
- **Content Studio Operator** — existing `content-studio.md` is a stub (440 bytes); rebuild from this spec.
- **Ad Agency Operator** — Rex sub-role implementation pending; chatId hardcoding to Tyson needs Em-aware routing; Flow States Retreats account hardcoded in Ledger workflow despite dormant status.
- **Stale references** — `charlie-cto.md` superseded by `CHARLIE_ROLE.md` (archive). `agent-coordination.md` references frozen Echo agent (archive). `n8n-api.md.backup.*` is a literal stale backup (delete).
- **Phantom tool reference** — `Supabase:execute_sql` referenced in `charlie-cto.md:16`; tool does not exist. To be replaced with `supabase_select` per Phase 3 Component 4 design.
- **Business intelligence content** — `business-intelligence.md` is not a specialist; preserve weekly strategic summary template for digest scaffolding in Phase 5+. Add keyword trigger to `KEYWORD_REFERENCE.md`.

## Maintenance log

This section captures changes to the registry over time. New entries appended at top.

- **2026-05-03 — v1 created.** 15 specialists drafted across 6 sections: Flow OS (7 specialists: Build Specialist, QA Operator, Lead Handler, Flow OS GHL Operator, GHL Support Bot, Flow OS GHL Marketing, Community Manager — Flow OS), Flow States Collective (3 specialists: Content Studio Operator, Community Manager — FSC, FSC GHL Operator), SproutCode (1: SproutCode Operator), Crete (2: Crete Operations Specialist, Crete Marketing Operator), Personal (1: Trading Operator), Shared (1: Ad Agency Operator). 3 deferred specialists named with trigger conditions (Retreat Planner — FSC, Stripe Operator, FSC Ads Operator). The original Phase 3 design's two Ads Operator entries (Flow OS + Emma Maidment Business) consolidated into single Ad Agency Operator after Claude Code architecture audit confirmed shared multi-account routing. Authored by Tyson + Claude (chat) per Phase 3 Component 2.
