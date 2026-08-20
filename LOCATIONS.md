# LOCATIONS

Single source of location for everything in the QClaw / Flow OS / FSC / SproutCode / Crete / Kairos Wines / Personal stack. Anything that has a "where does this live" answer is recorded here. When something moves, this file is updated; everything else reads from here.

This file is the second thing every agent reads at session start, after its identity layer.

**Last updated: 2026-08-20.** Change history is in the maintenance log at the
end of this file.

## Repository

- QClaw repo: `/root/QClaw` on qclaw server
- GitHub: `github.com/tysonven/QClaw`
- Default branch: `main`
- CI/CD: GitHub Actions auto-deploys on push to main

## Identity layer (canonical, rarely changes)

- `CEO_OPERATING_MODEL.md` — operating model and trust gradient (north star)
- `CHARLIE_ROLE.md` — Charlie's role spec
- `CHARLIE_OVERHAUL.md` — running architecture doc for Charlie 2.0
- `LOCATIONS.md` — this file

### Charlie identity files — repo-canonical, runtime via symlink

The repo at `/root/QClaw/workspace/...` is the canonical source for Charlie's
identity. Runtime paths are symlinks pointing into the repo. Edits go through
git, not via runtime mutation. Enforced by:
- `src/dashboard/server.js` PUT /api/agents/:name/soul refuses 409 when target is a symlink
- `src/security/trust-kernel.js` load() refuses default-write when target is a symlink

| Layer | Canonical (repo) | Runtime (symlink) |
|---|---|---|
| SOUL  | `workspace/agents/charlie/SOUL.md`     | `~/.quantumclaw/workspace/agents/charlie/SOUL.md` → repo |
| VALUES | `workspace/VALUES.md`                  | `~/.quantumclaw/VALUES.md` → repo |
| IDENTITY | `workspace/agents/charlie/IDENTITY.md` | `~/.quantumclaw/workspace/agents/charlie/IDENTITY.md` → repo |

For sub-agents that aren't yet repo-canonicalized (`echo`, `dispatch-zeta`,
`patcher`, `n8n-workflow-fixer`, `claude-code-ig-fix`, `post-auditor`),
runtime files at `~/.quantumclaw/workspace/agents/<name>/` remain regular
files and are still mutable via the dashboard. Reconciliation TBD.

- Repo-tracked workspace seeds (consumed by `qclaw onboard` for fresh
  installs): `workspace/agents/charlie/SOUL.md`, `workspace/VALUES.md`,
  `workspace/agents/charlie/IDENTITY.md`

## State layer (Charlie writes routine, Tyson approves significant)

- `FLOW_OS_STATE.md` — single source for current business state across Flow OS, FSC, SproutCode, Crete, Personal
- `FLOW_OS_SPECIALISTS.md` — specialist registry
- `N8N_WORKFLOW_INDEX.md` — every active n8n workflow

## Operational layer (append-only, never rewritten)

- `QCLAW_BUILD_LOG.md` — chronological build log
- `ANTHROPIC_API_SURFACE.md` — Slice 3g inventory of every Anthropic API call site across the stack (QClaw runtime, n8n, clipper, sms-gateway), credential origin, model, caching state, hardcoded-key audit, and the 2026-05-17 spike / 2026-05-19 detection retrospective. Maintained as call sites change.
- Bootstrap log: `~/.quantumclaw/bootstrap.log` (file-based, mode 0600, written by `src/agents/bootstrap.js` — file-based per Phase 4 Slice 1; Supabase migration deferred)
- Audit log: `~/.quantumclaw/audit.db` (SQLite via `better-sqlite3`) with JSONL fallback at `~/.quantumclaw/audit.jsonl` — read interface `AuditLog.recent(limit, agent)` (`src/security/audit.js`)
- Gate log: `~/.quantumclaw/gate.log` (file-based, JSON Lines, mode 0600, written by `src/observability/gate-log.js` from Slice 4 — one entry per verification-gate firing: `{ts, gate, claim, verification_attempted, verified, result, action, attempt, rewritten_claim?}`. `result` ∈ pass|soft_fail|hard_fail; `action` ∈ reprompt|rewrite|fail_closed_slice5_pending|escalate. Claim text scrubbed with the unanchored sk-ant/Telegram scrubber (free-form prose). Size-rotation at 50 MB → `.1` (1 generation). Override via `QCLAW_GATE_LOG_PATH`. Gate escalations also emit a `gate_escalation` event into `channel-events.log` (`src/observability/channel-events.js`, same stream as Slice 3e runner errors). Gates run only for agents in `QCLAW_GATES_AGENTS` (default `charlie`); master kill-switch `QCLAW_GATES_ENABLED`.)
- Skill load log: `~/.quantumclaw/skill-load.log` (file-based, JSON Lines, mode 0600, written by `src/agents/skill-loader.js` from Slice 2b — one entry per `loadSkills()` call. Supabase migration deferred post-Phase-4.) `userId` field semantics: Telegram-sourced calls carry the Telegram user id; non-Telegram callers (scheduled heartbeat tasks in `src/core/heartbeat.js`, CLI `agent.process()` invocations in `src/cli/index.js`) pass no userId, which surfaces as the string `"null"` in the log — by design, since these calls have no Telegram user. Identified Slice 2c Task 6.
- **Claude Code delegation (Phase 4 Slice 5):**
  - Dispatch table: Supabase `claude_code_dispatches` (RLS enable+force+revoke, `service_role` only; RPCs `claim_next_dispatch`/`reap_stale_dispatches`). Migration `n8n-workflows/migrations/2026_06_11_claude_code_dispatches.sql`.
  - **Dispatcher worker (qclaw):** PM2 process `claude-code-dispatcher` — runs `src/dispatch/start.js` (pre-merge from `/root/QClaw-slice5`; **post-merge repoint to `/root/QClaw`**). Single instance, claims queued rows, runs Claude Code READ-ONLY as the unprivileged `ccdispatch` user, atomic write-back. Logs: `/root/.pm2/logs/claude-code-dispatcher-{out,error}.log`. Roster change ⇒ update `src/agents/probes/pm2.js` `EXPECTED` (same discipline as `pm2 save`).
  - **`ccdispatch` user:** unprivileged system user (uid 999/gid 987, `/usr/sbin/nologin`), work root `/home/ccdispatch/work` (700). Created by `scripts/setup-ccdispatch-user.sh`. Kernel-perm isolation — CC never runs as root and cannot read `/root/.quantumclaw/*` secrets.
  - **`dispatcher-liveness` heartbeat:** `workflow_id='dispatcher-liveness'` rows in Supabase `workflow_heartbeats`, written by the dispatcher's decoupled ~45s `setInterval`; monitored by the off-host watcher (multi-target, below).
