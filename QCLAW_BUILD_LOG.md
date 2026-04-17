# QClaw Build Log & Technical Handoff

**Project:** QClaw — Self-hosted Claude agent runtime (Fork of QuantumClaw/QClaw)
**Owner:** Tyson Venables / Flow OS
**Last updated:** 8 April 2026
**Repo:** https://github.com/tysonven/QClaw

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
