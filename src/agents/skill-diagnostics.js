/**
 * QuantumClaw — Skill parse diagnostics
 *
 * Answers one question at boot: does this skill file declare an HTTP surface
 * that it then fails to deliver?
 *
 * WHY THIS EXISTS
 *
 * `parseSkill` returns null when a skill has no base URL or no endpoint that
 * matches the endpoint grammar, and null means the skill registers zero tools.
 * Nothing reported that. On 2026-09-10 an audit found four skill files that
 * present as HTTP surfaces and register nothing, and had done since the day
 * each was created:
 *
 *   ads-agency      `Base URL:` sits under `## Endpoints`, but the parser only
 *   content-studio  reads it under `## Auth`, so baseUrl stays null
 *   clipper         endpoint lines separate path from description with an em
 *                   dash, which the grammar does not match, and there is no
 *                   `Base URL:` line at all
 *   task-queue      NOT a defect: prompt-only, no `## Endpoints` section
 *
 * Charlie appeared to have four capabilities he did not have. The webhooks and
 * services behind three of them were live the whole time.
 *
 * WHAT COUNTS AS "DECLARES AN HTTP SURFACE"
 *
 * Derived from the file, never from a maintained list of skill names. A file
 * is treated as intending to be an HTTP surface if ANY of these is true:
 *
 *   - it has an `## Endpoints` section heading
 *   - it has a `Base URL:` line anywhere
 *   - it declares a non-empty `http:` permission
 *
 * A prose-only skill has none of the three and is silently fine, which is why
 * `identity`, `build`, `lanes` and the rest never appear. `task-queue` has
 * none of them either: its `POST /rest/v1/charlie_tasks` sits under
 * "Creating Tasks Programmatically" as documentation, and the file is
 * `surface: prompt`. Deriving the signal from the file rather than naming the
 * skills is deliberate. A list of "skills that are allowed to fail" is the
 * thing that drifts.
 */

import { parseSkill, skillToTools } from './skill-parser.js';

const ENDPOINT_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s]*)\s*-\s*(.+)/i;
const VERB_LINE_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+\S/i;

/**
 * Does this file present as an HTTP surface?
 * @param {string} content
 * @returns {{ intends: boolean, signals: string[] }}
 */
export function declaresHttpSurface(content) {
  const signals = [];
  const lines = String(content ?? '').split('\n');
  if (lines.some((l) => l.trim().startsWith('## Endpoints'))) signals.push('## Endpoints section');
  if (lines.some((l) => l.trim().startsWith('Base URL:'))) signals.push('Base URL: line');
  const httpPerm = lines.find((l) => /^-\s+http:/i.test(l.trim()));
  if (httpPerm) {
    const value = httpPerm.replace(/^-\s+http:\s*/i, '').trim();
    // Only a HOST LIST counts. The permission line is free text in practice:
    // `business-intelligence` writes "Inherited from Echo's skills (GHL,
    // Stripe, n8n)", which is a sentence about where its data comes from, not
    // a declaration that this file makes HTTP calls. That file is
    // surface: prompt with no endpoints and is correctly silent. Treating any
    // non-"none" value as a signal reported it as broken, which is how a
    // diagnostic earns being ignored.
    const hosts = value
      .replace(/[[\]]/g, '')
      .split(',')
      .map((h) => h.trim())
      // A host has a dot, or is localhost. A bare word does not qualify:
      // "Stripe" and "n8n" are service NAMES in a sentence, and even "none"
      // is a bare word, so a looser pattern matched the very value that means
      // this skill makes no HTTP calls.
      .filter((h) => /^(localhost(:\d+)?|[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+(:\d+)?)$/i.test(h));
    if (hosts.length > 0) signals.push(`http permission [${hosts.join(', ')}]`);
  }
  return { intends: signals.length > 0, signals };
}

/**
 * Explain, in terms an operator can act on, why a file that declares an HTTP
 * surface produced no tools. Returns the specific cause and the line it is on
 * where one can be identified.
 *
 * @param {string} content
 * @returns {{ reason: string, line: number|null, hint: string }}
 */
export function diagnose(content) {
  const lines = String(content ?? '').split('\n');

  // Which section is each line in? The parser only reads `Base URL:` while it
  // is inside `## Auth`, which is the failure ads-agency and content-studio hit.
  let section = null;
  let baseUrlLine = null;
  let baseUrlSection = null;
  let sawEndpointsHeading = false;
  const verbLines = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('## Auth')) { section = 'auth'; continue; }
    if (t.startsWith('## Endpoints')) { section = 'endpoints'; sawEndpointsHeading = true; continue; }
    if (t.startsWith('## Permissions')) { section = 'permissions'; continue; }
    if (t.startsWith('## Usage Notes') || t.startsWith('## Source')) { section = 'notes'; continue; }
    if (t.startsWith('## ')) { section = 'other'; continue; }

    if (t.startsWith('Base URL:') && baseUrlLine === null) {
      baseUrlLine = i + 1;
      baseUrlSection = section;
    }
    if (VERB_LINE_RE.test(t)) verbLines.push({ n: i + 1, text: t, inEndpoints: section === 'endpoints' });
  }

  if (baseUrlLine !== null && baseUrlSection !== 'auth') {
    return {
      reason: `"Base URL:" is inside ${baseUrlSection ? `the ${baseUrlSection} section` : 'no section'}, and the parser only reads it under "## Auth"`,
      line: baseUrlLine,
      hint: 'move the "Base URL:" line under a "## Auth" heading',
    };
  }
  if (baseUrlLine === null) {
    return {
      reason: 'no "Base URL:" line, so the skill has no base URL to build requests from',
      line: null,
      hint: 'add a "## Auth" section containing "Base URL: https://..."',
    };
  }

  // Base URL is fine, so the endpoints are the problem.
  const inEndpoints = verbLines.filter((v) => v.inEndpoints);
  const matching = inEndpoints.filter((v) => ENDPOINT_RE.test(v.text));
  if (matching.length === 0) {
    if (inEndpoints.length > 0) {
      const first = inEndpoints[0];
      const emDash = first.text.includes('—') || first.text.includes('–');
      return {
        reason: emDash
          ? 'endpoint lines separate the path from the description with a dash the grammar does not accept'
          : 'no endpoint line matches "METHOD /path - description"',
        line: first.n,
        hint: emDash
          ? 'use a plain hyphen-minus "-" between the path and the description'
          : 'each endpoint must be one line: METHOD /path - description',
      };
    }
    return {
      reason: sawEndpointsHeading
        ? 'the "## Endpoints" section contains no METHOD /path lines'
        : 'no "## Endpoints" section, so no endpoint is ever read',
      line: null,
      hint: 'add endpoint lines as "METHOD /path - description" under "## Endpoints"',
    };
  }
  return {
    reason: 'the skill parsed but produced no tools',
    line: null,
    hint: 'check that at least one endpoint has a path',
  };
}

