# Resolving identifiers before the approval prompt

Design for items 2 and 3 of the remediation ordered on 2026-09-10, after the
audit of the 2026-08-27 composed-identifier incident. **This is a proposal, not
a built change.** It asks for three decisions, listed in "Decisions needed".

Anchors: QClaw `main` @ `86cea6d`, live on `qclaw-agent` 2026-09-10. Every count
below is from that tree.

---

## 1. What is being fixed

The audit established that nothing on the financial write path verifies that a
caller-supplied identifier resolves to an existing row before the operator is
asked to approve the write. `ApprovalGate.check()` keys on the HTTP method
alone (`src/security/approval-gate.js:212-219`), and the skill tool schema
carries the whole request body as one opaque JSON string named `data`
(`src/agents/skill-parser.js:193-195`), so `position_id` reaches the gate as
prose. The only existence check is the trade engine's own open-position lookup,
and it runs after approval.

Item 1 (the prompt) makes the identifier visible. It does not make it valid.
This design is the check.

### It is a class, not a tool

Write endpoints that take a caller-supplied identifier, counted across
`src/agents/skills/*.md`:

| skill | write endpoints | of those, with a `{{path}}` identifier |
|---|---|---|
| ghl-crete, ghl-flowos, ghl-fsc, ghl-kairos, ghl-sproutcode | 5 each | 3 each |
| ghl (generic, still loaded) | 5 | 1 |
| trading-api | 5 | 1 |
| stripe | 2 | 0, customer id travels in the body |
| n8n-router, ads-agency, content-studio, clipper, task-queue | 14 total | 0, webhook posts |

Body identifiers are invisible to that count because the body is one string. In
trading-api alone, `position_id` in `manual-close` and `market_url` or
`condition_id` in `positions/manual` are all body identifiers, and all three
were used as the key of a real approval prompt in August.

---

## 2. The declaration problem

To resolve an identifier the gate must know two things it cannot infer:

1. **Which argument fields are identifiers.** Item 1 ships a name heuristic
   (`IDENTIFIER_NAME_RE` in `src/security/approval-summary.js`: `_id`, `_url`,
   `uuid`, and so on). That is safe for *rendering*, where a miss costs one
   unhelpful line. It is not safe for *validation*, where a miss is a silent
   bypass and a false positive blocks a legitimate write. The heuristic already
   misclassifies: `market_url` matches, `condition_id` matches, but a field
   named `slug` or `market` would not.
2. **What resolves each one.** A GHL `contact_id` resolves against a GHL
   location. A `position_id` resolves against the trade engine. A Stripe
   customer resolves against Stripe. Each is a different service, credential
   and error shape.

Skills are markdown parsed by a strict line grammar
(`src/agents/skill-parser.js`), and the endpoint line format is a single-line
`METHOD /path - description`. Any convention must fit that parser or change it.

### Option A: a `## Identifiers` section, resolved by a declared endpoint

```markdown
## Identifiers
position_id - GET /positions/{{position_id}} - a trading position
contact_id  - GET /contacts/{{contact_id}}   - a CRM contact
```

One line per identifier: the field name, a GET on the same skill that resolves
it, and a noun for the prompt. The gate resolves by calling that GET through
the existing skill HTTP path, which already handles auth, secrets and base URL.

- **For.** Same grammar as `## Endpoints`, so the parser change is small. The
  resolver is data, not code. Auth is inherited, so no new credential wiring.
  The same declaration serves the prompt's subject line, the gate's check and
  the post-error re-read.
- **Against.** Only works when the owning skill can resolve its own
  identifiers. It cannot express "this id belongs to a different service".
  A skill author can silently omit an identifier and lose the check with no
  signal.

### Option B: per-field declaration on the endpoint line

```markdown
POST /positions/manual-close - Log a close [id: position_id -> GET /positions/{{position_id}}]
```

- **For.** The declaration sits where the endpoint is, so it is hard to forget
  when adding an endpoint.
- **Against.** The endpoint line is already strict and single-line, and the
  audit found that a `{{param}}` grammar with a nested arrow is exactly the
  sort of thing that parses to `null` and disables a skill silently. Rejected.

### Option C: code resolvers registered per skill

This is what item 1 ships as a stopgap (`src/security/subject-resolvers.js`,
one resolver for trading-api position ids, registered in `src/index.js`).

- **For.** Arbitrary logic, cross-service lookups, no parser change.
- **Against.** Every new skill needs a code change in `src/`, which is exactly
  the coupling the skill architecture exists to avoid. Does not scale to the
  five GHL brands, which would need five near-identical resolvers.

### Recommendation