- Tool registration / call log: `~/.quantumclaw/tool-call.log` (file-based, JSON Lines, mode 0600, written by `src/tools/registry.js` from Slice 3a — one entry per registration event with `{ts, event, source, tool, scope, ...}`). Tests can override via `QCLAW_TOOL_CALL_LOG_PATH`. Slice 3b extends the same log to routing decisions; Slice 3c covers per-call execution.
- Channel events log: `~/.quantumclaw/channel-events.log` (file-based, JSON Lines, mode 0600, written by `src/channels/manager.js` from Slice 3e — one entry per Telegram channel state transition: transient/non_transient/unknown errors, retry_scheduled/succeeded, degraded, recovery_attempt/succeeded/failed, manual_intervention_required, stopped). Field-presence convention documented in `/tmp/slice3e_design.md` §5. Bot-token URLs are scrubbed via `_scrubToken` before write. Tests can override via `QCLAW_CHANNEL_EVENTS_LOG_PATH`.
  - **Diagnostic flow for restart investigations:** cross-reference `channel-events.log` event types against `/var/log/auth.log` (operator `sudo pm2 restart` entries) and `/root/.pm2/pm2.log` (`Stopping app:quantumclaw` entries). `event:"stopped"` in `channel-events.log` = graceful shutdown via SIGINT/SIGTERM (operator restart, system signal, or process manager). `event:"degraded"` or `event:"recovery_failed"` = grammY/Telegram-driven failure mode. Distinguishing these is the surface Slice 3e was built to provide.
    - **systemd diagnostic surfaces (alongside auth.log):** for graceful shutdowns *not* preceded by an `auth.log` sudo entry, also check `systemctl status pm2-root`, `journalctl -u pm2-root`, and `last reboot` — operator-initiated PM2 actions via systemd (e.g. `systemctl restart pm2-root`), direct root commands without `sudo`, or system reboots will **not** appear in `auth.log`. Apt unattended-upgrades + `needrestart` can also trigger `pm2-root.service` restarts; see the 2026-06-03 incident entry in `QCLAW_BUILD_LOG.md`.
  - **PM2 dump file (`/root/.pm2/dump.pm2`):** reflects the saved process state from the last `sudo pm2 save`. PM2 will **resurrect to that state on daemon restart** (systemd-triggered or operator-triggered), regardless of any intervening `pm2 start`/`stop`/`restart`/`reload` calls that were not followed by `save`. **Discipline:** any intentional process state change worth persisting must be followed by `sudo pm2 save` (run `save` only when runtime state is what you want PM2 to remember — it captures *current* state). The 2026-06-03 outage was caused by this discipline gap: a prior unrecorded `pm2 stop` left `quantumclaw` saved as `stopped` in the dump, and a systemd-triggered `pm2-root` restart faithfully resurrected the stale stopped state. See the 2026-06-03 incident entry in `QCLAW_BUILD_LOG.md`.
