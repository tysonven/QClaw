# ANTHROPIC_API_SURFACE.md

Single inventory of every Anthropic API call site across the QClaw / Flow OS stack, their credential origin, model, caching state, and retry policy. Produced by Slice 3g (2026-06-03) and maintained as call sites change. Joined into `LOCATIONS.md`.

**Last audited:** 2026-06-03 (live, all hosts).
**Auditor:** Claude Code, Slice 3g Brief 15.

---

## 1. Summary — all call sites

| # | Site | Host / store | Key origin | Model(s) | Caching | Retry | Category |
|---|---|---|---|---|---|---|---|
| 1 | `src/tools/executor.js::_anthropicWithTools` | QClaw runtime | `ANTHROPIC_API_KEY` env | dynamic (`claude-haiku-4-5-20251001`) | **YES** — Slice 3f `cache_control` + fail-open | fail-open 400 strip + 1 retry | PRODUCTION |
| 2 | `src/models/router.js::_callAnthropic` (completion, ~L333) | QClaw runtime | `ANTHROPIC_API_KEY` env | dynamic | **NO** (plain-string system) | throw on non-2xx | PRODUCTION |
| 3 | `src/models/router.js::_testProvider` (verify, ~L236, `max_tokens:1`) | QClaw runtime | env | dynamic | NO | 10s timeout | PRODUCTION (onboard only) |
| 4 | `src/clipper/main.py` (segment selection) | QClaw runtime | `ANTHROPIC_API_KEY` env | `claude-haiku-4-5-20251001` | NO | none | PRODUCTION |
| 5 | `scripts/verify-cache-hits.js` | QClaw runtime | env | haiku (env-overridable) | YES | none | STAGING (test harness) |
| 6 | **12 active n8n workflows** (see §3) | n8n Postgres `workflow_entity` | cred bindings `anthropicApi` / `httpHeaderAuth` | haiku, **sonnet ×7**, **opus ×1** | **NONE (cache_control=0 across all)** | n8n node defaults | PRODUCTION |
| 7 | 3 inactive n8n workflows | n8n Postgres | bindings | sonnet | NONE | — | DISABLED |
| 8 | `flowos-sms-gateway` (github.com/tysonven/flowos-sms-gateway) | separate repo | — | — | — | — | **no Anthropic surface** |

Models observed in the stack: `claude-haiku-4-5-20251001`, `claude-haiku-4-5`, `claude-sonnet-4-20250514`, `claude-opus-4-5`. (Strings like `claude-onboarding`, `claude-parse-ad`, `claude.flowstatescollective.com` are n8n node names / hostnames, **not** models.)

---

## 2. Per-host detail

### QClaw runtime (`/root/QClaw`, CI-deployed from `tysonven/QClaw:main`)
- **`_anthropicWithTools` (executor.js)** — Charlie's main agentic hot path. The only call site with prompt caching (Slice 3f): structured `system` content-blocks with `cache_control: {type:'ephemeral'}`, runtime invariant check, fail-open on 400 cache rejection, per-turn usage logged to `cache-usage.log`.
- **`_callAnthropic` (router.js)** — the non-tool path. System assembled from caller `system` messages + `options.system`, joined to a **plain string** (no content-blocks, no `cache_control`). Caching DEFERRED — see §4 + the Slice 3g.1 followup.
- **`clipper/main.py`** — independent FastAPI microservice (viral-clip segment selection). Official `anthropic` Python SDK, key from env. Does **not** write `cache-usage.log` (so it falls on the non-Charlie side of the spend reconciliation, §spend-design §3).

### n8n (separate host; workflows in `n8n-postgres` container, NOT flat files)
- 12 **active** workflows call `https://api.anthropic.com/v1/messages` via HTTP Request nodes, credentials bound through the n8n credential store (`anthropicApi`, `httpHeaderAuth` "Anthropic Header Auth"). Keys are encrypted at rest in the n8n cred store — not present as plaintext in workflow JSON.
- **Zero** workflows use `cache_control` (system prompts embedded as plain `jsonBody` strings).

