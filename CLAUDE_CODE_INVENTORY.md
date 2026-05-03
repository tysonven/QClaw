# Claude Code Inventory

What Claude Code has access to in this environment, and what it does not. Read at session start before any work. Updated whenever tool surface or access changes.

## Environment

- Server: qclaw (DigitalOcean droplet, Ubuntu 24.04 LTS)
- Repo: `/root/QClaw`
- User: typically root for system ops, flowos for app-level via `sudo -n`
- Node.js available
- Python 3 available
- Git available
- PM2 available

## Repo paths

**Read access:**
- `/root/QClaw/` — full repo (read everything)
- `/root/.quantumclaw/` — config and logs (read structure, never log secret values)
- `/home/flowos/.quantumclaw/` — symlinked config (same rules)

**Write access:**
- `/root/QClaw/` — repo files (subject to Operating Rule 1: stage specific files only)
- `/tmp/` — scratch and audit reports
- `/home/claude/` — working directory for in-progress work

**Never write:**
- `/etc/` — system config
- `/root/.quantumclaw/.env` — secrets file (never edit, never log content)
- `/etc/nginx/` — webserver config (out of scope unless explicit infra dispatch)

## Git operations

**Allowed without explicit approval:**
- `git status`, `git log`, `git diff`, `git show` — read-only
- `git add <specific-file>` — staging specific files
- `git commit` with verification line per Operating Rule 5
- `git push` to main when committing this session's work only
- `git checkout -b cc/<task>-<timestamp>` — create feature branch

**Requires explicit approval in brief:**
- Force push (`git push -f`)
- Branch deletion (`git branch -d`, `git push --delete`)
- Rebase or rewrite history (`git rebase -i`, `git reset --hard`)
- Merging to main from a feature branch
- Operations on commits not authored in this session

## Shell operations

**Always allowed:**
- File reads: `cat`, `less`, `head`, `tail`, `grep`, `find`, `ls`
- Git operations per above
- PM2 read: `pm2 list`, `pm2 logs --nostream`, `pm2 show <name>`
- Process inspection: `ps`, `lsof -i`, `netstat`
- Network probes from this server: `curl 127.0.0.1:<port>` (localhost only by default)

**Allowed with care:**
- PM2 writes: `pm2 restart <name>`, `pm2 reload <name>` — verify the process is in scope, never restart `quantumclaw` without explicit approval (Charlie's runtime)
- npm install, pip install — only when brief explicitly calls for it
- Docker operations on n8n container — only when brief is for n8n infra work

**Never allowed without per-task explicit approval:**
- Operations that touch external services that send messages, charge money, or modify production data outside this server
- Credential rotations
- Database schema migrations to production
- DNS or SSL changes

## External services

**Read access:**
- Supabase project `fdabygmromuqtysitodp` — read-only queries on whitelisted tables
- n8n at `webhook.flowos.tech` — read workflow JSON, read execution history
- GitHub `tysonven/QClaw` — push and PR operations
- Cloudflare R2 — read object lists in scoped buckets

**Write access (when explicitly in scope):**
- GitHub: push commits, open PRs
- Supabase: writes to operational tables (e.g. `claude_code_dispatches` results) when dispatched for those operations
- n8n: workflow updates only after audit-first flow, only when explicitly dispatched

**Never directly:**
- Stripe — Tyson controls all writes manually
- GHL message sends — drafts only via specialists, never direct from Claude Code
- Meta Ads API writes — via Ads Operator specialists only
- External email — drafts only

## Tools NOT available

These don't exist as tools — do not reference them in plans or briefs:

- No `Supabase:execute_sql` general write tool — read-only access only via `supabase_select`
- No `spawn_agent` (removed, was creating dead stubs)
- No filesystem MCP (broken, removed — use `read_file` / `list_dir` patterns)
- No GHL message send tool — drafts only
- No Stripe write tools — read-only reporting only

If a brief references a tool that's not in this inventory, surface the gap before proceeding. Do not invent tools.

## Coordination with other agents

- Charlie dispatches work to Claude Code via the `claude_code_dispatch` tool (Phase 4 Slice 5)
- Specialists do not dispatch directly — they route through Charlie
- Two Claude Code sessions are coordinated via `.claude-code-session.lock` per Operating Rule 2

## What to do when something is unclear

If the brief asks for something that conflicts with this inventory or the Operating Rules:

1. Stop
2. Cite the conflict explicitly
3. Surface to Charlie (via dispatch result) or Tyson (in chat) for resolution
4. Do not proceed until resolved

This is the audit-first reflex applied to your own scope.

## Updates

This file updates whenever:
- A new tool is added or removed from Claude Code's surface
- Access scope changes
- An external service connection changes
- A new coordination pattern is introduced

Updates are committed with a build log entry referencing what changed and why.
