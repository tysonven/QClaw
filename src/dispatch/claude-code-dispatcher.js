/**
 * QuantumClaw — claude-code-dispatcher (Slice 5, Component 6 v1, step 3)
 *
 * A single-instance PM2 worker (runs as root) that drains queued
 * `claude_code_dispatches`, runs Claude Code READ-ONLY as the unprivileged
 * `ccdispatch` user against a throwaway clone, and writes the result back.
 *
 * Security spine (design v2; Phase 5 Session 2 adds write scope):
 *  - Structural scope validation at the dispatcher (not the tool): only audit/
 *    read_only/write run; infra/critical → failed, CC never invoked. Fail closed.
 *  - Write scope also requires authorised_by/authorised_at on the row (the Telegram
 *    approval provenance) and CC runs under acceptEdits with the write settings; the
 *    DISPATCHER (never CC) validates the diff vs expected_paths then pushes + opens a
 *    PR to tysonven/QClaw. GH_TOKEN is read from the encrypted store at dispatch time,
 *    injected into the child env for write only, and scrubbed from all output.
 *  - CC runs as `ccdispatch` (kernel perms deny secret reads) in a fresh clone at
 *    the row's pinned commit; scrubbed child env (only ANTHROPIC_API_KEY/PATH/HOME,
 *    +GH_TOKEN for write); plan mode + --disallowedTools + --settings deny-list for
 *    read-only (defence-in-depth); --max-budget-usd; brief via stdin (never shell-interpolated).
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
import { loadConfig } from '../core/config.js';
import { SecretStore } from '../security/secrets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── config ────────────────────────────────────────────────────────────────
// v1 ran only audit/read_only. Phase 5 Session 2 adds `write` (mutating: CC runs
// under acceptEdits, then the DISPATCHER — never CC — validates the diff against
// expected_paths, pushes, and opens a PR). `infra`/`critical` remain hard-rejected;
// never expand this Set beyond write without a new slice + approval.
const ALLOWED_SCOPES = new Set(['audit', 'read_only', 'write']);
const WRITE_SCOPES = new Set(['write']);            // scopes that mutate + push a PR
const CC_BIN = process.env.QCLAW_CC_BIN || 'claude';
const CC_USER = process.env.QCLAW_CC_USER || 'ccdispatch';
const REPO_PATH = process.env.QCLAW_REPO_PATH || '/root/QClaw';
const WORK_ROOT = process.env.QCLAW_CC_WORK_ROOT || '/home/ccdispatch/work';
const SETTINGS_PATH = process.env.QCLAW_CC_SETTINGS || join(__dirname, 'cc-readonly-settings.json');
const WRITE_SETTINGS_PATH = process.env.QCLAW_CC_WRITE_SETTINGS || join(__dirname, 'cc-write-settings.json');
// GitHub push target for write-scope PRs. NEVER upstream QuantumClaw/QClaw.
const GH_REPO = process.env.QCLAW_CC_GH_REPO || 'tysonven/QClaw';
const GH_BASE_BRANCH = process.env.QCLAW_CC_GH_BASE || 'main';
const GH_SECRET_KEY = process.env.QCLAW_CC_GH_SECRET_KEY || 'ccdispatch_github_token';
// ccdispatch has no configured git identity; commits must carry one explicitly.
const GIT_AUTHOR_NAME = process.env.QCLAW_CC_GIT_NAME || 'Charlie (Claude Code)';
const GIT_AUTHOR_EMAIL = process.env.QCLAW_CC_GIT_EMAIL || 'charlie@flowos.tech';
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
export function loadEnv() {
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
 * no inherited root env (so /proc/self/environ can't leak our other secrets).
 * For WRITE scope only, a GH_TOKEN is injected (CC + the dispatcher's git/gh share
 * one scrubbed env). ghToken MUST be absent for audit/read_only (secret minimisation). */
export function scrubChildEnv(env, homeDir, ghToken = null) {
  const out = {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: homeDir,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || '',
    LANG: env.LANG || 'C.UTF-8',
  };
  if (ghToken) {
    out.GH_TOKEN = ghToken;
    // never let git block on an interactive credential prompt in a headless run
    out.GIT_TERMINAL_PROMPT = '0';
  }
  return out;
}

