# QClaw Build Log & Technical Handoff

**Project:** QClaw — Self-hosted Claude agent runtime (Fork of QuantumClaw/QClaw)
**Owner:** Tyson Venables / Flow OS
**Last updated:** 21 April 2026
**Repo:** https://github.com/tysonven/QClaw

---

## Build Log Rules

- **NEVER commit literal tokens, API keys, passwords, or secrets to the build log.**
- Reference them as `<stored in ~/.quantumclaw/.env>` or `<rotated — see secrets store>`.
- If a token accidentally lands in a commit, rotate it immediately even if the repo is private — history is durable and hard to scrub.

---

## Infrastructure

| Component | Location | Details |
|-----------|----------|---------|
| QClaw Agent (Charlie) | DigitalOcean Droplet | IP: [QCLAW_SERVER_IP], LON1, 2GB |
| n8n Server | DigitalOcean Droplet | IP: [N8N_SERVER_IP] |
| Dashboard | https://agentboardroom.flowos.tech | Nginx + SSL + PM2 |
| n8n Webhooks | https://webhook.flowos.tech | |
| Supabase | [SUPABASE_PROJECT_ID] | Ads agency data |

### SSH Aliases
```bash
ssh qclaw        # root@[QCLAW_SERVER_IP] — QClaw agent server
ssh n8n          # n8nadmin@[N8N_SERVER_IP] — n8n server
```

### Dashboard Access
URL: https://agentboardroom.flowos.tech/?token=[DASHBOARD_AUTH_TOKEN] Auth token: [DASHBOARD_AUTH_TOKEN] PIN: [DASHBOARD_PIN]

---

## PM2 Processes (on ssh qclaw)

| ID | Name | Port | Description |
|----|------|------|-------------|
| 0 | quantumclaw | 4000 | Main agent runtime (Charlie) |
| 1 | agex-hub | 4891 | AGEX identity/security hub |

Also running via Docker:
- cognee — Knowledge graph on port 8000 (docker ps to check)

---

## Agent: Charlie

- **Model:** claude-sonnet-4-6 (chat), claude-haiku-4-5-20251001 (fast tasks)
- **AID:** 7bdb59a3-2dfd-44fe-8c0b-f6e47e075061
- **Trust tier:** 0 (dev mode — self-signed, expected for hub-lite)
- **Telegram bot:** @tyson_quantumbot
- **Config:** ~/.quantumclaw/config.json
- **Skills dir:** ~/.quantumclaw/workspace/agents/charlie/skills/
- **6 skills loaded:** GHL, Stripe, n8n, QClaw repo, n8n-router, others

---

## Key Files
~/QClaw/ ├── src/ │ ├── index.js # Main entry point │ ├── credentials.js # AGEX credential manager │ ├── dashboard/ │ │ ├── server.js # API server (45 endpoints) │ │ ├── ui.html # Dashboard frontend (12 pabhook-manus.js # Manus job webhook handler │ ├── security/ # Trust kernel, audit, approvals │ ├── memory/ # Cognee + local graph │ └── agents/ # Agent registry ├── packages/ │ └── agex-core/ # PATCHED local copy of @agexhq/core │ └── src/crypto/ # Fixed Ed25519 crypto bugs ├── .github/workflows/ │ ├── deploy.yml # CI/CD — push to main auto-deploys │ ├── ci.yml # Tests + lint on every push │ └── build-cognee-venv.yml # ARM64 only — not used on x86_64 └── ~/.quantumclaw/ ├── config.json # Agent configuration ├── .env # Secrets (N8N_API_KEY etc) └── secrets.enc # Encrypted secrets store


---

## CI/CD

- **Trigger:** Push to main branch
- **Process:** SSH to server → git stash → git pull → npm install → pm2 restart
- **GitHub Secrets needed:** SERVER_IP, SERVER_USER, SERVER_SSH_KEY
- **Tests:** 22/22 passing (npm test)

---

## AGEX Security Layer

AGEX provides cryptographic identity for agents.

* packages/agex-core/. package.json references file:packages/agex-core so fixes survive npm install.

**Bugs fixed (commit db8bb70):**
1. keys.js — wrong import: @noble/ed25519 → @noble/curves/ed25519
2. keys.js — ed.getPublicKeySync() → ed.getPublicKey()
3. keys.js — ed.signAsync/verifyAsync → ed.sign/verify (sync)
4. ecdh.js — await in non-async function
5. ecdh.js — wrong SHA-256 scalar clamping → edwardsToMontgomeryPriv()

Bug report sent to QClaw/AGEX devs (same team).

---

## Dashboard Pages

| Page | Description | Key API |
|------|-------------|---------|
| Chat | Live Canvas chat with Charlie | POST /api/chat |
| Overview | Stats, costs, alerts | GET /api/stats |
| Channels | Telegram, dashboard config | GET /api/channels |
| Usage | Cost breakdown by channel | GET /api/costs |
| Agents | Spawn/manage agents | GET /api/agents |
| Skills | Charlie's loaded skills | GET /api/skills |
| Tools | MCP tools viewer | GET /api/tools |
| Scheduled | Heartbeat tasks | GET /api/scheduled |
|earch/remember | POST /api/memory/search |
| API Keys | Secrets management | GET /api/secrets |
| Config | Agent configuration | GET /api/config |
| Logs | Audit trail | GET /api/audit |

---

## n8n Workflows — Ads Agency

All workflows on: https://webhook.flowos.tech

| Workflow | ID | Webhook | Status |
|----------|----|---------|--------|
| Meta Ads Copy Agent | 0sIugM5o5wTwpflq | /webhook/meta-ads-copy-agent | Working |
| Meta Ads Creative Brief Agent | TtSUyKpvE5f9iQZg | /webhook/meta-ads-creative-brief | Working |
| Meta Ads Ad Creation Agent | lrGcirtmOHb1xTq8 | /webhook/ad-creation-agent | Fixed |
| Meta Ads Optimisation Agent | lf955LDteJ512RQi | Daily 9am + webhook | Working |
| Flow States Competitor Ad Research | QnCEES9T7WxW5vVR | /webhook/... | Untested |
| QClaw Router | n8n manual | /webhook/qclaw-router | Working |

### Ad Agency Supabase Tables ([SUPABASE_PROJECT_ID])
- copy_agent_output — stores copy variants with UTM URLs
- ad_creation_sessions — conversational ad creation state

# Structure
utm_source=meta&utm_medium=paid_social&utm_campaign=[offer-slug]&utm_content=[angle-slug]&utm_term=[creator]

### Offer Slugs
- free-community, claude-onboarding, manus-onboarding
- sustainable-blueprint, strategy-session, automate-to-elevate

---

## Ad Accounts

| Account | ID |
|---------|----|
| Flow States Retreats (all FSC ads) | act_464237024205104 |
| Emma Maidment Business | act_1426936257455201 |

### Facebook Pages
| Account | Page ID |
|---------|---------|
| Flow States Retreats | 2118187938198257 |
| Emma Maidment Business | 273319159777759 |

---

## Q2 2026 Strategy Context

**Primary CTA:** Join free community
https://fsc.app.clientclub.net/communities/groups/flow-states-collective/home?invite=69c559912f745e42c74153d6

**Lead Magnets:**
- Claude: https://claude.flowstatescollective.com
- Manus: https://manus.flowstatescollective.com
- Blueprint: https://go.flowstatescollective.com/the-sustainable-scaling-blueprint
- Strategy: https://go.flowstatescollective.com/strategy-sessions

**ICA:** Coaches and health professionals, solo operators, time-poor, non-technical
**Tone:** Calm, warm, authoritative — never urgent or pressure-based

---

## Roadmap

- [x] n8n router webhook
- [x] AGEX hub — crypto fixed, running under PM2
- [x] Dashboard sync with upstream (12 pages, 45 endpoints)
- [x] Manus webhook handler
- [x] Copy Agent — brand-aware + UTMs + Telegram working
- [x] Creative Brief Agent — brand-aware prompts
- [x] Ad Creation Agent — copy library + audience/targeting fixed
- [ ] **n8n env consolidation (prerequisite for new client intakes)**: switch n8n docker-compose to load env_file from ~/.quantumclaw/.env on the n8n host, then refactor hardcoded IDs in workflows (intake-kylie-content-system, GHL Changelog Emails, others) to reference env vars. Single source of truth across qclaw and n8n containers.
- [ ] Verify morning brief fires at 8am Athens time
- [ ] Test Ad Creation Agent end-to-end via Telegram
- [ ] Test Competitor Research Agent
- [ ] Connect Charlie skills to Ad Agency workflows
- [ ] Trading Room + Gym (Monte Carlo, Polymarket)
- [ ] Ads Agency dashboard room with agent characters
- [ ] Content Studio — Emma podcast "The Flow Lane with Emma Maidment"
- [ ] SproutCode continued development
- [ ] Wire Charlie memory to Cognee graph

---

## Common Commands
```bash
# Restart Charlie
ss restart quantumclaw"

# Restart AGEX hub
ssh qclaw "pm2 restart agex-hub"

# Check all processes
ssh qclaw "pm2 list"

# Check Cognee health
ssh qclaw "curl -s http://localhost:8000/health"

# Check Charlie health
ssh qclaw "curl -s http://localhost:4000/api/health --header 'Authorization: Bearer [DASHBOARD_AUTH_TOKEN]'"

# Deploy latest code
cd ~/QClaw && git push origin main

# View logs
ssh qclaw "pm2 logs quantumclaw --lines 50"
ssh qclaw "pm2 logs agex-hub --lines 20"

# Run tests
ssh qclaw "cd ~/QClaw && npm test"
```

---

## Key Contacts

- QClaw/AGEX devs — same team, in contact via Telegram. Bug report sent 26 Mar 2026.
- n8n API key — stored in ~/.quantumclaw/.env as N8N_API_KEY

---

## Session: 27 March 2026

### Completed This Session

**Morning Brief:**
- [x] Delivery queue consumer wired to Telegram channel (channels/manager.js)
- [x] Morning brief confirmed delivering to Telegram
- [x] Schedule corrected to 05:00 UTC = 08:00 Athens

**Ad Creation Agent (lrGcirtmOHb1xTq8):**
- [x] Full end-to-end test passed
- [x] Bug fix: campaign name "undefined" — added campaignName to Step: Objective Selected return object
- [x] Bug fix: no-adset-node fallback for undefined campaign name
- [x] Bug fix: copy agent pull uses parseInt(ctx.chatId)

**Competitor Research Agent (QnCEES9T7WxW5vVR):**
- [x] Model updated to claude-haiku-4-5-20251001, max_tokens 800
- [x] Truncation added at 3500 chars to fit Telegram limit
- [x] Tested via dashboard Scout button — working

**Charlie Routing:**
- [x] ads-agency.md skill updated with CRITICAL ROUTING RULES
- [x] Charlie calls ad-creation-agent webhook on "create ad"

**Ad Agency Dashboard Room:**
- [x] Agency page added (🎬 nav item)
- [x] 5 Pixar/DreamWorks 3D characters generated via Gemini:
  Rex (Strategist), Ledger (Media Buyer), Frame (Creative Dir),
  Penny (Copywriter), Scout (Researcher)
- [x] Characters at ~/QClaw/src/dashboard/agency-assets/
- [x] Dark cinematic office floor, colour-coded desk cards, trigger buttons
- [x] Modals for Scout, Penny, Frame — all calling correct webhooks
- [x] Ledger routes to Telegram, Rex shows Coming Soon

**Dashboard Fixes:**
- [x] Token persistence — saved to sessionStorage, no more Unauthorised errors
- [x] WebSocket timeout — Nginx proxy timeouts set to 3600s, fixes Offline badge

### Pending / Next Session

- [ ] Content Studio — Emma podcast "The Flow Lane with Emma Maidment"
  video → YouTube/Buzzsprout → social clips → email → blog
- [ ] Rex (Strategist) agent — not yet built
- [ ] Trading Room + Gym (Monte Carlo, Polymarket)
- [ ] Wire Charlie memory to Cognee graph
- [ ] SproutCode continued development

---

## Session: 1 April 2026 — Content Studio Phase 1

### Infrastructure
- Cloudflare R2 bucket: emma-content-studio
- R2 public URL: https://pub-70c436931e9e4611a135e7405c596611.r2.dev
- Supabase table: content_studio_jobs
- n8n credentials created: AssemblyAI, WordPress FSC, Buzzsprout, Supabase FSC, Anthropic

### n8n Workflow: Content Studio Pipeline (ID: Qf39NEOEgz2W0uls)
- 20 nodes, active at /webhook/content-studio-pipeline
- Webhook → Supabase job → Telegram notify → R2 URL → Buzzsprout → AssemblyAI → Extract highlights → Blog post → WordPress → Substack → LinkedIn → Update job → Telegram complete

### Dashboard — Content Studio Page
- New tab: microphone icon
- Drag-and-drop upload zone (MP4, MP3, WAV, M4A)
- server.js: POST /api/content-studio/upload (500MB limit)
- server.js: GET /api/content-studio/jobs
- Results Panel with 4 cards: Blog Post, Substack, LinkedIn, OpusClip Timestamps
- Job History table with View Results
- Nginx client_max_body_size 500M

### Services Integrated
- Cloudflare R2 (storage), Buzzsprout (podcast), AssemblyAI (transcription)
- Claude Sonnet (blog + substack + linkedin generation)
- WordPress REST API (draft posts), Telegram (notifications)

### Tested End-to-End
- Pipeline completed with real video upload (39.6MB MP4)
- Blog post draft created in WordPress
- All content cards loading in dashboard

### Pending — Phase 2
- YouTube OAuth (Emma Google account needed)
- LinkedIn direct posting via API
- Delete test Buzzsprout episodes and WordPress drafts
- Charlie skill: content-studio.md routing

### Key Technical Notes
- AssemblyAI: use speech_models (array) not speech_model
- Buzzsprout: audio_url must be publicly accessible
- n8n runs in Docker: use n8n credentials not host .env
- R2 upload must be server-side (credentials not exposed to browser)

---

## Session: 3 April 2026 — Content Studio Phase 2

### n8n Workflow Updates (Qf39NEOEgz2W0uls) — now 22 nodes
- Select Clip Segments node added (claude-haiku-4-5-20251001, analyses transcript, returns 5-8 clip segments as JSON)
- Parse Clip Selections node added (extracts JSON array, merges with highlight timestamps)
- Backlinks added to Blog Post prompt (Buzzsprout, LinkedIn, Substack)
- Backlinks added to Substack prompt (Buzzsprout, WordPress, LinkedIn)
- Backlinks added to LinkedIn prompt (Buzzsprout)
- clip_selections saved to Supabase job record

### Dashboard Updates
- Episode Images section: Hero image (1200x628) + YouTube Thumbnail (1280x720) upload zones
- Image resize via sharp, uploads to R2 at episodes/[jobId]/[imageType].jpg
- Social Clips section: drop zone for MP4 clips, caption editor, platform selector, schedule picker, Schedule via GHL button
- server.js: POST /api/content-studio/upload-image
- server.js: POST /api/content-studio/schedule-clip

### Supabase
- social_clip_schedules table created
- Columns added: clip_selections (jsonb), hero_image_url, thumbnail_url

### Pending — Phase 3
- YouTube OAuth (Emma Google account)
- LinkedIn direct posting via API
- GHL Social Planner integration for scheduled clips
- Auto-clipper: FFmpeg worker for automated clip generation from transcript timestamps
- Delete test Buzzsprout episodes before Emma uses it

---

## Session: 4 April 2026 — Trading Room

### Infrastructure
- Monte Carlo worker: PM2 trading-worker, port 4001
- Python Flask: ~/QClaw/src/trading/monte_carlo.py
- yfinance for gold (GC=F) and BTC (BTC-USD) price data
- Macro factors: DXY (DX-Y.NYB) and 10Y treasury yield (^TNX)
- 10,000 GBM simulations, 95% confidence interval
- Polymarket CLOB client: ~/QClaw/src/trading/execute_trade.py

### n8n Workflows (all active)
- Trading - Market Scanner (3YahxqOguET3pifj) — every 30 mins
  - Simulates gold (k target) + BTC (k target, 90 days)
  - Fetches Polymarket markets (100 markets, offset 500)
  - Compares sim probability vs market odds, flags edge >25%
  - Saves to trading_simulations, Telegram scan summary
- Trading - Trade Executor (fq7spfyiNcpt8Mf7) — webhook /webhook/trading-execute
  - Validates trading_config (trading_enabled, daily loss limit)
  - Executes via port 4000 API, saves to trading_positions
- Trading - Position Monitor (UYA0JppH7eqyI7fQ) — every 15 mins
- Trading - Weekly Analyst (vjj2uBIPc07FpIxx) — Monday 9am

### Dashboard — Trading Room Page (🎰)
- Live simulations table (auto-refresh 60s)
- Live positions table 
- Config panel: trading toggle, max position, min edge, daily loss limit
- Run Simulation panel: asset selector, target price, horizon input

### Supabase Tables
- trading_simulations, trading_positions, trading_config, 
  trading_analyst_reports, trading_markets

### Key Settings (trading_config)
- trading_enabled: false (manual activation required)
- max_position_usdc: 25
- min_edge_threshold: 25
- daily_loss_limit: 50

