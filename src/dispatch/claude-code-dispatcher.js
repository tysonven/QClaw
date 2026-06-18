/**
 * QuantumClaw — claude-code-dispatcher (Slice 5, Component 6 v1, step 3)
 *
 * A single-instance PM2 worker (runs as root) that drains queued
 * `claude_code_dispatches`, runs Claude Code READ-ONLY as the unprivileged
 * `ccdispatch` user against a throwaway clone, and writes the result back.
 *
 * Security spine (design v2):
 *  - Structural scope validation at the dispatcher (not the tool): only audit/
 *    read_only run; anything else → failed, CC never invoked. Fail closed.
 *  - CC runs as `ccdispatch` (kernel perms deny secret reads) in a fresh clone at
 *    the row's pinned commit; scrubbed child env (only ANTHROPIC_API_KEY/PATH/HOME);
 *    plan mode + --disallowedTools + --settings deny-list (defence-in-depth);
 *    --max-budget-usd; brief via stdin (never shell-interpolated).
 *  - Refuses to run CC as root: if the ccdispatch user is absent, the dispatch fails.
 *  - Post-hoc `git status` clean assert; output scrubbed for secret values.
 *  - Reaper (startup + periodic) recovers rows orphaned by a dead/hung dispatcher.
 *  - Heartbeat on an INDEPENDENT timer (decoupled from CC runs). Daily spend ceiling
 *    + queue saturation pause. v1 fails once, no retry.
 *
 * NOTE: the brief and dispatch row are untrusted end-to-end.
 *
 * Start (after scripts/setup-ccdispatch-user.sh):
 *   pm2 start src/dispatch/claude-code-dispatcher.js --name claude-code-dispatcher && pm2 save
 */

import { spawn, execFileSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { recordBeat } from '../observability/liveness-heartbeat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── config ────────────────────────────────────────────────────────────────
const ALLOWED_SCOPES = new Set(['audit', 'read_only']);
const CC_BIN = process.env.QCLAW_CC_BIN || 'claude';
const CC_USER = process.env.QCLAW_CC_USER || 'ccdispatch';
const REPO_PATH = process.env.QCLAW_REPO_PATH || '/root/QClaw';
const WORK_ROOT = process.env.QCLAW_CC_WORK_ROOT || '/home/ccdispatch/work';
const SETTINGS_PATH = process.env.QCLAW_CC_SETTINGS || join(__dirname, 'cc-readonly-settings.json');
const POLL_MS = Number(process.env.QCLAW_CC_POLL_MS) || 8000;
const HEARTBEAT_MS = Number(process.env.QCLAW_CC_HEARTBEAT_MS) || 45000;
const REAP_EVERY_MS = Number(process.env.QCLAW_CC_REAP_MS) || 120000;
const GRACE_SECONDS = Number(process.env.QCLAW_CC_GRACE_SECONDS) || 30;
const PER_DISPATCH_BUDGET_USD = Number(process.env.QCLAW_CC_BUDGET_USD) || 2.0;
const DAILY_SPEND_CAP_USD = Number(process.env.QCLAW_CC_DAILY_CAP_USD) || 20.0;
const QUEUE_SATURATION = Number(process.env.QCLAW_CC_QUEUE_SATURATION) || 20;
const DISPATCHER_ID = 'dispatcher-liveness';

// ── env ─────────────────────────────────────────────────────────────────────
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}
function loadEnv() {
  const path = process.env.QCLAW_ENV_PATH || '/root/.quantumclaw/.env';
  let fileEnv = {};
  try { if (existsSync(path)) fileEnv = parseEnvFile(readFileSync(path, 'utf-8')); } catch { /* */ }
  return { ...fileEnv, ...process.env };
}

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

/** The structural gate: only v1 scopes run; everything else is rejected. */
export function validateScope(scope) {
  if (!scope || !ALLOWED_SCOPES.has(scope)) {
    return { ok: false, reason: `scope "${scope ?? '(none)'}" is not runnable in v1 (allowed: ${[...ALLOWED_SCOPES].join(', ')})` };
  }
  return { ok: true };
}

/** Child env for CC: ONLY the API key + PATH + a worktree-local HOME. No SUPABASE_*,
 * no inherited root env (so /proc/self/environ can't leak our other secrets). */
