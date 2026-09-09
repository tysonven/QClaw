---
name: verification-discipline
category: always-on
surface: prompt
description: What makes a check trustworthy: prove it can fail, run it where it counts, execute the artefact under review; a check whose failure would look like success is the hazard
---

# Verification Discipline

**A check is dangerous in proportion to how much its failure mode resembles
its success mode.** The checks that burn this estate are never the ones that
fail loudly. They are the skipped suite that exits 0, the grep pointed away
from the defects, the fail-closed gate whose outage presents as the gate
working, the stale bytecode whose failure reads like a real one.
Every rule here is that principle applied somewhere specific.

Roughly seventeen occurrences were found across four repos between late
August and 2026-09-08. The full record, with SHAs and repro commands, is in
`QCLAW_BUILD_LOG.md`; this file carries the distillation. That count is
dated, not maintained.

`verification-reflexes` governs what you are allowed to claim. This file
governs whether the check behind the claim is worth anything. Claiming without
a check is caught by the gates; trusting a check that measures nothing is
caught by nobody. A false PASS is worse than a missing check, because a
missing check leaves an open question and a false PASS closes it.

## Rule 1: a test that has not failed has not been tested

A passing test proves the code and the test agree. It does not prove the test
can tell them apart. Before a test counts as evidence, break the thing it
guards and confirm it goes red.

The loop is: inject the defect, run, see FAIL, revert, run, see PASS. Then
state which shapes you injected, because "I proved it fails" is a claim like
any other and the shapes are its citation: `proven against 3 injected defects:
removed the invalidation call (FAIL), returned the stale row (FAIL), deleted
the helper (FAIL)`.

Shapes worth injecting, chosen from what the test claims to catch:

- Delete the guard, call, or filter the test exists to protect.
- Return a wrong value: off by one, stale, swapped argument, wrong branch.
- Delete the function or field entirely. This catches tests that pass because
  the assertion was never reached.
- Feed empty input. This catches assertions that iterate over zero items.
- Invert a boolean or a comparison.
- Pin the source of freshness. For any "re-read live, not cached" claim (a
  clock, a config row), capture it once at import and change nothing else. If
  the suite stays green, the claim is untested. A test asserting behaviour at
  time T must vary T, or it only proves the behaviour exists upstream of T.
- Starve a fail-closed gate: stop the field it reads from arriving. Only
  wrongly-admitting feels like a defect; wrongly-refusing is an outage wearing
  the costume of the control working, and it is the one that ships. Ask what
  tests the admit path, and expect the answer to be nothing.

This works at suite scale: stash the patch and rerun against the pre-patch
tree, proving the suite depends on the patch rather than that it is green. And
incidental coverage is not coverage: a property exercised only through fixture
values chosen for another purpose stops being exercised the day those values
change for a good reason, with every test still green. If a property matters,
something must assert it on purpose.

## Rule 2: "verified" means executed

Reading the code is analysis. Running something that resembles the real path
is analysis. "The script would do X" is analysis. Verified means a command
ran, in the place it needs to run, and you read the output. Anything short of
that gets said out loud: "I read this and it looks right. I have not run it."

The sharpest trap: you check a step by hand in a friendlier environment
than the one the script runs in, it works, and you report the script as
verified. The hand check and the script are two different artifacts
(a `curl | grep -q` script died under `pipefail` while the same greps passed
by hand in a shell without it). Verifying one says nothing about the other.

## Rule 3: cross the boundary the real request crosses

Failures collect at boundaries: serialization, transport, auth, process,
filesystem layout, build output. A check that stays on one side of a boundary
is structurally blind to everything on the other side.

Substitutes that are not the real path:

- An in-process caller instead of an HTTP request. Skips the serializer, the
  middleware, the auth layer (how `appRouter.createCaller` passed twice while
  the real path was broken in the transformer).
- A hardcoded fixture instead of the live corpus. Tests the prompt or the
  logic, blind by construction to the data.
- An ad-hoc shell command instead of the script, or a local build instead of
  the deployed artifact: different options, quoting, paths, environment.

When you report, name both halves: "this exercised the router and the
database. It did not cross HTTP." A gap you name is a gap someone can close. A
gap you leave implicit reads as covered.

