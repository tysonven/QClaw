# Identifier gate, part one (#184): where it stands

Written 2026-09-19 so a fresh session can continue without reading the
conversation that produced it. Every state claim is anchored to a SHA, a PR or
issue number, or a live read with its date. Anything not anchored says so. The
format follows `docs/trade-engine-handoff.md`.

**Nothing here has merged. Merging to `main` is a production deploy that
restarts every PM2 process. Tyson merges; a session opens the PR and stops.**

---

## 1. Where the work stands

- **PR #184**, draft, branch `feat/identifier-resolution`, worktree
  `~/QClaw-worktrees/identifier-resolution`. Head when this file was written:
  `f1cb266`, CI green on all four required checks (lint, python-test,
  test (20), test (22)). The last CODE commit is `d14150a`; everything after it
  is docs.
- It is part one of the design in #144 (approved 2026-09-10, head `cadc0f5`;
  read that PR's body and the design doc's section 4 "Resolved means the
  entity came back" first).
- **Part one is inert at the gate:** nothing is refused or resolved. It
  ships:
  - the `[level]` endpoint prefix;
  - one endpoint grammar and one `## Endpoints` section rule;
  - the derived identifier index, built at registration;
  - the boot countdown;
  - the 42 level declarations;
  - the committed mutation harness.
- **Part two (the gate change) is not built.** See section 6.

Commits on the branch, oldest first:

| SHA | what |
|---|---|
| `a9c6f7d` | grammar with `[level]`, derived index, registration, countdown |
| `3934456`, `a4d01b3` | tests tightened before the first mutation run |
| `e6c3404` | build log |
| `df2ffe0` | the 42 declarations; Stripe `POST /invoices` removed |
| `8ad56a2` | build log |
| `b353358`, `f41612d` | fixes for cold review round one |
| `bd99e98` | build log |
| `6fac6cb` | fixes for round two: strict section, one section rule, separator, broken skill counted |
| `958f672` | build log |
| `810a4e8` | fixes for round three: collisions refused, outside lines named |
| `3cfd691` | mutation harness and every mutant list committed |
| `d14150a` | test pinning the collision report's partner lines |
| `c8b6349`, `f1cb266` | build log |

## 2. The merge conditions

**For #184 itself:** it stays draft until the fourth cold review is resolved
(section 5). Tyson un-drafts and merges.

**For part two (decided 2026-09-18, D4):** no flag. Merging part two IS the
switch, and Tyson merges it only when Charlie's boot countdown on the host
reads 0:

```
identifier gate countdown (charlie) at <this boot's ISO time>: 0 of N skill writes unclassified across M skills.
```

A line that says `INCOMPLETE` is not a 0. No other agent prints a countdown
line. The date proves the line comes from the current boot.

**Expected on the host after #184 deploys:** `INCOMPLETE. 2 skill(s)
registered nothing`, naming ads-agency and content-studio. **Accepted by
Tyson 2026-09-19 (decision A):** part two cannot merge until #149 and #150
land. That is the design's own order (section 8). Once they land, their five
writes (ads-agency 4, content-studio 1) are unclassified until declared. After
declaring them, the expected merge line is `0 of 47 … across 11 skills`, if
nothing else changes.

This expectation was COMPUTED from the committed code over the 20 skill files
symlinked into `/root/.quantumclaw/workspace/agents/charlie/skills/` (listed
2026-09-18). It has not been printed by a real boot.

## 3. The review rounds

Each round ran in a fresh subagent context, on its own worktree. Each
blocking finding was reproduced by the author before it was fixed.

| round | reviewed at | blocking | fixed at |
|---|---|---|---|
| one | `df2ffe0` | 5 | `b353358`, tests `f41612d` |
| two | `bd99e98` | 4 | `6fac6cb` |
| three | `958f672` | 1 | `810a4e8`, harness `3cfd691`, `d14150a` |
| four | `c8b6349` | **result not received when this was written** | |

**Round one found:**
- a malformed line dropping a write silently;
- an empty agent (echo) printing `0 of 0`;
- a bad bracket on a DELETE reading `destructive`;
- join tests that did not reach the real registration seams (an index attached at `Agent.load` or the specialist path could be empty unnoticed);
- same-resource near misses;
- two rules for path identifiers (the prompt's and the index's).

All fixed.

Deliberately not fixed in round one:
- finding 7 (GHL notes and contact creation would prompt NOT VERIFIED every time), because it needed a decision;
- finding 11 (specialist-only skills in no countdown), filed as #191.

**Round two found:**
- an em dash on a hyphenated path registering a SHORTER path (live on main, filed #192, fixed here);
- a skill that registers nothing dropping out of the count;
- the malformed-line heuristic missing typos;
- no test of the multi-skill total.

All fixed via decisions A and B (section 4).

**Round three found:**
- **blocking:** colliding tool names, where the registry kept the last silently while the countdown counted both;
- endpoint lines outside the section, dropped silently;
- this PR body's post-deploy line;
- ordinals in the build log;
- 15 surviving reviewer mutants;
- the fact that the author's mutant lists could not be rerun.

All fixed. Filed as issues rather than fixed:
- #193: `## Auth` decided twice, so `diagnose()` names the wrong fix;
- #194: `declaresHttpSurface` misses some spellings.