### Polymarket Setup
- Account: .94 USDC deposited
- Private key and funder address stored in ~/.quantumclaw/.env on ssh qclaw
- py-clob-client installed

### Key Technical Notes
- Polymarket Gamma API requires User-Agent header or returns 403
- BTC k markets live at offset 500 in Gamma API
- No gold/XAU price markets currently on Polymarket
- n8n merge node v2.1 with append mode works; waitForAll with 3 inputs does not
- All Supabase nodes use Supabase FSC credential (never hardcode keys)
- Analyse Edge output[0] fans out to both Save Simulations and Notify Edge

### Pending
- Charlie trading.md skill file for conversational trading control
- News sentiment overlay for macro adjustment
- Oil as third asset when Polymarket markets appear
- First live trade once edge >25% is detected

## Session: 4 April 2026 — Trading Room (continued)

### Dashboard additions
- USDC Balance widget (shows Polymarket position value via data-api.polymarket.com/value)
- Realised PnL widget (from trading_positions table)
- Open Positions count widget
- All auto-refresh every 60 seconds
- Config values updated: max_position=, min_edge=30%, daily_loss=

### Technical notes
- Polymarket .94 balance sits in CTF exchange proxy contract, not funder wallet
- py-clob-client get_balance() returns CLOB collateral balance (0 until trade placed)
- data-api.polymarket.com/value returns position value only, not uninvested cash
- Balance widget will populate once first position is opened

### Status
- Trading system fully operational, trading_enabled=false
- Scanner running every 30 mins, Telegram scan summaries active
- No edge detected yet — BTC k markets exist, gold markets absent from Polymarket
- Ready for first trade when edge >30% is detected

---

## Session: 4 April 2026 — Security Hardening Sprint

### Audit Findings
Full security audit completed. 2 critical, 4 high, 3 medium issues identified and addressed.

### Completed
- Webhook auth: Trade Executor now requires x-trading-secret header (secret in .env)
- Telegram bot token: removed from all workflow JSON, stored in n8n docker .env as TELEGRAM_BOT_TOKEN
- Supabase anon key: migrated from hardcoded headers to Supabase FSC credential in all workflows (Competitor Research, Ad Creation, Copy Agent, Content Studio, Trading)
- Rate limiting: express-rate-limit on /api/trading/simulate (10/min), /api/trading/execute (5/min), /api/content-studio/upload (5/min), /api/content-studio/upload-image (10/min)
- Root SSH disabled on qclaw: flowos user created, SSH key copied, PermitRootLogin no, ssh service restarted
- .env permissions: chmod 600 ~/.quantumclaw/.env, chmod 700 ~/.quantumclaw/
- 7 Pillars architecture framework: written to src/agents/skills/architecture-pillars.md
- Security skill file: written to src/agents/skills/security.md

### SSH Config Change
- qclaw now connects as flowos (not root)
- Use sudo for PM2, nginx, and system commands
- Root login blocked: ssh root@138.68.138.214 returns Permission denied

### Pending Security Items
- Root SSH on n8n server (157.230.216.158) — same process, next session
- Dashboard static token — implement proper session auth
- Credentials rotation schedule — quarterly
- Older pre-March workflows not fully audited

### 7 Pillars Framework
Now enforced in:
- Claude project instructions (all future conversations)
- Memory (cross-chat enforcement)
- ~/QClaw/src/agents/skills/architecture-pillars.md (Charlie + Claude Code)

## Session: 6 April 2026 — Scanner Redesign + Charlie Tools

### Trading Room — Scanner Redesign
- Dynamic price-based targets replace static $5k gold / $150k BTC
- Gold short: current +1% / 14d, Gold medium: current +2.5% / 30d
- BTC short: current +5% / 14d, BTC medium: current +10% / 30d
- fetch() errors fixed — replaced with HTTP Request nodes
- Smart schedule: weekdays every 2h, weekends every 4h
- Silent notifications: Telegram only fires on edge >30% + $50k volume
- Weekend-aware: skips gold sims on Sat/Sun
- created_at column added to trading_positions (backfilled from opened_at)

### Charlie — Tools Now Working
- trading-api.md: 4 tools (get_simulations, get_positions, get_config, create_simulate)
- n8n-api.md: 2 tools (get_workflows, get_executions)
- All 6 tools registered and confirmed working via executeSkillTool
- charlie-cto.md updated with proactive tool usage rules
- Total: 11 skills loaded

### Security / Infrastructure
- TELEGRAM_BOT_TOKEN + SUPABASE_ANON_KEY added to n8n Docker .env
- Position Monitor: order=opened_at.desc fixed, Supabase FSC credential
- CI/CD deploy updated to use flowos user + sudo paths
- flowos user NOPASSWD sudo confirmed working

### Pending
- n8n server (157.230.216.158) root SSH still enabled — next session
- Dashboard static token — implement proper session auth
- Charlie content-studio.md skill file
- YouTube OAuth for Content Studio
- Instagram Reels workflow Google Sheets 403 — separate chat

---

## Session: Apr 6, 2026 — Content Studio Phase 2 Completion

### What Was Completed

**Content Studio Pipeline (Qf39NEOEgz2W0uls) — PRODUCTION READY**

Full end-to-end pipeline tested and confirmed working across all 30 nodes.

**Fixes applied this session:**
- Wait nodes: 5s before Substack, 3s before LinkedIn (rate limiting)
- Model: Substack + LinkedIn on Haiku, Blog stays on Sonnet
- Convert to HTML code node added between Blog Post and WordPress
- All three prompts: first person as Emma Maidment, no em dashes, no hashtags
- LinkedIn: Get LinkedIn Profile node removed; author hardcoded as urn:li:member:194094731
- LinkedIn posting via Blotato (avoids n8n JSON parser issues with dotted keys)
- YouTube Upload: inputDataFieldName fixed to data

**Verified pipeline outputs:**
- Buzzsprout upload, AssemblyAI transcription, Haiku clip selection
- WordPress HTML draft, Substack draft, LinkedIn post via Blotato
- YouTube unlisted upload, Supabase job record, Telegram start+complete notifications

### Pending Next Session
- Clean up test Buzzsprout episodes + WordPress drafts (post IDs 627-655)
- n8n server root SSH disable (157.230.216.158)
- Dashboard static token → session auth
- Charlie skill files: content-studio.md, trading.md
- YouTube auto-publish or Emma publishes manually

### Key Config
- Emma LinkedIn member ID: 194094731
- Emma YouTube channel: UCvUdyddTC_Njz52NNotKQWw
- Blotato API key: BLOTATO_API_KEY in ~/.quantumclaw/.env
- Content Studio workflow: Qf39NEOEgz2W0uls

---

## Session: Apr 7, 2026 — Weekly Analyst Fix + Oil Trading Room

### Weekly Analyst (vjj2uBIPc07FpIxx) — FIXED
- Supabase nodes: switched from hardcoded anon key to Supabase FSC
  credential (Nd2uuX5t9KEwbQPv) with apikey header
- Fetch Week Trades URL: fixed expression syntax (= prefix, single braces)
- Claude Analysis: switched to Anthropic API 2 credential (eXhIwRbh7FBgb6O3)
- Confirmed working: runs clean, handles empty trade set correctly

### Charlie Skill Files — ADDED
- src/agents/skills/content-studio.md: pipeline overview, webhook trigger,
  job status queries, content rules, safety rules
- src/agents/skills/trading.md: system architecture, config, API endpoints,
  wallet info, Supabase tables, safety rules, weekly analyst
- Committed a53f4e9, pushed to main

### Trading Room — Oil Futures Added
- Monte Carlo worker: added WTI (CL=F) and Brent (BZ=F) tickers
- Market Scanner (3YahxqOguET3pifj): 
  - Smart Schedule: hourly Mondays (weekend news volatility), 2h Tue-Fri, 4h weekends
  - Added Get WTI Price + Get Brent Price nodes
  - Chained merges: Gold+BTC → +WTI → +Brent (avoids n8n 4-input merge bug)
  - Calculate Targets: WTI/Brent short +3% / medium +8%
  - Analyse Edge: oil market matching, weekends skipped, Monday edge
    threshold lowered to 20% (vs 30% normal)
  - Notify Edge: all four asset prices in Telegram summary
- Test run confirmed: Gold 701, BTC 9134, WTI 11.66, Brent 08.11
  — 100 markets scanned, pipeline runs end-to-end

### Dashboard — Session Auth (ec3aad0)
- Login page at /login: minimal white form, matches flowos.tech aesthetic
- POST /api/auth/login: validates token, issues httpOnly JWT cookie (24h expiry,
  secure, sameSite=strict), redirects to /
- GET /api/auth/logout: clears cookie, redirects to /login
- Auth middleware priority: JWT cookie → Bearer header → ?token= query param
- Browser requests without auth → redirect to /login
- API requests without auth → 401 JSON
- Logout button added to dashboard topbar (ui.html)
- Bug fix: GET /api/config was mutating live config.dashboard.authToken to '***'
  via shallow spread — destroyed token in memory after first read. Fixed with
  deep copy of dashboard sub-object.
- New deps: jsonwebtoken, cookie-parser
- New env: DASHBOARD_SESSION_SECRET (32-byte hex, stored in ~/.quantumclaw/.env)
- PR to upstream: QuantumClaw/QClaw#6

### Pending
- n8n server root SSH disable (157.230.216.158)
- YouTube auto-publish option for Emma

---

## Session: Apr 7, 2026 — Clipper Microservice + Pipeline Completion

### Clipper Microservice — BUILT & PRODUCTION READY
- FastAPI service, port 4002, PM2: clipper-worker
- Source: /root/QClaw/src/clipper/main.py
- Supabase table: clip_jobs (id, status, video_url, transcript, clips, caption_style, etc.)
- Pipeline: Claude Haiku segment selection → FFmpeg cut → 9:16 vertical crop
  → SRT captions burned (word-by-word, Montserrat Bold, gold highlights, lower third)
  → R2 upload → Supabase job record
- Memory fix: -threads 1 -preset ultrafast, ffprobe duration guard (was OOM-killing at 681MB)
- Caption style: accepts dict or JSON string (fixed 422 error from n8n)
- Clip output: clips/{job_id}/clip_{n}.mp4 on R2
- Charlie skill file: src/agents/skills/clipper.md

### Content Studio Pipeline — FULLY PRODUCTION READY
- Clipper wired in parallel with blog post branch
- Merge Before Notify node: waits for both YouTube upload AND clips before firing Telegram
- Telegram notification now includes all 5 clip URLs
- AssemblyAI word_boost added: Maidment, Emma Maidment, Flowlane, Flow Lane
- Save Clip URLs: PATCHes clip_job_id + clip_selections into content_studio_jobs
- Supabase: clip_job_id column added to content_studio_jobs

### Dashboard Session Auth — SHIPPED
- /login page, JWT httpOnly cookie (24h), /logout endpoint
- Auth middleware: cookie → Bearer → ?token= priority chain
- Bug fix: /api/config shallow spread was destroying authToken in memory
- PR #6 opened upstream to QuantumClaw/QClaw

### Pending
- Blotato subscription renewal (LinkedIn posting disabled until paid)
- n8n server root SSH disable (157.230.216.158) — tonight
- YouTube auto-publish option for Emma
- Clipper Phase 2: face detection for rule-of-thirds reframing
- Clipper productisation: own domain, API key auth, Stripe

---

## Session: Apr 8, 2026 — Charlie Orchestration Loop

### Charlie Task Queue — BUILT & LIVE
- Supabase table: charlie_tasks (id, status, type, title, instructions,
  assigned_to, priority, result, error_message, parent_task_id, metadata)
- n8n workflow: Charlie - Task Handler (a88zSrQfEy79v3oc)
  - Webhook: POST /webhook/charlie-tasks
  - Commands: /task, /tasks, /done, /run
  - /done supports: exact UUID, ID prefix, partial title match
- Skill file: src/agents/skills/task-queue.md
- Skill file: src/agents/skills/build.md

### Claude Code CLI Integration — LIVE
- Claude Code CLI installed globally on qclaw (v2.1.96)
- run-task.sh: fetches task from Supabase, marks in_progress, 
  runs Claude Code, saves result, marks completed/failed
- charlie-watcher: PM2 process polling every 5s for queued tasks
- Architecture: Telegram → n8n → queued → charlie-watcher → 
  Claude Code → Supabase → Telegram

### First Real Task Completed by Charlie
- Task: Add swap space to qclaw droplet
- Result: 2GB swap added, persisted in /etc/fstab
- Before: 0 swap | After: 2GB swap active
- Clipper OOM risk eliminated

### Pending
- n8n server root SSH disable (needs DO console fix or password reset)
- YouTube auto-publish option for Emma
- Clipper Phase 2: face detection / rule of thirds
- Charlie sub-task spawning (parent_task_id support in run-task.sh)

---

## Session: Apr 8, 2026 (evening) — Telegram Token Rotation + n8n Recovery

### Security: Telegram Bot Token Rotated
- GitGuardian alert received — old token revoked in BotFather
- New token updated in /home/n8nadmin/n8n-project/.env on n8n server
- Confirmed: no token value was ever committed to git repo
- Added .env* to .gitignore to prevent future variants being committed

### n8n Recovery
- Charlie Task Handler lost during docker restart (NODE_FUNCTION_ALLOW_BUILTIN
  change required container recreate)
- Recreated: Charlie - Task Handler now at workflow ID dHoqL8Ph8kmFHwyx
- n8n owner account reset and reconfigured (password reset via n8n CLI)
- All workflows, credentials, and execution history preserved

### Workflow Backups Added
- All 6 QClaw workflows exported to /root/QClaw/n8n-workflows/
- Committed 3601424, pushed to main
- Update these exports after every workflow change

### Infrastructure Hardening
- Added postgres healthcheck to docker-compose.yml
- n8n now waits for postgres condition: service_healthy before starting
- Prevents workflow loss on future restarts

### Updated Workflow IDs
- Charlie - Task Handler: dHoqL8Ph8kmFHwyx (was a88zSrQfEy79v3oc)

## Session: Apr 9, 2026 — QA Agent Team + Stability Fixes

### Superpowers + claude-mem installed on qclaw
- Claude Code v2.1.96 now has Superpowers 5.0.7 and claude-mem 12.1.0
- Available for all tasks run via run-task.sh

### QA Agent System — LIVE
- qa-runner.sh: reviews completed tasks against 5-point checklist
- charlie-watcher updated to trigger QA async after task completion
- qa_status + qa_result + qa_completed_at columns added to charlie_tasks
- skill file: src/agents/skills/qa.md
- Tested end-to-end: task completed, QA passed, Telegram notified

### Task Watcher Resilience Fix
- Watcher now polls for status in (queued, pending) where assigned_to = claude-code
- Removes n8n as single point of failure for task execution
- Direct Supabase task inserts now flow through without n8n involvement

### PM2 Startup Persistence Fixed
- systemd service pm2-root.service created and enabled
- All 5 processes survive reboots: quantumclaw, trading-worker,
  clipper-worker, charlie-watcher, agex-hub

### Telegram Token Rotated + n8n Recovery (Apr 8 evening)
- See previous build log entry

---

## Session: Apr 9, 2026 (continued) — Clipper Phase 2

### Clipper Phase 2 — Face Detection + Platform-Safe Captions
- opencv-python-headless 4.13.0 installed
- OpenCV DNN face detector: deploy.prototxt (committed),
  caffemodel (gitignored, README install instructions added)
- detect_face_position(): samples 1fps max 10 frames, >50% confidence
- get_smart_crop_filter(): face-centered 9:16 crop, center fallback
- Platform-safe caption margins: MarginV=180, MarginL=40, MarginR=40
  (clears Instagram Reels + TikTok UI buttons)
- Montserrat Bold system font confirmed available
- Tested: fallback path confirmed on title card, face detection will
  activate on talking-head footage
- Committed f89cf1e, pushed to main

---

## Session: Apr 11, 2026 — Crete Marketing Dashboard Tab

### Crete Marketing — Content Review Queue
- New Supabase table `crete_content_queue` (schema in
  crete-qclaw-dashboard-spec.md): pending_review / approved /
  rejected / published / failed. RLS enabled, permissive policy
  matching existing QClaw tables (auth boundary is dashboard JWT).
- Six new Express routes under `/api/crete/content` added inline
  in src/dashboard/server.js `_setupAPI()`:
    GET    /api/crete/content           list with status filter + pagination
    GET    /api/crete/content/:id       single item
    POST   /api/crete/content           insert (fires Telegram notify)
    PUT    /api/crete/content/:id       edit title/body/cta/etc.
    PUT    /api/crete/content/:id/approve   → fires publish webhook
    PUT    /api/crete/content/:id/reject    → fires regenerate webhook
    POST   /api/crete/content/regenerate/:id
- Supabase URL + anon key read from /root/.quantumclaw/.env at
  server boot (no hardcoded creds). UUID regex validation on all
  :id params, status allowlist, limit/offset clamping, field
  allowlist on PATCH, notes truncated to 2000 chars.
- All routes inherit the existing global auth middleware (JWT
  cookie / Bearer / ?token=). Confirmed 401 on unauth request.
