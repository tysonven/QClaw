# Resolving identifiers before the approval prompt

Design for items 2 and 3 of the remediation ordered on 2026-09-10, after the
audit of the 2026-08-27 composed-identifier incident. **Approved by Tyson on
2026-09-10 as designed. Not built.**

Revision 2, 2026-09-10. Tyson decided the fail-closed question and set three
constraints on how the split is expressed. Those constraints replaced the
recommendation in revision 1: the identifier convention is now derived from
what a skill already declares rather than from a new list. The measurements
that justify the change are in section 4.

**Read first:** section 4, "Resolved means the entity came back". Rule 2 as
originally written would have validated nothing; Tyson decided the fix after
approval, the same day.

Corrected after approval, the same day. Section 3 names three broken skills,
not four. Section 4 amends rule 2 per that decision and marks which surfacing
mechanisms have shipped or been decided. Section 5 carries the revised
countdown, section 6 the undecided resolver budget, and section 8 the decision
to fix rather than delete.

Anchors: QClaw `main` @ `86cea6d`. Counts re-measured against that tree and
against the live process on `qclaw-agent`.

---

## 1. The decision, and why it must survive into the code

**Fail closed by classification, not uniformly.** In Tyson's words, kept here
so the reasoning reaches whoever writes the comment:

> Fail-closed costs a refusal every time the resolver is unavailable. That
> price is worth paying to avoid an unvalidated financial write. It is not
> worth paying to add a CRM note. Uniform hard-fail across five GHL brands
> means every note, task and contact update is refused whenever GoHighLevel is
> slow, and a control people route around is worse than no control.

Three constraints follow, and each one changes the design rather than
decorating it.

| # | Constraint | Where it lands |
|---|---|---|
| 1 | The default must be the safe one. Declaring earns leniency. | Section 5: `unclassified` hard-fails |
| 2 | No per-skill allowlist of identifier fields. Prefer deriving. | Section 4: the index is derived |
| 3 | Soft-fail must be visible, not silent. | Section 6: the prompt and the row both say so |

Constraint 2 carries a warning worth recording, because it is the reason
revision 1's recommendation was withdrawn. A hand-maintained list has drifted
silently four times in this repo: the six-process restart list, the two-name
native rebuild list, the Dormancy Alerter's monitored set, and the `console.log`
exclusion list. Each was correct when written.

---

## 2. What is being fixed

Nothing on the path verifies that a caller-supplied identifier resolves to an
existing row before the operator is asked to approve a write. The gate keys on
the HTTP method alone, and the skill tool schema carries the whole request body
as one opaque JSON string, so the identifier reaches the gate as prose. The
only existence check is the trade engine's own lookup, and it runs after
approval.

Item 1 makes the identifier visible. This is the check.

---

## 3. The surface, re-measured

Revision 1 got this wrong and the correction matters, because it is itself an
instance of the drift constraint 2 is about.

Three skills present as HTTP surfaces, carry endpoint lines and an `http:`
permission, and **register zero tools**. Confirmed against the live process,
where every boot in `tool-call.log` shows ten skills registering and these
three absent:

| skill | why it registers nothing | issue |
|---|---|---|
| `ads-agency` | no `## Auth` section, so `Base URL:` is never read and the skill parses to null | #149 |
| `content-studio` | same | #150 |
| `clipper` | no `Base URL:`, endpoint lines use an em dash the endpoint grammar does not match, and a single-brace `{job_id}` the parser does not treat as a parameter | #151 |

The parser requires a base URL and at least one endpoint, and returns null
otherwise. Null means no tools. Nothing reported it until PR #148.

None of the three ever parsed, in any commit. The services behind all three
answered throughout. Tyson's decision is to fix them, not delete them. Two of
them need more than the parse fix: `ads-agency` and `content-studio` are
`category: specialist-scope`, which Charlie's router never routes, and
specialist spawning was retired on 2026-08-14, so a parse fix alone registers
tools that no turn activates.

An earlier draft of this section also listed `task-queue`. That was wrong: it
is `surface: prompt` with no `## Endpoints` section, its
`POST /rest/v1/charlie_tasks` is documentation prose, and it was delivered as
prompt content nine times in the live log. It is working as designed.

**This is the failure mode constraint 2 is guarding against, already present.**
Three skill files declare a surface that does not exist, and the only way to
find out was to go looking. Adding a second hand-maintained declaration to the
same files would inherit the same silence.

The real write surface is ten skills. Forty-three write endpoints parse.

---

## 4. Deriving the identifier index

**Proposal: derive from the skill's own `## Endpoints` block. Add nothing.**

A skill that has a path parameter has already declared that the token names an
entity, and a skill that has a GET ending at that parameter has already
declared what resolves it. Both facts are in the file today.

The rule, in three lines:

1. Per skill, index every `{{param}}` that appears in any endpoint path,
   excluding `{{secrets.*}}` and `{{config.*}}`.