### flowos-sms-gateway
- Telnyx/Twilio SMS service (Ed25519-verified). Grepped for `sk-ant-`, `anthropic`, `claude-*`, `api.anthropic.com` — **no matches**. No Anthropic surface; out of scope for hardening. Inventoried for completeness.

---

## 3. Hardcoded-key findings + search method

### Findings: ✓ CLEAN — no live hardcoded keys
The only `sk-ant-` literals anywhere in `/root/QClaw` are:
1. `QCLAW_BUILD_LOG.md` — historical 2026-05-18 incident text, already partially masked (`sk-ant-api03-vET…pAAA`). Documentation of a past leak, not a live key.
2. `tests/cache-usage-log.test.js` — **synthetic** scrub-test fixtures (`sk-ant-api03-abc…`, `sk-ant-admin-anothersecret`) asserting the token-scrubber masks them. Not real keys.

All production keys resolve from `process.env` / n8n credential bindings. No remediation required.

### Search method (so "CLEAN" is verifiable)
- **Patterns:** `sk-ant-`, `ANTHROPIC_API_KEY`, `anthropic`, `claude-(3|sonnet|opus|haiku)`, `api.anthropic.com`, `/v1/messages`, credential-binding names (`anthropicApi`, `httpHeaderAuth`).
- **Globs:** `*.js, *.ts, *.py, *.json, *.env*, *.yml` across `/root/QClaw` (excl. `node_modules`, `venv`, `site-packages`, `.git`); n8n workflows queried directly from `workflow_entity` in `n8n-postgres`; `flowos-sms-gateway` local clone.
- **Coverage statements:**
  - **n8n sub-workflows (Execute Workflow nodes):** the regex scan over `workflow_entity.nodes::text` covers ALL workflows incl. those invoked as sub-workflows; the 12 "active" count is `active=t` workflows referencing claude/anthropic — sub-workflows that themselves carry an Anthropic node are included in that scan.
  - **MCP server configs:** Charlie's MCP servers are tool providers, not Anthropic callers; none hold an `ANTHROPIC_API_KEY`. (Charlie's own Anthropic key reaches the model via `executor.js`/`router.js`, sites #1–3.)
  - **Dashboard:** `src/dashboard/server.js` is a consumer of Charlie/Supabase, not a direct Anthropic caller — no `ANTHROPIC_API_KEY` use.
  - **base64/obfuscated keys cannot be grepped.** Compensating control: the Admin **Usage API** `api_key_id` enumeration (§5 method) lists every *active* key regardless of storage form — any key in real use surfaces there.

---

