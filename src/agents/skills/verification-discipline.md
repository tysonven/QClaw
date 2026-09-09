---
name: verification-discipline
category: always-on
surface: prompt
description: What makes a check trustworthy: prove it can fail, run it rather than read it, cross the boundary the real request crosses, and never report PASS while measuring nothing
---

# Verification Discipline

In the two weeks to 2026-08-28, four checks in this estate reported something
other than the truth. Three were caught by reasoning about the check instead of
by running it. One only surfaced in production. Adversarial review caught none
of them, because none of them were reasoning failures. The logic was sound in
every case, and the check still did not measure the thing it named.

That is now the most common defect class here, so it gets a rule rather than a
habit.

`verification-reflexes` governs what you are allowed to claim. This file governs
whether the check behind that claim is worth anything. The two failure modes are
different: claiming without a check is caught by the gates, while trusting a
check that measures nothing is caught by nobody. A false PASS is worse than a
missing check, because a missing check leaves an open question and a false PASS
closes it.

## Rule 1: a test that has not failed has not been tested

A passing test proves the code and the test agree. It does not prove the test
can tell them apart. Before a test counts as evidence, break the thing it guards
and confirm it goes red.

The loop is: inject the defect, run, see FAIL, revert, run, see PASS. Then state
which shapes you injected, because "I proved it fails" is a claim like any other
and the shapes are its citation.

Shapes worth injecting, chosen from what the test claims to catch:

- Delete the guard, call, or filter the test exists to protect.
- Return a wrong value: off by one, stale, swapped argument, wrong branch.
- Delete the function or field entirely. This catches tests that pass because
  the assertion was never reached at all.
- Feed empty input. This catches assertions that iterate over zero items.
- Invert a boolean or a comparison.

Report it as: `proven against 3 injected defects: removed the cache
invalidation call (FAIL), returned the stale row (FAIL), deleted the helper
entirely (FAIL)`.

If you cannot make it fail, you have not written a strong test. You have written
something that does not depend on the code.

## Rule 2: "verified" means executed

Reading the code is analysis. Running something that resembles the real path is
analysis. "The script would do X" is analysis. None of them are verification.

Verified means a command ran, in the place it needs to run, and you read the
output. Anything short of that gets said out loud:

- "I read this and it looks right. I have not run it."
- "I ran the query by hand. I have not run the script that wraps it."

Those sentences cost nothing and are always available. Reporting done without
one of them is the failure, not the not-having-run.

The sharpest version of this trap: you check a step by hand in a friendlier
environment than the one the script runs in, it works, and you report the script
as verified. The hand check and the script are two different artifacts with two
different failure surfaces. Verifying one says nothing about the other.

## Rule 3: cross the boundary the real request crosses

Failures collect at boundaries: serialization, transport, auth, process,
filesystem layout, build output. A check that stays on one side of a boundary is
structurally blind to everything on the other side, and it will pass with total
confidence while doing it.

Substitutes that are not the real path:

- An in-process caller instead of an HTTP request. Skips the serializer, the
  middleware, the auth layer, the error mapping.
- A hardcoded fixture instead of the live corpus. Tests the prompt or the logic,
  and is blind by construction to the data.
- An ad-hoc shell command instead of the script. Different shell options,
  different quoting, different working directory, different exit handling.
- A local build instead of the deployed artifact. Different paths, different
  environment, different files present.

When you report, name both halves: "this exercised the router and the database.
It did not cross HTTP or the transformer." A gap you name is a gap someone can
close. A gap you leave implicit reads as covered.

## Rule 4: a PASS that measures nothing is worse than no check

There are two shapes and both are quiet:

**Vacuous pass.** The assertion never ran. A skip branch was taken, the
collection was empty, a glob matched nothing, a directory no longer exists, the
setup failed without saying so.

**Right answer, wrong reason.** The assertion ran and passed on something other
than what it claims to measure. A status code that would be identical on an
error page. A substring present in both the correct and the broken output. A
default value returned from an error path inside a 2xx.

Two habits close both:

- Every check must be able to name a concrete input that produces FAIL. If you
  cannot state one, it is not a check.
- Make emptiness loud. A skip, a zero-length list, a glob with no matches, a
  missing directory: fail, or shout. Never pass quietly.

And assert on a positive marker of the right thing rather than on the absence of
an error, because the absence of an error is also what an unrelated failure
looks like.

## The incidents

These are the evidence, not illustrations. Each one passed review.

**`appRouter.createCaller` on `listCuratedDocs`.** Passed end to end twice while
the real path was broken. The caller never crossed the superjson transformer,
which is exactly where the failure lived. Rule 3.

**`curl | grep -q` under `set -uo pipefail`.** Reported FAIL against a correct
410. `grep -q` exits on first match and closes the pipe, `curl` died with exit
56 and 39KB unwritten, and `pipefail` promoted curl's death to the pipeline's
status. The check failed for a reason that had nothing to do with the subject.
It was then "verified" with ad-hoc greps in a shell that had no `pipefail` set,
and reported as done without the script ever being run. Rules 2 and 4. The fix
is to capture first and match second: `body=$(curl ...)` then `[[ $body == *pat* ]]`.

**A verify block deriving slugs from `dist/post/*/`.** Once that directory
stopped existing the glob matched nothing, the block took its SKIP branch, and
it reported PASS while asserting nothing at all. Rule 4, vacuous.

**A status-only assertion against a removed deployment.** It would have passed
against Vercel's canned "The deployment has been removed" body, because it
checked the status and never checked what was served alongside it. Rule 4, right
answer for the wrong reason.

**`grounding.eval.test.ts`.** Uses hardcoded fixture contexts, so it tests the
prompt and is blind by construction to the corpus. Treating it as the acceptance
gate for a corpus change would have returned a clean false negative. Rule 3.

## What the rules look like when they are applied

**The `searchKnowledgeDocs` invariant test caught a real defect,** and it did so
only because it had been proven against three injected defects first. One of
those injections was a function that did not exist when the test was written.
That is rule 1 doing the work it exists to do.

**The `selfGrant` patch was stashed and the suite rerun against the pre-patch
tree.** 21 of 30 tests failed. That is rule 1 at suite scale: proof the suite
actually depends on the patch, rather than proof that it is green.

**The invalidation invariant was defect-injected before being trusted,** rather
than trusted because it was green.

The shared move in all three is the same: make the check fail on purpose before
you let it tell you anything.

## Before you write "verified"

Answer these in the report, not just in your head:

1. What did I run, and where did it run?
2. What did I inject to prove it can fail, and did it fail?
3. Which boundary did this cross, and which did it not?
4. What input would make this report FAIL? If none, say so and downgrade the
   claim.

If any answer is missing, the honest word is not "verified". It is "I checked X,
I did not check Y."