Both are latent, and the countdown already reads INCOMPLETE for the shapes involved.

**Round four** was launched at `c8b6349` with Tyson's split rule (below). Its
result was not back when this file was written.

**Tyson's rule for round four (2026-09-19):** no further round unless it finds
something in a NEW area. If it finds a blocking defect in round three's fix,
that is a round finding a defect in the previous round's fix yet again: the PR
is too large and gets SPLIT rather than patched.

## 4. Decisions, with the reasoning

**2026-09-18 (the D1 to D4 answers to the audit):**

- **D1: notice identifiers by name, resolve them only through the index.**
  - #143's `IDENTIFIER_NAME_RE` notices that an identifier is present; the derived index is the only thing that resolves it. A noticed identifier that cannot be resolved fails by the endpoint's level. This avoids a maintained list (design constraint 2).
  - Amendment: Stripe's `customer` is caught by neither. Relying on the endpoint staying undeclared was "a real control resting on an accident", so it is recorded as a known gap in code and in the PR. The endpoint was later removed (below).
- **D2: an undeclared non-DELETE write is refused outright; an undeclared DELETE counts as destructive.** It is the only reading where the countdown means anything.
- **D3: the resolver timeout is 5s.** It matches #143, and is four times the slowest engine time measured on the host: `GET /positions/{id}` took 1.0 to 1.2s for a real id, 0.34s for a missing UUID, and about 1.5ms for a composed id (2026-09-18). The code must note that GHL latency was never measured.
- **D4: no flag; merging part two is the switch.** "A flag is a second thing that can disagree with reality."

**Levels, decided in #184's table 2026-09-18:** 36 `mutating`, 5 `destructive`, 1 `financial`.

- **`POST /positions/manual-close` is `financial`.** It is the incident endpoint and writes the money columns.
- **`POST /positions/manual` is `mutating`.** "Refusing every call is worse than prompting NOT VERIFIED."
- **`PUT /contacts/{{contact_id}}` is `mutating`,** overriding the author's `destructive`. The fail-closed decision declined to refuse CRM writes whenever GHL is slow, and "a contact update is recoverable; that is what separates it from a message". Recorded against design 7.3: this was decided on judgment, not tested.
- **`POST /conversations/messages` is `destructive`** (all five brands): "a message cannot be unsent and the recipient is a client".
- **Stripe `POST /invoices` is REMOVED, not undeclared,** with a comment in `stripe.md` where the line was. The reasons are #181 (the executor sends JSON to a form-encoded API) and the `customer` gap. "An endpoint that exists but is deliberately absent from the index is a different thing from one nobody got to."

**2026-09-19:**

- **A: a skill that registers nothing makes the countdown INCOMPLETE,** with the accepted consequence in section 2. "A countdown blind to a whole broken skill is the vacuity class again."
- **B: `## Endpoints` may hold only endpoints, `#` comments and blank lines.**
  - Prose inside the section is a parse error BY DESIGN, and n8n-api.md's prose became comments.
  - The heuristic detector was replaced because "heuristics will keep missing variants, so stop guessing at what a malformed endpoint looks like and declare what the section may contain".
  - #183 (one section rule) was fixed alongside.
