# Keyword Reference

This is the cheat sheet for which keywords trigger which skills in Charlie's prompt assembly. It exists because keyword-based routing is brittle — Tyson uses this to be deliberate about loading the right skill into Charlie's context.

This will be retired when intent classification replaces keyword routing (planned Phase 5+, after 2-4 weeks of routing telemetry).

## Always-on skills (always loaded, no keyword needed)

These load on every prompt regardless of message content:

- `identity.md` — Charlie's role spec
- `lanes.md` — in-lane vs out-of-lane behaviour, escalation paths
- `verification-reflexes.md` — cite-or-don't-claim, audit-before-brief, verify-before-claim
- `architecture-pillars.md` — 7 Pillars framework
- `security.md` — security gate checklist, credential rules
- `delegation.md` — routing work to Claude Code, specialists, Tyson
- `bootstrap-awareness.md` — Charlie's understanding of his own bootstrap state

## On-demand skills (triggered by keywords)

| Keyword(s) | Skill loaded |
|---|---|
| build, modify, fix, implement, deploy, ship | `build.md` |
| qa, test, audit, verify | `qa.md` |
| schedule, task, delegate, queue | `task-queue.md` |
| trade, trading, scanner, position | `trading.md` |
| Emma + content/podcast/reel/Buzzsprout | `content-studio.md` |
| clip, clipper, vertical, captions | `clipper.md` |
| community, members, engagement, GHL communities | `community-manager.md` (variant by business unit context) |

## Combination triggers

Some keywords are too ambiguous on their own. They only trigger skill loading when paired with a domain keyword:

- "Emma" alone → no skill triggered (Emma comes up in non-content contexts)
- "Emma" + content/podcast/reel/Buzzsprout → `content-studio.md`
- "community" + GHL or specific portal name → routes to correct community-manager variant

## Hard limits

- Hard cap of 4 on-demand skills per prompt
- If more than 4 keywords match, top 4 by keyword density load
- Dropped skills logged in skill load log

## How to use this file

When you want Charlie to load a specific skill, include the trigger keyword in your message. Example:

- "Help me think through the Trading scanner heartbeat" → triggers `trading.md`
- "Audit the dashboard wiring" → triggers `qa.md` and `build.md`
- "Walk me through this n8n workflow" → triggers `build.md`

When you want Charlie to *not* load a skill, avoid the keyword. Example:

- Casual mention of Emma without content keywords → `content-studio.md` not loaded
- General "what's pending" question → no on-demand skills loaded

## Maintenance

This file is updated whenever skills are added, removed, or routing rules change. Updates require Tyson approval per the canonical doc maintenance rules.
