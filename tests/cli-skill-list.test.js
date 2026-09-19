/**
 * qclaw skill list CLI regression test.
 *
 * Run: node tests/cli-skill-list.test.js
 *
 * Slice 2a Task 7. The skill list command was migrated from SkillLoader
 * (now retired) to direct frontmatter parsing of /root/QClaw/src/agents/skills/.
 * This test spawns the CLI as a subprocess and asserts the new output
 * surface produces:
 *   - the expected skill count
 *   - every canonical skill name
 *   - a category tag in [brackets] for each skill
 *   - "(N endpoints)" for skills that declare a "## Endpoints" section
 *
 * The pre-migration command emitted "<name>" with optional "(N endpoints)".
 * The post-migration command preserves that format and adds " [category]"
 * — superset of the legacy format.
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { readdirSync, readFileSync } from 'fs';
import { countEndpointLines } from '../src/agents/skill-parser.js';

const __filename = fileURLToPath(import.meta.url);
const REPO = join(dirname(__filename), '..');
const CLI = join(REPO, 'src', 'cli', 'index.js');
const SKILLS_DIR = join(REPO, 'src', 'agents', 'skills');

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function expectedSkills() {
  const out = [];
  for (const file of readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md')).sort()) {
    const content = readFileSync(join(SKILLS_DIR, file), 'utf-8');
    const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    const body = m[1];
    const get = (k) => {
      const line = body.split(/\r?\n/).find(l => l.match(new RegExp(`^${k}:\\s`)));
      return line ? line.replace(new RegExp(`^${k}:\\s*`), '').trim() : null;
    };
    const name = get('name') || file.replace(/\.md$/, '');
    const category = get('category');
    // Endpoint count under "## Endpoints", by the parser's own grammar. This
    // was a fourth copy of that grammar, which is how a `[level]` prefix
    // would have made the CLI and this test agree with each other and
    // disagree with the parser.
    out.push({ name, category, endpoints: countEndpointLines(content) });
  }
  return out;
}

const result = spawnSync('node', [CLI, 'skill', 'list'], {
  cwd: REPO, encoding: 'utf-8',
  // some env entries (HOME) the banner module may need
  env: { ...process.env },
});

check('CLI exited 0', result.status === 0, `status=${result.status} stderr=${result.stderr?.slice(0, 200)}`);

const stdout = stripAnsi(result.stdout || '');
const expected = expectedSkills();

check(`CLI output mentions skill count (${expected.length})`,
  new RegExp(`${expected.length}\\s+skill`).test(stdout),
  `output head: ${stdout.split('\n').slice(0, 5).join(' | ')}`);

for (const sk of expected) {
  check(`CLI lists skill "${sk.name}"`, stdout.includes(sk.name),
    `looking for "${sk.name}" in output`);
  if (sk.category) {
    check(`CLI tags "${sk.name}" with [${sk.category}]`,
      stdout.includes(`[${sk.category}]`),
      `expected [${sk.category}] near "${sk.name}"`);
  }
  if (sk.endpoints > 0) {
    check(`CLI shows endpoint count for "${sk.name}"`,
      new RegExp(`${sk.name}.*\\(${sk.endpoints} endpoints\\)`).test(stdout),
      `expected (${sk.endpoints} endpoints) for ${sk.name}`);
  } else {
    // Zero is a claim too. A skill whose endpoint-looking lines the parser
    // rejects (clipper's em dashes, #151) must not be shown with a count, or
    // the CLI reports a surface that registers nothing.
    const esc = sk.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = stdout.split('\n').find((l) => new RegExp(`^\\s*${esc}(\\s|$)`).test(l)) || '';
    check(`CLI shows no endpoint count for "${sk.name}"`,
      !/\(\d+ endpoints\)/.test(line), `line: ${line.trim()}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