2. Map each to the GET endpoint on the same resource whose path, with any
   query string stripped, **ends** at that parameter, if one exists. That GET
   is the resolver. It is keyed on the endpoint, not the parameter name, and
   it resolves only when the entity comes back (see "Resolved means the
   entity came back" below; decided after approval).
3. At the gate, resolve every write argument whose name matches an indexed
   parameter after normalising case and separators, **whether it arrived in
   the path or inside the body**.

Step 3 is what reaches the incident. `POST /positions/manual-close` has no path
parameter at all; `position_id` is a body field. But `position_id` is indexed
from the sibling endpoints, so a body field of that name resolves through the
same GET.

PR #148 already implements the derivation in rules 1 and 2, in
`src/agents/skill-diagnostics.js`, for its boot-time report. The build should
import that, not write a second one: two implementations of one rule are a
maintained list by another name.

### Measured coverage

Executed against the real skill files with the real parser:

| | |
|---|---|
| Write endpoints that parse | 43 |
| Path identifiers across them | 17 |
| Resolve to a GET already in the same skill, on `main` | 16 |
| Resolve once PR #142 lands | 17 |

The one miss on `main` is `position_id`, because `GET /positions/{position_id}`
does not exist yet. PR #142 adds it, and the index then closes.

Two cases worth naming because they are the ones that would have mattered:

- **The incident identifier.** `position_id` in the manual-close body resolves
  via `GET /positions/{{position_id}}`. The composed value
  `solana-110-aug-2026` resolves to a 404, so the write is refused and never
  becomes a prompt.
- **Case and separator drift.** GHL sends `contactId` in a body while the path
  declares `{{contact_id}}`. Normalising to lower case with separators removed
  makes these the same token, verified against both spellings.

### What derivation cannot see, stated plainly

An identifier whose name appears in **no** path in its skill is invisible to
the index. Two live examples:

- `market_url` on manual-close, which is how approval 125 was keyed. It is not
  a path parameter anywhere in trading-api.
- Stripe's `customer` field on `POST /invoices`. The skill indexes
  `customer_id` from `GET /customers/{{customer_id}}`, and `customer` does not
  normalise to it.

Under constraint 1 both hard-fail, which is the direction we can live with, and
both are visible the first time the write runs. Neither becomes an unchecked
write. `n8n-router` is the one parsing skill with writes and no path identifier
anywhere, so all six of its webhook posts have nothing to resolve.

**"Nothing to resolve" and "could not resolve" are different states and must
not collapse.** A webhook post carrying no identifier is not a failure; it
proceeds to the prompt with the subject block saying no identifier was present.

### Resolved means the entity came back (decided 2026-09-10, read this first)

Found reading the design after approval, and decided by Tyson the same day.

As originally written, rule 2 would have shipped a validation layer that
validates nothing. The parser's `path` includes the query string
(`src/agents/skill-parser.js:98`), so "ends at the parameter" matches filters
as well as identifiers: `{{query}}` on six GHL contact-search GETs, and
`{{status}}` on n8n-api's executions filter. A search answers 200 for any
value, so a body field named `query` would come back `resolved` with nothing
checked. And n8n-api uses `{{id}}` for both `GET /workflows/{{id}}` and
`GET /executions/{{id}}`, so a name alone cannot pick between them. Both are
latent today (n8n-api has no writes, and GHL write payloads were not audited
for a `query` field), which is why they are settled before the gate turns on
rather than found after.

**The decision:**

- **A resolve succeeds only when the entity comes back**, carrying the
  identifier that was asked for. A 2xx alone is not a resolve: an empty list,
  a search result, or an entity with a different identifier is "could not
  resolve". This is the same require-a-positive-marker rule as the gate work.
- **The resolver keys on the endpoint, not the parameter name.** That is what
  settles `{{id}}`.

What that implies for the derivation, to be pinned by tests against the real
skill files rather than decided here:

- Strip the query string before deriving resolvers. A query-string parameter
  is never an identifier.
- For each write, the resolver is the GET on the same resource whose path ends
  at the parameter. A body field whose name matches more than one candidate is
  "could not resolve", never a guess.

### What surfaces a skill with none

Constraint 2 asks this explicitly, and it is the part a derivation scheme owes.
Three mechanisms, none of them a list:

1. **Static, at boot. Shipped in PR #148**, as a boot-time diagnostic called
   from `src/agents/registry.js` rather than in `scripts/verify-coupling.js`.
   It names the file, the line, the cause and the fix for a skill that declares
   an HTTP surface and registers nothing, and it reports a write whose path
   parameter has no resolver. The per-skill counts are still owed and belong
   beside it: writes parsed, identifiers indexed, identifiers with a resolver,
   writes unclassified.
2. **A CI assertion. Decided against as a build gate.** Tyson preferred the
   boot-time error, because a skill can be edited on the host where CI never
   runs.
3. **At runtime.** An unindexed identifier on an unclassified endpoint is
   refused, loudly, the first time it is called. A forgotten declaration
   produces a refused write, not a silent bypass.

---

## 5. Classification, and the one thing that must be declared

Identifiers are derived. Classification cannot be: the whole finding of the
audit's fifth question is that the verb does not carry the information.
`POST /simulate` writes nothing and `POST /positions/manual-close` writes the
profit column, and today both classify `medium`. Every trading approval ever
recorded is `medium`; all 88 `high` rows are shell commands.

So one declaration is unavoidable. Constraint 1 is what makes it safe:

| level | meaning | identifier behaviour |
|---|---|---|
| `financial` | moves money or writes a money column | hard-fail |
| `destructive` | overwrites or deletes unrecoverably | hard-fail |
| `mutating` | any other state change | soft-fail, stated in the prompt |
| *(undeclared)* | nobody has said | **hard-fail** |

Undeclared is not a fourth level. It is the absence of one, and it is
deliberately not defaulted to `mutating`, because that is the value that would
make a forgotten declaration silent. Showing `financial` would be a lie;
showing `unclassified` is true and tells the operator that nobody has said what
this endpoint does.

`DELETE` with no declaration reads as `destructive`, so current behaviour is
never weakened by omission.

This inverts revision 1, which defaulted to `mutating`. That was wrong for
exactly the reason constraint 1 gives.

### The migration cost, stated rather than discovered

On the day this turns on, every write on every skill is unclassified and
therefore hard-fails. That is 43 endpoints on `main` @ `86cea6d`, or 49 if
#149 to #151 land first: fixing those three skills adds six writes
(`ads-agency` 4, `content-studio` 1, `clipper` 1). **The rollout order is:
declare first, enable second**, and the per-skill count is how you know you
are done. It should be a countdown to zero unclassified writes, run before the
gate change ships, not after.

---

## 6. Soft-fail must be visible

Constraint 3. A `mutating` write that proceeds with an unresolved identifier
must say so, or the operator cannot tell a validated approval from an
unvalidated one, which is the same defect as a risk label that never varies.

Two places, because the prompt is a moment and the row is the record.

**In the prompt**, using the subject block item 1 already ships:

```
Subject:
  contact_id ocQHyuzHvysMo5N5VsXc: NOT VERIFIED
  The CRM did not answer within 5s. This approval was not validated.
  Approving it accepts an identifier nobody has checked.
```

The `5s` is illustrative. The resolver's own timeout budget has not been
decided: skill fetches on `main` use 15s (`src/agents/skill-parser.js:260`)
and PR #143 raises writes to 45s. The resolver GET sits between the call and
the prompt, so its budget is a design decision for the build, not a default.

**In the approvals row**, a `validated` column recording `resolved`,
`unverified`, or `none_present`. Without it, a month later the row for a
validated approval and the row for an unvalidated one are identical, and the
question "was this one checked?" has no answer. This is a small schema
addition to a table created with `CREATE TABLE IF NOT EXISTS`, so it needs a
migration step rather than an edit to the create statement.

The machinery exists: item 1 already carries a `subjectStatus` of `resolved`,
`failed`, `no_resolver`, `no_identifiers` or `empty` through to the notifier.
This is wiring it to a column and a sentence, not new plumbing.

---

## 7. The three questions, answered

**1. Declaration convention.** Derive the identifier index from the skill's own
endpoint block (section 4). Declare classification only (section 5). Code
resolvers stay as an override for the cross-service case, which is the one
thing derivation structurally cannot express. Revision 1's `## Identifiers`
section is withdrawn: it was a maintained list, and section 3 is what those go
on to look like.

**2. Fail-closed split.** Decided: split. Expressed as section 5, with
undeclared hard-failing.

**3. GHL `PUT /contacts/{{contact_id}}`.** Recommend leaving it **unclassified
for now**, which hard-fails, rather than classifying it `mutating`.

Revision 1 recommended `mutating` on the grounds that GHL retains field
history and the write is therefore recoverable. **That claim was not verified
and should not have been stated.** Checking it needs a write against a real
location, which is not something to do to settle a documentation question.

Constraint 1 makes this decision cheap: unclassified is safe, so the cost of
not deciding is a refusal rather than an unchecked overwrite. Classify it
`mutating` when someone has confirmed recoverability, and record how they
confirmed it.

---

## 8. Sequencing

1. PR #142 and PR #143 land. #142 also closes the last hole in the derived
   index.
2. Read the boot diagnostic from PR #148. Fix the three zero-tool skills in
   section 3 (#149, #150, #151). Tyson decided fix, not delete.
3. Parser change: the `[level]` endpoint prefix, plus the derived index built
   at registration, importing #148's derivation. Additive; a skill with
   neither behaves exactly as today.
4. Declare classifications across all writes. Countdown to zero.
5. Gate change: resolve before prompting, fail by level.

Steps 3 and 5 want separate PRs. A parser change that returns null disables a
skill silently, which section 3 shows is not hypothetical, and it deserves its
own review and its own boot-diagnostic run.

---

## 9. Out of scope

Constraining Charlie from composing identifiers, per the instruction of
2026-09-10. The finding was that nothing checks, and Charlie is one of several
callers.