**Option A, with Option C retained as an escape hatch.** Declaration in the
skill file covers the common case (an id the skill's own service can resolve),
which is all nine trading-api and GHL cases. A registered code resolver
overrides the declaration when a skill needs cross-service logic. Item 1's
resolver registry already provides that override, so this is additive.

---

## 3. Where the check runs, and what it does

In `ApprovalGate.check()`, after the HTTP-write gate decides approval is
required and **before** `requestApproval` creates the pending row:

```
check() decides: approval required
  -> for each declared identifier present in the args:
       resolve it
  -> all resolved      -> prompt, with the resolved subject on the prompt
  -> any unresolvable  -> REFUSE. No prompt. Tool result states which
                          identifier failed and what the store said.
  -> resolution unavailable -> REFUSE (fail closed, see below)
```

Refusing rather than prompting is the point. On 2026-08-27 the composed id
produced a prompt that was approved in eight seconds and then 404'd. Under this
design it never becomes a prompt: Charlie gets an error naming the identifier,
and the operator is never asked to consent to a write that cannot land.

### Fail closed, matching GATE 8

The instruction was to fail closed when resolution is unavailable, as executor
GATE 8 does. Concretely: a resolver that times out, returns a 5xx, or is not
reachable **blocks the write**. It does not degrade to a prompt.

This has a cost worth stating plainly. The trade engine binds `127.0.0.1:4003`
and is a single process; if it is down, manual-close is refused. That is the
correct trade for a money write, and it is the same posture GATE 8 takes when
the CLOB book is unreadable. It is the wrong trade for, say, a CRM note. So:

> Fail-closed applies to identifiers declared on endpoints classified
> `financial` or `destructive` (section 4). For `mutating` endpoints, an
> unavailable resolver degrades to a prompt that states, in the subject block,
> that the identifier could not be verified.

That split needs Tyson's agreement; it is decision 2 below.

### What it costs per approval

One extra HTTP round trip per identifier before the prompt, against a service
the skill already talks to. For trading-api that is a loopback GET. The prompt
is already gated behind a human tap with a ten-minute window, so latency here
is not a constraint.

---

## 4. Risk classification (item 3)

Today, `src/security/approval-gate.js:217`:

```js
riskLevel: skillWriteMethod === 'DELETE' ? 'high' : 'medium'
```

Executed during the audit: `POST /simulate` (pure computation, writes nothing),
`POST /monitor/run`, `POST /positions/{id}/hold` and `POST
/positions/manual-close` all classify `medium`. All eight trading-api approvals
ever recorded are `medium`. The label carries no information.

The HTTP verb is the wrong signal. It describes the shape of the request, not
what the request does. `POST /simulate` and `POST /positions/manual-close`
differ in everything that matters and agree on the only thing being measured.

### Proposed: three levels, declared per endpoint

| level | meaning | prompt behaviour |
|---|---|---|
| `financial` | moves money, or writes a money column: `exit_usdc`, `pnl`, an order, a charge | Identifiers fail closed. Prompt states the money delta. |
| `destructive` | deletes or overwrites a record such that the prior value is unrecoverable | Identifiers fail closed. |
| `mutating` | any other state change: a flag, a note, a task, a queued job | Prompted as today. Unverifiable identifier degrades to a stated warning. |

Reads stay unprompted, as now.

Declared on the endpoint line so the classification lives with the endpoint:

```markdown
POST /positions/manual-close - [financial] Log a position Tyson closed by hand; body position_id, exit_price, ...
```

An endpoint with no declaration defaults to `mutating`, and a `DELETE` with no
declaration defaults to `destructive` so the current behaviour is never
weakened by omission.

Three levels, not five, per the instruction. `financial` versus `mutating` is
the distinction that would have changed the 2026-08-27 outcome; further
subdivision buys nothing today.

### Applying it to the current surface

- `financial`: trading-api `manual-close`, `positions/manual`; stripe
  `POST /customers`, `POST /invoices`.
- `destructive`: no current endpoint. The GHL `PUT /contacts/{{contact_id}}`
  family overwrites fields and is arguably here; recommend `mutating`, since
  GHL retains field history and the write is recoverable.
- `mutating`: everything else, including `POST /simulate` and
  `POST /monitor/run`, which today share a label with a money write.

---

## 5. Sequencing

1. Item 1 (prompt) and the engine changes ship first. They are independent and
   already built.
2. Parser change: `## Identifiers` section plus the `[level]` endpoint prefix.
   Both are additive, and a skill with neither behaves exactly as today.
3. Gate change: resolve-before-prompt, fail-closed by level.
4. Declare identifiers and levels on trading-api first, since it is the surface
   the incident came from and the only one with a loopback resolver already.
5. GHL brands next, five skills sharing one endpoint shape.

Steps 2 and 3 want separate PRs: a parser change that returns `null` disables a
skill silently, and that failure mode deserves its own review and its own
`scripts/verify-coupling.js` run.

---

## 6. Decisions needed

1. **Option A** for the declaration convention, with code resolvers retained as
   an override? Or a different shape.
2. **The fail-closed split**: hard-fail for `financial` and `destructive`,
   degrade-with-warning for `mutating`. Or fail closed for everything, which is
   simpler to reason about and will block CRM writes whenever GHL is slow.
3. **The GHL `PUT /contacts` classification**: `mutating` as recommended, or
   `destructive`.

---

## 7. What this design does NOT do

Constraining Charlie from composing identifiers is deliberately out of scope,
per the instruction of 2026-09-10. The audit's finding was that nothing checks,
and Charlie is one of several callers. A model-side constraint would not have
prevented the incident and cannot be verified.