- New "Crete Marketing" tab in src/dashboard/ui.html (nav-item
  🌿, page id `page-crete`). Filter pills, card grid, inline
  edit, approve/reject/regenerate, prompt-based reject notes.
  Brand palette: olive #5B6F3C, sand #D4C5A9, cream #FAF8F4,
  charcoal #2D2D2D. All DB content HTML-escaped client-side.
- Telegram notification on new pending_review insert via
  qclaw.channels telegram channel (same pattern as
  webhook-manus.js). Non-blocking — failures logged, not raised.
- n8n webhooks `crete-content-publish` and `crete-content-regenerate`
  fired async fire-and-forget. Workflows do not exist yet — 404s
  on test runs are expected and only log.warn.
- Backups before edit: server.js.bak + ui.html.bak in
  /root/QClaw/src/dashboard/.
- pm2 restart quantumclaw — clean boot, Dashboard ready at
  http://localhost:4000.

### Smoke test (end-to-end, Apr 11 06:51 UTC)
- POST insert → UUID dbbb054d-... returned, Telegram fired
- GET ?status=pending_review → count 1
- GET /:id → row matches
- PUT /:id/approve → status=approved, reviewed_at set,
  publish webhook fired (404 expected)
- 2nd insert → PUT /:id/reject with notes → status=rejected,
  reviewer_notes saved, regenerate webhook fired (404 expected)
- Invalid UUID → 400
- No auth → 401
- Final counts: 0 pending, 1 approved, 1 rejected

### Outstanding (next session)
- [ ] n8n workflow: crete-content-publish (reads approved row,
      posts to platform API, updates status→published)
- [ ] n8n workflow: crete-content-regenerate (re-runs Claude
      with original prompt + reviewer notes, updates row,
      resets status→pending_review)
- [ ] n8n workflow: crete-content-generate cron (reads R2
      content-calendar.json, generates upcoming content,
      inserts to crete_content_queue)
- [ ] R2: upload initial crete-projects/content-calendar.json
- [ ] Manual cleanup of the 2 smoke-test rows when convenient
- [ ] (optional) Replace hardcoded anon keys in content-studio/
      trading routes with the same env-loading pattern used here

### Security gate (7 Pillars)
- Credentials: no hardcoded secrets; env-loaded at boot ✓
- Input validation: UUID regex, status allowlist, field
  allowlist, limit/offset clamping, notes truncation ✓
- Auth: global JWT middleware gates all new routes ✓
- XSS: creteEsc() on all DB fields rendered in HTML ✓
- Injection: PostgREST only, no SQL concat, UUIDs pre-validated ✓
- RLS: enabled on table, policy matches existing tables ✓
- Error handling: try/catch on every route, external-system
  failures swallowed with log.warn ✓


---

## 2026-04-13 — GHL Marketing Automation
- Added ghl-marketing.md skill file to /src/agents/skills/
- Created Supabase table: marketing_drafts (with RLS)
- Built 4 n8n workflows: Content Generator, Approval Handler, Publisher, Weekly Report
- Distribution: Telegram approval flow, copy-paste-ready posts per platform
- Cadence: Mon/Wed/Fri organic posts (pain-led/value-led/offer-led), weekly report Sunday 20:00 UTC
- Content Generator: Claude Sonnet, rotates hooks to avoid repetition
- Approval Handler: Telegram reply "go" approves, any other reply triggers regeneration with feedback
- Publisher: Webhook-triggered, updates Supabase status to published, sends formatted posts to Telegram
- Weekly Report: Claude Haiku summarises drafts generated/approved/rejected/published
- GHL Social Planner API: deferred (copy-paste via Telegram until OAuth confirmed)
- Security gate: PASSED (no hardcoded keys, RLS enabled, chat ID filter, credentials via n8n creds/env)
- All workflow JSONs backed up to /root/QClaw/n8n-workflows/
- No existing workflows, files, or processes were modified

### Trading Market Scanner Redesign (Apr 14)
- Flipped Polymarket matching logic: now fetches 600 markets from
  Gamma API (3 pages x 200), identifies asset type + target price
  from question text, runs Monte Carlo against each markets own
  resolution criteria
- Removed 7 nodes (price fetchers, old merges, old sims, old targets).
  Flow: Schedule > 3xFetch > Merge > Analyse Edge (parse markets) >
  Run Market Simulations (per-market) > Calculate Edge > Save/Notify
- Sports false-positive exclusion (Golden Knights, Warriors, Oilers etc.)
- Price regex handles 150k, 1m, 1b suffixes
- Horizon cap widened to 180 days (Polymarket crypto markets run 80+ days)
- Volume threshold lowered to 10k for calibration
- Edge threshold: 20% (15% on Mondays)
- First successful run found 1 BTC market: Will bitcoin hit 1m before
  GTA VI - sim 0.02% vs market 48.85%, edge -48.8% (market is massively
  overpriced for YES). Would signal a NO bet if that feature existed.
- Note: Only 3 crypto price markets exist across 1800 Polymarket markets
  currently. Zero gold/oil commodity price markets on the platform.
  Scanner will pick up new markets as they appear.

---

## Session: Apr 14, 2026 — Trading Room Fixes + Kalshi + Ops

### Monte Carlo dt Bug Fixed
- Changed dt = 1.0 / TRADING_DAYS_YEAR to dt = 1.0
- mu/sigma are daily parameters so dt must be 1.0 day per step
- Gold probability for realistic targets now 60-85% (was 5-12%)
- Committed 19a2791

### Polymarket Matching Logic Redesigned
- Flipped from "generate target, find market" to "find market, simulate against it"
- Fetches 600 Polymarket markets across 3 pages
- Parses each market's resolution criteria (price + end date)
- Runs Monte Carlo against those specific criteria
- Volume threshold lowered to $10k, edge threshold 20% (was 30%)
- Sports/entertainment exclusion regex added
- Committed bf96118

### Kalshi Integration Added
- Added Kalshi as second market source (api.elections.kalshi.com)
- Fetches 1,000 open markets, normalizes to Polymarket format
- Total markets scanned per run: ~1,600 across both platforms
- Source tracking added to edge notifications
- Finding: Kalshi currently has no commodity/crypto price markets
  (all sports + politics). Infrastructure ready for when they return.

### Instagram Reels — Fixed Schedule
- Changed from rolling every 5 hours to fixed times
- Now posts at 21:00, 02:00, 07:00, 11:00 UTC (7am/12pm/5pm/9pm AEST)
- Committed 9623509

### Charlie Fixes
- Fixed env path fallback in run-task.sh, qa-runner.sh, task-watcher.sh
- Fixed hardcoded dead Telegram token — all scripts now read from .env
- Fixed flowos user permissions via symlink to /root/.quantumclaw/.env
- Updated trading.md skill: n8n via MCP not localhost, all 10 workflow IDs
- Committed ff3da75, 9623509

### R2 Large File Upload
- Added upload-to-r2.sh and receive-and-upload.sh scripts
- Supports files over 300MB (Cloudflare browser UI limit) via S3 API
- First real episode (1.87GB) uploaded via SCP + script
- TODO: Fix dashboard R2 uploader to support multipart for large files
- Committed 0cc12c7

### Pending
- Dashboard R2 uploader multipart fix (files >100MB)
- receive-and-upload.sh r2FileKey variable bug (prints empty in curl command)
- Trading room: monitor for new gold/oil markets on Polymarket/Kalshi
- n8n root SSH disable (parked)

---

## Session: Apr 16, 2026 — Bug fixes + upstream sync

### spawn_agent fixed (commit 5b12cee)
- Root cause: handler registered as raw async function, not {fn, description, inputSchema}
- Fixed: both spawn_agent and search_knowledge wrapped correctly
- Charlie can now delegate to Claude Code directly

### Flow OS ad account added
- act_414785961683125 added to Meta Ads Optimisation Agent (lf955LDteJ512RQi)
- Copy Agent and Creative Brief Agent have no hardcoded accounts (dynamic from webhook)

### Playwright MCP installed
- claude mcp add playwright npx @playwright/mcp@latest
- Available for Claude Code browser automation and QA testing

### Upstream sync (cherry-pick from QuantumClaw/QClaw)
- c99dafb: CLEAN - fix: dashboard rate limiter lockout behind Nginx
- c5a29d7: SKIPPED (conflict) - web_search + process + message tools
- f4e3088: SKIPPED (conflict) - fix WSS EADDRINUSE crash
- 510c409: SKIPPED (conflict) - fix EADDRINUSE, MCP workspace placeholder
- 3be8d0b: SKIPPED (conflict) - fix security module imports
- eeb8d14: SKIPPED (conflict) - skill tool HTTP execution engine
- bb717d4: SKIPPED (conflict) - agent & team performance metrics
- bcdb1a5: SKIPPED (conflict) - native multi-agent spawning
- 7/8 conflicted due to diverged codebase. Only rate limiter fix applied.
  Full upstream merge requires dedicated session to resolve conflicts.

### Higgsfield skills noted in build.md roadmap
- 15 Seedance 2.0 video skills for future integration