/** Headless CC argv. Brief is piped via stdin, never argv.
 *  - read-only (default): plan mode + Edit/Write/NotebookEdit disallowed.
 *  - write (writeMode): acceptEdits (CC actually mutates the clone); no Edit/Write
 *    disallow; the write settings deny-list still blocks push/commit/gh/secret reads. */
export function buildCcArgv({ clonePath, settingsPath, budgetUsd, writeMode = false }) {
  const argv = ['-p', '--bare'];
  if (writeMode) {
    argv.push('--permission-mode', 'acceptEdits');
  } else {
    argv.push('--permission-mode', 'plan');
  }
  argv.push('--add-dir', clonePath, '--settings', settingsPath);
  if (!writeMode) argv.push('--disallowedTools', 'Edit Write NotebookEdit');
  argv.push('--output-format', 'json', '--max-budget-usd', String(budgetUsd));
  return argv;
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

// ── write-scope helpers (unit-tested; no host, no shell) ─────────────────────

/** First non-empty line of the brief's `# Task` section — the PR/commit one-liner.
 * Falls back to the first non-empty, non-heading line, then a generic default. */
export function briefTaskLine(brief, max = 100) {
  const lines = String(brief ?? '').replace(/\r/g, '').split('\n');
  const i = lines.findIndex((l) => l.trim().toLowerCase() === '# task');
  if (i >= 0) {
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t.startsWith('#')) break;          // hit the next section, no task body
      if (t) return t.slice(0, max);
    }
  }
  const firstReal = lines.map((l) => l.trim()).find((t) => t && !t.startsWith('#'));
  return (firstReal || 'dispatched change').slice(0, max);
}

/** Parse an optional `# Expected paths` section from the brief. Accepts either a
 * JSON array on one line or a bullet/newline list. Returns a de-duped string[] of
 * declared repo-relative paths, or `null` if the section is absent (→ skip
 * validation). An EMPTY declared list returns [] (→ nothing may change). */
