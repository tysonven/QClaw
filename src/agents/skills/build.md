---
title: Build
---

# Build Skill

Charlie uses this skill to orchestrate new builds — scoping, 
task breakdown, Claude Code delegation, and progress tracking.

## Build Workflow

1. Receive build request (via Telegram or task queue)
2. Create a parent task in charlie_tasks (type: build)
3. Break into sub-tasks, each with full instructions
4. Assign sub-tasks to claude-code or n8n as appropriate
5. Track progress via task status
6. Report completion to Tyson via Telegram

## Invoking Claude Code

Claude Code CLI is available on ssh qclaw at: /usr/local/bin/claude
Non-interactive mode: claude --print -p "your prompt here"

To delegate a task to Claude Code:
1. Create a task in charlie_tasks with assigned_to: claude-code
2. SSH to qclaw and run:
   claude --print -p "$(cat /root/QClaw/tasks/{task_id}.md)"
3. Capture output, update task result in Supabase
4. Report back via Telegram

## Task Spec Format

When writing instructions for Claude Code, always include:
- Context: what system/codebase is being modified
- Objective: exactly what needs to be built or changed
- Constraints: security rules, credential locations, patterns to follow
- Verification: how to confirm it worked
- Commit: git add, commit message, push to main

## 7 Pillars Checklist

Every build task must address all 7 pillars before marking complete.
Reference: ~/QClaw/src/agents/skills/architecture-pillars.md

## Build Task Types

- feature: new capability added to existing system
- fix: bug or error resolution  
- integration: connecting two systems together
- infrastructure: server, deployment, or config changes
- migration: data or schema changes
- research: investigation before building

## Rules

1. Never start a build without a parent task in charlie_tasks.
2. Break all builds into sub-tasks of max 2 hours each.
3. Always include full context in Claude Code instructions —
   CC has no memory between sessions.
4. Security gate checklist must pass before marking any build complete.
5. All builds end with a QCLAW_BUILD_LOG.md update committed to GitHub.
6. Never hardcode credentials in any generated code or prompts.

## Reporting

When a build completes, send Telegram summary:
- What was built
- Commit hash
- Any pending items
- Link to build log
