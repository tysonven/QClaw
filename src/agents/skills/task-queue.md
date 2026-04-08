---
title: Task Queue
---

# Task Queue Skill

Charlie uses this skill to manage the task queue — receiving, tracking,
and orchestrating work items.

## Supabase Table: charlie_tasks

Columns: id (uuid), status, type, title, description, instructions,
         assigned_to, created_by, priority (1=urgent, 3=low),
         result, error_message, metadata (jsonb), parent_task_id,
         created_at, updated_at, completed_at

Status values: pending | in_progress | blocked | completed | failed

Task types: build | research | automation | content | ops

## Telegram Commands

/task <title>     — create new task
/tasks            — list pending + in_progress tasks  
/done <id_prefix> — mark task complete

Webhook: POST https://webhook.flowos.tech/webhook/charlie-tasks

## Creating Tasks Programmatically

POST /rest/v1/charlie_tasks
{
  "title": "...",
  "type": "build",
  "description": "...",
  "instructions": "Full prompt/spec here",
  "priority": 1,
  "assigned_to": "claude-code"
}

## Sub-tasks

Set parent_task_id to link sub-tasks to a parent.
Charlie can break a large build task into sub-tasks and track each one.

## Rules

1. Always set instructions to a complete, actionable spec —
   enough for Claude Code to execute without clarification.
2. Mark tasks in_progress before starting work on them.
3. Always record the result or error_message when completing/failing.
4. Sub-tasks must be completed before the parent task is marked done.
5. Priority 1 tasks should be actioned immediately.