## 4. Caching-gap findings
- **n8n: 12/12 active workflows uncached.** Every n8n Anthropic call pays full input-token price on each run. Largest opportunity in the stack; **out of Slice 3g code scope** (3g is QClaw-runtime + observability), filed for a future n8n caching slice.
- **`Meta Ads Optimisation Agent` runs `claude-opus-4-5`** (active) — the single most expensive model in the stack and a prime 2026-05-18 retrospective lead (§5).
- **router.js (#2/#3) uncached** — DEFERRED to Slice 3g.1 (the only cacheable router path is the degraded chat-only fallback, which should be repaired/surfaced rather than cost-optimized; see design §6).
- **clipper (#4) uncached** — low volume; not prioritized.

---

## 5. 2026-05-18 retrospective

**STATUS: CLOSED — culprit named (2026-06-03, Admin Usage API).**

**Method:** the Cost API cannot group by API key, so the culprit was identified via the **Usage API** —
`GET /v1/organizations/usage_report/messages?group_by[]=api_key_id&group_by[]=model&bucket_width=1d&starting_at=2026-05-17T00:00:00Z&ending_at=2026-05-20T00:00:00Z` — cross-referenced with the **List API Keys** endpoint to map `api_key_id` → key name.

**Verdict:** the leak source was the **`qclaw-local`** key (`apikey_01NDpbXBEtAcwZVFaFyqZ4Sv`).

**Evidence chain (verbatim):**
1. **Incident record** (`QCLAW_BUILD_LOG.md:12308`, dated 2026-05-19 ~14:00 UTC detection): *"Anthropic API key `qclaw-local` (sk-ant-api03-vET...pAAA) exposed in Git repository; unauthorized usage detected MTD. Estimated cost ~$81 (qclaw-local ~$80.15 + n8n-anthropic ~$0.84)."* Incident action #1: *"Revoked exposed key. `qclaw-local` key deactivated in Anthropic console."*
2. **git-history scan** (`git log --all -S 'sk-ant-'`): no real key value ever committed to QClaw history beyond the masked incident reference — only synthetic test fixtures + type-name doc mentions. qclaw-local was the **sole** confirmed leak.
3. **Admin Usage API — tokens per `api_key_id`, 2026-05-16→05-20:** `qclaw-local` **5,252,934** vs quantumclaw-haiku 101,757, gel-support-bot 64,430, n8n-anthropic 17,599, advisors-chatbot 6,629 — qclaw-local was **98% of window tokens, ~50× the next key.**
4. **Status confirmation:** List API Keys today returns `qclaw-local` = **`inactive`** (cannot authenticate). Charlie now runs on the active **`quantumclaw-haiku`** (`apikey_01NJZwfvXt6B3wf6unzu4bij`). **Containment confirmed effective — revoked at incident time and still revoked.**

**Date precision (forward references should use these):** the spend **spike was 2026-05-17 UTC** (qclaw-local's 1,422,887 Haiku input tokens ≈ $1.44 that day — the cost_report `anthropic_spend_daily` row for 2026-05-17 reflects it exactly); **detection was 2026-05-19 ~14:00 UTC**. The project has historically labelled this "2026-05-18" from the original incident timestamp; past entries are left as-is (no value in rewriting), but new references use **2026-05-17 spike / 2026-05-19 detection**.

**Magnitude validates the detection narrative (strengthened by the cents fix):** the corrected org spend is **~$89.53/30d**, so the original incident's **~$81 unauthorized ≈ a doubling of monthly spend** — which is why detection on 2026-05-19 happened *visually* (an obviously-anomalous bill) rather than via instrumentation. (The 100×-too-high pre-correction figures would have made $81 look negligible and broken this narrative.) This is exactly the cost-blindness gap Slice 3g closes.

**Limitation (as predicted):** 1h/1m granularity only reaches 7 days back; the spike is 16+ days prior, so the original "$79→$85 in 10 minutes" sub-hour burst shape had aged out — the retrospective resolves to daily per-key attribution, sufficient to name the key + model but not to replay the 10-minute curve.

**Larger finding (incidental, not the 2026-05-18 incident):** the org's dominant spend is **`claude-sonnet-4-6` — $8,167.80 of an $8,952.68 30-day total (91%)** — Claude Code / cursor / coding-tool usage (keys `cursor API KEY`, `claude_code_key_info_tjav`, etc.), entirely outside Charlie's Haiku runtime (~$200/30d). This is why the spend-alerter thresholds on **Charlie-attributed** rollups (cache-usage.log), not the org-wide daily total. Org-level spend alerting (which would cover the Sonnet-4.6 surface) is a candidate future slice. The n8n surface (1 Opus + 7 Sonnet workflows, all uncached, §4) is a secondary standing cost.

---

## 6. Remediation log
| Date | Finding | Action |
|---|---|---|
| 2026-06-03 | No live hardcoded keys | None required (audit clean) |
| 2026-06-03 | router.js uncached | Deferred → Slice 3g.1 (with reason) |
| 2026-06-03 | n8n 12/12 uncached + 1 Opus workflow | Logged; future n8n caching slice (out of 3g scope) |