- Cache usage log: `~/.quantumclaw/cache-usage.log` (file-based, JSON Lines, mode 0600, written by `src/observability/cache-usage-log.js` from Slice 3f — one entry per `_anthropicWithTools` API call including each tool-loop iteration). Captures: `ts`, `model`, `channel`, `user_id` (token-scrubbed), `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`, `bootstrap_cache_hit`, `bootstrap_present`, `cache_control_emitted`, `tools_count`, `tools_hash` (sha256/8-hex of tool names in order — detects Map iteration shuffles across pm2 reloads), `had_on_demand_skills`, `tool_loop_iteration`, `seconds_since_last_call` (null on first write per process). Conditional fields surface failure modes: `cache_control_rejection_message` (API-side rejection, persists per-call until restart), `fail_open_triggered` (the actual rejection turn), `runtime_invariant_failed`, `ephemeral_extraction_failed`. Size-based rotation at 50 MB → renames to `cache-usage.log.1` (2 generations kept). Tests can override via `QCLAW_CACHE_USAGE_LOG_PATH`. Feeds Slice 3g's spend-observability layer and the 1h-TTL revisit decision rule documented in `/tmp/slice3f_design.md` §6.2.
- Anthropic spend (Slice 3g): Supabase project `fdabygmromuqtysitodp` ("n8n database"), tables **`anthropic_spend_daily`** (one row/UTC day: authoritative org-level USD from the Admin Cost API; `total_cost_usd` + `model_breakdown` jsonb in dollars, `raw_api_response` jsonb verbatim in **cents** for forensics) and **`anthropic_spend_rollup`** (Charlie-attributed rollups from cache-usage.log: windows 1h/24h/7d/30d + `calendar_day` reconciliation, per dimension total/model/channel/user). Both RLS-enabled, **service-role only** (no anon policy — spend data is sensitive). Migration: `n8n-workflows/migrations/2026_06_03_anthropic_spend_observability.sql`.
- Spend alert thresholds: `/root/.quantumclaw/spend-thresholds.json` (mode 0600, operator-editable without redeploy; defaults baked in: `{soft_24h_usd:5, hard_1h_usd:3, cooldown_minutes:60}`). Override path via `QCLAW_SPEND_THRESHOLDS_PATH`.
- Spend alert state: `~/.quantumclaw/spend-alert-state.log` (JSON Lines, mode 0600, per-class `attempt`/`fired` cooldown ledger) + sidecar `spend-alert-state.log.health`. Override via `QCLAW_SPEND_ALERT_STATE_PATH`.
- Spend cron (host-side, NOT in repo — documented per the 2026-06-03 needrestart precedent): poller **daily 23:59 UTC** (cost_report is daily-granularity); aggregator **hourly at :05** and alerter **hourly at :06** (the alerter's hard tier reads a rolling 1h window, so it needs sub-daily cadence to be meaningful; the aggregator's boundary-floored window_end makes hourly runs idempotent). Each is a standalone `node src/observability/<x>.js` run outside PM2 (guarded by a `pm_id` check) so a failure can never crash Charlie.
- **Liveness monitoring (Slice 3h) — two halves on two hosts:**
  - **Writer (qclaw, INSIDE quantumclaw):** `src/observability/liveness-heartbeat.js`, started from `src/index.js` after channels. A 60s `setInterval` (no LLM, unref'd) writes `workflow_id='charlie-liveness'` rows to Supabase `workflow_heartbeats` via `record_heartbeat()` (service_role, **no execution_id** so `created_at` advances). `metadata` = `{pid, uptime_s, version, channel_status, polling_ok, host}` (`channel_status` from the live 3e `TelegramChannel.status` = the class-(b) signal). Writer-side retention prunes `charlie-liveness` rows >24h every ~60 beats. NOT a new PM2 process — runs inside the existing `quantumclaw` process.
  - **Watcher (n8n droplet `157.230.216.158`, OFF-HOST cron):** `src/observability/liveness-watcher.js` (self-contained, no repo imports) deployed to `/home/n8nadmin/charlie-liveness/` + `.env` (mode 0600: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `LIVENESS_DIR`, `LIVENESS_STALE_MINUTES=4`, optional `LIVENESS_TARGET`). Cron **every 1 min** (`crontab -l` as `n8nadmin`), logs to `~/charlie-liveness/watcher.log`. Reads latest `charlie-liveness` beat; staleness computed against Supabase's clock (response `Date` header, not the droplet clock). Alerts via **direct Telegram API** (NOT Charlie's bot) to chat `1375806243`: class `down` (a/c-full/d) / `polling` (b) / `unknown` (Supabase unreachable — fails LOUD). Cooldown ledger `~/charlie-liveness/liveness-state.log` (JSONL 0600): first alert + 15m + hourly reminders; recovery all-clear; cold-start "armed" one-shot. **Inverted polarity vs spend-alerter:** an unwritable ledger still fires the outage alert (a dead Charlie must be loud). `LIVENESS_DIR` MUST come from the `.env` file (read via `env`, not `process.env`) — the 2026-06-10 storm bug.
  - **Backstop (HIGH#2):** `charlie-liveness` added to the n8n **Workflow Dormancy Alerter** allowlist (`O5ir2Mp0e2AXkUXZ`, expected 60s × slack 5 = 5min) — a 2nd, hourly, different-code-path detector on the same droplet (covers watcher-script-crash, NOT droplet-down). Repo JSON updated; apply to live via n8n UI (keyless API → 401). **Residual SPOF:** if the n8n droplet itself dies, both detectors die — a cross-host dead-man's-switch is a Phase-5 follow-up.
  - **Class (c) partial-hang** (event loop + heartbeat fine but LLM/message path broken) NOT covered in v1 — staged to a v2 synthetic message round-trip probe.
  - **Slice 5 (2026-06-18) — watcher is now MULTI-TARGET:** the same off-host cron monitors both `charlie-liveness` and `dispatcher-liveness`, each with its own state-ledger file (`liveness-state.log` / `dispatcher-state.log`) and stale threshold (charlie 4m via `LIVENESS_STALE_MINUTES`; dispatcher 5m via `DISPATCHER_STALE_MINUTES`). Targets are isolated — a dispatcher outage fires only the `CC dispatcher` alert, Charlie unaffected (acceptance scenario 4, proven live). `classify()` is parameterised by `label`/`proc`; `recordBeat()` by `workflowId`.

## Capability layer

- Cache observability writer: `src/observability/cache-usage-log.js` — Slice 3f. Exports `appendCacheUsage(record)` and `toolsHash(tools)`. Pure JSONL appender with token-scrub + size-based rotation. Consumed by `src/tools/executor.js::_anthropicWithTools` once per API round-trip.
- Spend observability (Slice 3g): `src/observability/pricing.js` (single source of model rates `as_of` 2026-06-03 + dated→family normalization + cache multipliers; note `router.js`'s own `COST_TABLE` is stale and flagged to migrate here), `src/observability/anthropic-spend-poller.js` (Admin Cost API → `anthropic_spend_daily`; cents→USD on ingest; unanchored secret scrub over logs/errors/`raw_api_response`), `src/observability/spend-aggregator.js` (cache-usage.log → `anthropic_spend_rollup`; boundary-floored half-open windows + calendar-day reconciliation), `src/observability/spend-alerter.js` (thresholds Charlie-attributed rollups → Telegram; per-class cooldown + corrupt-state health meta-alert). All standalone cron entrypoints, not imported by Charlie's runtime.
- Channel manager: `src/channels/manager.js` — Telegram (grammY) channel adapter. Slice 3e (2026-05-21): runner update-loop errors are classified + retried + degraded via `_onRunnerFailure` + `_attemptRecovery`; process no longer crashes on 401/429/etc. Pure error classifier at `src/channels/grammy-error-classifier.js` (input: error from grammY runner; output: `{kind, httpStatus?, networkCode?, shouldRetry, backoffMs?, reason}`; no side effects). Recovery timer fires every 5 min, capped at 12 attempts (1h) before emitting `manual_intervention_required`. State machine: `starting → active → retrying/degraded → active|degraded → stopped`. Surfaced via dashboard `/api/channels` `status` field.
- Skill files (canonical SSOT): `/root/QClaw/src/agents/skills/` — enforced by `SKILL_EDIT_ALLOWLIST` in `src/security/approval-gate.js`. Edits go through git, not via runtime mutation. Archived skills live at `src/agents/skills/archive/` (preserved via git history, excluded from runtime by `loadSkills`).
- Skill frontmatter (canonical keyword source): each skill `.md` declares `name`, `category` (always-on | on-demand | specialist-scope | archive), `surface` (prompt | tool | both), `keywords` (required iff on-demand), `description`. Spec landed in Slice 2a.
- Skill loader: `src/agents/skill-loader.js` — `loadSkills(context) → SkillLoadResult` is the canonical agent-level skill-loading code path (Slice 2b Task 4). Reads canonical SSOT directly, partitions by category, applies hard-cap-4 to on-demand routing. Tool registration stays in `Agent.load()` until Slice 3 (audit T7).
- Skill router: `src/agents/skill-router.js` — token-level keyword matching with combination-trigger filter (Slice 2b Task 5). LLM-driven router is the Phase 5+ replacement behind the same `loadSkills` interface.
- Bootstrap Layer 6: `bootstrap.skills.always_on` — populated by `_layer6Skills` (`src/agents/bootstrap.js`); cached per session by the existing 30-min bootstrap TTL; reused by `loadSkills` via `context.bootstrap` so always-on skills don't re-read on every message inside the cache window.
- Generated keyword reference: `KEYWORD_REFERENCE.md` at repo root — generated from skill frontmatter via `node scripts/regen-keyword-reference.js`. Marked GENERATED at top; do not hand-edit. Will be retired when intent classification replaces keyword routing (Phase 5+).
- Skill symlinks (Charlie runtime): `/root/.quantumclaw/workspace/agents/charlie/skills/` — every file is a symlink into `/root/QClaw/src/agents/skills/`. As of Slice 2b: 15 symlinks (17 post-Slice-2a Task 1, minus 2 archived in 2b — `charlie-cto.md` and `agent-coordination.md`).
- Tool registry: `src/tools/registry.js` — `ToolRegistry` class. Three storage maps: `_builtins` (`get_current_time`, `calculate`, `web_fetch`, `search_knowledge`, `shell_exec`, `n8n_workflow_update`), `_apiTools` (preset HTTP tools + per-agent skill-defined HTTP tools), `_tools` (live MCP server tools). Public registration surface: `registerBuiltin(name, def)`, `registerSkillTool(agentName, skillName, parsedSkill, toolDef)`, `enablePreset`, `addCustom`, `addRemote`. Every entry carries an explicit `scope` field — `'shared'` for utility/memory/comms/read-only tools, or `[agent_name, ...]` for domain tools (Slice 3a `shared__` rule; see CHARLIE_OVERHAUL.md Component 4). Sibling files in `src/tools/`: `executor.js` (agentic loop + AGEX gates), `mcp-client.js` (MCP stdio/SSE transport), `shell-exec.js` (factory), `shell-exec-parser.js` (Slice 3d hand-rolled argv parser — exports `parseAndValidate(command)` returning `{ok, argv, schemaKey, resolvedPaths} | {ok:false, error, reason, detail}`; pure function, no env / fs / spawn at parse time), `shell-exec-verb-schemas.js` (Slice 3d per-verb schemas, `VERB_BINARY`, `SAFE_ENV`, `DENY_PREFIXES`/`DENY_GLOBS`, dangerous-git-config-key lists, `resolvePath` realpath + DENY/ALLOW chain), `shell-exec-spawn.js` (Slice 3d `spawnWithCaps` — `child_process.spawn` with `shell:false`, hardcoded `SAFE_ENV` including `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`, 30s timeout, 1 MiB combined output cap via hand-rolled accumulator, realpath substitution into argv before spawn), `n8n-workflow-update.js` (factory). Slice 3d (2026-05-16): `shell_exec` is enabled with a 5-verb structural surface (`ls`, `cat`, `git status`, `git log`, `pm2 list`); 4 rounds of adversarial review converged the design. Kill-switch `QCLAW_SHELL_EXEC_ENABLED=0`/`false`/`no`/`off` registers `createDisabledShellExecTool` for emergency rollback. Verification harness: `scripts/verify-shell-exec-parser.js`. Replaces the deleted Slice 3c allowlist (`shell-exec-allowlist.js`) and its harness — three rounds of adversarial review surfaced 4 CRITICAL bypasses in the regex-on-shell-string approach.

## Reference docs (Tyson and Claude Code)

- `KEYWORD_REFERENCE.md` — skill loading keyword cheat sheet
- `CLAUDE_CODE_OPERATING_RULES.md` — Claude Code session discipline
- `CLAUDE_CODE_INVENTORY.md` — Claude Code tool surface and access

## Infrastructure

- QClaw server: `ssh qclaw` → `138.68.138.214`, port 4000
- qclaw requires **git ≥ 2.30**. The Slice 3d `shell_exec` repo-local git-config trust-boundary argument depends on git 2.30's alias-resolution hardening (alias-overrides-of-built-in-commands are silently ignored in 2.30+). Pre-Unit-3-merge verification in `CHARLIE_OVERHAUL.md` Slice 3d pre-merge checklist. Tyson runs `git --version` on qclaw before merging Slice 3d Unit 3; if < 2.30, halt and escalate.
- n8n server: `ssh n8n` → `157.230.216.158`, Docker Compose
- Dashboard: `agentboardroom.flowos.tech`
- Supabase project: `fdabygmromuqtysitodp`
- Secondary Supabase project (LinkedIn lead gen): `zshmlgtvhdneekbfcyjc` — separate from main QClaw Supabase. Used by Tyson personal brand LinkedIn lead gen workflows for prospect tracking, engagement counters, and analytics. Schema and tables are LinkedIn-cluster-specific; not part of the main canonical state architecture. To be inventoried in the LinkedIn-cluster reconciliation work.
- Cloudflare R2: used by Clipper, Content Studio, Crete Marketing, Flow OS GHL Marketing (each scoped to own bucket/folder)
- n8n internal Postgres database — used by some n8n workflows for state/dedup logic (e.g. Morning Light WL→HL conflict resolution). Distinct from external Supabase. Hidden architectural dependency; access scope is internal-to-n8n only, not externally queryable from the Charlie or QClaw stack.

- **Polymarket execution relay (`polymarket-relay`)**: `68.183.13.219:8000`, DigitalOcean AMS3, Ubuntu 24.04. **The third production host.** It owns 100% of the Polymarket CLOB interaction for every trade (`get_market`, price calculation, order build, `post_order`), because qclaw's LON1 IP is UK-geoblocked. The authoritative test is a differential CLOB probe, an empty-body `POST clob.polymarket.com/order`: **403 from qclaw**, **401 from Amsterdam**. The frontend `polymarket.com/api/geoblock` endpoint reports `blocked:true` for NL as well and is the wrong signal for API access.
  - **No split-origin calls, deliberately.** One trade whose market lookup comes from one country and whose signature comes from another is indistinguishable from geoblock evasion and risks account action, so the relay is the sole Polymarket-facing side. Never "optimise" a lookup back onto qclaw.
  - Runtime: FastAPI/uvicorn under **systemd** (`Restart=always`, verified by surviving a real reboot). Client library `py-clob-client-v2==1.1.0` in `venv2`; the v1 venv is kept as rollback, but v1's order format is now rejected by the CLOB (`invalid order version`).
  - Network: **UFW default-deny inbound**, SSH open, port 8000 reachable **only from qclaw's IP `138.68.138.214`**. No public exposure. `GET /health` runs the differential geoblock self-check (the CLOB probe, not the frontend endpoint) and warns loudly if it ever reports `blocked`.
  - **Holds `POLYMARKET_PRIVATE_KEY` (the authoritative signing copy) and `RELAY_SHARED_SECRET`.** Auth on `POST /execute` is a constant-time bearer compare that fails closed.
  - Caller: `src/trading/execute_trade.py` on qclaw, a thin client since commit `44c905b`. Its CLI and stdout-JSON contract are byte-identical to the pre-relay version, so `src/trade_engine/executor.py` and the dashboard execute route flow through the relay transparently. **All six execution gates still run on qclaw before anything reaches the relay.**
  - **Key duplication is intentional, not drift.** `POLYMARKET_PRIVATE_KEY` and `POLYMARKET_FUNDER_ADDRESS` remain in qclaw's `.env` because `src/trade_engine/config.py` hard-requires them in `REQUIRED_KEYS` and `src/trading/get_balance.py` uses them. Removing the qclaw copy is deferred to Slice 6. **Rotating the Polymarket key therefore means rotating both hosts**, and qclaw alone is not enough.
  - Not decommission-pending: this host is load-bearing for as long as trading runs from a geoblocked region. It appears in no CI config and in no repo sweep, which is how it stayed undocumented until the 2026-08-19 audit.

- n8n Health Dashboard (email alerter): runs in a Manus GCP workspace (external platform, unaudited runtime); code exported 2026-08-18 to `github.com/tysonven/n8n-health-dashboard` (private). Sends "n8n Alert" emails via Gmail app password "n8n dashboard email" (created 2026-03-16, Manus-side env only); polls the n8n REST API every 5 min with the dedicated unscoped key "manus API" (`MYYZFn3DjtKQ43i4`). **DECOMMISSION-PENDING**: revoke the app password and the API key only after the heartbeat-based Telegram alerter is live and proven. Standing rule from this incident: platform-hosted builder workspaces (Manus and similar) get a LOCATIONS.md entry at creation, not at first commit; estate recon cannot enumerate them later.
## Standalone applications (separate infrastructure, NOT on qclaw)

Apps that have their own hosting and their own database. They share
branding and sometimes credentials with the QClaw stack, but nothing about
them is reachable from `ssh qclaw`. Do not assume a repo root, a `.env`, or
a database is on the qclaw droplet just because the product is Flow OS.

- **ghl-support-bot** (GHL Support Specialist + Flow OS Support chat)
  - Repo: `github.com/tysonven/ghl-support-bot` (private). Local checkouts:
    `~/Projects/ghl-support-bot` (primary) and `~/code/ghl-support-bot`
    (second clone, same remote, keep them in sync or delete one)
  - Default branch: `main`. Railway auto-deploys on merge to main, so a
    merged PR is a production deploy. Migrations run at boot via
    `runMigrations()` in `server/_core/index.ts` before the server listens
  - Host: Railway project `wholesome-emotion`, single `production`
    environment, services `ghl-support-bot` and `MySQL`
  - Database: Railway MySQL, database `railway`. Internal
    `mysql.railway.internal:3306` (app only, not reachable from a laptop);
    external access via the MySQL service's `MYSQL_PUBLIC_URL` TCP proxy
    (`caboose.proxy.rlwy.net`). Both are the same instance
  - Domain: `support.flowos.tech`. Routes: `/` Flow OS app, `/ghl` GHL app,
    `/ghl/landing` public marketing page
  - Dependencies: Clerk (auth), Stripe (billing), Anthropic
    `claude-haiku-4-5-20251001` (all user-facing answers), OpenAI
    `text-embedding-3-small` (retrieval embeddings only), GHL Agency API
    (sub-account verification)
  - `GHL_AGENCY_API_KEY` is load-bearing: since the 2026-08-12 fail-closed
    patch, an expired PIT blocks all new Flow OS self-service onboarding
    and fails silently. No heartbeat yet
  - Stale reference warning: the `.manus/db/*.json` dumps committed in that
    repo show a TiDB host (`gateway04.us-east-1.prod.aws.tidbcloud.com`).
    That is NOT the live database. It moved to Railway MySQL. Those dumps
    also contain production DB host, user, database name and five real
    customer email addresses, which is a problem if the repo is ever shared
    with a white-label partner

## Secrets and credentials

- QClaw-side secrets: `/root/.quantumclaw/.env` (root-owned, 600 permissions)
- QClaw encrypted store: `/root/.quantumclaw/.secrets.enc` (root-owned, 600). Flat JSON, one entry per credential, each an AES-GCM record of `{encrypted, iv, tag}`. Separate from `.env` and read by a different code path; a key can exist in one store and not the other, and the two are not kept in sync automatically.
- Symlink for sudo flowos access: `/home/flowos/.quantumclaw/.env` (intentional, root-managed)
- n8n-side secrets: `/home/n8nadmin/n8n-project/.env` (compose env_file)
- n8n API keys: rows in the n8n Postgres table `user_api_keys` on `157.230.216.158`. Not files, and not visible to any qclaw-side sweep.
- **Relay-side secrets: on the Amsterdam relay host, not on qclaw.** The authoritative `POLYMARKET_PRIVATE_KEY` signing copy and `RELAY_SHARED_SECRET` live there. See the relay entry under Infrastructure for the rotation consequence.
- Supabase credentials in n8n: "Supabase FSC" credential
- Never log secret values. Never commit secrets to repo.

### Credential inventory

<!-- BEGIN GENERATED: secrets-inventory -->

Generated by `scripts/regen-secrets-inventory.js`. **Do not hand-edit** this
section; edit the `PURPOSES` map in the script and re-run it. Names only, never
values. A key not in the map renders as [needs Tyson input], so a newly added
credential surfaces here automatically on the next run.

**79 credentials across 3 stores. 55 fully documented, 24 carrying a [needs Tyson input] marker.**

#### `.secrets.enc` (26)

`/root/.quantumclaw/.secrets.enc` (qclaw, root 0600)

| Key | Purpose |
|---|---|
| `agex_private_key` | AGEX action-signing key for `charlie`. Consumed by `src/tools/executor.js` gates. |
| `anthropic_api_key` | Anthropic API key for Charlie's runtime. See `ANTHROPIC_API_SURFACE.md`. |
| `ccdispatch_github_token` | GitHub token for the unprivileged `ccdispatch` user (Slice 5 dispatcher). |
| `claude-code-ig-fix_agex_private_key` | AGEX signing key for sub-agent `claude-code-ig-fix`. |
| `cloudflare_tunnel_token` | Cloudflare Tunnel credential. Tunnel target [needs Tyson input]. |
| `dashboard_auth_token` | Dashboard bearer token. Source of truth is `~/.quantumclaw/config.json` `dashboard.authToken`; re-minted by `qclaw dashboard` on 24h expiry. |
| `dispatch-zeta_agex_private_key` | AGEX signing key for sub-agent `dispatch-zeta`. |
| `ghl_api_key` | Legacy unscoped GHL key, predates the per-brand split. Still-in-use status [needs Tyson input]. |
| `ghl_crete_api_key` | GHL private integration token, Crete sub-account. Used by skill `ghl-crete.md`. |
| `ghl_crete_location_id` | GHL location id, Crete sub-account. |
| `ghl_flowos_api_key` | GHL private integration token, Flow OS sub-account. Used by skill `ghl-flowos.md`. |
| `ghl_flowos_location_id` | GHL location id, Flow OS sub-account. |
| `ghl_fsc_api_key` | GHL private integration token, FSC sub-account. Used by skill `ghl-fsc.md`. |
| `ghl_fsc_location_id` | GHL location id, FSC sub-account. |
| `ghl_kairos_api_key` | GHL private integration token, Kairos Wines sub-account. Used by skill `ghl-kairos.md`. |
| `ghl_kairos_location_id` | GHL location id, Kairos Wines sub-account. |
| `ghl_location_id` | Legacy unscoped GHL location id, pairs with `ghl_api_key`. Still-in-use status [needs Tyson input]. |
| `ghl_sproutcode_api_key` | GHL private integration token, SproutCode sub-account. Used by skill `ghl-sproutcode.md`. |
| `ghl_sproutcode_location_id` | GHL location id, SproutCode sub-account. |
| `n8n_api_key` | n8n REST API key held in the encrypted store. Relationship to the `.env` `N8N_API_KEY` [needs Tyson input]. |
| `n8n_router_token` | [needs Tyson input] |
| `n8n-workflow-fixer_agex_private_key` | AGEX signing key for sub-agent `n8n-workflow-fixer`. |
| `patcher_agex_private_key` | AGEX signing key for sub-agent `patcher`. |
| `post-auditor_agex_private_key` | AGEX signing key for sub-agent `post-auditor`. |
| `stripe_api_key` | Stripe API key. Account and live/test mode [needs Tyson input]. |
| `telegram_bot_token` | Charlie's Telegram bot token (encrypted-store copy). |

#### `.env` (48)

`/root/.quantumclaw/.env` (qclaw, root 0600)

| Key | Purpose |
|---|---|
| `ANTHROPIC_ADMIN_API_KEY` | Anthropic Admin Cost API, read by `src/observability/anthropic-spend-poller.js` (Slice 3g). Distinct from the runtime key. |
| `ANTHROPIC_API_KEY` | Anthropic API key for Charlie's runtime. |
| `ANTHROPIC_ORG_ID` | Anthropic org id, required alongside the admin key by the spend poller. |
| `ASSEMBLYAI_API_KEY` | AssemblyAI transcription. Consumer [needs Tyson input] (no call site in this repo). |
| `BUZZSPROUT_API_TOKEN` | Buzzsprout podcast API. Which show, and which workflow publishes [needs Tyson input]. |
| `BUZZSPROUT_PODCAST_ID` | Buzzsprout show id, pairs with `BUZZSPROUT_API_TOKEN`. Which show [needs Tyson input]. |
| `CCDISPATCH_GITHUB_TOKEN` | GitHub token for the `ccdispatch` dispatcher user (`.env` copy). |
| `CONTENT_STUDIO_PUBLISH_TOKEN` | Content Studio publish auth. Consumer [needs Tyson input]. |
| `CRETE_R2_BUCKET_NAME` | Cloudflare R2 bucket name, Crete Marketing. |
| `CRETE_R2_PUBLIC_URL` | Cloudflare R2 public base URL, Crete Marketing. |
| `DASHBOARD_SESSION_SECRET` | Session signing secret for the dashboard (`src/dashboard/server.js`). |
| `FLOWOS_R2_ACCESS_KEY_ID` | Cloudflare R2 access key, Flow OS GHL Marketing bucket. |
| `FLOWOS_R2_BUCKET_NAME` | Cloudflare R2 bucket name, Flow OS GHL Marketing. |
| `FLOWOS_R2_PUBLIC_URL` | Cloudflare R2 public base URL, Flow OS GHL Marketing. |
| `FLOWOS_R2_SECRET_ACCESS_KEY` | Cloudflare R2 secret key, Flow OS GHL Marketing bucket. |
| `GHL_FLOWOS_NOTIFY_CONTACT_ID` | GHL contact id that Flow OS notifications are sent to. |
| `GHL_FLOWOS_USER_ID` | GHL user id used as the actor on Flow OS sub-account writes. |
| `GHL_FSC_API_KEY` | GHL private integration token, FSC sub-account (`.env` copy). |
| `GHL_FSC_LOCATION_ID` | GHL location id, FSC sub-account (`.env` copy). |
| `GHL_FSC_NOTIFY_CONTACT_ID` | GHL contact id that FSC notifications are sent to. |
| `GHL_FSC_USER_ID` | GHL user id used as the actor on FSC sub-account writes. |
| `META_IG_ACCOUNT_ID` | Instagram account id for Meta Graph publishing. Which brand account [needs Tyson input]. |
| `META_PAGE_ACCESS_TOKEN` | Meta Page access token. Which page, and expiry policy [needs Tyson input]. |
| `META_PAGE_ID` | Meta Page id. Which page [needs Tyson input]. |
| `N8N_API_KEY` | n8n REST API key. Verified 2026-08-20 to be the key labelled "quantum claw api v2" in n8n (sha256 match). |
| `N8N_BASE_URL` | n8n REST API base URL. |
| `N8N_SSH_KEY` | SSH key path/material for reaching the n8n droplet from qclaw. |
| `NOTIFY_EMAIL` | Destination address for email notifications. Which sender/workflow [needs Tyson input]. |
| `OWNER_TELEGRAM_CHAT_ID` | Tyson's Telegram chat id. Alert destination for Charlie and the trade engine. |
| `POLYMARKET_FUNDER_ADDRESS` | Polymarket funder (share-holding) address. Kept on qclaw after the relay migration because `config.py` `REQUIRED_KEYS` and `get_balance.py` still demand it. Order placement itself uses the relay copy. |
| `POLYMARKET_PRIVATE_KEY` | Polymarket signer key. **Kept in parallel on qclaw, not used for order placement** since the relay migration (Slice-6 removal deferred). The authoritative signing copy lives on the Amsterdam relay. |
| `QCLAW_GATES_ENABLED` | Master kill-switch for the Slice 4 verification gates. |
| `QCLAW_SPECIALIST_LIVE_IDS` | Specialist live-id allowlist. Emptied 2026-08-14, so all `delegate_to` calls route to the stub. Host config, not in git. |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 access key, default/unprefixed bucket. Which bucket [needs Tyson input]. |
| `R2_ACCOUNT_ID` | Cloudflare R2 account id. |
| `R2_BUCKET_NAME` | Cloudflare R2 bucket name, default/unprefixed. Which consumer [needs Tyson input]. |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 secret key, default/unprefixed bucket. Which bucket [needs Tyson input]. |
| `RELAY_SHARED_SECRET` | Bearer secret for `POST /execute` on the Amsterdam Polymarket relay. Constant-time compared relay-side, fails closed. |
| `RELAY_URL` | Amsterdam relay base URL. Defaults to `http://68.183.13.219:8000` in `src/trading/execute_trade.py`. |
| `SUPABASE_ANON_KEY` | Supabase anon key, project `fdabygmromuqtysitodp`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key, project `fdabygmromuqtysitodp`. Required by every service-role-only table (spend, liveness, dispatch, trading). |
| `SUPABASE_URL` | Supabase REST base URL, project `fdabygmromuqtysitodp`. |
| `TELEGRAM_BOT_TOKEN` | Charlie's Telegram bot token. |
| `TRADE_TELEGRAM_BOT_TOKEN` | Separate Telegram bot for trade-engine alerts (`src/trade_engine/monitor.py`). Deliberately not Charlie's bot. |
| `TRADING_WEBHOOK_SECRET` | Shared secret on the trading webhook path. Which caller [needs Tyson input]. |
| `WP_APP_PASSWORD` | WordPress application password. Which site [needs Tyson input]. |
| `WP_SITE_URL` | WordPress site base URL. Which site [needs Tyson input]. |
| `WP_USERNAME` | WordPress username. Which site [needs Tyson input]. |

#### n8n API keys (5)

n8n Postgres `user_api_keys` on `157.230.216.158`

| Key | Purpose |
|---|---|
| `manus API` | Unscoped key polled every 5 min by the Manus-hosted n8n Health Dashboard. **DECOMMISSION-PENDING**: revoke once the heartbeat Telegram alerter is proven. Created 2026-03-16. |
| `MCP Server API Key` | [needs Tyson input]. Created 2026-01-02. |
| `n8n mcp` | [needs Tyson input]. Created 2025-07-15, the oldest key in the store. |
| `n8n query key v2` | [needs Tyson input]. Created 2026-04-20. |
| `quantum claw api v2` | QClaw's n8n REST access. Confirmed 2026-08-20 to be the same key as `.env` `N8N_API_KEY` (sha256 match). Created 2026-07-01. |

<!-- END GENERATED: secrets-inventory -->

## Business unit portals and accounts

- Flow OS community portal: `portal.flowos.tech`
- FSC community portal: `https://fsc.app.clientclub.net/home`
- GHL sub-accounts: Flow OS, FSC, SproutCode, Crete, Kairos Wines (one each).
  Credentials are **split per brand and are not interchangeable**: each has its
  own private integration token and location id in the encrypted store
  (`ghl_<brand>_api_key` / `ghl_<brand>_location_id`) and its own skill at
  `src/agents/skills/ghl-<brand>.md`. Never default to another brand's
  location id. Kairos has no dedicated GHL user and runs under Tyson's
  personal user.
- Meta Ads accounts:
  - Flow OS: `act_414785961683125`
  - Emma Maidment Business: `act_1426936257455201`
  - Flow States Retreats: `act_464237024205104` (currently dormant)

## Migration notes

When migrating any location (e.g. file-based log → Supabase table):
1. Update this file with the new location
2. Update any code or doc that references the old location
3. Note the migration in the build log
4. Verify all consumers pick up the new location before retiring the old

## Maintenance log

Append-only record of what changed in this file and why. A location that moved
without an entry here is the failure mode this log exists to catch.

- **2026-08-20** Added the Polymarket execution relay (`68.183.13.219`, AMS3) as
  a documented third production host, added Kairos Wines to the GHL sub-account
  list, and replaced the credential prose with a generated inventory covering
  all 79 keys across the three stores. All three gaps were found by the
  2026-08-19 estate audit, which reported 73 of 79 credentials undocumented and
  the relay present in no canonical doc at all. The inventory is generated
  rather than hand-written specifically so it cannot drift back into that state.
- **2026-08-18** Added the Manus-hosted n8n Health Dashboard, with the standing
  rule that platform-hosted builder workspaces (Manus and similar) get an entry
  at creation rather than at first commit, because estate recon cannot enumerate
  them later.