export function scrubChildEnv(env, homeDir) {
  return {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: homeDir,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || '',
    LANG: env.LANG || 'C.UTF-8',
  };
}

/** Headless read-only CC argv. Brief is piped via stdin, never argv. */
export function buildCcArgv({ clonePath, settingsPath, budgetUsd }) {
  return [
    '-p', '--bare',
    '--permission-mode', 'plan',
    '--add-dir', clonePath,
    '--settings', settingsPath,
    '--disallowedTools', 'Edit Write NotebookEdit',
    '--output-format', 'json',
    '--max-budget-usd', String(budgetUsd),
  ];
}

/** Redact known secret values + high-entropy tokens from CC output before it is
 * written back / surfaced. CC output is untrusted (a function of an untrusted brief). */
export function scrubSecretsFromOutput(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  }
  return out
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED-KEY]')
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED-JWT]');
}

/** Sum cost_usd of rows completed since `sinceMs` (client-side daily ceiling). */
export function sumCostSince(rows, sinceMs) {
  return (rows || []).reduce((acc, r) => {
    const t = Date.parse(r.completed_at || r.created_at || '');
    if (Number.isFinite(t) && t >= sinceMs) acc += Number(r.cost_usd) || 0;
    return acc;
  }, 0);
}

/** Short summary for surfacing (first non-empty lines of the result). */
export function summarise(text, max = 600) {
  return String(text ?? '').replace(/\r/g, '').trim().slice(0, max);
}