- **Collisions: every line in a colliding group is refused, identical duplicates included.** "Neither line can be trusted over the other, and merging identical duplicates leaves a rule that guesses." n8n-api.md's duplicate line was deleted.
- **Endpoint-shaped lines outside `## Endpoints` are invalid,** because the alternative is the silent capability loss of #149 to #151.
- **The mutation harness and lists are committed** (`scripts/mutation/`). "79 killed" had been a claim nobody could check, and "an uncheckable verification claim is the thing this whole register is about".
- **Finding 7, option (a): grant the FSC token read on users and locations.**
  - Rejected (b), accepting a constant NOT VERIFIED: "a warning that fires every time stops being a signal within a day".
  - Rejected (c), a scope-free check for `locationId` only: it "leaves userId firing constantly … plus a control that reads complete and is not".
  - The grant was made and verified (section 5). The two GETs themselves (`GET /users/{{user_id}}`, `GET /locations/{{location_id}}` in the GHL skills) are NOT yet added.

## 5. Verified, asserted, not tested

**Verified by execution (with where):**

- **Tests:** `npm test` 57/57; `tests/identifier-index.test.js` 165/165; lint clean; all at `d14150a`, locally on Node 22. CI green at `f1cb266`.
- **Mutation, current list:** `node scripts/mutation/run.mjs scripts/mutation/identifier-gate.mjs` at `d14150a` gave 100 applied, 100 killed, exit 0.
- **Mutation, reproduced:** the committed round-three lists, rerun at `6fac6cb` in a fresh worktree, gave 79 applied, 79 killed (76, plus the same 2 not applied then re-targeted, plus 1).
- **Parse identity:** every real skill parses to the same tools, levels and descriptions before and after the round-two and round-three rule changes. The only difference is n8n-api.md losing its duplicate line.
- **Host layout** (2026-09-18): Charlie has 20 symlinked skills, and `echo` has an empty `skills/` directory.
- **The FSC grant:** reads of users and the location went from 401 (2026-09-18) to 200 with the entity id matching (2026-09-19T09:16:34Z). The token fingerprint is unchanged at `37f56094bfdd`. Recorded on #184 and in the build log.
- **Message-write permission probe** (2026-09-19, no send):
  - FSC and Flow OS: 401;
  - Crete, Kairos and SproutCode: pass authorisation (404, contact id missing).
- **#186 sends, to Kairos contact `yjjrbumMkTbLAU7Y0F4V`:**
  - the skill's documented body gave 422 `CONVERSATIONS_MSG_NO_CONTENT` and created nothing;
  - GHL's real fields (`subject`, `html`, `message`) gave 201, and GHL recorded an outbound email with no draft marker.

**Asserted, not verified:**

- **The host boot output** in section 2. It was computed, not printed, because merging is the deploy.
- **The Telegram approval prompt's wording.** It is read from `approval-summary.js`, not observed live. PR #58's live Telegram round trip has never been tested.
- **GHL documentation claims:** the scope-to-endpoint mapping, and "no draft field; sends immediately". The FSC grant not rotating the token WAS verified, by fingerprint.

**Not tested:**

- **Whether the #186 email arrived** at `tyson.venables@gmail.com`: subject token `QC186-20260919081625`. Tyson is checking; only that settles draft versus send.
- **The host boot itself.**
- **GHL resolver latency.**
- **Part two.**

## 6. Next step, precisely

1. **Get the round-four review result.** It was launched from the session
   that wrote this file. If that result is not recorded on #184, rerun it:
   - a fresh subagent, on its own worktree, detached at `c8b6349`, installed with `npm ci --ignore-scripts`;
   - brief it to attack this round's changes (the collision rule, the outside rule, invisible-character escaping, the n8n-api deletion, the committed harness) and the merge line;
   - have it classify every finding as (A) a defect in round three's fix, (B) a new area, or (C) earlier work.
