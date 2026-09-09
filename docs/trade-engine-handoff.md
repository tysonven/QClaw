# Trade engine: where the remediation stands

Written 2026-09-09 so a session can pick this up without reading the
conversation that produced it. State claims are anchored to a SHA, an issue
number or a live read, per the build log convention; anything not anchored is
marked as such.

**TRADING IS DISABLED.** `trading_config.trading_enabled` read live 2026-09-09:
`false`. It stays that way until the conditions in "The gate" below are met.
That is Tyson's decision to make and no session's.

---

## 1. Where the work stands

The remediation was ordered 3 > 4,5 > 1 > 7+2. Item 1 (fractional horizon) and
item 7+2 (fee-aware Kelly sizing) are the ones this handoff covers.

### Merged

| what | where |
|---|---|
| Item 1, fractional horizon and executor GATE 7 | PR #118, on `main` |
| Item 7+2 part one, the pure sizing kernel | PR #134, `main` @ `33d5852` |

`src/trade_engine/sizing.py` is on `main` and **nothing imports it yet**. That
was deliberate: it merged as inert code so the arithmetic could stop being
re-reviewed every round. The wiring PR is what makes it live.

### Open, and the only thing blocking item 7+2

**PR #135, draft**, on `feat/kelly-sizing-wiring`. Wires Kelly into the scanner
and executor, adds GATE 8, and rewrites the cash-out ceiling.

At the time of writing it is green on CI and has just had the GATE 8 book-walk
change pushed to it. A scoped cold review of that change alone was in flight
when this was written; **check the PR for review comments before assuming it is
clean**. It has been through four full review rounds already, and every one
found something.

### F2, approved as designed

GATE 8 sizes off the **live CLOB order book**, not Gamma's price. Approved
2026-09-09 on measurement:

- Across 24 live markets in the tradeable band, `ask/mid` had a median of
  1.0178, a p90 of 1.0556 and a max of 1.2211.
- Decisively, **three of those markets returned an ask BELOW Gamma's price**,
  worst case a Gamma price of 0.265 against a best ask of 0.070.

So Gamma's figure is not a mid with bounded error; it is a different number that
sometimes tracks the book. That is why a fixed margin above the minimum was
rejected: no margin in either direction can be safe against an error with no
sign and no bound. **Do not reopen the margin option without new measurement.**

The gate makes two CLOB calls on purpose (`/markets/<conditionId>` then
`/book`), and `src/trade_engine/executor.py` says why in the docstring. Do not
collapse it to one: the market endpoint's `tokens[].price` is a mid and carries
the same defect as Gamma's.

---

## 2. The gate on re-enabling

Trading does not re-enable until **all** of:

1. PR #135 is merged.
2. The deploy is verified on the host: both `trade-engine` and `trading-worker`
   restarted, running the merged SHA, no traceback, scheduler jobs registered.
3. **Tyson decides.** Not a session, not an inference from green CI.

`trading_enabled` is a column in the `trading_config` table, not a config file
or an env var. Executor GATE 1 re-reads it live on every execution, so flipping
it is the whole switch. Nothing in any merge touches it.

Expect near-total suppression when it is enabled, and expect that to be
correct. See section 5.

---

## 3. Open queue, and what blocks what

| issue | what | blocks |
|---|---|---|
| #119 | Decide Monte Carlo step density (`STEPS_PER_DAY`) | nothing; blocked ON a sizing decision by Tyson |
| #122 | n8n Market Scanner still has the `ceil()` horizon bug | nothing; latent, workflow is inactive |
| #130 | Three test files silently unrunnable locally | nothing, but it is how two defects hid |
| #136 | A PR based on a non-main branch gets no CI | nothing; review-integrity, not a merge-gate hole |
| #104, #105 | `gates.js` COMPLETION_RE holes | unrelated to trading |
| #106 | position `f4a0bd50` understates true cost | unrelated to this work |
| #107, #108 | monitor: voided markets, Gamma outage indistinguishable | unrelated to this work |

Nothing in that list blocks PR #135. #119 and #122 are downstream of it in
sequence but not in dependency.

---

## 4. Verification rules this work established

These are NOT yet in `src/agents/skills/verification-discipline.md`, which is
the file every session is pointed at. They were learned across four review
rounds on one PR and they are the reason it took four.

### The fixture agrees with the hardcode

> A test comparing against a constant proves the constant, not the behaviour.
> The gap is invisible whenever the value equals its default, which in a test
> environment is always.

Concretely: `assertEqual(captured["bankroll"], config.bankroll_usdc)` and
`assertEqual(captured["bankroll"], 25.0)` are the same assertion when config
says 25.0, and both pass against a call site that hardcodes `25.0`.

The corollary, which cost three separate fixes:

> A test for a REMOTE value must use a value the remote never returns.

`orderMinSize` is 5 on every Polymarket market ever sampled. A fixture saying 5
cannot distinguish real wiring from a hardcoded 5. Use 12, or 50, or 2.5.

**Assert that the value TRACKS its source**: move the source, assert the
captured value moves, with at least two distinct non-default probes.

### `assertIn` on a label proves the format string

```python
self.assertIn("price=", s.log_fields())     # proves nothing
```

The label is written by the same line that writes the value, so it cannot
witness it. Nine mutants zeroing every number in a refusal log survived a suite
asserting only labels. That log is the measurement instrument behind the sizing
decision.

