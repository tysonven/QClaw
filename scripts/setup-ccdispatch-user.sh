#!/bin/bash
# Slice 5 — create the unprivileged `ccdispatch` user that runs Claude Code.
#
# This is the STRUCTURAL secret-read control: the dispatcher runs as root (to read
# /root/.quantumclaw/.env and write Supabase), but spawns Claude Code as `ccdispatch`,
# which by kernel file-permissions CANNOT read /root/.quantumclaw/.env (600 root),
# /root/.ssh, /root/.pm2, other users' files, host keys, or /proc/<root-pid>/environ —
# regardless of which CC tool (Read or Bash) issues the request. The CC --settings
# deny-list is only defence-in-depth on top of this.
#
# Run once on qclaw as root:  sudo bash scripts/setup-ccdispatch-user.sh
set -euo pipefail

USER=ccdispatch
HOME_DIR=/home/$USER
WORK_ROOT=$HOME_DIR/work

if id "$USER" &>/dev/null; then
  echo "user $USER already exists"
else
  useradd -r -m -d "$HOME_DIR" -s /usr/sbin/nologin "$USER"
  echo "created system user $USER (no login shell)"
fi

mkdir -p "$WORK_ROOT"
chown -R "$USER:$USER" "$HOME_DIR"
# 700 so no other non-root user can read CC working clones (which may contain repo
# source). root still can (it owns the dispatcher); ccdispatch owns its own tree.
chmod 700 "$HOME_DIR" "$WORK_ROOT"

# Confirm the user genuinely cannot read the secret (proof the control holds).
if sudo -u "$USER" cat /root/.quantumclaw/.env &>/dev/null; then
  echo "FATAL: $USER can read /root/.quantumclaw/.env — refusing. Check perms (must be 600 root)." >&2
  exit 1
fi
echo "verified: $USER cannot read /root/.quantumclaw/.env"
echo "work root: $WORK_ROOT  (uid=$(id -u "$USER") gid=$(id -g "$USER"))"