## Rule 4: four ways a check is weaker than it looks

Each of these shapes passed review in this estate. They are review
questions, asked of every check before it is trusted:

1. **Asserts nothing.** Does it assert anything at all? A skip branch taken,
   an empty collection, a glob matching nothing, setup failing silently. Make
   emptiness loud: a check that finds nothing to check must fail or shout,
   never pass quietly.
2. **Asserts, but looks where the defect is not.** Does it look where the
   defect would actually be? A check scoped by an enumeration or a single
   literal pattern is an undocumented claim about where defects live, and
   that claim is usually wrong.
3. **Matches a proxy rather than the property.** Keyword lists, regexes over
   prose, filename patterns are all proxies, and a proxy fails wherever it
   and the property come apart, in both directions at once. The false
   positives are visible and create pressure to loosen it; the leaks are
   silent, and already leaking before anyone touches it. Measure both
   directions.
4. **The artefact executed was not the artefact under review.** Rule 5. It
   gets its own rule because the check itself is blameless.

Behind all four: **what is this check actually promising, and is that what it
is being trusted for?** `wrangler deploy --dry-run` validates bundling and
syntax; trusted to prove a custom domain real, it would have let a
one-character typo detach the Stripe webhook route with a customer as the
only detector. The check was exactly as strong as it looked; the failure was
the guarantee about to be loaded onto it. Assert the outcome, not the
mechanism, and assert a positive marker of the right thing, never the absence
of an error: an unrelated failure also leaves no error.

## Rule 5: a check must execute the artefact under review

A correct test over correct source can still report a wrong answer if what
actually ran was neither. A test result is a claim about a specific tree
state; anything that can change that state without the runner noticing can
invert the result in either direction, and none of it is visible in output: a
stale-cache failure reads exactly like a real one.

Ask this wherever a build or bytecode cache sits between source and run:
`__pycache__`, `.tsbuildinfo`, `node_modules/.cache`, `target/`, a Jest
transform cache. CPython validates a `.pyc` on (mtime in whole seconds, size
in bytes), so a same-length edit restored within the same second runs the old
bytecode while every tool that reads the file shows the new source. That
exact trap served a `min(` mutant's bytecode against a clean tree, making the
harness built to prove tests can fail itself unfalsifiable while wrong.

Any mutation harness needs two guards before its output means anything: purge
the cache on both sides of every mutation, not merely restore the source; and
refuse to run against a dirty tree, because a restore that resets to HEAD
deletes the changes under test. CI is not exposed (fresh checkout, no cache),
so only a local run can catch this, and green CI does not contradict a local
failure.

## The incidents

These are evidence, not illustrations; each passed review. The fourth
shape's incident is told inside Rule 5.

**Asserts nothing.** CSP tests gated on `it.runIf(built)` while `dist/` was
gitignored and nothing built first: a clean clone reported 5 passed, 5
skipped, exit 0. Two of the five skips were the anti-vacuity guards
themselves.

**Looks where the defect is not.** A `console.log` lint grep returned 23
results, not one a true positive, and missed all 8 real defects at any
exclusion-list setting, because the defects used `console.error` and
`console.warn` and it matched only `console.log`.

**Proxy, not property.** A fabrication guard flagged numbered lines
containing UI keywords. Over a 75-line labelled corpus it flagged 10 of 25
correct answers and missed 5 of 40 real fabrications, one an invented
two-step procedure using none of its keywords. Both directions, at once.

## Before you write "verified"

Answer these in the report, not just in your head. Each is a rule at the moment
it matters:

1. What did I run, and where did it run? Not read, not reasoned about: ran.
2. What did I inject to prove it can fail, and did it go red?
3. Which boundary did this cross, and which did it not? Name the uncrossed
   one.
4. What concrete input would make this report FAIL? If I cannot state one,
   this is not a check.
5. Where would the defect actually live, and is that where this looks?
6. Is this matching the property, or a proxy for it? If a proxy, have I
   measured the silent leaks as well as the visible false alarms?
7. Was the thing that ran the thing on disk? What sat between them: a cache,
   a restore step, a build?
8. What is this check being trusted for, and is that what it actually
   promises?

If any answer is missing, the honest word is not "verified". It is "I checked
X, I did not check Y."
