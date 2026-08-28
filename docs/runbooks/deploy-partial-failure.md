# Runbook: deploy failed partway through

Applies to the `deploy` job in `.github/workflows/ci.yml` (qclaw, /root/QClaw).

## The situation this exists for

The deploy is a serial script and it fails CLOSED: any failing step stops it
(`script_stop: true`). That is correct, but it is not atomic. `npm ci` replaces
`node_modules` BEFORE the six `pm2 restart` calls, and the restarts themselves
are serial. So a failure partway leaves a mixed state that no automation
resolves.

Failures fall into three classes, and they need different responses:

- **Failure at the clean-tree check or the commit pin.** Nothing was installed
  and nothing was restarted, so the box is still serving fine. But these do NOT
  clear by re-running the workflow. See **Box-side recovery** below. Re-running
  replays the same `github.sha` against the same box state and fails
  identically, every time, forever.
- **Failure between `npm ci` and the restarts** (native rebuild failed, the
  `new Database(':memory:')` assertion failed, hub entry file missing): the
  running processes are on OLD code against a REPLACED `node_modules`. They
  keep working only for as long as they do not need something that changed
  underneath them. **Manual restart required after fixing the cause.**
- **Failure during the restart list**: processes before the failure point run
  new code, processes after it run old code against the new `node_modules`.
  The order is `agex-hub, quantumclaw, trade-engine, trading-worker,
  claude-code-dispatcher, clipper-worker`, so read the deploy log to see how far
  it got. **Manual restart required.**

Nothing retries and nothing alerts on the mixed state.

## Box-side recovery: dirty tree, or HEAD not the validated commit

These are the only two failures that CANNOT be cleared by re-running the
workflow. Re-running is the instinct, and here it is wrong, which is why they
get their own section. Recovery is exclusively box-side.

### HEAD is not the CI-validated commit

The pin (`git merge --ff-only <sha>` plus the equality assert after it) trips
only when the box HEAD is at or AHEAD of the validated commit. A re-run uses the
same `github.sha` against the same box HEAD and fails the same way. Left alone
this is a PERMANENT deploy outage, not a transient one. The expected trigger is
a commit made directly on `/root/QClaw`, which does happen here.

First, see what is on the box that CI never validated:

    sudo git -C /root/QClaw log --oneline <sha>..HEAD

Then choose deliberately:

    # (a) the box commits are WANTED. Get them onto main so CI validates them,
    #     then deploy normally. Capture them first:
    sudo git -C /root/QClaw log -p <sha>..HEAD > /tmp/box-drift.patch

    # (b) the box commits are UNWANTED. Preserve, then discard:
    sudo git -C /root/QClaw branch box-drift-$(date -u +%Y%m%dT%H%M%SZ)
    sudo git -C /root/QClaw reset --hard <sha>

Never `reset --hard` without creating that branch first. Commits made directly
on the box exist nowhere else, and discarding them is unrecoverable.

### Dirty tree

Pre-existing rather than introduced by this pipeline, and the same shape: the
guard refuses, and re-running changes nothing because the workflow never touches
the working tree.

    sudo git -C /root/QClaw status --porcelain
    sudo git -C /root/QClaw diff

INSPECT before discarding. The predecessor pipeline ran `git stash` at this
point, and silently promoting unreviewed drift is precisely what the guard
replaced, so do not reintroduce it by reflex. Then either commit and push the
change so it gets reviewed, or, once certain it is disposable:

    sudo git -C /root/QClaw stash push -m "deploy-blocked-$(date -u +%Y%m%dT%H%M%SZ)"

## Recovering the mixed-state failures

1. Read the failing step in the Actions log and fix the underlying cause first.
   Restarting on a broken `node_modules` just spreads the breakage to the
   processes that were still healthy.
2. Confirm the tree is the commit you expect and is clean:

       sudo git -C /root/QClaw rev-parse HEAD
       sudo git -C /root/QClaw status --porcelain     # must be empty

3. Confirm the native modules actually work. `require()` alone is NOT
   sufficient: better-sqlite3 loads its addon lazily inside the constructor, so
   it must be instantiated.

       cd /root/QClaw && sudo node -e "require('canvas'); const D=require('better-sqlite3'); new D(':memory:').exec('create table t(x)'); console.log('native modules OK')"

   If that fails: `sudo npm rebuild canvas better-sqlite3` and re-check.
   Do NOT skip this. A broken better-sqlite3 does not crash anything; audit.db
   and memory.db just stop receiving writes behind a `log.warn`, which strands
   the gate replay corpus.

4. Restart the full set, `agex-hub` first (quantumclaw connects to it at
   `localhost:4891` during boot, `src/index.js:92-106`, with no reconnect
   logic):

       sudo pm2 restart agex-hub quantumclaw trade-engine trading-worker \
         claude-code-dispatcher clipper-worker --update-env

5. Verify the processes actually came up. `pm2 restart` returns when a process
   RESPAWNS, not when it is healthy, so a crash-looping process reports a fresh
   uptime: check that `status` is `online` and that the restart counter is not
   climbing between two reads, rather than trusting uptime alone.

       sudo pm2 list

   PR #94 is the cautionary case, and it had two separate failures worth keeping
   distinct. The CAUSE was the pipeline restarting only `quantumclaw`, so the
   process carrying the fix never picked it up; that is fixed in the workflow's
   restart list. The missed DETECTION was that nobody compared uptime against
   the deploy timestamp for 8 days; that is what this step addresses. Fixing
   either one alone would have left the other.

## Note on trade-engine

Restarting `trade-engine` can interrupt an in-flight scan: `scanner.run()`
blocks through the approval gate for up to 30 minutes with `max_instances=1`,
and a restart drops a pending approval. The scanner fires on even UTC hours
Tue-Fri, hourly Mondays, every 4h at weekends. Check before restarting if the
timing is discretionary:

    curl -s http://127.0.0.1:4003/health

`last_scan_at` and `pending_approvals` tell you whether a scan is live.
Deferring the restart automatically when a scan is in flight is a tracked
follow-up, not implemented.