export function parseExpectedPaths(brief) {
  const lines = String(brief ?? '').replace(/\r/g, '').split('\n');
  const i = lines.findIndex((l) => l.trim().toLowerCase() === '# expected paths');
  if (i < 0) return null;                     // section absent → caller skips validation
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim().startsWith('#')) break; // next section
    body.push(lines[j]);
  }
  const raw = body.join('\n').trim();
  let paths = [];
  if (raw.startsWith('[')) {
    try { const arr = JSON.parse(raw); if (Array.isArray(arr)) paths = arr.map(String); }
    catch { /* fall through to line parsing */ }
  }
  if (paths.length === 0) {
    paths = raw.split('\n')
      .map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/^["']|["'],?$/g, '').trim())
      .filter(Boolean);
  }
  // normalise: strip leading ./ and surrounding quotes; de-dupe
  const norm = paths.map((p) => p.replace(/^\.\//, '').replace(/^["']|["']$/g, '').trim()).filter(Boolean);
  return [...new Set(norm)];
}

/** Pure decision for a write run's post-CC state. `changedFiles` = git-diff output
 * (repo-relative). `expectedPaths` = parseExpectedPaths result (null ⇒ not declared).
 *  - no changes            → { action:'nochange' }  (mark complete, note, no push)
 *  - expectedPaths null     → { action:'push', skippedValidation:true }  (+warn)
 *  - all changes ⊆ expected → { action:'push' }
 *  - any change ⊄ expected  → { action:'abort', unexpected:[...] }  (fail, no push) */
export function planWriteOutcome({ changedFiles, expectedPaths }) {
  const changed = (changedFiles || []).map((f) => String(f).trim()).filter(Boolean);
  if (changed.length === 0) return { action: 'nochange', unexpected: [] };
  if (expectedPaths == null) return { action: 'push', unexpected: [], skippedValidation: true };
  const allow = new Set(expectedPaths);
  const unexpected = changed.filter((f) => !allow.has(f));
  if (unexpected.length > 0) return { action: 'abort', unexpected };
  return { action: 'push', unexpected: [] };
}

/** Read the ccdispatch GitHub token from the encrypted secret store at dispatch
 * time (never cached at module load). Returns the token string, or null if the
 * store/key is unavailable — the write dispatch then fails cleanly (no push). */
export async function getGhToken(secretKey = GH_SECRET_KEY) {
  try {
    const cfg = await loadConfig();
    const store = new SecretStore(cfg);
    await store.load();
    return store.get(secretKey) || null;
  } catch {
    return null;
  }
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
/** Prepare the throwaway clone + a sibling ccdispatch-owned HOME. Returns both paths.
 * (Extracted so processOne's control flow can be exercised with an injected fake.) */
function setupWorkspace(id, row, ccUser) {
  const clonePath = prepareClone(id, row.pinned_commit, ccUser);
  // CC's HOME — a sibling dir to the clone (owned by ccdispatch) so CC's own state
  // files never pollute the repo clone's git-status assert.
  const homeDir = `${clonePath}.home`;
  mkdirSync(homeDir, { recursive: true });
  execFileSync('chown', ['-R', `${ccUser.uid}:${ccUser.gid}`, homeDir]);
  return { clonePath, homeDir };
}
function cleanupWorkspace(clonePath, homeDir) {
  if (clonePath) cleanupClone(clonePath);
  if (homeDir) cleanupClone(homeDir);
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

// ── write-scope git/gh (as ccdispatch; the dispatcher, NEVER CC, pushes) ──────
/** Repo-relative list of every file CC changed in the clone — tracked
 * modifications AND untracked new files. Run AS ccUser (clone owner) so there is
 * no dubious-ownership warning. `--porcelain` with rename detection off keeps the
 * path list literal (safe to compare as JS strings, never shell-globbed). */
export function changedFilesInClone(clonePath, ccUser, runner = execFileSync) {
  const out = runner('git', ['-C', clonePath, 'status', '--porcelain', '--untracked-files=all', '--no-renames'],
    { uid: ccUser.uid, gid: ccUser.gid, encoding: 'utf8' });
  return String(out).split('\n')
    .map((l) => l.slice(3).trim())   // strip the 2-char XY status + space
    .filter(Boolean);
}

/**
 * Commit CC's changes, push a fresh branch to GH_REPO, open a PR. Runs every git/gh
 * command AS ccUser with a scrubbed env holding GH_TOKEN (never in argv or the URL:
 * the gh credential helper supplies it). Returns the PR URL (last stdout line).
 * Throws on any git/gh failure — the caller marks the dispatch failed (no partial).
 */
export function pushAndOpenPr({ clonePath, homeDir, ccUser, ghToken, branch, commitMessage, title, body, runner = execFileSync }) {
  const env = scrubChildEnv({ PATH: process.env.PATH }, homeDir, ghToken);
  const git = (...args) => runner('git', ['-C', clonePath, ...args], { uid: ccUser.uid, gid: ccUser.gid, env, encoding: 'utf8' });
  git('checkout', '-b', branch);
  git('add', '-A');
  git('-c', `user.name=${GIT_AUTHOR_NAME}`, '-c', `user.email=${GIT_AUTHOR_EMAIL}`, 'commit', '-m', commitMessage);
  // push to the GitHub URL directly (token is NOT in the URL — the gh credential
  // helper injects it), so no persistent remote or token-in-config is left behind.
  git('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    'push', `https://github.com/${GH_REPO}.git`, `HEAD:${branch}`);
  const prOut = runner('gh',
    ['pr', 'create', '-R', GH_REPO, '--base', GH_BASE_BRANCH, '--head', branch, '--title', title, '--body', body],
    { cwd: clonePath, uid: ccUser.uid, gid: ccUser.gid, env, encoding: 'utf8' });
  const url = String(prOut).trim().split('\n').filter(Boolean).pop() || '';
  return url;
}

// ── CC invocation (the wiring; gated to live runs, reviewed at pause c) ───────
/**
 * Spawn Claude Code as `ccdispatch`, brief on stdin, group-killed on timeout.
 * Single-flight: only the first of {exit, timeout} resolves. Returns
 * { ok, status, resultText, exitCode, costUsd, ccSessionId, error }.
 */
export function runClaudeCode({ env, clonePath, homeDir, brief, ccUser, timeoutSeconds, budgetUsd = PER_DISPATCH_BUDGET_USD, writeMode = false, ghToken = null }) {
  return new Promise((resolve) => {
    // write scope runs under acceptEdits with the write settings; GH_TOKEN is only
    // injected into the child env for write (secret minimisation for read-only runs).
    const argv = buildCcArgv({ clonePath, settingsPath: writeMode ? WRITE_SETTINGS_PATH : SETTINGS_PATH, budgetUsd, writeMode });
    const child = spawn(CC_BIN, argv, {
      cwd: clonePath,
      uid: ccUser.uid,
      gid: ccUser.gid,
      // HOME is a SEPARATE dir, NOT the clone — otherwise CC writes its own state
      // (.claude/, session files) into the repo clone and pollutes the post-hoc
      // git-status clean assert (false "mutated" failures). HOME falls back to the
      // clone only if no separate home was provided.
      env: scrubChildEnv(env, homeDir || clonePath, writeMode ? ghToken : null),
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
// deps are injectable seams so processOne's control flow (esp. the write branch)
// can be exercised without a real clone/CC/host. Production passes none → real impls.
export async function processOne(env, rest, row, ccUser, log = console, deps = {}) {
  const {
    setup = setupWorkspace,
    runCc = runClaudeCode,
    isDirty = workingTreeDirty,
    listChanged = changedFilesInClone,
    pushPr = pushAndOpenPr,
    loadGhToken = getGhToken,
    cleanup = cleanupWorkspace,
    now = () => new Date().toISOString(),
  } = deps;
  const id = row.id;
  // 1. structural scope validation — never trust the row
  const sv = validateScope(row.scope);
  if (!sv.ok) {
    await writeBack(rest, id, { status: 'failed', error_message: sv.reason, completed_at: now() });
    log.warn?.(`[dispatcher] ${id} rejected: ${sv.reason}`);
    return;
  }
  const isWrite = WRITE_SCOPES.has(row.scope);
  // 1b. write-scope authorisation-provenance guard (defence in depth). The row is
  // untrusted; only the ✅ handler re-queues a write row and stamps authorised_by/at.
  // A directly-fabricated queued+write row (bypassing Telegram) lacks them → refuse.
  if (isWrite && !(row.authorised_at && row.authorised_by)) {
    await writeBack(rest, id, { status: 'failed', error_message: 'write-scope dispatch is not authorised (no authorised_by/authorised_at) — refusing to execute', completed_at: now() });
    log.warn?.(`[dispatcher] ${id} rejected: unauthorised write-scope row`);
    return;
  }
  // 2. never run CC as root
  if (!ccUser) {
    await writeBack(rest, id, { status: 'failed', error_message: `ccdispatch user absent — refusing to run Claude Code as root. Run scripts/setup-ccdispatch-user.sh.`, completed_at: now() });
    return;
  }
  // 3. write scope: read GH_TOKEN from the encrypted store AT DISPATCH TIME (not at
  // module load). Fail cleanly (no CC run) if the secret is missing.
  let ghToken = null;
  if (isWrite) {
    ghToken = await loadGhToken();
    if (!ghToken) {
      await writeBack(rest, id, { status: 'failed', error_message: `write-scope dispatch needs ${GH_SECRET_KEY} in the secret store — none found; not run`, completed_at: now() });
      log.warn?.(`[dispatcher] ${id} rejected: ${GH_SECRET_KEY} unavailable`);
      return;
    }
  }
  // secret-scrub set — GH_TOKEN is added to the scrubber's known-values list BEFORE
  // CC runs, so it can never survive into result/error/summary (criterion E).
  const secrets = [env.ANTHROPIC_API_KEY, env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_ANON_KEY, ghToken].filter(Boolean);

  let clonePath, homeDir;
  try {
    ({ clonePath, homeDir } = setup(id, row, ccUser));
    // pause-(c) matrix plant (gated): drop a root-owned 0600 file INSIDE the
    // ccdispatch-owned clone to prove ownership/perms gate reads even within CC's
    // own work area. Off in production (no env var).
    if (process.env.QCLAW_CC_PLANT_FILE) {
      writeFileSync(join(clonePath, 'PLANTED_SECRET.txt'), `${process.env.QCLAW_CC_PLANT_VALUE || 'PLANTED-SECRET-DO-NOT-LEAK'}\n`, { mode: 0o600 });
    }
    const r = await runCc({
      env, clonePath, homeDir, brief: row.brief, ccUser,
      timeoutSeconds: Number(row.timeout_seconds) || 600,
      writeMode: isWrite, ghToken,
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

    let { status, resultText, error } = r;
    let prUrl = null;
    let note = null;
    let unexpected = [];

    if (isWrite) {
      // Write contract: CC mutates; the DISPATCHER validates the diff vs expected_paths
      // and (only if clean) commits + pushes + opens a PR. CC never pushes.
      if (status === 'complete') {
        let changed = [];
        try { changed = listChanged(clonePath, ccUser); }
        catch (e) { status = 'failed'; error = `could not read git diff: ${e.message}`; }
        if (status === 'complete') {
          const expectedPaths = parseExpectedPaths(row.brief);
          const plan = planWriteOutcome({ changedFiles: changed, expectedPaths });
          if (plan.skippedValidation) log.warn?.(`[dispatcher] ${id}: no expected_paths declared — skipping path validation; pushing whatever CC changed`);
          if (plan.action === 'nochange') {
            note = 'no mutations — CC found nothing to change';   // criterion C/G: still complete, no push
          } else if (plan.action === 'abort') {
            unexpected = plan.unexpected;
            status = 'failed';
            error = `aborted: CC changed files outside expected_paths (not pushed): ${plan.unexpected.join(', ')}`;
          } else {
            const oneLiner = briefTaskLine(row.brief);
            const branch = `cc/write-${String(id).slice(0, 8)}`;
            try {
              prUrl = pushPr({
                clonePath, homeDir, ccUser, ghToken, branch,
                commitMessage: `feat(dispatch): ${oneLiner}`,
                title: oneLiner,
                body: `Dispatched by Charlie. Task ID: ${id}. Review before merging.`,
              });
            } catch (e) { status = 'failed'; error = `push/PR failed: ${e.message}`; }
          }
        }
      }
    } else {
      // read-only contract: any working-tree mutation → fail.
      if (status === 'complete' && isDirty(clonePath, ccUser, log)) {
        status = 'failed';
        error = 'working tree mutated under a read-only scope — rejected';
      }
    }

    // scrub secrets from untrusted output, then a SINGLE atomic write-back
    const cleanResult = scrubSecretsFromOutput(resultText, secrets);
    // for write success, surface the PR url / no-mutation note ahead of CC's own text.
    const resultBody = status !== 'complete' ? null
      : scrubSecretsFromOutput([prUrl ? `PR: ${prUrl}` : null, note, cleanResult].filter(Boolean).join('\n\n'), secrets);
    await writeBack(rest, id, {
      status,
      result: resultBody,
      result_summary: status === 'complete' ? summarise(prUrl || note || cleanResult) : null,
      error_message: status === 'complete' ? null : (scrubSecretsFromOutput(error, secrets) || 'failed'),
      exit_code: r.exitCode,
      cc_session_id: r.ccSessionId,
      cost_usd: r.costUsd,
      attempts: (Number(row.attempts) || 1),
      completed_at: now(),
      // permission_denials is CC's tool-policy refusal list (not secrets) — useful audit signal.
      metadata: { permission_denials: r.permissionDenials || [], pr_url: prUrl, note, unexpected_paths: unexpected },
    });
    log.info?.(`[dispatcher] ${id} → ${status}${prUrl ? ` (${prUrl})` : ''}${r.costUsd != null ? ` ($${r.costUsd})` : ''}`);
  } catch (err) {
    await writeBack(rest, id, { status: 'failed', error_message: scrubSecretsFromOutput(`dispatcher error: ${err.message}`, secrets).slice(0, 500), completed_at: now() }).catch(() => {});
    log.error?.(`[dispatcher] ${id} errored: ${err.message}`);
  } finally {
    cleanup(clonePath, homeDir);
  }
}

// ── main loop ─────────────────────────────────────────────────────────────────
export async function mainLoop(env, log = console) {
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