// ── Supabase (PostgREST, service_role) ───────────────────────────────────────
function makeRest(env) {
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  return async function rest(method, path, { body, prefer } = {}) {
    const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${url}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`Supabase ${method} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  };
}
const claimNext = (rest) => rest('POST', 'rpc/claim_next_dispatch', { body: { p_dispatcher: 'claude-code-dispatcher' }, prefer: 'return=representation' }).then(r => (Array.isArray(r) ? r[0] : r) || null);
const reapStale = (rest) => rest('POST', 'rpc/reap_stale_dispatches', { body: { p_grace_seconds: GRACE_SECONDS } });
const queueDepth = (rest) => rest('GET', 'claude_code_dispatches?status=eq.queued&select=id').then(r => (Array.isArray(r) ? r.length : 0));
const dailySpend = async (rest, sinceMs, sinceIso) => sumCostSince(await rest('GET', `claude_code_dispatches?completed_at=gte.${encodeURIComponent(sinceIso)}&select=cost_usd,completed_at`), sinceMs);
const writeBack = (rest, id, patch) => rest('PATCH', `claude_code_dispatches?id=eq.${id}`, { body: patch });

// ── ccdispatch user ──────────────────────────────────────────────────────────
/** Resolve the unprivileged uid/gid. Returns null if the user is absent — the
 * dispatcher then REFUSES to run CC (never as root). */
export function resolveCcUser(user = CC_USER) {
  try {
    const uid = parseInt(execFileSync('id', ['-u', user], { encoding: 'utf8' }).trim(), 10);
    const gid = parseInt(execFileSync('id', ['-g', user], { encoding: 'utf8' }).trim(), 10);
    if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid, gid };
  } catch { /* absent */ }
  return null;
}

// ── clone lifecycle ───────────────────────────────────────────────────────────
function prepareClone(id, pinnedCommit, ccUser) {
  const clonePath = join(WORK_ROOT, id);
  mkdirSync(WORK_ROOT, { recursive: true });
  rmSync(clonePath, { recursive: true, force: true });
  // local clone so all git state is owned by ccdispatch (a worktree's objects stay
  // in the 700-root /root/QClaw/.git and ccdispatch couldn't read them).
  execFileSync('git', ['clone', '--no-hardlinks', '--quiet', REPO_PATH, clonePath]);
  if (pinnedCommit) {
    try { execFileSync('git', ['-C', clonePath, 'checkout', '--quiet', pinnedCommit]); }
    catch { /* commit not present in clone (shouldn't happen) — proceed at HEAD */ }
  }
  execFileSync('chown', ['-R', `${ccUser.uid}:${ccUser.gid}`, clonePath]);
  return clonePath;
}
function cleanupClone(clonePath) {
  try { rmSync(clonePath, { recursive: true, force: true }); } catch { /* */ }
}
/** Detect-only: any working-tree mutation under a read-only run → fail. */
export function workingTreeDirty(clonePath, ccUser, log = console) {
  // Run git AS ccdispatch (the clone's owner) — root running git on a ccdispatch-
  // owned repo trips `fatal: detected dubious ownership`, which previously fell into
  // the catch and reported "clean" (a non-functional backstop). As the owner there
  // is no ownership warning, and we see exactly what ccdispatch could have mutated.
  try {
    const out = execFileSync('git', ['-C', clonePath, 'status', '--porcelain', '--ignored'],
      { uid: ccUser.uid, gid: ccUser.gid, encoding: 'utf8' });
    return out.trim().length > 0;
  } catch (e) {
    // Fallback: explicit safe.directory for THIS clone only (never '*').
    try {
      const out = execFileSync('git', ['-c', `safe.directory=${clonePath}`, '-C', clonePath, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' });
      return out.trim().length > 0;
    } catch (e2) {
      // Fail SAFE: if cleanliness can't be determined, treat as DIRTY (reject).
      log.warn?.(`[dispatcher] workingTreeDirty check failed (${e2.message}) — failing safe (dirty)`);
      return true;
    }
  }
}

// ── CC invocation (the wiring; gated to live runs, reviewed at pause c) ───────
/**
 * Spawn Claude Code as `ccdispatch`, brief on stdin, group-killed on timeout.
 * Single-flight: only the first of {exit, timeout} resolves. Returns
 * { ok, status, resultText, exitCode, costUsd, ccSessionId, error }.
 */
export function runClaudeCode({ env, clonePath, homeDir, brief, ccUser, timeoutSeconds, budgetUsd = PER_DISPATCH_BUDGET_USD }) {
  return new Promise((resolve) => {
    const argv = buildCcArgv({ clonePath, settingsPath: SETTINGS_PATH, budgetUsd });
    const child = spawn(CC_BIN, argv, {
      cwd: clonePath,
      uid: ccUser.uid,
      gid: ccUser.gid,
      // HOME is a SEPARATE dir, NOT the clone — otherwise CC writes its own state
      // (.claude/, session files) into the repo clone and pollutes the post-hoc
      // git-status clean assert (false "mutated" failures). HOME falls back to the
      // clone only if no separate home was provided.
      env: scrubChildEnv(env, homeDir || clonePath),
      detached: true, // own process group so we can kill the whole tree on timeout
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };

    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* */ }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* */ } }, 5000);
      finish({ ok: false, status: 'timeout', error: `exceeded ${timeoutSeconds}s`, exitCode: null, costUsd: null, ccSessionId: null, resultText: stdout });
    }, timeoutSeconds * 1000);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ ok: false, status: 'failed', error: `spawn error: ${err.message}`, exitCode: null, costUsd: null, ccSessionId: null, resultText: '' }));
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* non-json output */ }
      const costUsd = parsed ? (parsed.total_cost_usd ?? parsed.cost_usd ?? null) : null;
      const ccSessionId = parsed ? (parsed.session_id ?? null) : null;
      const resultText = parsed ? (parsed.result ?? stdout) : stdout;
      const permissionDenials = parsed ? (parsed.permission_denials ?? null) : null;
      const isErr = code !== 0 || (parsed && parsed.is_error === true);
      finish({
        ok: !isErr,
        status: isErr ? 'failed' : 'complete',
        error: isErr ? (stderr.slice(0, 500) || `exit ${code}`) : null,
        exitCode: code, costUsd, ccSessionId, resultText, permissionDenials,
        // raw streams retained on the in-process return ONLY (never written to the
        // DB row) so the pause-(c) matrix can inspect ground truth as root.
        rawStdout: stdout, rawStderr: stderr,
      });
    });

    // brief via stdin — never interpolated into argv or a shell
    try { child.stdin.write(String(brief ?? '')); child.stdin.end(); } catch { /* */ }
  });
}

// ── process one dispatch ──────────────────────────────────────────────────────
async function processOne(env, rest, row, ccUser, log = console) {
  const id = row.id;
  // 1. structural scope validation — never trust the row
  const sv = validateScope(row.scope);
  if (!sv.ok) {
    await writeBack(rest, id, { status: 'failed', error_message: sv.reason, completed_at: new Date().toISOString() });
    log.warn?.(`[dispatcher] ${id} rejected: ${sv.reason}`);
    return;
  }
  // 2. never run CC as root
  if (!ccUser) {
    await writeBack(rest, id, { status: 'failed', error_message: `ccdispatch user absent — refusing to run Claude Code as root. Run scripts/setup-ccdispatch-user.sh.`, completed_at: new Date().toISOString() });
    return;
  }
  let clonePath, homeDir;
  try {
    clonePath = prepareClone(id, row.pinned_commit, ccUser);
    // CC's HOME — a sibling dir to the clone (owned by ccdispatch) so CC's own
    // state files never pollute the repo clone's git-status clean assert.
    homeDir = `${clonePath}.home`;
    mkdirSync(homeDir, { recursive: true });
    execFileSync('chown', ['-R', `${ccUser.uid}:${ccUser.gid}`, homeDir]);
    // pause-(c) matrix plant (gated): drop a root-owned 0600 file INSIDE the
    // ccdispatch-owned clone to prove ownership/perms gate reads even within CC's
    // own work area. Off in production (no env var).
    if (process.env.QCLAW_CC_PLANT_FILE) {
      writeFileSync(join(clonePath, 'PLANTED_SECRET.txt'), `${process.env.QCLAW_CC_PLANT_VALUE || 'PLANTED-SECRET-DO-NOT-LEAK'}\n`, { mode: 0o600 });
    }
    const r = await runClaudeCode({
      env, clonePath, homeDir, brief: row.brief, ccUser,
      timeoutSeconds: Number(row.timeout_seconds) || 600,
    });
    // pause-(c) matrix raw capture (gated): write CC's RAW stdout/stderr +
    // permission_denials to a ROOT-ONLY file (0600) — NEVER to the DB row — so the
    // matrix can verify the secret was never read (vs read-then-scrubbed) as root.
    if (process.env.QCLAW_CC_CAPTURE_DIR) {
      try {
        mkdirSync(process.env.QCLAW_CC_CAPTURE_DIR, { recursive: true });
        writeFileSync(join(process.env.QCLAW_CC_CAPTURE_DIR, `${id}.json`),
          JSON.stringify({ id, exitCode: r.exitCode, permission_denials: r.permissionDenials, rawStdout: r.rawStdout, rawStderr: r.rawStderr }, null, 2),
          { mode: 0o600 });
      } catch (e) { log.warn?.(`[dispatcher] capture failed: ${e.message}`); }
    }
    // 3. post-hoc clean assert (read-only contract)
    let { status, resultText, error } = r;
    if (status === 'complete' && workingTreeDirty(clonePath, ccUser, log)) {
      status = 'failed';
      error = 'working tree mutated under a read-only scope — rejected';
    }
    // 4. scrub secrets from untrusted output, then a SINGLE atomic write-back
    const secrets = [env.ANTHROPIC_API_KEY, env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_ANON_KEY].filter(Boolean);
    const cleanResult = scrubSecretsFromOutput(resultText, secrets);
    await writeBack(rest, id, {
      status,
      result: status === 'complete' ? cleanResult : null,
      result_summary: status === 'complete' ? summarise(cleanResult) : null,
      error_message: status === 'complete' ? null : (scrubSecretsFromOutput(error, secrets) || 'failed'),
      exit_code: r.exitCode,
      cc_session_id: r.ccSessionId,
      cost_usd: r.costUsd,
      attempts: (Number(row.attempts) || 1),
      completed_at: new Date().toISOString(),
      // permission_denials is CC's tool-policy refusal list (not secrets) — useful audit signal
      metadata: { permission_denials: r.permissionDenials || [] },
    });
    log.info?.(`[dispatcher] ${id} → ${status}${r.costUsd != null ? ` ($${r.costUsd})` : ''}`);
  } catch (err) {
    await writeBack(rest, id, { status: 'failed', error_message: `dispatcher error: ${err.message}`.slice(0, 500), completed_at: new Date().toISOString() }).catch(() => {});
    log.error?.(`[dispatcher] ${id} errored: ${err.message}`);
  } finally {
    if (clonePath) cleanupClone(clonePath);
    if (homeDir) cleanupClone(homeDir);
  }
}

// ── main loop ─────────────────────────────────────────────────────────────────
async function mainLoop(env, log = console) {
  const rest = makeRest(env);
  const ccUser = resolveCcUser();
  log.info?.(`[dispatcher] starting — ccUser=${ccUser ? `${ccUser.uid}:${ccUser.gid}` : 'MISSING'}, poll=${POLL_MS}ms, heartbeat=${HEARTBEAT_MS}ms, supabase=${env.SUPABASE_URL ? 'set' : 'MISSING'}`);
  if (!ccUser) log.warn?.(`[dispatcher] ccdispatch user not found — dispatches will FAIL (never run CC as root). Run scripts/setup-ccdispatch-user.sh`);

  // startup reaper: recover rows orphaned by a previous dead/hung dispatcher
  try { await reapStale(rest); } catch (e) { log.warn?.(`[dispatcher] startup reap failed: ${e.message}`); }

  // decoupled heartbeat — independent of long CC runs
  let inProgress = null;
  const beat = async () => {
    try {
      const depth = await queueDepth(rest).catch(() => null);
      await recordBeat({
        url: (env.SUPABASE_URL || '').replace(/\/+$/, ''), key: env.SUPABASE_SERVICE_ROLE_KEY,
        workflowId: DISPATCHER_ID, workflowName: 'Claude Code dispatcher (quantumclaw)', status: 'success',
        metadata: { pid: process.pid, queue_depth: depth, in_progress_task_id: inProgress },
      });
    } catch (e) { log.debug?.(`[dispatcher] beat failed: ${e.message}`); }
  };
  beat();
  const hbTimer = setInterval(beat, HEARTBEAT_MS); if (hbTimer.unref) hbTimer.unref();
  const reapTimer = setInterval(() => reapStale(rest).catch(() => {}), REAP_EVERY_MS); if (reapTimer.unref) reapTimer.unref();

  const startOfDayMs = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };

  // poll loop
  for (;;) {
    try {
      // spend ceiling
      const sinceMs = startOfDayMs();
      const spent = await dailySpend(rest, sinceMs, new Date(sinceMs).toISOString());
      if (spent >= DAILY_SPEND_CAP_USD) { log.warn?.(`[dispatcher] daily spend cap reached ($${spent.toFixed(2)}/${DAILY_SPEND_CAP_USD}) — pausing claims`); await sleep(POLL_MS * 4); continue; }
      // saturation pause
      const depth = await queueDepth(rest);
      if (depth > QUEUE_SATURATION) log.warn?.(`[dispatcher] queue saturated (${depth} > ${QUEUE_SATURATION})`);

      const row = await claimNext(rest);
      // one-shot drain (gated): used by the pause-(c) matrix to process the queued
      // briefs then exit cleanly. Production runs the infinite loop.
      if (!row) {
        if (process.env.QCLAW_CC_ONESHOT === '1') { log.info?.('[dispatcher] one-shot: queue drained, exiting'); return; }
        await sleep(POLL_MS); continue;
      }
      inProgress = row.id;
      await processOne(env, rest, row, ccUser, log);
      inProgress = null;
    } catch (err) {
      log.error?.(`[dispatcher] loop error (continuing): ${err.message}`);
      await sleep(POLL_MS);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── entrypoint (only when run directly; importing for tests does nothing) ─────
// Robust main detection — the naive `import.meta.url === 'file://'+argv[1]` is
// fragile under PM2's ESM launch (path/symlink differences) and silently skips
// mainLoop while PM2 keeps the process "online". Compare realpaths.
let isMain = false;
try {
  const here = fileURLToPath(import.meta.url);
  isMain = !!process.argv[1] && (process.argv[1] === here || realpathSync(process.argv[1]) === realpathSync(here));
} catch { isMain = import.meta.url === `file://${process.argv[1]}`; }
if (isMain) {
  if (process.env.QCLAW_CC_DISPATCHER_ENABLED === '0') {
    console.warn('[dispatcher] QCLAW_CC_DISPATCHER_ENABLED=0 — not starting');
    process.exit(0);
  }
  mainLoop(loadEnv()).catch((err) => { console.error(`[dispatcher] fatal: ${err?.message || err}`); process.exit(1); });
}
