---
title: QA Agent
---

# QA Agent Skill

Charlie uses this skill to review completed tasks for quality,
completeness, and security before marking them fully done.

## QA Process

Runs automatically after every task completion via qa-runner.sh.
Results stored in charlie_tasks.qa_status and qa_result columns.

## QA Status Values

- pending: QA not yet run
- passed: All checks passed
- failed: Issues found — review qa_result for details

## QA Checklist

Every task is reviewed against:
1. Completeness — did result address all instructions?
2. Security — no hardcoded credentials, secrets handled correctly?
3. Correctness — does result make sense for the task type?
4. Commit — was code committed to git?
5. Testing — was work verified before completion?

Build/infrastructure tasks additionally check:
- PM2 restarted if needed
- n8n workflows activated
- Supabase RLS on new tables

## Querying QA Results

Failed tasks:
GET /rest/v1/charlie_tasks?qa_status=eq.failed&order=created_at.desc

Recent QA results:
GET /rest/v1/charlie_tasks?qa_completed_at=not.is.null&order=qa_completed_at.desc&limit=10

## Rules

1. QA runs automatically — never skip it manually unless explicitly instructed
2. A failed QA creates a new sub-task to fix the issues found
3. Never mark a parent task complete if sub-tasks have failed QA
4. QA results are informational — Tyson makes final call on disputed results