### Content Studio fixes (Apr 14-15)
- Fixed custom_spelling error in AssemblyAI node (two-word "to" field)
- Fixed LinkedIn post: plain text only, no markdown, Buzzsprout URL appended
### Instagram Image Generation System (Apr 17)
- Installed node-canvas with Cairo dependencies for server-side image rendering
- Created src/crete-marketing/generate-text-card.js: branded 1080x1080 PNG generator
  - Two styles: quote (centred italic serif text, decorative quotation marks) and editorial (headline + body, structured layout)
  - Brand palette: cream background (#F5F0EB), olive green accents, Cormorant Garamond + DM Sans + Montserrat
  - Olive branch decorative elements, gold dividers, CRETE PROJECTS footer
- Added POST /api/crete/generate-image endpoint to dashboard server
  - Validates style + required fields, generates PNG in memory, uploads to R2
  - Returns public R2 URL at crete-projects/images/{uuid}.png
  - Rate-limited (10/min), protected by existing auth middleware
- Curated 22-photo stock library from Unsplash (all free for commercial use)
  - 8 agriculture/land, 6 village/stone buildings, 4 wellness, 4 Crete landscape
  - Centre-cropped to 1080x1080, uploaded to R2 at crete-projects/photos/{theme}/
  - Library index at crete-projects/photos/library.json
- Security: no hardcoded credentials, input sanitised, R2 creds from env, auth required

---

## Session: Apr 17, 2026 — Trading Scanner Fixes

### Kalshi Parse Fix
- Root cause: Kalshi v2 API returns yes_bid in cents not dollars
- Fix: changed yes_bid_dollars to yes_bid / 100
- Result: 1,000 Kalshi markets now output correctly (was 1)
- Total markets scanned per run: ~1,600 (600 Polymarket + 1,000 Kalshi)

### NO Edge / Market Intelligence Tracking
- Added noEdge detection: markets where yes_price > 20% but 
  our sim is <30% of market price (overpriced markets)
- Has Edge? now triggers on highEdge OR noEdge
- Notify Edge sends market intelligence message when no YES edge
  but overpriced markets detected
- First detection: BTC "Will bitcoin hit $1m before GTA VI?" 
  (market YES=49%, our sim=0%) — significant NO edge

### Current Market Status
- Zero tradeable YES edge opportunities on Polymarket or Kalshi
- Only 1 matched market total: BTC $1M (overpriced)
- Infrastructure ready — will auto-trigger when commodity/crypto 
  price markets appear


---

## Session: Apr 11-17, 2026 -- Crete Projects Marketing Automation

### Crete Marketing Dashboard Tab (Apr 11)
- New "Crete Marketing" tab added to QClaw dashboard (ui.html, server.js)
- 7 API routes under /api/crete/content (list, get, create, edit, approve, reject, regenerate)
- Supabase table: crete_content_queue (RLS enabled, 3 indexes)
- Filter pills (Pending Review, Approved, Published, Rejected, All)
- Inline edit, approve/reject with notes, card grid layout
- Telegram notification on new pending_review via qclaw.channels
- Brand palette: Olive #5B6F3C, Sand #D4C5A9, Charcoal #2D2D2D, Cream #FAF8F4
- Commits: 296b265, f9a05f8

### n8n Workflows -- Content Pipeline (Apr 11-13)
- Crete - Content Generator (tnvXFYvODL1PrhJa): daily 08:00 UTC cron, fetches R2 calendar, generates content via Claude API, inserts to Supabase
- Crete - Content Publish (zXKBjp3yjW2oR2Mj): webhook, routes by platform to Facebook Graph API, Instagram Graph API (two-step), LinkedIn via Blotato, updates status
- Crete - Content Regenerate (KKjw893zwzHwv1o6): webhook, appends reviewer notes to prompt, regenerates via Claude API, resets to pending_review
- Content calendar stored in R2 at crete-projects/content-calendar.json (v1.2)
- LinkedIn scheduled Tue/Thu only to avoid collision with Flow OS Mon/Wed/Fri posts

### Charlie Skill: crete-marketing (Apr 11)
- New skill file at src/agents/skills/crete-marketing.md
- Charlie can now check crete_content_queue for pending items and report status

### Brand Assets (Apr 16)
- CP monogram logo with olive branch (SVG + PNG on R2)
- Stacked wordmark "Crete / PROJECTS" (SVG + PNG on R2)
- Facebook banner "Land. Village. Wellness." (SVG + PNG on R2)
- Fonts: Cormorant Garamond + DM Sans installed on qclaw at /usr/share/fonts/truetype/custom/
- Assets on R2 at crete-projects/brand/

### Facebook & Instagram Pages (Apr 16)
- Facebook Page: Crete Projects (username: creteprojects.gr, Page ID: 1151574668028295)
- Instagram Business: @creteprojects (ID: 17841427777246522)
- Linked via Meta Business Suite
- Long-lived Page Access Token stored in n8n env (META_PAGE_ACCESS_TOKEN) and qclaw env

### Instagram Image Generation System (Apr 17)
- Text card generator: src/crete-marketing/generate-text-card.js (node-canvas, 1080x1080 branded PNGs)
- Two styles: quote (centred) and editorial (left-aligned headline + body)
- API endpoint: POST /api/crete/generate-image (auth-protected, rate-limited)
- Stock photo library: 22 Unsplash photos across 4 themes (agriculture, village, wellness, lifestyle)
- Photo library index: crete-projects/photos/library.json on R2
- Generated images stored at crete-projects/images/{uuid}.png on R2
- n8n Content Generator updated with Image Router, Generate Text Card, Merge Image URL nodes
- Dashboard updated to display images in content cards
- Commit: d31fc1a

### LinkedIn Auto-Publish via Blotato (Apr 17)
- Crete - Content Publish workflow updated with LinkedIn routing
- Uses Blotato account 11109 (Tyson Venables personal profile)
- Text-only LinkedIn posts, no image
- Tested end-to-end: Blotato submission confirmed

### GHL Email Sequences (Apr 11)
- 5-email EOI nurture sequence (Emails 3-7) built in GHL
- Trigger: tag eoi-pdf-sent, timing: Days 3, 7, 11, 16, 21
- From: hello@creteprojects.com
- Existing leads enrolled
- FB retarget audience workflow added by Tyson

### Supabase Schema Changes
- crete_content_queue table created (migration: create_crete_content_queue)
- Columns added: image_type, image_style, image_theme (migration: add_image_columns_to_crete_content_queue)

### Security Notes
- Meta Page Access Token stored in env only (n8n + qclaw), never hardcoded
- QCLAW_API_TOKEN for n8n to qclaw image API auth
- All new routes protected by existing dashboard JWT auth middleware
- XSS: creteEsc() applied to all user-controlled content in dashboard
- GitHub PAT in git remote URL flagged for rotation (not changed)

### Bug Fixes (Apr 22)
- Content Generator: stock photo selection now implemented (was previously stubbed as "future feature")
- Content Generator: Select Random Photo node reads row from Image Router, not Fetch Photo Library response
- Dashboard: approve handler checks scheduled_for date — future-dated approvals sit at "approved" without triggering publish
- New workflow: Crete - Scheduled Publisher (9kTWhh9PlxMpyMlp) — hourly cron picks up approved content when scheduled_for <= now
- Photo library themes aligned: agriculture/village/wellness/lifestyle (was Land Sourcing/Village Restoration/Health & Wellness/Crete General)

## Session: Apr 17, 2026 — Final cleanup

### Dashboard R2 Multipart Upload (commits 9b1e80f, 047f559)
- Files >50MB use chunked multipart upload via S3 API
- Files <=50MB use existing FormData upload
- Progress bar with percentage + part counter
- Chunks sent as raw binary (no base64 overhead)
- Endpoints: /api/upload/initiate, /api/upload/part, /api/upload/complete
- All auth-protected with rate limiting

### Dashboard Session Secret Fixed (047f559)
- Added dotenv loader at DashboardServer.start()
- DASHBOARD_SESSION_SECRET now persists across PM2 restarts
- tunnelUrl set to https://agentboardroom.flowos.tech in config.json

### All active backlog items cleared
- spawn_agent fixed (5b12cee)
- Flow OS ad account added (d490788)
- Playwright MCP installed (d490788)
- Kalshi parse fix — yes_bid/100 (cents not dollars)
- NO edge market intelligence tracking added
- receive-and-upload.sh r2FileKey quoting bug fixed (83b92a4)
- Morning Light WL checked — healthy, token fresh

### Pending
- Upstream full merge: bcdb1a5 (delegate_to), bb717d4 (metrics/leaderboard)
- n8n root SSH disable (parked — DO console broken)
- YouTube auto-publish (carparked — wait for Emma)

## Session: Apr 20, 2026 — Security Audit + Charlie Recovery

### Charlie Recovery
- Root cause: Anthropic credits exhausted Apr 18 — all LLM calls failing
- Added credits exhaustion handler in executor.js — 6h cooldown 
  Telegram notification instead of silent crash (cc7f37e)
- Added heartbeat.js graceful degradation for credits errors
- Fixed Charlie 401 on trading API — dashboard token updated in config
- GitHub PAT rotated and updated in git remote

### Vercel Security Audit (Vercel breach response)
- Reviewed all 12 Vercel projects
- gohighlevel_mcp: token rotated
- fit-quiz-results: new scoped GHL JWT created
- n8n-dashboard: n8n API key rotated to v2
- flowos-ai-va, venables-finances, codesprout, triple-a-tracker: no keys
- wellness-oauth: dormant, kept for reuse
- wellness-oauth-fresh: kept as reusable WL OAuth connector for future clients

### GHL Token Refresh Security Fix
- Found hardcoded client_id, client_secret in HighLevel OAuth 
  Token Refresh workflows
- Moved credentials to n8n env vars (HL_LOCATION1_CLIENT_ID/SECRET)
- Primary workflow (N3VF1VKlekDdhxGU): cleaned + left inactive (deprecated)
- Sister workflow (02Dob9FCEkXZFDAs): fixed + stays active
- Verified live execution — tokens refreshing correctly in Supabase

### Pending
- wellness-oauth-fresh: consider rebuilding as proper 
  Flow OS GHL OAuth connector (documented, multi-tenant)
- Upstream full merge: bcdb1a5 (delegate_to), bb717d4 (metrics)
- Social media automation for SproutCode, Flow OS, FSC (parked)

---

## Session: Apr 20, 2026 — Full Day Build

### Charlie Recovery (Anthropic credits exhaustion)
- Root cause: Anthropic credits exhausted Apr 18–20 — all LLM calls failing
- Added credits exhaustion handler in executor.js (commit cc7f37e)
  - 6-hour cooldown Telegram notification instead of silent crash
  - Tagged error code `ANTHROPIC_CREDITS_EXHAUSTED` for downstream handling
- Added heartbeat.js graceful degradation for credits errors
- Charlie restored after credits top-up

### Dashboard Trading API 401 Fix
- Dashboard auth token updated in Charlie config
- New token: `<rotated — stored in ~/.quantumclaw/.env>`

### GitHub PAT Rotated
- Previous PAT expired, blocking git push from qclaw
- New PAT rotated and updated in git remote URL
- Flagged for future: move from plaintext URL to SSH auth or credential helper

### Vercel Security Audit (Vercel breach response)
Reviewed all 12 Vercel projects after Vercel security incident notification:
- gohighlevel_mcp: token rotated
- fit-quiz-results: new scoped GHL JWT created (fit-quiz labeled)
- n8n-dashboard: n8n API key rotated to v2 query key
- flowos-ai-va, venables-finances, codesprout, triple-a-tracker: no API keys
- wellness-oauth: dormant, kept for reuse
- wellness-oauth-fresh: kept as reusable WL OAuth connector for future clients
- portfolio, crete-eoi, 1-ceo-dashboard: static/low risk

### GHL Token Refresh Credentials Hardened
- Found hardcoded client_id + client_secret in 2 n8n workflows
- Moved credentials to n8n env vars (HL_LOCATION1_CLIENT_ID/SECRET)
- Primary workflow (N3VF1VKlekDdhxGU): cleaned + left inactive (deprecated duplicate)
- Sister workflow (02Dob9FCEkXZFDAs): fixed + remains active
- Verified live execution — tokens refreshing correctly in Supabase

### Charlie n8n Diagnosis — Permanent Fix (commit db6bc9c)
Permanently solved Charlie's recurring "I don't have access to that workflow" issue:
- Replaced static hardcoded workflow registry with dynamic n8n API queries
- charlie-cto.md skill: added n8n Diagnostics section with live-query recipes
- trading.md: removed static workflow ID list
- New `/diagnose <workflow_id_or_name>` Telegram command
  - Charlie auto-queries n8n for any workflow, live
  - Claude Code executes the diagnosis and reports findings to Telegram
  - E2E verified with `44g7cbGz5osQ1pcBVhIoz` — found Instagram media_publish 500 issue
- Self-serve: new workflows automatically discoverable, no manual updates needed

### Instagram Reels Workflow Status
- Charlie's diagnosis flagged Instagram media_publish 500 on Apr 16 (transient)
- Real current issue: post 271 missing from R2 (now uploaded by Tyson)
- Workflow should resume on next scheduled cron run
- Retry/wait fix parked until next failure confirms it's needed

### Pending
- wellness-oauth-fresh: consider rebuilding as proper Flow OS GHL OAuth connector
  (documented, multi-tenant, safe for future clients)
- Upstream full merge: bcdb1a5 (delegate_to), bb717d4 (metrics/leaderboard)
- Social media automation for SproutCode, Flow OS, FSC
  (awaiting brand kits + content topics from Tyson)
- Enhance `/diagnose` to also check Slack #n8n-error for recent messages
  (would have caught R2 404 pattern faster)
- Move GitHub PAT from plaintext git remote URL to SSH auth

### Parked
- n8n root SSH disable (DO console broken, too risky)
- YouTube auto-publish (carparked — wait for Emma to test pipeline)

---

## Session: Apr 21, 2026 — Charlie Architecture Fix

### Split-Brain Skill Loading — RESOLVED (commit e47767d)
Diagnosed via /diagnose task path still working while interactive Charlie
path kept claiming "tools hardcoded to Market Scanner". Root cause was a
fundamental architecture split:
- Task queue path loads skills from git repo via symlinked charlie-cto.md
- Interactive path loads skills from /root/.quantumclaw/workspace/agents/charlie/skills/
  which had its own stale copies

### Skills Dir Fully Symlinked
- All 11 skill files now symlinked from workspace → /root/QClaw/src/agents/skills/
- Moved to repo + symlinked: ads-agency.md, agent-coordination.md,
  business-intelligence.md, ghl.md, n8n-router.md, qclaw-dev.md,
  stripe.md, trading-api.md
- content-studio.md existed in both, workspace version won (overwrote repo)
- n8n-api.md rewritten from scratch
- charlie-cto.md was already symlinked from yesterday
- Backup: /root/.quantumclaw/workspace/agents/charlie/skills.backup-1776770419
- End state: any git repo skill edit is instantly live in runtime

### n8n Tools Fully Parameterised
New tool surface (no workflow IDs baked into names):
- get_workflows (list all)
- get_workflows_id (get details by id)
- get_executions_id
- get_executions_workflowid_id
- get_executions_workflowid_id_status_id
Base URL: https://webhook.flowos.tech/api/v1 (was localhost:5678 — wrong host)

### Generic Skill Executor Bug Fixed
Found during restart testing — registry.js:1127 only substituted
{{secrets.*}} placeholders, appending all other args as query string.
Result: get_workflows_id with {id: "X"} hit /workflows/{{id}}?id=X (400 error).
Fix: added pass to substitute {{k}} → args[k] and track consumed args
to prevent double-append.

### spawn_agent Approval Gate Auto-approved (commit b537573)
Diagnosed: spawn_agent was dying after 10-minute silent timeouts.
Root cause was NOT the gated-tool list — it was the approval-gate
keyword scan tripping on role descriptions containing words like
'send', 'publish', 'post'. Every sub-agent spawn needing these
words expired without approval.

Fix: added autoApproveTools list in src/security/approval-gate.js,
seeded with spawn_agent. Short-circuits check() before the keyword
scan. Debug logging via log.debug for traceability.

Guardrails retained:
- Credential scoping (AGEX envelopes with 1h TTL)
- Audit log on every spawn
- Rate limits (api_calls 200/hour)
- Trust tier inheritance (sub-agents can't elevate past Tier 0)

### Interactive Test Confirmed
Telegram query: "What's the status of workflow 44g7cbGz5osQ1pcBVhIoz"
Charlie now uses dynamic tools, returns full node-by-node breakdown,
no more "I don't have access" responses. ~17s end-to-end for
sub-agent spawning tasks.

### Pending
- wellness-oauth-fresh: rebuild as proper Flow OS GHL OAuth connector
- Upstream full merge: bcdb1a5 (delegate_to), bb717d4 (metrics/leaderboard)
- Social media automation for SproutCode, Flow OS, FSC
- Enhance /diagnose to also check Slack #n8n-error channel
- Move GitHub PAT from plaintext git remote URL to SSH auth

## 2026-04-21 — GHL Marketing Automation System

### What was built
- Full marketing automation for GHL Support Specialist (support.flowos.tech/ghl/landing)
- Skill file: `ghl-marketing.md` deployed to `/root/QClaw/src/agents/skills/`
- Supabase table: `marketing_drafts` with RLS, publish tracking columns, partial index
- 4 n8n workflows:
  - Content Generator (Awo65rdSe5BvDHtC) — Mon/Wed/Fri 07:00 UTC, Claude Sonnet, auto-assigns branded template images
  - Approval Handler (ptHK2TZq5XppKOOg) — Telegram fallback + dashboard regenerate webhook
  - Publisher (fonuRTyqepxdyIdf) — Posts to Facebook (Flow OS page), Instagram (Flow OS IG), LinkedIn (Blotato/Tyson) with branded images
  - Scheduled Publisher (dHceOMijUOcnEowO) — 15-min cron, picks up approved drafts when scheduled_for <= now
  - Weekly Report (jRiiOsWneQAtfVPD) — Sunday 20:00 UTC performance summary
- Dashboard: GHL Marketing tab with Content Review Queue (Pending/Approved/Published/Rejected), Schedule/Post Now/Custom Time actions, template thumbnails
- 4 branded post templates uploaded to R2 (pain-led, value-led, offer-led, story) with auto-rotation by post type
- Calendar guardrails: max 1 post/day, LinkedIn 4-hour spacing, MWF auto-scheduling

### Landing page conversion fixes
- Hero headline/CTA updated (removed Flow OS branding for /ghl/landing route)
- Server-side meta tag rewrite for social crawlers (og:title, og:image, og:url, twitter tags)
- Added: trust bar, "How it works" section, FAQ accordion (6 questions), value comparison, Founders Offer pill in hero
- Cache-busting headers for /ghl/landing (Cloudflare-CDN-Cache-Control: no-store)

### Paid ads
- Meta Pixel verified (927054375981982): PageView, Lead, InitiateCheckout, Purchase
- 3 Canva ad creatives (primary feed, vertical story, retargeting)
- Campaign structure: Conversion + Retargeting + Awareness
- Custom audiences and automated rules created in Meta Ads Manager
- Facebook Sharing Debugger verified with correct OG tags

### Cleanup
- Removed all Manus references from codebase (-1263 LOC, 9 files deleted, 7 edited)
- Tightened CSP headers (removed manus.im, manus.computer from connect-src)
- Weekly admin digest notification migrated from Manus to Telegram

### Commits (ghl-support-bot repo, Railway auto-deploy)
- b9ece5c — GHL landing SEO copy + CTA
- 92fb14a — SSR meta rewrite (initial)
- 8c5225c — Conversion polish (trust bar, FAQ, how-it-works, value line)
- 4875606 — Manus cleanup
- 05ab3ef — SSR root cause fix (req.originalUrl) + cache headers
- 8889596 — GHL default image URL fix
- b747c36 — Publisher + scheduled posting + dashboard actions
- c6d56bf — Template images to R2 + image rotation in Content Generator

### Commits (QClaw repo)
- ghl-marketing.md skill file
- n8n workflow backups (4 files)
- Dashboard GHL Marketing tab (server.js + ui.html)

### Security gate: PASSED
- No hardcoded credentials
- Supabase RLS enabled
- Telegram handler restricted to Tyson's chat ID
- All API keys via n8n credentials or env files
- Webhook endpoints authenticated
- All workflow JSONs backed up

---

## Session: Apr 22, 2026 — Charlie Phase 1 Session 1 (execution tools)

### Problem solved
Charlie's interactive path had no execution tools — every "do X" request
ended with Charlie dumping shell commands for Tyson to paste. Pure
diagnostic agent, no action capability.

### shell_exec tool (src/tools/shell-exec.js)
- qclaw-local command execution (quantumclaw PM2 runs as root)
- Three safety tiers:
  1. DENY_PATTERNS — hard-block, no approval path. Covers cat of .env /
     .secrets / .ssh, pipe-to-shell (curl | sh), base64 exfil, source
     .env, eval, echo .env, any write into .quantumclaw secrets files.
  2. DESTRUCTIVE_PATTERNS — inline Telegram approval. Covers rm -rf,
     sudo, kill, pm2 stop/delete/kill, systemctl stop/disable/mask,
     chmod/chown on root paths, git force-push / hard-reset, docker
     compose down, dd if=, redirects and tee writing outside /tmp
     (both > and >>, including relative-path file creation).
  3. /root/.quantumclaw touches — require approval even for reads, so
     secrets-directory activity is surfaced.
- pm2 restart / reload are NOT gated (recovery ops).
- 60s default timeout, max 300s, SIGKILL on timeout.
- Audit log per call: command, exit code, duration_ms, approved_inline
  flag, stdout/stderr truncated to 500 chars.

### n8n_workflow_update tool (src/tools/n8n-workflow-update.js)
- Full GET → modify → PUT → re-activate cycle for
  webhook.flowos.tech/api/v1 workflows.
- Always requires inline approval (writes are high-risk).
- Strips n8n read-only fields before PUT (updatedAt, createdAt, id,
  shared, tags, versionId family, isArchived, meta, pinData,
  staticData, description, active).
- Preserves settings.availableInMCP so the MCP surface stays enabled.
- Re-activates the workflow if it was active before the edit.
- Accepts either `{ patch: {...} }` for shallow root merges or
  `{ node_updates: [{node_name, parameter_path, new_value}] }` for
  targeted edits. parameter_path supports dot + [N] notation.

### Inline Telegram approval (no poller conflict)
Telegram's single-consumer getUpdates rule meant the original spec
(parallel poller) would have collided with the existing grammy bot.
Redesign:
- ApprovalGate.requestInlineApproval() reuses the existing
  ExecApprovals promise system. ExecApprovals gained createPending()
  which returns {id, promise} synchronously so the id can be embedded
  in the Telegram prompt.
- index.js wires a notifier that DMs the owner chat at boot — the
  bot reference is resolved at call time via
  channels._channelsByName.get('telegram').bot so the notifier
  survives ChannelManager reinit.
- channels/manager.js got:
  - a new /deny command
  - an inline reply handler that recognises "✅ {id}", "❌ {id}",
    "approve {id}", "deny {id}", "yes {id}", "no {id}" from the
    owner chat
- ExecApprovals.approve()/deny() resolve the pending promise →
  shell_exec / n8n_workflow_update continue.
- 10-minute auto-deny still provided by ExecApprovals.
- Executor got a longRunning tool flag — tools with longRunning:true
  use an 11-minute ceiling instead of the default 30s TOOL_TIMEOUT so
  approval waits don't trip the tool-level timeout.

### Threat model note
shell_exec exposes root code execution to Charlie's LLM. Mitigations:
DENY_PATTERNS hard-block exfiltration vectors; DESTRUCTIVE_PATTERNS
require Telegram approval; /root/.quantumclaw touches require
approval; every call audit-logged with stdout/stderr truncation.
Blast radius is still larger than pre-Phase-1; accepted trade-off for
operational velocity.

### Anti-pattern documentation
charlie-cto.md gained an Execution Tools section with explicit
"NEVER tell Tyson to paste commands" guidance. SSH to the n8n server
is still unavailable — Phase 1 Session 2 will add ssh_exec; until
then any task needing n8n-server shell access is routed via the task
queue (`/diagnose`-style) rather than dumping SSH commands on Tyson.

### Verified this session
- Safe-path shell_exec: "pm2 status" — executes without approval,
  returns parsed table.
- DENY hard-block: "cat /root/.quantumclaw/.env | head -3" — refused
  outright with pattern_matched reason.
- Approval path: "ls /root/.quantumclaw/workspace/agents/charlie/skills/"
  — creates pending approval, Telegram notifier sends the prompt
  cleanly to the owner chat, Charlie waits for ✅ / ❌ reply. Final
  owner-tap still required to verify resolve-on-reply path end-to-end.

### Known follow-ups
- SSH ops (ssh_exec) — Phase 1 Session 2
- file_edit_remote — Phase 1 Session 2
- Consider surfacing pending approvals on the dashboard as well as
  Telegram (currently only CLI + Telegram).

---

## 2026-04-22 — Skill file path corrections + approval gate fix

Charlie flagged that skill files carried Mac-local paths (`~/QClaw`)
and BSD sed syntax (`sed -i ''`) that doesn't work on Linux. Also
identified that edit attempts were timing out at the approval gate.

### Diagnosis (approval gate)
Charlie's symlink-vs-realpath hypothesis was wrong — `approval-gate.js`
had no `/root/.quantumclaw` path check at all, so no path-normalization
fix applied. The actual block came from two places:
- **Generic keyword scan** in `ApprovalGate.check()` that ran
  `JSON.stringify(args).includes(keyword)` against the blob, so any
  sed script or file content containing "truncate", "delete", "remove"
  etc. falsely triggered approval (e.g. approvals 18/19/20 on
  knowledge.js edits where "truncate" appeared inside a comment).
- **Gated fs tools** covering all `filesystem__*` operations
  unconditionally, so skill-file edits under
  `/root/QClaw/src/agents/skills/` required Telegram approval even
  though that directory exists for agent self-service.

10-minute timeout in `approvals.js:66` is intentional; not changed.
`tools/shell-exec.js` was already fine (regex-anchored DESTRUCTIVE
patterns, properly verb-scoped) and was not modified.

### Fixed
- All `~/QClaw` references in skill files → `/root/QClaw` absolute
  (14 hits in `qclaw-dev.md`, 1 in `build.md`).
- `sed -i ''` (BSD) → `sed -i` (GNU) in `qclaw-dev.md`.
- Added environment-clarifying header comment to `qclaw-dev.md`
  (target ssh qclaw, user root, absolute paths, GNU tools).
- Rewrote `ApprovalGate.check()`:
  - Removed the `gatedKeywords` JSON.stringify scan entirely.
  - Added `SKILL_EDIT_ALLOWLIST = '/root/QClaw/src/agents/skills/'`
    with `path.resolve()` + `startsWith()` — narrow prefix match that
    rejects `skills-evil/` lookalikes and `../` traversal attempts.
    Checks structured fields (`path`, `destination`, `cwd`) only;
    does not scan free-text command bodies.
  - Added verb-scoped `DESTRUCTIVE_PATTERNS` (rm, kill, killall,
    shutdown, reboot, dd, pm2 stop, pm2 delete, pm2 restart) matched
    against the first token (or first two for two-word patterns) of
    shell commands only. Leading `sudo ` is stripped before matching
    so `sudo rm -rf` still parses as `rm`.
  - Decision order puts destructive check BEFORE allowlist, so a
    destructive verb targeting a skill file still requires approval.
  - Stripe special-case tightened to inspect `args.action/operation/
    type === 'charge'` instead of `JSON.stringify(args).includes('charge')`.

### Test matrix (11/11 pass)
1. Sed edit in skill dir (via cwd) → no prompt (allowlist hit)
1b. Fs edit via `path` field under skill dir → no prompt
2. Sed with "truncate" in script body on non-skill file → no prompt
3. `rm -rf /something` → prompt fires
3b. `sudo rm -rf /something` → prompt fires (sudo prefix stripped)
4. `pm2 stop charlie-watcher` → prompt fires
4b. `pm2 status` → no prompt (not destructive)
5. Write to `/root/QClaw/src/someotherdir/` → prompt fires (gated)
5b. `rm` on a skill file STILL fires (destructive beats allowlist)
5c. `/root/QClaw/src/agents/skills-evil/` lookalike → prompt fires
5d. `../skills-evil/` traversal normalized → prompt fires

### Impact
Charlie can now update his own skill files directly, and make legitimate
code edits containing incidentally-destructive words without Tyson
needing to tap through Telegram approvals. Genuine destructive ops
(rm, kill, pm2 stop, etc.) and writes outside the skill directory are
still gated.

### Open follow-ups
- `tools/shell-exec.js` still gates on sudo-prefix (`\bsudo\b` in
  DESTRUCTIVE_PATTERNS), which fires correctly but could be noisy.
  Deferred.
- GitHub PAT embedded in `/root/QClaw` origin URL — visible in
  `git remote -v`. Separate rotation task if not already tracked.

---

## 2026-04-27 — Approval gate: orphan-callback safety

Small defensive change to `ExecApprovals.approve/deny`. On process restart
the in-memory `pendingCallbacks` Map empties; previously the SQL row update
ran but the resolution call site silently no-op'd. Now:
- Read the row first; throw `Error('not found')` for nonexistent ids.
- Return `{alreadyResolved:true,status}` for rows already approved/denied
  (instead of running a second UPDATE that does nothing because of the
  `WHERE status='pending'` clause — same outcome, but the call site now
  knows what happened).
- When `pendingCallbacks.get(id)` is empty, log a warning instead of
  silently dropping the resolution. Row still updates correctly.

The original requester's Promise stays unresolved on the orphan path
— a full DB-backed callback queue is a larger architectural change,
out of scope for this PR.

### Origin of this PR — and what it isn't

Started as a fix for "approval gate timing out every approval since
2026-04-22" after I diagnosed the bug as a missing emoji parser. That
diagnosis was wrong — `b08d64b` (2026-04-21) already added the
`/^([✅❌]|approve|deny|yes|no)\s*#?(\d+)\s*(.*)$/i` parser inside
`bot.on('message:text')`, line 263 of channels/manager.js. The parser
works correctly (verified against the diagnostic input matrix).

The actual headline bug is **handler concurrency**: `bot.on('message:text')`
runs `await agent.process(text)` synchronously, which blocks grammY's
update loop. When Charlie's chat handler stalls (Cognee reconnect storms,
slow tool calls, etc.) the user's emoji-reply sits undelivered until the
previous chat completes — by which time the 10-minute timeout has already
denied the row. Production logs for [37] show a 13-minute silence between
the previous chat completion (09:41:16) and the next (09:54:17), with the
[37] timeout firing at 09:54:13 inside that gap.

`pm2 logs quantumclaw --lines 5000` confirms exactly **1 successful
approval** (`[7] granted by telegram:tysonven via inline reply` at
21:23:34) against ~49 timeouts — consistent with messages occasionally
arriving while the chat handler is between calls.

Headline-bug fix (extract `approvalReply` to a `bot.hears()` registered
before `bot.on('message:text')`, or fire-and-forget the agent call) is
tracked separately. This PR only ships the small defensive change; the
gate will still time out approvals until the concurrency fix lands.

### Changes
- `src/security/approvals.js` — orphan-callback safety + return shape.
- `tests/approvals.test.js` — 13 cases (happy path, already-resolved,
  not-found, orphan-callback for both approve and deny). JSON fallback
  path so no SQLite dep.

### Test results
- `node tests/approvals.test.js` → 13/13 pass
- `node tests/smoke.test.js` → 21/22 (pre-existing local `jsonwebtoken`
  module-not-found, unrelated)

### Deferred to other sessions
- Real headline fix: handler concurrency / approval reply pre-empting
  long chat handler.
- Cognee reconnect storms (probable amplifier of the concurrency bug).
- QClaw on `qclaw` is under root's PM2 (not raw node — diagnostic
  correction). `flowos` user has its own empty PM2 instance, which is
  what threw me earlier.
