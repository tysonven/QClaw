# LOCATIONS

Single source of location for everything in the QClaw / Flow OS / FSC / SproutCode / Crete / Personal stack. Anything that has a "where does this live" answer is recorded here. When something moves, this file is updated; everything else reads from here.

This file is the second thing every agent reads at session start, after its identity layer.

## Repository

- QClaw repo: `/root/QClaw` on qclaw server
- GitHub: `github.com/tysonven/QClaw`
- Default branch: `main`
- CI/CD: GitHub Actions auto-deploys on push to main

## Identity layer (canonical, rarely changes)

- `CEO_OPERATING_MODEL.md` — operating model and trust gradient (north star)
- `CHARLIE_ROLE.md` — Charlie's role spec (PENDING — to be written in next pre-slice session)
- `CHARLIE_OVERHAUL.md` — running architecture doc for Charlie 2.0
- `LOCATIONS.md` — this file
- Existing identity files retained for continuity: `SOUL.md`, `VALUES.md`, `IDENTITY.md`

## State layer (Charlie writes routine, Tyson approves significant)

- `FLOW_OS_STATE.md` — single source for current business state across Flow OS, FSC, SproutCode, Crete, Personal (PENDING — to be populated)
- `FLOW_OS_SPECIALISTS.md` — specialist registry (PENDING — to be populated)
- `N8N_WORKFLOW_INDEX.md` — every active n8n workflow (PENDING — focused Tyson + Claude Code session)

## Operational layer (append-only, never rewritten)

- `QCLAW_BUILD_LOG.md` — chronological build log
- Bootstrap log: `~/.quantumclaw/bootstrap.log` (file-based, will migrate to Supabase post-Phase-4)
- Audit log: existing audit DB (location to be confirmed in Phase 4 Slice 3)
- Gate log: `~/.quantumclaw/gate.log` (file-based, will surface in QClaw dashboard post-Phase-5)
- Skill load log: `~/.quantumclaw/skill-load.log` (file-based, will migrate to Supabase post-Phase-4)
- Claude Code dispatch log: Supabase table `claude_code_dispatches` (Phase 4 Slice 5)

## Capability layer

- Skill files: `/root/QClaw/src/agents/skills/`
- Symlinks for loaded skills: `/root/QClaw/<workspace path — confirm in Phase 4 Slice 2>`
- Tool registry: code-defined in `src/agents/tools/` (Phase 4 Slice 3)

## Reference docs (Tyson and Claude Code)

- `KEYWORD_REFERENCE.md` — skill loading keyword cheat sheet
- `CLAUDE_CODE_OPERATING_RULES.md` — Claude Code session discipline
- `CLAUDE_CODE_INVENTORY.md` — Claude Code tool surface and access

## Infrastructure

- QClaw server: `ssh qclaw` → `138.68.138.214`, port 4000
- n8n server: `ssh n8n` → `157.230.216.158`, Docker Compose
- Dashboard: `agentboardroom.flowos.tech`
- Supabase project: `fdabygmromuqtysitodp`
- Cloudflare R2: used by Clipper, Content Studio, Crete Marketing, Flow OS GHL Marketing (each scoped to own bucket/folder)

## Secrets and credentials

- QClaw-side secrets: `/root/.quantumclaw/.env` (root-owned, 600 permissions)
- Symlink for sudo flowos access: `/home/flowos/.quantumclaw/.env` (intentional, root-managed)
- n8n-side secrets: `/home/n8nadmin/n8n-project/.env` (compose env_file)
- Supabase credentials in n8n: "Supabase FSC" credential
- Never log secret values. Never commit secrets to repo.

## Business unit portals and accounts

- Flow OS community portal: `portal.flowos.tech`
- FSC community portal: `https://fsc.app.clientclub.net/home`
- GHL sub-accounts: Flow OS, FSC, SproutCode, Crete (one each)
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