Pin values, and pin them at fixtures where the values **differ**. When nothing
clamps, `debit == kelly_debit` by construction, so a swap between them is
invisible at a single fixture.

> If a log is the instrument, it needs the same test discipline as the
> calculation. It usually gets less, because it reads as reporting.

### Mutants must pin the property, not the mechanism

Specifying mutants rather than the property gets you the mutants. Two examples
from this work:

- A mutant that removed GATE 7's comparison proved a second static assertion
  existed. It did not prove the two layers evaluate against different clocks.
  The mutant that does: **keep the whole gate and change only which clock it
  reads.**
- For GATE 8: keep the book call and the depth walk, and change only **which
  price** the share count divides by. If that survives, the tests assert the
  shape rather than the number.

The general form:

> Keep the entire shape and change only the source of the substance. If the
> suite stays green, the claim is untested however well the shape is.

And when choosing mutants at all: **mutants that look wrong to a human are the
ones a literal-comparison test already catches.** A table full of `250.0`, `1.0`
and `1e9` proves the easy half while reading as if it proved the class.

### Commit before mutating

The mutation harness restores with `git checkout -- .`, which resets to HEAD and
**deletes uncommitted work**. It did so twice in one session, and the second
time it also produced a wrong ANSWER: a mutant reported SURVIVED because its
test had been deleted by the previous restore, not because it was vacuous.

Refuse to run on a dirty tree:

```sh
[ "$(git status --porcelain | wc -l)" = "0" ] || { echo "REFUSING"; exit 1; }
```

And purge `__pycache__` on **both** sides of every mutation. Python validates
bytecode on `(mtime, size)`, not content, so a size-preserving edit restored
within the same second leaves the interpreter running the mutant while
`git status` is clean.

### Closing an instance is not closing a class

The same defect was found three times in one session, each after the previous
was closed, because each fix was applied at the layer where the defect was
observed.

> The evidence a class is closed is that the mutant fails at every layer it
> could live at. After fixing, re-run it one call deeper and one call shallower.

---

## 5. Deliberately not done, and why

### `STEPS_PER_DAY` stays at 1 (#119)

Raising it is a **sizing decision**, not a tuning change. A discrete path only
observes the barrier at step boundaries, so refining the grid raises every
`touch_*` probability, which raises edge, which recruits markets from below the
7-point floor. Measured on four historical positions: an hourly grid lifts edges
by +0.7 to +6.4 points against a 7-point floor. On that sample it roughly
doubles the qualifying population while barely resizing what was already taken.

The numbers are in `docs/trade-engine-horizon-rebaseline.md` and #119. A test
named `test_steps_per_day_is_one` fails if the constant moves, and says why.

**#119's first task is not to change the constant.** It is to count how many
`touch_*` rows sit in the 1-to-7 point band, because "roughly doubles" is
inferred from four positions, not counted from the 5,649 stored rows.

### The bankroll is a measurement, not a dial

`bankroll_usdc = 25` comes from $29.24 of real spendable collateral. At that
bankroll the exchange's 5-share minimum is coarser than the entire Kelly budget,
so almost nothing can be placed. **That is arithmetic and it is the intended
outcome**: the model was 7x wrong six weeks ago, and a system that sizes
correctly and therefore almost never trades is behaving properly.

The number that would make Kelly and the exchange compatible at mid prices is
about $180. Getting there is a **deposit of roughly $155, a capital decision for
Tyson**. It is not a config edit, and `config.py` now clamps the value so env
cannot raise it. If you are here because nothing is trading, that is why, and
the fix is not this constant.

The tradeable region, re-derived independently by four reviews: price in
`[0.10, 0.482521]` with a very large edge. **Above 0.482521 the minimum is
unreachable at any edge including certainty**: deep favourites are the region
that is arithmetically impossible, not the one that survives.

### The n8n scanner is not fixed (#122)

`Trading - Market Scanner` (`3YahxqOguET3pifj`) still has `Math.ceil`, no
tradeable-horizon floor and no gate equivalent. Verified against the n8n
Postgres 2026-09-08: `active=false`, `Math.ceil=true`, and the single
`workflow_history` row contains it too.

Dormant, so latent. **Reactivating it reproduces position e09b82fe.** Not fixed
in the Python PRs because n8n executes the PUBLISHED `workflow_history` row, not
`workflow_entity.nodes`, so editing the draft is a silent runtime no-op and it
needs its own change and its own verification.

---

## 6. Practical notes

- **`~/QClaw` is a reference checkout on `main`.** No branches, no harnesses, no
  writes. Every job gets its own worktree under `~/QClaw-worktrees/`. Other
  sessions read it, and a mutation harness run there will destroy their work.
- **Branch protection** on `main`: `lint`, `python-test`, `test (20)`,
  `test (22)`, strict, enforce_admins. `deploy` must never become a required
  context; it is push-only and reports `skipping` on PRs.
- **Merging to `main` is a production deploy.** It restarts all six PM2
  processes. Open the PR and stop.
- `tests/test_analyst.py`, `tests/test_manual_position.py` and
  `tests/test_relay_settlement.py` need third-party packages and are invisible
  on a stock machine (#130). Build a venv or state you could not run them.
  Anything you cannot run is an unverified claim.
- Position `e09b82fe` is the acceptance-test record for item 1. Do not correct
  the row.