- `charlie-watcher` PM2 entry exists (id 4, runs
  `bash src/agents/task-watcher.sh`) — name is real, role is task-queue
  watching, not Telegram listening.
- `/root/QClaw` has 1 unpushed commit (`26fe992`) and 3 WIP files
  (`monte_carlo.py`, `n8n-api.md`, `yarn.lock`) — Pillar 7 drift, parked.
- Local Mac PM2 zombie entry `quantumclaw` (PID 1381) — `pm2 delete`
  on the Mac.
- Plaintext credentials in local `~/.quantumclaw/config.json`
  (`dashboard.authToken`, `dashboard.pin`, `dashboard.tunnelToken`).

---

## 2026-04-27 — Flow OS Intake System: Kylie content build

First module of a reusable Flow States Collective (FSC) client intake
system. Static intake form on Vercel POSTs to a public n8n webhook, which
emails Tyson via GHL, syncs the submitter to GHL as a contact with a
note, and falls back to Telegram if GHL sync fails.

### Architecture
- Webhook: `POST https://webhook.flowos.tech/webhook/intake-kylie`,
  CORS restricted to `https://intake.flowstatescollective.com`
- Honeypot: `body.rawData.website` non-empty short-circuits to silent 200
  before any GHL call (no contact, no email, no log noise)
- Rate limit: per-IP 3 hits / 60s window via `getWorkflowStaticData`,
  4th and beyond return 429 (no body) without any GHL or email work
- Format: builds markdown note body and HTML email body from
  `responses[]`; HTML escape everywhere
- GHL email: POST `/conversations/messages` (type=Email) to a fixed
  internal notify contact, same pattern as `GHL Changelog Emails`
- GHL sync: `/contacts/search/duplicate` then either add note to existing
  or create contact (tags `intake-completed`, `kylie-content-build`,
  `fsc-client`, source `intake.flowstatescollective.com`) and add note
- Error fallback: any non-2xx from a GHL node fires a Telegram alert to
  chat `1375806243` so we know GHL sync broke even though the form still
  got a 200

### What got created
- n8n workflow `intake-kylie-content-system` (id `qOwJhClx5BnOeycf`,
  active, `availableInMCP: false`, 17 nodes)
- JSON backup committed at
  `n8n-workflows/intake-kylie-content-system.json`
- New `.env` keys in `~/.quantumclaw/.env` (perms tightened from 644 to
  600 in this session): `GHL_FSC_LOCATION_ID`, `GHL_FSC_USER_ID`,
  `GHL_FSC_NOTIFY_CONTACT_ID`, `NOTIFY_EMAIL`. The qclaw `.env` is the
  source of truth; the values are also referenced in the workflow.

### Credential decisions
- Reused existing n8n credential `FSC GHL pit` (id `TK2wBgy9ZtKLf8UG`,
  httpHeaderAuth) for all GHL HTTP nodes. The brief had asked for a new
  `GHL Flow States Collective PIT`; on inspection the live credential
  was already named `FSC GHL pit` and scoped to the FSC location,
  so creating a duplicate would have been churn.
- The four FSC `.env` values above (locationId, userId, notify
  contactId, notify email) are NOT secrets, just public IDs and an
  email. n8n on its host (157.230.216.158) does not currently load
  the qclaw `.env`, and adding them to the n8n container env would
  require a Docker restart that would interrupt active production
  workflows. Compromise: hardcode the four IDs in the workflow JSON
  and document in this entry. The PIT (the only real secret) stays in
  the n8n credential vault. Future improvement: migrate n8n to an
  `env_file` and consolidate.
- Also bootstrapped `tyson@flowstatescollective.com` as an FSC GHL
  contact for the operator-notify path (already existed: id
  `SbPJpeihuGK3RT6bspyq`). GHL conversations API requires a contactId
  to send email; that contact is the recipient.

### Tests run
1. Happy path: `{success:true}` 200, contact created, note added,
   email queued via GHL conversations
2. Honeypot: filled `rawData.website` returns 200 silent, only
   3 nodes execute (no GHL, no email)
3. CORS: server returns fixed
   `Access-Control-Allow-Origin: https://intake.flowstatescollective.com`
   regardless of request origin, so non-allowed origins are rejected
   client-side
4. Rate limit: submissions 1-3 within 60s succeed with full GHL flow,
   4th+ returns HTTP 429 with no body and skips GHL entirely

7 test contacts deleted from FSC GHL after testing.

### Security gate
- [x] No hardcoded secrets in the workflow JSON. The PIT lives only in
      the n8n credential vault. The four FSC IDs are public, not secret.
- [x] `~/.quantumclaw/.env` permissions are 600 (was 644 before this
      session, fixed)
- [x] Webhook CORS restricted to `https://intake.flowstatescollective.com`
- [x] Honeypot routes filled-honeypot submissions to silent 200 with no
      GHL/email side effects
- [x] Rate limit caps at 3/60s per IP, returns 429 silently
- [x] Workflow `availableInMCP: false` (public webhook, not for agent use)
- [x] Activated only after all 4 tests passed

### 7 Pillars
1. Frontend — form is on Vercel; handled in form-build session, not here
2. Backend — n8n workflow validates honeypot first, rate-limits, then
   processes. All HTTP nodes have `neverError: True`/
   `onError: continueRegularOutput` so a single GHL failure cannot crash
   the request path
3. Databases — n/a (no DB writes; static data is workflow-scoped)
4. Authentication — webhook is intentionally public (form endpoint);
   protection is honeypot + rate limit + CORS at the n8n layer; GHL PIT
   in n8n credential vault
5. Payments — n/a
6. Security — no hardcoded credentials, CORS restricted, rate limit in
   place, `.env` perms 600
7. Infrastructure — n8n workflow is JSON-backed in the repo; can be
   re-imported via the public API if the n8n host is reset

### Known limitations / deferred
- The four FSC `.env` keys live on qclaw but are not yet consumed by
  the n8n host; they're mirrored in `.env` for docs/source-of-truth and
  the actual values are inlined in the workflow JSON. The right long-
  term fix is to switch n8n's docker-compose to load an env_file and
  drop the inline values.
- The notify email path uses GHL's conversations endpoint and so the
  email comes from `tyson@flowstatescollective.com` to itself via the
  internal notify contact. Functional; if the brand voice eventually
  matters for these internal alerts we can switch to a dedicated
  transactional sender.
- Reusable intake module: this is workflow #1. The next intake (e.g.
  for a non-Kylie client) should clone this workflow, change the path
  (`/intake-<client>`), the tag set (drop `kylie-content-build`, add
  client-specific), and CORS origin if hosting at a different subdomain.

---

## 2026-04-27 — Session close: intake shipped, security pass, drift triage

End-of-session summary. The intake-kylie build entry above covers the
feature work. This entry covers the post-build hardening pass and a drift
triage list for next session.

### Recap
- **Kylie intake form**, FSC client #1 of the reusable intake module:
  built, deployed, tested (4/4 tests pass), JSON backup committed at
  `n8n-workflows/intake-kylie-content-system.json`. Live workflow id
  `qOwJhClx5BnOeycf`, webhook
  `https://webhook.flowos.tech/webhook/intake-kylie`. See the previous
  entry for architecture and decisions.
- **Security pass**: `~/.quantumclaw/.env` perms tightened from 644 to
  600. New FSC keys added (`GHL_FSC_LOCATION_ID`, `GHL_FSC_USER_ID`,
  `GHL_FSC_NOTIFY_CONTACT_ID`, `NOTIFY_EMAIL`). FSC PIT remains in the
  n8n credential vault only (`FSC GHL pit`, id `TK2wBgy9ZtKLf8UG`). Test
  contacts created during testing were deleted from FSC GHL.
- **charlie_n8n_key incident remediated**:
  - `git log --all --full-history -- charlie_n8n_key` confirmed the key
    was never committed (untracked only)
  - Moved from `/root/QClaw/charlie_n8n_key` to
    `/root/.ssh/charlie/charlie_n8n_key`, perms 600, owner root:root
  - Duplicate copy at `/home/flowos/charlie_n8n_key` shredded with
    `shred -u` after grep across `/root/QClaw/`, `/etc/`, `/home/flowos/`
    confirmed zero references
  - SSH from qclaw to n8n host (`n8nadmin@157.230.216.158`) verified
    working from the new path
  - `.gitignore` hardened with private-key patterns: `*.pem`, `*.key`,
    `*_key`, `*_rsa`, `*_ed25519`, `id_*`, `**/charlie_n8n_key`
- **Skill doc**: `src/agents/skills/ghl.md` gained a
  "Notification email pattern (out of GHL)" section so future-Charlie
  doesn't re-derive the contactId-required workaround.
- **Roadmap**: added `n8n env consolidation` as the first priority,
  flagged as a prerequisite for new client intakes (so we don't keep
  hardcoding location/user/contact IDs into each cloned workflow).

### Security gate (final)
- [x] No hardcoded secrets in workflow JSON or repo
- [x] No private keys in the repo or in git history
- [x] `.env` perms 600
- [x] Webhook CORS restricted, honeypot active, rate limit active
- [x] Workflow `availableInMCP: false` for the public intake webhook
- [x] All 4 functional tests pass; test data cleaned up

### Pre-existing drift (not touched this session, for separate triage)
Listed so next session can decide what to do with each:

- `src/agents/skills/n8n-api.md` — 1+/1- line. Trivial doc tweak adding
  `?limit=200` to a GET endpoint example. File last touched 2026-04-23,
  so this drifted somewhere in the last 4 days.
- `src/trading/monte_carlo.py` — 2+/0- lines. Last touched 2026-04-25.
  Has a sibling `.backup.1777144066` file from the same modtime,
  suggesting an automated edit pass.
- `yarn.lock` — 14+/1- lines, modtime 2026-04-27 12:42 UTC (today).
  Indicates a `yarn install` ran during this session window without a
  paired `package.json` change being staged. Worth confirming nothing
  got orphaned.
- Untracked: `scripts/migrate-r2.mjs`, `scripts/update-library.mjs`,
  `src/crete-marketing/curate-photos.mjs` — all from Apr 17–23,
  pre-session WIP.
- Untracked backups: `src/agents/skills/n8n-api.md.backup.1776933191`,
  `src/trading/monte_carlo.py.backup.1777144066` — these will be
  swallowed by the existing `*.backup` gitignore pattern only if the
  automated tooling renames them; current names don't match the
  pattern. Either delete them or add `*.backup.[0-9]*` to gitignore.

### Commits this session (origin/main)
- `88aa45d docs: update build log [2026-04-27]` — Kylie intake build
- `7dc1820 security: gitignore private keys, move charlie_n8n_key out of repo`
- (this commit) — session close summary

