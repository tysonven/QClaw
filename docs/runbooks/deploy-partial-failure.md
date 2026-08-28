# Runbook: deploy failed partway through

Applies to the `deploy` job in `.github/workflows/ci.yml` (qclaw, /root/QClaw).

## The situation this exists for

The deploy is a serial script and it fails CLOSED: any failing step stops it
(`script_stop: true`). That is correct, but it is not atomic. `npm ci` replaces
`node_modules` BEFORE the six `pm2 restart` calls, and the restarts themselves
are serial. So a failure partway leaves a mixed state that no automation
resolves:

- **Failure before `npm ci`** (dirty tree, git error, HEAD not the validated
  commit): nothing changed. No action needed. Fix the cause and re-run.
- **Failure between `npm ci` and the restarts** (native rebuild failed, the
  `new Database(':memory:')` assertion failed, hub entry file missing): the
  running processes are on OLD code against a REPLACED `node_modules`. They
  keep working only for as long as they do not need something that changed
  underneath them.
- **Failure during the restart list**: processes before the failure point run
  new code, processes after it run old code against the new `node_modules`.
  The restart order is `agex-hub, quantumclaw, trade-engine, trading-worker,
  claude-code-dispatcher, clipper-worker`, so read the deploy log to see how
  far it got.

**The box needs a manual restart in the second and third cases. The deploy will
not retry them and nothing alerts on the mixed state.**

## What to do

1. Read the failing step in the Actions log and fix the underlying cause first.
   Restarting on a broken `node_modules` just spreads the breakage to the
   processes that were still healthy.
2. Confirm the tree is the commit you expect:

       sudo git -C /root/QClaw rev-parse HEAD
       sudo git -C /root/QClaw status --porcelain     # must be empty

3. Confirm the native modules actually work. `require()` alone is NOT
   sufficient: better-sqlite3 loads its addon lazily inside the constructor,
   so it must be instantiated.

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

5. Verify uptimes actually reset. This is the step that gets skipped, and
   skipping it is how PR #94 sat inert for 8 days:

       sudo pm2 list

## Note on trade-engine

Restarting `trade-engine` can interrupt an in-flight scan: `scanner.run()`
blocks through the approval gate for up to 30 minutes with `max_instances=1`,
and a restart drops a pending approval. Check whether a scan is running before
restarting if the timing is discretionary. Deferring the restart when a scan is
in flight is a tracked follow-up, not implemented.