/**
 * Inspect every loaded skill and return one report row per file that declares
 * an HTTP surface. Pure: no logging, no process state, so it can be tested.
 *
 * @param {Array<{name: string, content: string, filename?: string}>} skills
 * @param {object|null} secrets
 * @returns {{ rows: Array<object>, broken: Array<object>, unresolved: Array<object> }}
 */
export function inspectSkills(skills, secrets = null) {
  const rows = [];
  for (const skill of skills || []) {
    const { intends, signals } = declaresHttpSurface(skill.content);
    if (!intends) continue;

    const file = skill.filename || `${skill.name}.md`;
    const parsed = parseSkill(skill.name, skill.content, secrets);
    if (!parsed) {
      const d = diagnose(skill.content);
      rows.push({
        file, name: skill.name, ok: false, tools: 0, signals,
        reason: d.reason, line: d.line, hint: d.hint, unresolvedParams: [],
      });
      continue;
    }

    const tools = skillToTools(parsed);

    // A write endpoint with a {{param}} and no GET in the same skill ending at
    // that param cannot have its identifier checked before approval. Derived
    // from the endpoint block, so there is nothing to maintain.
    const norm = (s) => s.toLowerCase().replace(/[_-]/g, '');
    const resolvers = new Set();
    for (const e of parsed.endpoints) {
      if (e.method !== 'GET') continue;
      const m = e.path.match(/\{\{([^}]+)\}\}\/?$/);
      if (m) resolvers.add(norm(m[1].trim()));
    }
    const unresolvedParams = [];
    for (const e of parsed.endpoints) {
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method)) continue;
      for (const m of e.path.matchAll(/\{\{([^}]+)\}\}/g)) {
        const n = m[1].trim();
        if (n.startsWith('secrets.') || n.startsWith('config.')) continue;
        if (!resolvers.has(norm(n))) unresolvedParams.push({ param: n, endpoint: `${e.method} ${e.path}` });
      }
    }

    rows.push({
      file, name: skill.name, ok: tools.length > 0, tools: tools.length, signals,
      reason: tools.length > 0 ? null : 'parsed but produced no tools',
      line: null, hint: null, unresolvedParams,
    });
  }

  return {
    rows,
    broken: rows.filter((r) => !r.ok),
    unresolved: rows.filter((r) => r.unresolvedParams.length > 0),
  };
}

/**
 * Format the report for the boot log. Returns an array of lines, empty when
 * everything is healthy, so a clean boot stays quiet.
 */
export function formatReport(report) {
  const lines = [];
  for (const r of report.broken) {
    lines.push(
      `skill "${r.name}" (${r.file}${r.line ? `:${r.line}` : ''}) declares an HTTP surface but registered 0 tools: ${r.reason}. Fix: ${r.hint}.`
    );
    lines.push(`  it looked like an HTTP skill because of: ${r.signals.join(', ')}`);
  }
  for (const r of report.unresolved) {
    for (const u of r.unresolvedParams) {
      lines.push(
        `skill "${r.name}" (${r.file}): ${u.endpoint} takes {{${u.param}}} but no GET in this skill ends at {{${u.param}}}, so that identifier cannot be resolved before approval.`
      );
    }
  }
  return lines;
}
