/**
 * Slice 6c Unit 6 — typed, read-only observation tools for specialists.
 *
 * Scope principal isolation: specialists do NOT get shell_exec (charlie's
 * surface). Instead they get four typed, path-bounded builtins that expose
 * just enough of the codebase to observe it, with no shell, no writes, and
 * no path escape.
 *
 *   read_file(path)        → { content, path, lines }     (src/ + docs/ only)
 *   grep_repo(pattern,dir?)→ { matches:[{file,line,content}] } (src/ + docs/)
 *   list_dir(path)         → { entries:[{name,type,size}] } (anywhere in repo)
 *   git_status()           → { branch, clean, changes:[{status,file}] }
 *
 * Registration scope is supplied by the caller (index.js) and is built
 * DYNAMICALLY from the loaded specialist registry at registration time — the
 * scope array is never hardcoded here.
 *
 * repoRoot defaults to this module's repo root (src/tools → '../..'), which is
 * /root/QClaw in production. Overridable for tests (Rule 5 CI-parity — no
 * hardcoded /root on the happy path).
 */

import child_process from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, sep } from 'path';
import { SAFE_ENV } from './shell-exec-verb-schemas.js';

const DEFAULT_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Shell metacharacters rejected in grep patterns. We never invoke a shell
// (matching is done in-process with RegExp), so this is defence-in-depth —
// it also keeps patterns from smuggling intent that a future impl might shell out.
const SHELL_META = /[;|&$`\n\r<>(){}\\]/;

const MAX_FILE_BYTES = 512 * 1024;   // read_file / grep per-file ceiling
const MAX_GREP_MATCHES = 200;
const SKIP_DIRS = new Set(['node_modules', '.git', '.quantumclaw']);

/** Resolve `candidate` (abs or relative-to-repoRoot) and confirm it is the
 *  realpath of, or contained under, one of the allowed subdirs. null = reject. */
function resolveWithin(repoRoot, subdirs, candidate) {
  if (typeof candidate !== 'string' || !candidate) return null;
  const abs = resolve(repoRoot, candidate);
  let real;
  try { real = realpathSync(abs); } catch { return null; }
  for (const sub of subdirs) {
    let root;
    try { root = realpathSync(join(repoRoot, sub)); } catch { continue; }
    if (real === root || real.startsWith(root + sep)) return real;
  }
  return null;
}

function walkFiles(dir, out, cap) {
  if (out.length >= cap) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= cap) return;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkFiles(join(dir, e.name), out, cap);
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
    }
  }
}

/**
 * @param {object} opts { repoRoot?, audit?, auditActor? }
 * @returns {Array<{name,description,inputSchema,fn}>} builtin definitions (no scope — caller sets it)
 */
export function createObservationTools(opts = {}) {
  const repoRoot = opts.repoRoot || DEFAULT_REPO_ROOT;
  const audit = opts.audit || null;
  const actor = opts.auditActor || 'specialist';
  const note = (tool, detail) => { try { audit?.log?.(actor, `observe:${tool}`, String(detail).slice(0, 120)); } catch {} };

  const read_file = {
    name: 'read_file',
    description: 'Read a source/doc file. Path must be under the repo src/ or docs/ directories. Returns { content, path, lines }.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'repo-relative or absolute path under src/ or docs/' } }, required: ['path'] },
    fn: async ({ path } = {}) => {
      const real = resolveWithin(repoRoot, ['src', 'docs'], path);
      if (!real) throw new Error(`read_file: path not allowed (must resolve under repo src/ or docs/): ${path}`);
      const st = statSync(real);
      if (!st.isFile()) throw new Error(`read_file: not a file: ${path}`);
      if (st.size > MAX_FILE_BYTES) throw new Error(`read_file: file too large (${st.size} > ${MAX_FILE_BYTES} bytes)`);
      const content = readFileSync(real, 'utf-8');
      note('read_file', real);
      return { content, path: real, lines: content.split('\n').length };
    },
  };

  const grep_repo = {
    name: 'grep_repo',
    description: 'Search repo file contents (src/ + docs/) for a pattern. Pattern is a literal/simple regex — shell metacharacters are rejected. Returns { matches:[{file,line,content}] }.',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, dir: { type: 'string', description: 'optional subdir (default src/)' } }, required: ['pattern'] },
    fn: async ({ pattern, dir } = {}) => {
      if (typeof pattern !== 'string' || !pattern) throw new Error('grep_repo: pattern required');
      if (SHELL_META.test(pattern)) throw new Error('grep_repo: pattern contains disallowed shell metacharacters');
      let re;
      try { re = new RegExp(pattern); } catch (e) { throw new Error(`grep_repo: invalid pattern: ${e.message}`); }
      const searchRoot = resolveWithin(repoRoot, ['src', 'docs'], dir || 'src');
      if (!searchRoot) throw new Error(`grep_repo: dir not allowed (must be under src/ or docs/): ${dir}`);
      const files = [];
      walkFiles(searchRoot, files, 5000);
      const matches = [];
      for (const f of files) {
        if (matches.length >= MAX_GREP_MATCHES) break;
        let st; try { st = statSync(f); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) continue;
        let text; try { text = readFileSync(f, 'utf-8'); } catch { continue; }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push({ file: f, line: i + 1, content: lines[i].slice(0, 300) });
            if (matches.length >= MAX_GREP_MATCHES) break;
          }
        }
      }
      note('grep_repo', `${pattern} (${matches.length})`);
      return { matches, truncated: matches.length >= MAX_GREP_MATCHES };
    },
  };

  const list_dir = {
    name: 'list_dir',
    description: 'List a directory inside the repo. Path must be under the repo root. Returns { entries:[{name,type,size}] }.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'repo-relative or absolute path under the repo root' } }, required: ['path'] },
    fn: async ({ path } = {}) => {
      const real = resolveWithin(repoRoot, ['.'], path);
      if (!real) throw new Error(`list_dir: path not allowed (must resolve under repo root): ${path}`);
      const st = statSync(real);
      if (!st.isDirectory()) throw new Error(`list_dir: not a directory: ${path}`);
      const entries = readdirSync(real, { withFileTypes: true }).map(e => {
        let size = null;
        try { size = e.isFile() ? statSync(join(real, e.name)).size : null; } catch {}
        return { name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size };
      });
      note('list_dir', real);
      return { path: real, entries };
    },
  };

  const git_status = {
    name: 'git_status',
    description: 'Working-tree state of the repo (no path argument — always the repo). Returns { branch, clean, changes:[{status,file}] }.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    fn: async () => {
      const out = await new Promise((res, rej) => {
        // shell:false, hardened SAFE_ENV; -c safe.directory neutralises the
        // GIT_CONFIG_GLOBAL=/dev/null "dubious ownership" refusal (LOCATIONS /
        // shell-exec-spawn precedent). Fixed argv — no user input reaches argv.
        const child = child_process.spawn('git', [
          '-c', `safe.directory=${repoRoot}`, '-C', repoRoot, 'status', '--porcelain=v1', '-b',
        ], { shell: false, env: { ...SAFE_ENV }, timeout: 10000 });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; if (stdout.length > MAX_FILE_BYTES) child.kill(); });
        child.stderr.on('data', d => { stderr += d; });
        child.on('error', rej);
        child.on('close', (code) => code === 0 ? res(stdout) : rej(new Error(`git_status: git exited ${code}: ${stderr.slice(0, 200)}`)));
      });
      const lines = out.split('\n').filter(Boolean);
      let branch = null;
      const changes = [];
      for (const ln of lines) {
        if (ln.startsWith('## ')) {
          // "## branch...origin/branch [ahead N]" → take the local branch token
          branch = ln.slice(3).split(/\.\.\.| /)[0];
        } else {
          changes.push({ status: ln.slice(0, 2).trim(), file: ln.slice(3) });
        }
      }
      note('git_status', `${branch} (${changes.length} changes)`);
      return { branch, clean: changes.length === 0, changes };
    },
  };

  return [read_file, grep_repo, list_dir, git_status];
}

/** Register all observation tools as builtins scoped to `specialistNames`
 *  (a dynamically-built array). No-op + warn if the array is empty. */
export function registerObservationTools(toolRegistry, specialistNames, opts = {}) {
  if (!toolRegistry || typeof toolRegistry.registerBuiltin !== 'function') return [];
  if (!Array.isArray(specialistNames) || specialistNames.length === 0) return [];
  const tools = createObservationTools(opts);
  for (const def of tools) {
    toolRegistry.registerBuiltin(def.name, {
      scope: specialistNames,           // dynamic — the loaded specialist roster
      description: def.description,
      inputSchema: def.inputSchema,
      fn: def.fn,
    });
  }
  return tools.map(t => t.name);
}