origin/main HEAD before this commit: `7dc182051551b0e54c8b2f6c00c761ae3b6c77f2`.

## 2026-04-27 — GHL Marketing R2 migration + IG path hardening

Completed:
- Migrated marketing templates from emma-content-studio (PNG) to
  flowos-content (JPEG) for proper bucket separation
- Updated Publisher (fonuRTyqepxdyIdf): Patches A/B/C — image format
  guard in Prepare, IG Eligible IF gate, error precedence flip in
  Compute Final
- Updated Content Generator (Awo65rdSe5BvDHtC): literal swap to new
  R2 prefix + .jpg extension
- Set GHL_DEFAULT_IMAGE_URL env var on n8n droplet
- Re-enabled availableInMCP=true on both workflows post-PUT (verified
  by re-GET)
- Refreshed JSON dumps in n8n-workflows/
- Supabase migration: zero rows in active statuses (no-op as expected)

Verified working:
- Publisher smoke test surfaced TRUE upstream Meta error
  (9004/2207052) instead of misleading "creation_id required" —
  error precedence flip working as designed
- Content Generator dry-run produced draft with new R2 prefix + .jpg
- FB and LinkedIn publish paths functioning end-to-end

Pending (next session priorities):
1. IG fetch failure (Meta 9004/2207052) — likely IG-FB account
   linkage, IG-specific token scope decay, or IG fetcher edge issue
   with *.r2.dev. Quick diagnostics: /debug_token,
   /me/accounts?fields=instagram_business_account, swap to non-R2
   control image. Test draft 82294451 reserved for this.
2. LinkedIn 4h guard didn't fire despite 11:00 UTC LI post — verify
   published_platforms and published_at stamping on draft a78794b6.
3. Bind media.flowos.tech to flowos-content R2 — something else is
   currently on that hostname.
4. Audit src/dashboard/server.js upload destination — likely should
   move to flowos-content/ for same architectural reason
   marketing-templates moved.

Architecture decision: emma-content-studio holds Emma's
personal-brand and content-pipeline assets only. flowos-content holds
Flow OS marketing/brand/agent assets. Future Flow OS infra defaults
to flowos-content unless there's a specific reason otherwise.

### Security gate (this session)
- [x] No hardcoded credentials added (R2 dev URL is a public-read
      hostname; no keys in repo or workflow JSON)
- [x] `/root/.quantumclaw/.env` perms remain 600;
      `/home/n8nadmin/n8n-project/.env` perms remain 600
- [x] No new webhooks introduced — existing
      `webhook/ghl-marketing-publish` path unchanged
- [x] Supabase RLS unchanged — only data UPDATE/INSERT on existing
      `marketing_drafts` table; no schema changes
- [x] `availableInMCP: true` confirmed via re-GET on both Publisher
      (fonuRTyqepxdyIdf) and Content Generator (Awo65rdSe5BvDHtC)
- [x] No financial features touched
- [x] No stack traces or secrets in error messages exposed to
      Telegram (Compute Final emits `errors.{platform} = msg`,
      msg sourced from API `error.message` strings only)

### Reserved test artifacts
- Supabase `marketing_drafts` row `82294451-3adc-4852-8ab0-3cd285664b91`
  (status=partially_published, feedback tagged) — reserved for
  next-session IG fetch failure diagnosis. Do not delete.


## 2026-04-27 (afternoon) — IG path: pivot to Blotato

**Issue:** After morning's R2 migration, IG still failed with Meta 9004.

**Diagnosis:** Cloudflare-fronted URLs (both `pub-*.r2.dev` and
`media.flowos.tech`) are blocked by IG's fetcher. Confirmed via
controls — Wikipedia and GitHub raw both work, both Cloudflare URLs
fail. Bot Fight Mode off, no Workers Routes, no UA-based blocking.
Cause is in Cloudflare's edge security vs IG's fetcher specifically.

**Resolution:** Route IG via Blotato (account 27064, `flow_os_`).
Blotato uploads bytes to Meta directly, bypassing the Cloudflare
block. Already a dependency in this workflow for LinkedIn; Crete
workflow proves the IG path.

- **Removed**: `IG Eligible?`, `IG Create Container`, `IG Wait For Ready`,
  `IG Publish` (all 4 IG-direct nodes from morning's hardening)
- **Added**: `IG Post (Blotato)` — single node
- **Updated**: Compute Final IG block, Prepare (dropped
  `ig_eligible` flag)

**Net:** workflow simpler (4 IG nodes → 1), bypasses
Cloudflare-vs-Meta entirely.

**Deferred investigation:** Cloudflare-vs-Meta-fetcher block on
`media.flowos.tech`. Worth fixing eventually if we ever want direct
Graph API for IG, but Blotato is fine for now.

### Patch: Compute Final IG block (Blotato success detection)

**Bug:** Architect's spec checked `igB.id || igB.submissionId ||
igB.success || igB.status`, but Blotato actually returns
`postSubmissionId`. None matched, fell to error else-branch despite
IG having posted successfully. Row `c21b3192` was labeled
`partially_published` incorrectly.

**Fix:** Mirrored the LinkedIn pattern (`if (li && !li.error)`) which
was proven correct by the same execution. One-line semantics:
truthy node response without an error field = success.

**Lesson logged:** when adapting a known-working pattern, mirror it
rather than re-speccing from scratch.

**Manually corrected:** row `c21b3192-8fb9-4d34-a79d-155f7c5055a9`
`status → published`, `published_platforms → all three`,
`publish_errors → null`.

### Pending (next session priorities, updated)

1. ~~IG fetch failure~~ — **RESOLVED** via Blotato pivot
2. LinkedIn 4h guard didn't fire on draft `a78794b6` — verify
   `published_platforms` and `published_at` stamping logic
3. ~~Bind media.flowos.tech to flowos-content R2~~ — **DONE today**
4. Cloudflare-vs-Meta-fetcher diagnosis (deferred from above)
5. Audit `src/dashboard/server.js` upload destination — likely
   should move to `flowos-content/`
6. Clean up duplicate `FLOWOS_META_PAGE_ACCESS_TOKEN` line in
   `/home/n8nadmin/n8n-project/.env` (one empty, one populated —
   docker-compose takes the last but it's a latent bug)

### Reserved test artifacts

- Supabase `marketing_drafts` row
  `82294451-3adc-4852-8ab0-3cd285664b91` (morning smoke test, kept
  for Cloudflare-vs-Meta-fetcher diagnosis next session — see #4)
- Supabase `marketing_drafts` row
  `c21b3192-8fb9-4d34-a79d-155f7c5055a9` (afternoon Blotato smoke
  test, manually corrected to `published`)

### Security gate (this session)
- [x] No new credentials, webhooks, or financial features
- [x] availableInMCP === true verified post-PUT
- [x] Supabase update scoped to single row by primary key
- [x] No stack traces exposed via Telegram errors
---

## 2026-04-27 — Approval gate concurrency fix

Fixes the deterministic deadlock-by-origin documented in the prior audit:
when an approval was requested from inside a tool call inside
`bot.on('message:text')`'s `await agent.process(...)` chain, the user's
`✅ <id>` reply could not be processed because the same handler instance
that owns the reply parser was the one awaiting the approval Promise.
Production data: ~25 timeouts vs 1 success (`[7]`) over 5 days, with the
single success originating from a heartbeat task — i.e., outside the
chat handler's await chain.

### Changes

`src/channels/manager.js`
- New dependency `@grammyjs/runner@2.0.3`.
- Inline approval-reply branch removed from `bot.on('message:text')` and
  re-registered as a top-level `bot.hears(APPROVAL_REPLY_RE, …)` placed
  before `message:text`. Under the runner's concurrent middleware, emoji
  replies dispatch in parallel with any in-flight `agent.process()`.
- `bot.start({drop_pending_updates:true})` replaced with
  `run(bot, { runner: { fetch: { allowed_updates: ['message','callback_query'] } } })`.
  `drop_pending_updates` is still applied via the existing
  `deleteWebhook({drop_pending_updates:true})`.
- `stop()` now calls `_runner.stop()`.
- `handleApprovalReply` extracted as an exported function so it can be
  unit-tested without spinning up a real Bot. The `bot.hears` callback
  is a one-line wrapper.

`src/agents/registry.js`
- Concurrent dispatch would let two `agent.process()` calls for the
  same agent run in parallel — both reading the same history snapshot,
  running separate LLM calls, then writing interleaved turns. (Audit §3
  conversation-history hazard.)
- Added a module-level mutex (Map<agentName, Promise>) and a
  `_withAgentLock(name, fn)` helper. Reflex-tier responses skip the lock
  (no history I/O). Everything from `graphQuery` through the second
  `addMessage` is held under the lock, restoring the same serialization
  grammY's default sequential middleware used to provide.
- Body extracted to `_processNonReflex(message, context, route, textMessage)`
  so the lock wrap doesn't reindent ~165 lines. No logic change.
- Mutex exported as `__agentLockForTests` for the concurrency test only.

The existing `/approve <id>` and `/deny <id>` slash commands are
untouched. All other handlers (audited as concurrency-safe) are now
running through the runner.

### Tests

- `node tests/smoke.test.js` → 22/22
- `node tests/approvals.test.js` → 13/13 (added `process.exit(failed?1:0)`
  so it doesn't hang on armed 10-min timeouts)
- `node tests/approval-parser-handler.test.js` → **29/29** new — full
  regex input matrix plus handler behaviour (authorized success,
  already-resolved, unauthorized silent ignore, nonexistent id, deny
  aliases, deny-with-tail-as-reason)
- `node tests/agent-mutex.test.js` → **7/7** new — same-key
  serialization, history consistency under concurrency, different-key
  parallel execution, lock release on throw, post-throw reacquire

### Deploy

PM2 still owns the process (root's PM2, id 2 `quantumclaw`):
```
ssh qclaw
sudo git -C /root/QClaw fetch origin
sudo git -C /root/QClaw merge --no-ff origin/fix/approval-gate-concurrency
sudo pm2 restart quantumclaw
sudo pm2 logs quantumclaw --lines 30
```

Tyson runs the manual smoke from Telegram once deployed. The headline
`[37]`-class failure should disappear: emoji replies resolve approvals
even while a chat handler is mid-`agent.process()`.
---

## 2026-04-28 — Approval notifier: bypass `bot.api.sendMessage` (raw fetch workaround)

Workaround for a silent-drop on the outbound approval notifier path:
`bot.api.sendMessage` from inside the `@grammyjs/runner`-managed process
returned without error and without delivery. No "Telegram send failed"
log line ever fired (catch never hit). Independent verification:
- `curl https://api.telegram.org/bot$TOKEN/sendMessage` → delivered.
- `new Bot(token).api.sendMessage(...)` from a one-shot script under
  `/root/QClaw` (same node_modules, same `.env`) → delivered (msg id
  `2843`).
- The same call from inside the long-running QClaw process → no error,
  no delivery.

Root cause is suspected to be an interaction between the runner's
update-fetch loop and the bot's outbound API client (possibly an
internal queue / abort signal / connection-pool state). **Tracked as
a separate investigation; not addressed in this PR.**

### Change

`src/index.js` notifier callback:
- Replace `await bot.api.sendMessage(ownerChatId, text)` with a raw
  `fetch('https://api.telegram.org/bot${token}/sendMessage', …)` POST.
- Cache the bot token at notifier-wire time (one `secrets.get` call at
  boot, not per-notification).
- On HTTP 401, refresh the token from `secrets.get` once and retry —
  so a BotFather rotation while the process is running doesn't
  permanently wedge the notifier.
- 10 s `AbortSignal.timeout` so a network stall can't hold up the
  approval flow indefinitely.