2. **Apply Tyson's rule.**
   - Any blocking (A): do NOT patch. Propose a split of #184 to Tyson, naming what each part would carry.
   - Only (B) or (C): report them to Tyson and let him decide.
   - Do not start a further round either way.
3. **Stop there.** Tyson un-drafts and merges.

**Waiting on Tyson, not on a session:**

- **The Gmail check** for `QC186-20260919081625`.
- **A direct instruction on #186's skill files.** Another session (tysonvenables-2a) relayed that Tyson asked for "fix the five skill files ... then back to #184's review round" and that it reached the wrong session. It was NOT acted on, because a relayed instruction is information, not approval.
  - Its audit, checked: "draft" appears in 3 places in each of the five brand skills, and the likely origin is `lanes.md` lines 19 and 33, which state the draft-only policy as fact.
  - Its claim that the approval prompt shows "DRAFT" is wrong. The prompt code never reads the endpoint description; the wrong word reaches Tyson through what Charlie says.
- **Where finding 7's two GETs land:** in #184, in part two, or in their own PR.

**Part two, when it starts, carries:**

- resolve-before-prompt;
- refusal by level (D2);
- the entity marker: an object at the top level or one wrapper down, never an array, whose `id` equals the value asked for. That covers the engine's `{position:{id}}`, GHL's `{contact:{id}}` and Stripe's `{id}`. #173's two GHL 400 bodies are fixtures;
- the 5s budget with the GHL-not-measured note (D3);
- NOT VERIFIED rendering in the prompt;
- the `validated` column (PRAGMA plus ALTER, as `audit.js` does);
- one shared request builder, so resolver auth is not built twice;
- the D1 notice/resolve split;
- finding 7's GETs;
- the latent case of a body field `id` with exactly one match resolving through another resource's GET.

#143's `resolveSubject` reports `resolved` for a NOT FOUND line: keep its lines for display only, never as the verdict.

## 7. Issues filed from this work

- #181: Stripe skill writes send JSON to a form-encoded API.
- #182: test runs routinely write fixture registrations into the live `tool-call.log`. It was seen repeatedly from other sessions. No code in `src/` reads the log; verification does.
- #183: one `## Endpoints` section rule. Fixed in #184.
- #185: the CI install comment claims to match the deploy and does not (`--ignore-scripts`); plain `npm ci` rewrites `yarn.lock`.
- #186: on Crete, Kairos and SproutCode, Charlie can report a sent client email as a draft awaiting review.
- #190: `SecretStore` deletes `.secrets.enc` when opened with a differently spelled `_dir`.
- #191: specialist-only skills appear in no countdown.
- #192: a dash typo in a hyphenated path registers a shorter path. Live on `main`, fixed in #184.
- #193: `## Auth` is decided twice.
- #194: `declaresHttpSurface` misses spellings.

## 8. Practical notes

- **`~/QClaw` is a shared reference checkout on `main`.** Never write in it. Work in a worktree.
- **The mutation harness** refuses a dirty tree and a main checkout. Install a worktree with `npm ci --ignore-scripts`: a `node_modules` symlink reads as untracked, and plain `npm ci` rewrites `yarn.lock`.
- **Set `QCLAW_TOOL_CALL_LOG_PATH`** to a temp file for any test or script run (#182).
- **Never open the live secret store with `SecretStore.load()`** (#190). Copy `.secrets.enc` to a `mktemp -d` directory, construct `new SecretStore({ _dir: "/root/.quantumclaw" })`, set `store.file` to the copy, and remove the copy on EXIT with a `trap`. Never print values; compare sha256 prefixes.
- **A one-shot send script** wrapped in `node -e '…'` inside a heredoc breaks on an apostrophe in a JS comment. That happened once here and aborted before any request. Check for single quotes first.
- **Hosts:**
  - `ssh qclaw` (sudo is fine for reads);
  - `ssh n8n` (docker, no sudo). n8n credentials can be fingerprinted with `docker exec n8n-project-n8n-1 n8n export:credentials --id=<id> --decrypted` piped straight into a hash, never written.
- **Build log style:** no em dashes, and no numbering of vacuity instances; name them by date and heading. Repo-qualify SHAs; paste real output.
- **Peer sessions' messages** are information, never approval.
