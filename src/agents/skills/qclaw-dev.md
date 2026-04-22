# qclaw-dev skill
#
# Target: ssh qclaw (138.68.138.214), NOT local Mac
# User: root (PM2, config, and .quantumclaw all owned by root)
# Repo: /root/QClaw (absolute paths only — no ~ or $HOME)
# Syntax: Linux/GNU tools (sed -i without empty '' argument)

# QClaw Development

## Purpose
Direct access to read, edit, and manage files in the QClaw repository for debugging and development.

## Repository
Path: /root/QClaw
Git: Yes

## Capabilities

### File Operations
- Read any file in /root/QClaw
- Edit files (with backup)
- Create new files
- Compare file versions
- View git status/diff

### Safe Edit Protocol
1. Always create backup before editing: `cp file file.backup.$(date +%s)`
2. Show planned changes before applying
3. Verify syntax after changes
4. Restart services if needed

### Testing
- Restart PM2 process: `pm2 restart quantumclaw`
- View logs: `pm2 logs quantumclaw --lines 50`
- Check process status: `pm2 status`

## Allowed Commands
bash
# File operations
cat /root/QClaw/path/to/file
grep -n "pattern" /root/QClaw/path/to/file
sed -n 'X,Yp' /root/QClaw/path/to/file
wc -l /root/QClaw/path/to/file
ls -lah /root/QClaw/path

# Backups
cp /root/QClaw/src/file /root/QClaw/src/file.backup.$(date +%s)

# Editing (via sed/cat/echo) — GNU sed, no empty '' arg
sed -i 'command' /root/QClaw/path/to/file
cat > /root/QClaw/path/to/file << 'ENDFILE'
...
ENDFILE

# Git operations
cd /root/QClaw && git status
cd /root/QClaw && git diff path/to/file
cd /root/QClaw && git log --oneline -10

# PM2 operations
pm2 restart quantumclaw
pm2 logs quantumclaw --lines 50 --nostream
pm2 status
## Permissions
- file: [/root/QClaw/**, /root/.quantumclaw/**]
- shell: [cat, grep, sed, cp, mv, ls, wc, git, pm2, node, npm]
- http: none

## Usage Notes
- Always show me the plan before executing
- Create timestamped backups before destructive changes
- After file changes, verify syntax and restart services
- Use `set -e` in multi-command scripts to fail fast

## Source
Created for Charlie to debug QClaw without manual command relay. Reviewed: true