- Keep the `tgChannel` availability check as a fast-fail (channel never
  came up → don't try to send), but the actual send no longer depends
  on the bot reference.
- Surface non-OK responses via `log.warn` with status + first 200 chars
  of the body, so future failures are visible (this was the missing
  signal that made the silent-drop hard to diagnose).

The bot's own API client is still used for everything else (chat
replies via `bot.on('message:text')`, `bot.command(...)` responses,
the inline `bot.hears` approval-reply parser added in PR #2). The
workaround is scoped to the single notifier callback.

### Tests

- `node tests/smoke.test.js` → 22/22
- `node tests/approvals.test.js` → 13/13
- Manual smoke (post-deploy, run by Tyson):
  - [ ] Trigger an approval from Telegram (or via Charlie tool call).
        Confirm `⚠️ Approval needed [N] …` arrives at chat
        `1375806243` within 5 s.
  - [ ] Reply `✅ <id>`. Confirm row resolves to `approved` and the
        original tool action proceeds.
  - [ ] Trigger another, wait 10 min without replying — confirm the
        timeout still fires.

### Branch / PR

- `fix/notifier-raw-fetch`, off `origin/main` (`5a5b546`).
- Single-file change to `src/index.js`. No new dependencies.
- Deploy via `git merge --no-ff origin/fix/notifier-raw-fetch` onto
  `/root/QClaw`'s local `main` (which already carries the concurrency
  fix from PR #2). No conflicts expected — PR #2's changes are in
  `src/channels/manager.js` + `src/agents/registry.js`, this PR only
  touches `src/index.js`. After merge, `pm2 restart quantumclaw`.

### Out of scope (deferred)

- Root-cause analysis of why `bot.api.sendMessage` silently drops in
  runner context. Separate investigation; not blocking the gate fix.
- The previous Telegram-side 429/502 storm on the prior process
  (PID 2230128) — already cleared by the post-rotation restart;
  unrelated to this PR.
---

## 2026-04-28 — Approval gate: unify request paths so notifier always fires

The actual root cause of the production approval-gate failures.

`src/tools/executor.js` calls `approvalGate.requestApproval(...)` for
every tier-classified tool call inside `agent.process()`.
`requestApproval` delegated straight to `approvals.request()` and
**bypassed the notifier entirely**. Only `requestInlineApproval` (used by
`shell_exec` and `n8n_workflow_update` directly) ever fired the
notifier.

Result: every executor-driven approval created a row, logged
`⏸️  Approval required: …`, then sat invisible until the 10-min timeout
denied it. No Telegram prompt was ever sent for those — which is why
the logs showed `Approval needed: [N]` but no `Telegram send failed`,
no `Telegram bot unavailable`, no `No notifier wired` warnings: the
notifier code was never reached on that path. The PR #3 raw-fetch
workaround for `bot.api.sendMessage` was real but addressed a
*separate* silent-drop in the notifier transport, not the missing
notifier dispatch on the executor path.

### Change — single file

`src/security/approval-gate.js` `requestApproval`:
- Replace its body (which did `approvals.request(...)` directly) with
  a delegation to `requestInlineApproval`. Same payload shape — `agent`,
  `tool`, `action`, `detail`, `riskLevel`. Single approval-creation
  code path. Single notifier dispatch.
- Existing `log.warn('⏸️  Approval required: …')` line kept so log
  format stays consistent with previous output.

### Tests

- `node tests/smoke.test.js` → 22/22
- `node tests/approvals.test.js` → 13/13
- `node tests/approval-gate-notifier.test.js` → **13/13** new
  - notifier fires exactly once on `requestApproval`
  - payload contains agent / tool / numeric id / riskLevel / action /
    detail with the right shape
  - works without a notifier (warns, still resolves)
  - notifier-throws path is non-fatal (approval resolves regardless)
  - `requestInlineApproval` (existing callers: `shell_exec`,
    `n8n_workflow_update`) still fires the notifier — sanity check on
    the shared code path

### Deploy

Branch off `origin/main` (`5a5b546`). Single-file change to
`src/security/approval-gate.js` plus one new test file. No new deps.

```
ssh qclaw
sudo git -C /root/QClaw fetch origin
sudo git -C /root/QClaw merge --no-ff origin/fix/approval-gate-unify
sudo pm2 restart quantumclaw
sudo pm2 logs quantumclaw --lines 30
```

PR #2 (concurrency) and PR #3 (raw-fetch) are already on prod's local
`main`. This PR layers on top — no conflicts expected on
`approval-gate.js` (PR #2 didn't touch it; PR #3 didn't touch it).

### Why earlier PRs missed this

Both #2 and #3 were correct as far as they went, but neither path was
the failing one in production:
- #2 fixed the `bot.hears` reply parser and the agent concurrency
  hazard. Needed for once approvals start arriving via Telegram.
- #3 worked around the `bot.api.sendMessage` silent drop in runner
  context. Needed for the notifier transport to actually reach
  Telegram.
- This PR fixes the *missing* notifier dispatch on the executor path.

The three are independent and stack: the executor's approval row now
fires the notifier (this PR) → the notifier sends via raw fetch (#3) →
the user's `✅ <id>` reply arrives via concurrent middleware (#2) →
the row resolves.

### Out of scope (unchanged)

- Root-cause investigation of why `bot.api.sendMessage` silently drops
  in runner context. Tracked separately; PR #3's workaround stays.

---

## 2026-04-28 — Approval gate fix journey: closeout

End-of-day summary. Approval `[50]` resolved successfully end-to-end via
Telegram smoke test, confirming the gate is working. Three PRs were
needed because the failure had three independent contributing causes —
each PR addressed one, and only the combination unblocks the path.

### Root cause

`requestApproval` and `requestInlineApproval` were two parallel
approval-creation code paths in `src/security/approval-gate.js`, and
**only the inline one had the notifier wired**. The executor
(`src/tools/executor.js`) — which gates every tier-classified tool call
inside `agent.process()` — used `requestApproval`, the no-notifier
path. Direct callers (`shell_exec`, `n8n_workflow_update`) used
`requestInlineApproval`, which did fire the notifier. So most of
production's "Approval needed: [N]" log lines were created on a path
that never sent a Telegram prompt at all.

### Three PRs, three fixes (all merged into `origin/main`)

| PR | Branch | Fix | Why needed |
|---|---|---|---|
| **#2** `732876b` | `fix/approval-gate-concurrency` | `bot.hears(APPROVAL_REPLY_RE)` registered before `bot.on('message:text')` via `@grammyjs/runner`'s concurrent middleware; per-agent async mutex around `agent.process()`'s history read-modify-write. | Once approvals start arriving via Telegram, the inbound `✅ <id>` reply needs to be parseable while a prior chat handler is mid-`agent.process()`. Without this, replies queue behind a slow chat. Concurrent dispatch added a separate hazard (concurrent history reads → interleaved DB writes), which the mutex fixes. |
| **#3** `ede5dec` | `fix/notifier-raw-fetch` | Replace `bot.api.sendMessage(ownerChatId, text)` in the notifier callback with raw `fetch()` to `https://api.telegram.org/bot${token}/sendMessage`. Token cached at wire time; refresh on 401; 10 s `AbortSignal.timeout`. | `bot.api.sendMessage` from inside the runner-managed process was returning without error and without delivery — silent drop. Independent verification (curl, one-shot `new Bot(token).api.sendMessage`) confirmed the env, token, network path, chat id, and grammy library all worked outside the running process. Workaround scope is the single notifier callback; bot's API client unchanged for chat replies. Runner-context root cause still under investigation. |
| **#4** `7d471c6` | `fix/approval-gate-unify` | `requestApproval` delegates to `requestInlineApproval` instead of calling `approvals.request` directly. Single approval-creation path; single notifier dispatch. | The actual root cause. Without this, executor-driven approvals (the production majority) created rows that timed out silently — the notifier was never invoked for them at all. PRs #2 and #3 only had effect once this PR routed those approvals through the notifier in the first place. |

### How the three stack at runtime

For an approval-gated tool call inside Charlie's chat reply:

1. Tier-classified tool call hits `executor.runTool` → `approvalGate.requestApproval(...)`
2. **(PR #4)** `requestApproval` delegates to `requestInlineApproval`, creating the row AND firing the notifier.
3. **(PR #3)** Notifier sends via raw `fetch` to Telegram's HTTP API → Tyson sees `⚠️ Approval needed [N] …` within seconds.
4. Tyson replies `✅ N`.
5. **(PR #2)** `bot.hears(APPROVAL_REPLY_RE)` matches the reply concurrently with the still-running `agent.process()` (no head-of-line blocking under runner middleware) → calls `approvals.approve(N)`.
6. The original `agent.process` await resolves with `{approved:true}` → tool executes → Charlie's reply continues → done.

### Confirmed working today

- Approval `[50]` resolved successfully end-to-end via Telegram smoke
  test.
- Boot logs on prod show all three changes loaded:
  `Telegram: ready (2 users)` and
  `Approval gate Telegram notifier wired (raw fetch)`.

### Open follow-ups (deferred to future sessions)

- **Root-cause: `bot.api.sendMessage` silent-drop in `@grammyjs/runner`
  context.** PR #3's raw-fetch workaround sticks until this is
  understood. Suspected interaction between the runner's update-fetch
  loop and the bot's outbound API client (connection-pool state,
  transformer chain, AbortSignal handling).
- **`/root/QClaw` ↔ `origin/main` graph divergence.** Functionally in
  sync: the only file-content diff is 3 cosmetic lines in
  `QCLAW_BUILD_LOG.md` (extra `---` separator from how an earlier
  merge resolved). Different commit graphs (prod has local merge
  commits; origin has GitHub PR merge commits). Not blocking;
  reconciles next time the build log is touched.
- **Pre-existing WIP on prod** (parked, untouched in this session):
  `M yarn.lock` (drift) and `?? scripts/upload-ep66.mjs` (new
  one-shot). Neither affects the approval-gate path.

---

## 2026-04-28 — Content Studio EP66 first live run; n8n Telegram token fix

First end-to-end attempt at shipping a podcast episode through the
`Qf39NEOEgz2W0uls` "Content Studio Pipeline" workflow. The dashboard
`/api/content-studio/upload` route had failed earlier in the day
(~17:00 UTC, suspected dashboard restart mid-stream — separate issue,
not investigated this session). EP66 was bypassed via CLI: file
uploaded directly to R2, webhook fired manually with the same payload
shape the dashboard would build.

### Recon (Phase 1)

- R2 multipart-uploads listing on `emma-content-studio` returned `[]`
  — no orphan from the 17:00 failure (the dashboard busboy path
  doesn't use multipart for the single-shot upload, so a mid-stream
  restart leaves no R2-side trace).
- `scripts/upload-to-r2.sh` and `scripts/receive-and-upload.sh` both
  depend on `/home/flowos/.local/bin/aws`, which is broken on qclaw —
  `ModuleNotFoundError: No module named 'awscli'`. Documented but
  not fixed this session.
- Commit `83b92a4` (r2FileKey-interpolation fix in
  `receive-and-upload.sh` curl example) confirmed on `main`.
- EP05 in the bucket: `theflowlane-ep05-Brand_Positioning.mp4`. EP66
  key conventionalised to
  `theflowlane-ep66-Mothering_In_Business.mp4` to match — kebab +
  lowercase prefix, underscored title segment.
- n8n workflow `Qf39NEOEgz2W0uls` payload shape verified via MCP:
  webhook expects camelCase `r2FileKey`, `episodeTitle`,
  `episodeDescription`, optional `chatId`, `r2Url`. No
  episode-number field — episode 66 lives only in the title prefix.

### Upload — `scripts/upload-to-r2-multipart.mjs`

50-line node multipart uploader as fallback when the awscli shim is
broken. Uses the `@aws-sdk/client-s3` already in `node_modules`
(no new deps). Reads R2 creds from `/root/.quantumclaw/.env`. 16 MB
parts, 4 concurrent workers. Aborts the multipart upload on any
error to avoid orphans.

The 2.42 GB EP66 file was scp'd from laptop to qclaw `/tmp`, then
uploaded:

```
ssh qclaw 'sudo node /root/QClaw/scripts/upload-to-r2-multipart.mjs \
  /tmp/theflowlane-ep66-Mothering_In_Business.mp4 \
  episodes/theflowlane-ep66-Mothering_In_Business.mp4'
```

R2 ETag `8af99de9e6e11428778216dee9c25a14-145` (145 parts). Public
URL `https://pub-70c436931e9e4611a135e7405c596611.r2.dev/episodes/theflowlane-ep66-Mothering_In_Business.mp4`.

Promoted to canonical large-file uploader for future episodes — the
script is generic, not EP66-specific.

### First webhook fire — failed at Notify Start (T+1.2s)

curl to `https://webhook.flowos.tech/webhook/content-studio-pipeline`
returned HTTP 200 / 0 bytes in 1.6s (Cloudflare tunnel buffer
artefact). n8n executions API revealed the real cause:

```
n8n execution 718765:
  Webhook Trigger:    OK    (1ms)
  Create Job Record:  OK    (908ms)
  Notify Start:       error (318ms)
    NodeApiError 401 — Authorization failed - please check your credentials
```

Notify Start calls
`https://api.telegram.org/bot{{ $env.TELEGRAM_BOT_TOKEN }}/sendMessage`.
Telegram replied 401 → token unset, empty, or wrong on the n8n
container.

### Token diagnosis

- qclaw `/root/.quantumclaw/.env` `TELEGRAM_BOT_TOKEN`: `getMe`
  returns `{ok:true, @tyson_quantumbot, id 8588434821}`. Working.
- n8n `/home/n8nadmin/n8n-project/.env` line 15: set, length 46.
  Same length as qclaw's.
- sha256 first-8-char comparison:
  - qclaw: `5520af11…`
  - n8n .env (current + 3 historical backups going back to Apr 21):
    `acfc03ae…`
  - n8n container env: `acfc03ae…`
- `getMe` against the n8n token directly: 401 Unauthorized.

Two completely different bot tokens, both 46 chars (the format is
`<10-12 digit bot id>:<33-35 char auth>`, always 46). n8n had been
holding a dead token since at least Apr 21 — all 4 .env backups
have the same `acfc03ae…` hash. The workflow `updatedAt` is
`2026-04-14T21:13Z`; EP05 ran Apr 14 20:39, before that change —
likely the change introduced the `$env.TELEGRAM_BOT_TOKEN`
reference and EP66 is the first time anyone tried to fire the
workflow since.

### Fix — replace n8n token, recreate container

Token pulled from qclaw via stdin pipeline directly into a sed -i
replacement on n8n's .env (never echoed in either direction):

```
ssh qclaw 'sudo grep "^TELEGRAM_BOT_TOKEN=" /root/.quantumclaw/.env | cut -d= -f2-' | \
ssh n8n 'NEW=$(cat); sed -i.bak.20260428-pretoken \
  "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=${NEW}|" \
  /home/n8nadmin/n8n-project/.env'
```

Pre-edit backup written to `.env.bak.20260428-pretoken`. Perms
preserved 600 / `n8nadmin:n8nadmin`. Then on n8n:

```
cd /home/n8nadmin/n8n-project && docker compose up -d
```

(`up -d` rather than `restart` is required — restart re-signals the
existing container and does not pick up env_file changes.)
Recreated only the n8n service; postgres + flowos-overlay untouched.
Container `starting → healthy` in ~20s. Container env sha256 now
`5520af11…`. n8n editor reachable. `getMe` from n8n side now
returns `tyson_quantumbot`.

### Re-fire — Phase 3

Orphan `content_studio_jobs` row from the failed first run deleted
via PostgREST DELETE (anon role has DELETE permission on the table —
`SUPABASE_SERVICE_KEY` is not present in qclaw .env, but anon
worked). Webhook re-fired from qclaw using the same
`/tmp/ep66-payload.json` from the first attempt.

New job `219ad102-6767-40ab-ba39-1e71aa9debce`, fired
`2026-04-28T17:05:22Z`.

Stages cleared (verified via Supabase row updates and clipper-worker
logs):

```
T+0s     Webhook Trigger
T+1s     Create Job Record
T<100s   Notify Start (Telegram)            — Phase 2 fix confirmed
T<100s   Generate R2 Presigned URL
T<100s   Upload to Buzzsprout                — episode id 19091555
T<100s   Save Buzzsprout ID
T~100s   Send to AssemblyAI / Wait / Poll    — transcribed cleanly,
                                              5,681 words captured
T<166s   Extract Highlights / Select Clip Segments / Parse
T+166s   Generate Blog Post / Convert to HTML / Post to WordPress
                                              — post id 675, draft
T+166s   Save WordPress URL
T+288s   Generate Clips                      — clipper job
                                              aa9be7f0-a424-42d9-9338-
                                              f56b67416602
```

Then deadlock at clipper.

### Clipper deadlock — out-of-scope to fix tonight

Clipper job `aa9be7f0` errored on the first vertical-crop step.
ffmpeg invocation:

```
ffmpeg -y -threads 1 -i /tmp/aa9be7f0…_clip_0.mp4 \
  -vf 'crop=ih*9/16:ih:max(0, min(iw-ih*9/16, 0.3919*iw - ih*9/16/2)):0' \
  -preset ultrafast -c:a copy /tmp/aa9be7f0…_vertical_0.mp4
```

Returned exit status 8 (ffmpeg "Conversion failed"). Likely
audio-codec compatibility with `-c:a copy` for this source's
encoding; would resolve with re-encoding (`-c:a aac -b:a 128k`) or
by skipping vertical processing. AssemblyAI transcript completed
cleanly, so video download + transcription are not implicated.

Workflow "Clip Done?" IF only branches on `status == "complete"`
(true → Save Clip URLs, false → Wait 10s Retry). No error branch.
Clipper returns `status: "error"` indefinitely → infinite poll.
Pipeline cannot finalise — Update Job Record, Notify Complete,
Respond to Webhook all unreached.

### Persisted vs lost

Persisted (survives the deadlock, written before the clipper
branch):

- Buzzsprout EP66 draft (id 19091555, unpublished)
- WordPress draft (post id 675)
- LinkedIn post via Blotato — likely published; the parallel branch
  reaches Blotato before YouTube and before the deadlock point.
  Not confirmed in Supabase (`linkedin_post_url` writes only at the
  final Update Job Record).
- YouTube unlisted upload — likely complete; same parallel branch.
  Not confirmed in Supabase (same writeback constraint).

Lost if the runaway execution is stopped without harvest:

- Substack draft text (held in n8n runtime memory only)
- LinkedIn post URL (returned by Blotato but only persisted at the
  final node)
- YouTube video ID (returned by upload but only persisted at the
  final node)

### Phase 1 finding correction

Phase 1 recon claimed PM2 was empty on qclaw. That was `pm2 list`
run as user `flowos`, which has its own empty PM2 daemon.
Production processes are managed by root's PM2: `sudo pm2 list`
shows `agex-hub`, `charlie-watcher`, `clipper-worker`,
`quantumclaw`, `trading-worker` all online. The dashboard
"not under PM2" framing earlier today was based on the same
wrong-user query. Documented as a session-incident gotcha.

### Backlog from this session

P0 (next session, EP66 unblock):

- Stop the runaway n8n execution still polling clipper. Currently
  spinning at ~6 req/min against `clipper-worker:4002/clip/aa9be7f0`
  and won't self-resolve.
- Investigate clipper-worker ffmpeg vertical-crop+`-c:a copy`
  failure on EP66's source. Reproduce manually if `_clip_0.mp4`
  still in `/tmp`; otherwise re-trigger with debug logging.
- Patch workflow `Qf39NEOEgz2W0uls`: add error branch on
  "Clip Done?" → Update Job Record (with empty clips +
  error_message). Stops infinite polls on all future clipper
  failures, generic to the workflow not specific to EP66.

P1 (workflow / config hygiene):

- Refactor `$env.TELEGRAM_BOT_TOKEN` references in
  `Qf39NEOEgz2W0uls` to n8n credential store (Telegram credential
  type). Removes the env-var-on-host-not-on-container failure mode
  entirely.
- Diff the Apr 14 21:13 workflow update against its prior version
  to confirm it's the change that introduced
  `$env.TELEGRAM_BOT_TOKEN`, and audit other workflows for the
  same pattern.
- Move `N8N_ENCRYPTION_KEY` and `POSTGRES_PASSWORD` out of the
  tracked `docker-compose.yml` into the env_file. Both are in git
  history; rotate after move. The git-history exposure is the
  larger concern.

P2 (config cleanup):

- Dedupe `FLOWOS_META_PAGE_ACCESS_TOKEN` (appears twice) in
  `/home/n8nadmin/n8n-project/.env`.
- Delete `/home/n8nadmin/n8n-project/.docker-compose.yml.swp`
  vim-swap leftover from Sep 2025.
- Confirm via BotFather (using the working `5520af11…` token's
  bot) that no zombie bot remains for the `acfc03ae…` token.
- Add `SUPABASE_SERVICE_KEY` to qclaw `/root/.quantumclaw/.env`
  for proper service-role DELETEs. Anon role currently has DELETE
  on `content_studio_jobs` — broader than typical, worth auditing
  RLS on that table.
- Fix awscli on qclaw (`pip install --user awscli` for flowos), or
  formally retire `scripts/upload-to-r2.sh` /
  `scripts/receive-and-upload.sh` in favour of
  `upload-to-r2-multipart.mjs`.

### Out of scope (deferred)

- Dashboard PM2 enrolment / 17:00 UTC dashboard upload root cause:
  the dashboard is in fact PM2-managed (id 2 under root's PM2,
  restart count visible in the `↺` column). Whether the 17:00
  failure was a restart mid-stream or a different cause was not
  investigated this session.
- Ship-completion harvest: deciding whether to manually patch
  `clip_jobs.aa9be7f0` to `status='complete'` to let the workflow
  finalise and write Substack/LinkedIn/YouTube URLs. Risk:
  clipper-worker may serve in-memory state over DB on its
  `/clip/<id>` GET; needs verification before any patch.

---

## Session — 28 April 2026

### Completed

#### Trading Room — yarn.lock & dependency cleanup
- Resolved yarn.lock conflicts that were blocking clean installs
- Trading worker dependencies reconciled; `agex-hub`, `trading-worker`, and `charlie-watcher` all confirmed stable in PM2
- Market scanner (`3YahxqOguET3pifj`) extended from ~50 to ~400 Polymarket markets
- Added Silver and ETH to market scanner asset coverage
- Scanner confirmed live and running every 30 mins; Telegram alerts firing correctly
- Note: Polymarket currently has limited gold/silver/oil price-target markets — scanner will catch them when they open

#### Meta Ads Report — Split by Account (workflow `lf955LDteJ512RQi`)
- **Problem:** Emma Maidment and Flow OS ad account data was being merged into a single combined report, producing incorrect aggregated figures
- **Root cause:** `Process & Score Insights` node dropped account identity when merging insights; single Telegram message sent for all accounts combined
- **Fix:** Rewrote `Process & Score Insights` to preserve `account_id` and `account_name` on every row, group by account, and sort each account's ad sets independently
- Rewrote `Format Report` to produce **one Telegram message per account** (3 messages total: Flow States Retreats, Emma Maidment Business, Flow OS)
- Each message includes: spend, leads, avg CPL, top performers, needs-attention ad sets — all scoped to that account only
- Workflow re-activated; `availableInMCP` preserved
- Tomorrow's 9am report will deliver three separate Telegram messages

### Pending (carried forward)
- All P0/P1/P2 items from previous session remain open (see above)
- Flow States Collective ad account (`act_464237024205104`) label in workflow still reads "Flow States Retreats" — sticky note also needs updating. Low priority cosmetic fix.
- Confirm tomorrow's report fires correctly and figures match individual account dashboards


---

## Session — 29 April 2026

### Completed

#### Content Studio — Force JPEG output from FAL Gemini (workflow `kJ2EdkOeEAwVbMwU`)
- **Workflow:** Infographic Social Media Machine V2 - Flow Os
- **Problem:** Instagram Graph API was rejecting generated images. FAL Gemini was returning PNG by default; Meta's Graph API for IG/TikTok image upload is JPEG-only per Meta docs.
- **Fix:** Added `output_format: 'jpeg'` to the FAL Gemini request body on node `a4db370c-7eb7-4977-8082-4b863cdc9ee6` ("Generate Image - Variation 1"), field `parameters.jsonBody`.
- **Before:** `={{ JSON.stringify({ prompt: $json.variation1Prompt, aspect_ratio: '4:5' }) }}`
- **After:**  `={{ JSON.stringify({ prompt: $json.variation1Prompt, aspect_ratio: '4:5', output_format: 'jpeg' }) }}`
- `settings.availableInMCP` re-asserted to `true` on PUT (n8n public API resets it otherwise — known issue).
- PUT returned HTTP 200; `updatedAt` advanced from `2026-04-29T12:21:03.986Z` to `2026-04-29T14:13:42.202Z`.
- **Rollback artefact:** `/root/QClaw/n8n-workflows/kJ2EdkOeEAwVbMwU.before-jpeg-fix.json` (pre-patch GET response, 107024 bytes).
- **Post-patch artefact:** `/root/QClaw/n8n-workflows/kJ2EdkOeEAwVbMwU.json` (full patched workflow).
- Semantic diff between pre/post is exactly the two expected lines (one jsonBody removed, one added). No other nodes, settings, or connections changed.
- Workflow execution NOT triggered — manual test in n8n UI pending.

### Pending (carried forward)
- All P0/P1/P2 items from previous sessions remain open.

### Infrastructure note
- Added `N8N_BASE_URL` to `/root/.quantumclaw/.env` (was missing; only `N8N_API_KEY` and `N8N_SSH_KEY` present prior). Perms confirmed `600`. Value not logged.
- `.env` line 11 emits a `command not found` warning when sourced via `set -a; source ...; set +a` — a value contains an unquoted shell metacharacter. Worked around by extracting needed vars via `grep`/`cut` instead of sourcing. Worth fixing properly in a future hygiene pass.

---

## Session — 29 April 2026 — Meta Ads Optimisation Agent (workflow lf955LDteJ512RQi)

**Completed:**
- Rotated to long-lived Graph API token; stored as Header Auth credential
  (id: bJDoAH6FBEUyRbJK), removed from query params on Fetch nodes
- Fixed Fetch Ad Insights auth (genericCredentialType + httpHeaderAuth,
  credential attached); confirmed Bearer header injection working
- Removed Fetch Campaigns node entirely — was dead weight causing dual-fire
  of Process & Score (resulted in 2 Telegram messages + 2 Opus calls per run)
- Rewrote Process & Score Insights to correlate adsets back to source
  account via pairedItem + $('Split Accounts'); added belt-and-braces block
  ensuring all 3 accounts appear even when one has 0 active adsets
- Rewrote Build Opt Analysis Request prompt to mandate per-account sections
  and Telegram-safe Markdown (no ## headers, no pipe tables); bumped
  max_tokens 1500 → 2000
- Rewrote Format Report to consume AI markdown from upstream Anthropic node
  (was previously ignoring the AI output entirely)
- Verified end-to-end: single Telegram message, 3 account sections
  (Emma Maidment Business 4 adsets, Flow OS 2 adsets, Flow States Retreats
  0 adsets), cross-account priorities footer

**Pending (carparked for next session):**
- Sticky note on workflow still references "60-day expiry" — update to
  reflect long-lived token
- Log Report (Optional) Airtable node still points at literal
  "AIRTABLE_BASE_ID" placeholder — disabled but should be wired to Supabase
  or removed

**7 Pillars gate:**
- ✅ P4 Auth — token in n8n credential store, Bearer header injection,
  no credentials in workflow JSON
- ✅ P6 Security — token out of query string + workflow JSON, no
  hardcoded secrets, credential file permissions verified 600
- ✅ P7 Infra — workflow JSON backed up to n8n-workflows/ in this commit
- N/A P1 Frontend, P2 Backend, P3 Database, P5 Payments — no changes in
  these areas this session

#### Content Studio — Cap Hashtags Code node (workflow `kJ2EdkOeEAwVbMwU`)
- **Workflow:** Infographic Social Media Machine V2 - Flow Os
- **Problem:** Instagram's December 2025 hard 5-hashtag limit on Graph API publishing. AI Writer system prompt was updated by Tyson to instruct the LLM, but a code-level safety net is needed to defend against AI prompt drift.
- **Change:** Added a new `Cap Hashtags` Code node (id `0b0ab9e2-3a2c-494f-a4cb-352f5c890b5a`, position `[-7080, 1728]`) between `Cost Per Run` and the Blotato fan-out. Node trims any hashtag past the 5th from `captions.{facebook,instagram,twitter,youtube,linkedin,tiktok}` and tidies whitespace.
- **Connections rewired:**
  - `Cost Per Run` → previously `[Instagram [BLOTATO], Tiktok [BLOTATO]]`. Now: `[Cap Hashtags]`.
  - `Cap Hashtags` → `Instagram [BLOTATO]` (new).
  - `Tiktok [BLOTATO]` input edge **removed entirely** — Tyson is locked out of TikTok in Blotato; not re-routing through Cap Hashtags.
  - Twitter / Facebook / YouTube / LinkedIn Blotato nodes remain disconnected (Tyson's debug state); they will need to be re-wired manually from `Cap Hashtags` when ready.
- **Blotato `postContentText` updated** on all 6 platform nodes (Twitter, Instagram, Facebook, YouTube, LinkedIn, TikTok) from `={{ $('AI Writer - Content Generator').item.json.choices[0].message.content.captions.<X> }}` → `={{ $json.captions.<X> }}`. So when Tyson reconnects them, they read the capped output. YouTube's `postCreateYoutubeOptionTitle` was not touched (no hashtags in titles).
- `settings.availableInMCP` re-asserted to `true` on PUT.
- PUT returned HTTP 200; `updatedAt` advanced to `2026-04-29T18:51:33.781Z`. Node count 24 → 25.
- Verified all 6 platforms' new `$json.captions.<X>` literal landed cleanly via grep round-trip on the saved JSON.
- **Rollback artefact:** `/root/QClaw/n8n-workflows/kJ2EdkOeEAwVbMwU.before-hashtag-cap.json` (73701 bytes, pre-patch GET).
- **Post-patch artefact:** `/root/QClaw/n8n-workflows/kJ2EdkOeEAwVbMwU.json` (94335 bytes).
- Workflow execution NOT triggered — manual UI test pending with Tyson.

#### Trading Market Scanner — Restored after 2-day silent failure (workflow `3YahxqOguET3pifj`)
- **Workflow:** Trading - Market Scanner. Cron: hourly Mon, every 2h Tue–Fri, every 4h weekend.
- **Symptom:** No Telegram updates since Tue 28 Apr 2026 18:00 UTC. 22 consecutive failed runs (status=error, ~1s each) before detection on Wed 29 Apr 2026 ~19:30 UTC. Detection lag: ~25h. Heartbeat now in place — would have been ~2h instead.
- **Root cause:** Workflow edit on **2026-04-28T18:30:52Z** introduced a templated `Notify Edge` body referencing `$json.highEdge.length` and `$json.noEdge.length` — but no upstream node produced a `{ highEdge, noEdge }` object. The pipeline reached `Notify Edge` (Analyse Edge → Run Market Sims → Has Edge?), then n8n's HttpRequestV3 pre-flight JSON validation rejected the evaluated body. Has Edge? IF was also broken (same bad refs) but routed items through anyway because both `main[0]` and `main[1]` pointed at Notify Edge — the IF was a no-op pass-through.
- **Raw exception text** (execution 723655, last in series):
  ```
  NodeOperationError: JSON parameter needs to be valid JSON
      at ExecuteContext.execute (HttpRequestV3.node.ts:442:15)
      at WorkflowExecute.executeNode (workflow-execute.ts:1045:31)
      at WorkflowExecute.runNode (workflow-execute.ts:1226:22)
  lastNodeExecuted: "Notify Edge"
  ```
- **Triage findings** (none of the brief's three hypotheses were the cause):
  - Sim worker on `:4001`: healthy (HTTP 200 in 230ms; pid 2276594, plain python3 — no pm2 entry).
  - Cron firing: yes, on schedule. n8n in Docker (`n8n-project-n8n-1`) on a separate host (157.230.216.158), not on the qclaw box.
  - Markets passing filter: yes — `Build Run Summary` `stats.passed_filter` is consistently 2–3 BTC markets per run.
  - Polymarket commodity coverage: thin. Across 3500 open markets, 11 hits for `gold|silver|wti|brent|crude|oil price|barrel`; most "gold" hits are Trump "Gold Cards" merch, not commodity. Regex broadening landed but real bottleneck is payload availability, not the keyword list.
- **Fixes applied** (priority order swapped from original brief — restore Telegram first, regex broadening last):
  1. **New `Build Run Summary` Code node** between `Run Market Simulations` and `Has Edge?`. Aggregates sim outputs back with original Analyse Edge fields via `$('Analyse Edge').itemMatching(i)`. Partitions into `highEdge` / `noEdge` / `neutral` by asymmetric thresholds: `+0.07` for high, `-0.10` for no, gated on `volume ≥ 5000`. Emits `stats {fetched, passed_filter, markets_simulated, sim_errors, high_edge_count, no_edge_count, neutral_count}` and a Supabase-shaped `sims` array.
  2. **`Has Edge?` IF rewired**: TRUE → `Notify Edge`, FALSE → new `NoOp End` terminator (was previously both → Notify Edge).
  3. **`Save Simulations` reconnected** off `Build Run Summary`. Was orphaned (`"Save Simulations":{"main":[[]]}`). Credential unchanged — uses stored `Supabase FSC` httpHeaderAuth (id `Nd2uuX5t9KEwbQPv`); no raw service-role key in workflow JSON.
  4. **`Notify Heartbeat` HTTP node** off `Build Run Summary` — fires every successful run with `🔁 Scanner run | <ts> | Fetched: N | Passed filter: N | Sims: ok/total | Edges: H high / N no`. `continueOnFail: true`, `retryOnFail: true`, `maxTries: 3`, `waitBetweenTries: 2000`.
  5. **`Merge Pages` node** before `Analyse Edge` — combines the four `Fetch Page*` HTTP outputs into a single execution stream, fixing per-execution `seen` Set dedup that previously failed across the 4 parallel Analyse Edge runs.
  6. **`Analyse Edge` regex broadened** — adds bare-number `(?:above|over|reach|hit|cross|exceed|surpass|past|to|at)\s+\$?<num>` fallback alongside the original `\$<num>` matcher, with per-asset `minPrice` floor (`btc:10000, eth:500, gold:1000, silver:10, wti:30, brent:30`) so years/IDs cannot be misread as targets. False-positive `gold cards / olympic gold / gold medal / golden bachelor / golden globe` exclusions added to the sports/non-commodity filter.
  7. **`Notify Edge` resilience** — `continueOnFail: true`, retry 3× / 2s backoff, 15s timeout, hardcoded chat_id replaced with `$env.TELEGRAM_TRADING_CHAT_ID`.
  8. **Env hardening**: `SIM_HOST=http://138.68.138.214:4001` and `TELEGRAM_TRADING_CHAT_ID=1375806243` appended to `/home/n8nadmin/n8n-project/.env` on the n8n host (NOT `/root/.quantumclaw/.env` on qclaw — n8n loads via `env_file:` in compose; brief had this conflated). Container recreated via `docker compose up -d n8n` (NOT `restart` — restart keeps old env). Backup: `.env.before-trading-fix-2026-04-29`. Permissions still `-rw------- n8nadmin:n8nadmin`.
  9. **`Run Market Simulations` URL** → `={{ $env.SIM_HOST }}/simulate` (was hardcoded IP).
  10. **New companion workflow `Trading - Error Handler`** (id `7kpNnMtnuDWXgWcX`). Single ErrorTrigger → Telegram HTTP node sending `🚨 Workflow error\nWorkflow: <name>\nExecution: <id>\nNode: <node>\nMessage: <msg>\nLast node: <last>`. Wired as `settings.errorWorkflow` on the scanner. Two-day silent failures are now structurally impossible — any run that errors before reaching `Notify Heartbeat` triggers a Telegram alert via the error workflow.
- **Secondary follow-up bug discovered during verification:** First post-patch run (723715) succeeded but `Save Simulations` returned `400 - {"code":"22P02","message":"invalid input syntax for type uuid: \"540844\""}`. The `trading_simulations.market_id` column is `uuid`, but Polymarket emits integer-string IDs. Historical successful rows have `market_id: NULL`. Fix: dropped `market_id` from the `sims` payload, moved Polymarket's id into `raw_output.polymarket_market_id` so the linkage isn't lost. Verified row 2 of execution 723751 contains `raw_output.polymarket_market_id: "540844"`, `raw_output.question: "Will bitcoin hit $1m before GTA VI?"`, `probability: 0.0002`, `current_price: 75515.19`, `edge: -0.4903`, full `macro_factors {dxy, tnx}`.
- **Verification (live, not theoretical):**
  - Execution 723715 (20:05 UTC): finished=t, status=success, 6.1s, lastNodeExecuted=`Notify Heartbeat` — all 13 nodes ran.
  - Execution 723751 (20:14 UTC, after market_id fix): finished=t, status=success, 4.6s — **2 rows landed in `trading_simulations`** with `created_at >= 2026-04-29T20:13:09Z`.
  - Tested via temporary `* * * * *` cron expression added to `Smart Schedule`, removed immediately after each verification (3 extra rows in execution log, no production impact).
- **Topology after fix** (14 nodes):
  - `Smart Schedule` → fan-out to `Fetch Polymarket / Fetch Page 2/3/4`
  - 4× Fetch → `Merge Pages` (append, 4 inputs) → `Analyse Edge` (runs once now, dedup intact)
  - `Analyse Edge` → `Run Market Simulations` (env URL) → `Build Run Summary`
  - `Build Run Summary` → fan-out: `Has Edge?` + `Save Simulations` + `Notify Heartbeat`
  - `Has Edge?` TRUE → `Notify Edge` ; FALSE → `NoOp End`
- **Repo artefacts:**
  - Pre-patch backup: `/root/QClaw/n8n-workflows/trading-market-scanner.before-2026-04-29-fix.json` (33908 bytes, broken state)
  - Post-patch live: `/root/QClaw/n8n-workflows/trading-market-scanner.json` (43907 bytes, 14 nodes)
  - New: `/root/QClaw/n8n-workflows/trading-error-handler.json` (4449 bytes)
- **Settings re-asserted on PUT:** `availableInMCP: true ✓`, `errorWorkflow: 7kpNnMtnuDWXgWcX ✓`, `executionOrder: v1`, `callerPolicy: workflowsFromSameOwner`. Cron expressions back to original 3 (`0 */1 * * 1`, `0 */2 * * 2-5`, `0 */4 * * 0,6`).

**Pending (carparked for next session):**
- Polymarket commodity coverage is thin even with broadened regex. If commodity edge is the goal, supplement with Kalshi/PredictIt sources rather than expanding keyword lists.
- The Apr 28 broken edit pattern would benefit from a pre-deploy lint of n8n expressions (catch references to fields no upstream node produces) — could be a Code-node-only smoke test that walks the graph and grep-checks `$json.<key>` against upstream emitters.
- Clipper Phase 2 (face detection) still next.

**7 Pillars gate:**
- ✅ P3 Database — `trading_simulations` table mapping verified (uuid mismatch caught and routed via `raw_output`)
- ✅ P4 Auth — Supabase FSC credential unchanged (stored, not raw); n8n public API key used for orchestration only
- ✅ P6 Security — no hardcoded chat_id / sim host / service role key in workflow JSON; `/root/.quantumclaw/.env` permissions `600` unchanged; `/home/n8nadmin/n8n-project/.env` permissions `600` unchanged; backups created before each in-place edit
- ✅ P7 Infra — workflow + error handler + .env backups committed to repo; live state matches repo state
- N/A P1 Frontend, P2 Backend, P5 Payments — no changes in these areas this session
