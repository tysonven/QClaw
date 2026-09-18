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

import {
  parseSkill,
  skillToTools,
  parseEndpointLine,
  looksLikeEndpointLine,
  ENDPOINT_LEVELS,
} from './skill-parser.js';

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * The level a write is treated as having. Declaring earns leniency; the
 * default is the safe one (design section 5, constraint 1):
 *
 *   declared valid level   -> that level
 *   undeclared DELETE      -> 'destructive', so omission never weakens what a
 *                             DELETE already got (it was always high risk)
 *   any other undeclared   -> 'unclassified', which the gate refuses outright,
 *   write                     identifiers or not. NOT defaulted to 'mutating':
 *                             that is the value that would make a forgotten
 *                             declaration silent.
 *   GET                    -> null; reads are not classified
 *
 * @param {string} method
 * @param {string|null|undefined} declaredLevel - a valid level or null
 * @returns {'financial'|'destructive'|'mutating'|'unclassified'|null}
 */
export function effectiveWriteLevel(method, declaredLevel) {
  const m = String(method ?? '').trim().toUpperCase();
  if (!WRITE_METHODS.includes(m)) return null;
  if (declaredLevel && ENDPOINT_LEVELS.includes(declaredLevel)) return declaredLevel;
  return m === 'DELETE' ? 'destructive' : 'unclassified';
}

/**
 * Normalise an identifier name so the body spelling and the path spelling
 * meet: `contactId` in a GHL body and `{{contact_id}}` in the path are the
 * same token. Lower case, `_` and `-` removed.
 */
export function normaliseIdentifierName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[_-]/g, '');
}

// The part of an endpoint path before any query string. A query-string
// parameter is never an identifier (decided 2026-09-10, design section 4).
function pathOnly(path) {
  return String(path ?? '').split('?')[0];
}

function trimTrailingSlash(p) {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

// `{{param}}` names in a path, excluding the registry's own templates.
function placeholderNames(path) {
  const out = [];
  for (const m of String(path ?? '').matchAll(/\{\{([^}]+)\}\}/g)) {
    const n = m[1].trim();
    if (n.startsWith('secrets.') || n.startsWith('config.')) continue;
    out.push(n);
  }
  return out;
}

/**
 * Derive the identifier index for one skill from its own `## Endpoints`
 * block. Nothing is declared and nothing is maintained: a path parameter
 * already says a token names an entity, and a GET ending at it already says
 * what resolves it. This is THE implementation; the boot report below and the
 * tool registry both call it (two implementations of one rule would be a
 * maintained list by another name, design constraint 2).
 *
 * Rules (design section 4, with the read-first amendments of 2026-09-10):
 *
 *   1. Index every `{{param}}` in an endpoint path with the query string
 *      stripped, excluding `{{secrets.*}}` and `{{config.*}}`.
 *   2. A RESOLVER is a GET whose path, query string stripped, ENDS at a
 *      parameter. The resolver for a write's path parameter is keyed on the
 *      ENDPOINT, not the parameter name: it is the GET whose path equals the
 *      write's path cut off just after that parameter (the same resource).
 *      So `POST /contacts/{{contact_id}}/notes` resolves through
 *      `GET /contacts/{{contact_id}}`, and `{{id}}` on one resource never
 *      resolves through a GET on another.
 *   3. A body field has no path to key on. Its candidates are every resolver
 *      whose parameter normalises to the field's name. The caller must treat
 *      more than one candidate as "could not resolve", never a guess.
 *
 * Why the amendments. As #148 first shipped this rule it matched the path
 * WITH its query string and keyed on the parameter name, so on the real files
 * it counted `{{query}}` on six GHL contact searches, `{{status}}` and
 * `{{workflow_id}}` on n8n-api's execution filters, and every
 * `{{secrets.ghl_*_location_id}}` as resolvers. A search answers 200 for any
 * value, so a check built on that would have marked an unchecked identifier
 * as resolved. Resolution only counts when the entity comes back, and that is
 * the gate's job; this function only decides which GET to ask.
 *
 * WHAT THIS CANNOT SEE: an identifier whose name normalises to no path
 * parameter in its skill. Two live examples, both named here on purpose so
 * whoever hits one finds the reason instead of rediscovering it:
 *
 *   - `market_url` (and `condition_id`) on trading-api POST /positions/manual.
 *     Neither is a path parameter anywhere in the skill. Decided 2026-09-18:
 *     the gate notices an identifier by NAME (IDENTIFIER_NAME_RE in
 *     approval-summary.js) and RESOLVES it only through this index, so these
 *     two are noticed, cannot be resolved, and fail by the endpoint's level.
 *     (The gate change carries that; this index only supplies the resolvers.)
 *   - Stripe's `customer` field on POST /invoices. The skill indexes
 *     `customer_id` from GET /customers/{{customer_id}}, and `customer` does
 *     not normalise to it. It is ALSO invisible to the name heuristic,
 *     because `customer` does not look like an id. KNOWN GAP: while
 *     POST /invoices is unclassified the gate refuses it outright, so nothing
 *     goes through unchecked. That control is an accident of the endpoint
 *     being undeclared. Declaring a level on POST /invoices, any level, lets
 *     a `customer` value through with no check at all. Close this gap before
 *     or with that declaration, not after.
 *
 * @param {Array<{method: string, path: string, level?: string|null,
 *                declaredLevel?: string|null, line?: number}>} endpoints
 * @returns {{
 *   indexed: Map<string, string[]>,
 *   resolvers: Array<{ path: string, resource: string, param: string, key: string, params: string[] }>,
 *   writes: Array<{ method: string, path: string, line: number|null,
 *                   declaredLevel: string|null, level: string,
 *                   pathParams: Array<{ param: string, resolver: object|null }> }>,
 * }}
 */
export function deriveIdentifierIndex(endpoints) {
  const eps = Array.isArray(endpoints) ? endpoints : [];

  const indexed = new Map(); // normalised name -> spellings seen in paths
  for (const e of eps) {
    for (const n of placeholderNames(pathOnly(e.path))) {
      const key = normaliseIdentifierName(n);
      if (!indexed.has(key)) indexed.set(key, []);
      if (!indexed.get(key).includes(n)) indexed.get(key).push(n);
    }
  }

  const resolvers = [];
  const seen = new Set();
  for (const e of eps) {
    if (String(e.method).toUpperCase() !== 'GET') continue;
    const resource = trimTrailingSlash(pathOnly(e.path));
    const m = resource.match(/\{\{([^}]+)\}\}$/);
    if (!m) continue;
    const param = m[1].trim();
    if (param.startsWith('secrets.') || param.startsWith('config.')) continue;
    if (seen.has(resource)) continue; // a GET line written twice is one resolver
    seen.add(resource);
    resolvers.push({
      path: e.path,
      resource,
      param,
      key: normaliseIdentifierName(param),
      params: placeholderNames(resource),
    });
  }

  const writes = [];
  for (const e of eps) {
    const method = String(e.method).toUpperCase();
    if (!WRITE_METHODS.includes(method)) continue;
    const bare = pathOnly(e.path);
    const pathParams = placeholderNames(bare).map((param) => ({
      param,
      resolver: pathParamResolver({ resolvers }, e.path, param),
    }));
    writes.push({
      method,
      path: e.path,
      line: e.line ?? null,
      declaredLevel: e.declaredLevel ?? null,
      level: effectiveWriteLevel(method, e.level ?? null),
      pathParams,
    });
  }

  return { indexed, resolvers, writes };
}

/**
 * The resolver for a path parameter of a write, keyed on the endpoint: the
 * GET whose path is the write's path up to and including `{{param}}`.
 * @returns {object|null}
 */
export function pathParamResolver(index, writePath, param) {
  const bare = pathOnly(writePath);
  const token = `{{${param}}}`;
  const at = bare.indexOf(token);
  if (at === -1) return null;
  const resource = trimTrailingSlash(bare.slice(0, at + token.length));
  return (index?.resolvers || []).find((r) => r.resource === resource) || null;
}

/**
 * Every resolver a BODY field of this name could mean. More than one is
 * ambiguous and must be treated as "could not resolve" by the caller.
 * @returns {object[]}
 */
export function bodyFieldResolvers(index, fieldName) {
  const key = normaliseIdentifierName(fieldName);
  return (index?.resolvers || []).filter((r) => r.key === key);
}

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
    if (looksLikeEndpointLine(t)) verbLines.push({ n: i + 1, text: t, inEndpoints: section === 'endpoints' });
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
  const matching = inEndpoints.filter((v) => parseEndpointLine(v.text) !== null);
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

    // A write endpoint with a {{param}} and no GET on the same resource
    // ending at it cannot have its identifier checked before approval.
    const index = deriveIdentifierIndex(parsed.endpoints);
    const unresolvedParams = [];
    for (const w of index.writes) {
      for (const p of w.pathParams) {
        if (!p.resolver) unresolvedParams.push({ param: p.param, endpoint: `${w.method} ${w.path}` });
      }
    }

    // A bracket that is not a level keeps its endpoint (the parser never drops
    // a line for it) but leaves the write unclassified, so the gate refuses
    // it. Named here with its line, so a typo is found at boot, not by the
    // first refused write. A level on a GET does nothing, which is also worth
    // saying rather than letting someone believe a read is classified.
    const badLevels = [];
    const ignoredLevels = [];
    for (const e of parsed.endpoints) {
      if (e.declaredLevel === null || e.declaredLevel === undefined) continue;
      const where = { line: e.line ?? null, declared: e.declaredLevel, endpoint: `${e.method} ${e.path}` };
      if (!WRITE_METHODS.includes(e.method)) ignoredLevels.push(where);
      else if (!e.level) badLevels.push(where);
    }

    const writes = index.writes.length;
    const unclassified = index.writes.filter((w) => w.level === 'unclassified').length;
    // "With a resolver" means exactly one: two GETs ending at the same name
    // (n8n-api's {{id}} on workflows and executions) cannot resolve a body
    // field of that name, so they are counted as ambiguous instead.
    const resolverCount = (k) => index.resolvers.filter((r) => r.key === k).length;
    const withResolver = [...index.indexed.keys()].filter((k) => resolverCount(k) === 1);
    const ambiguous = [...index.indexed.keys()].filter((k) => resolverCount(k) > 1);

    rows.push({
      file, name: skill.name, ok: tools.length > 0, tools: tools.length, signals,
      reason: tools.length > 0 ? null : 'parsed but produced no tools',
      line: null, hint: null, unresolvedParams,
      badLevels, ignoredLevels,
      counts: {
        writes,
        unclassified,
        indexed: [...index.indexed.values()].map((names) => names[0]),
        withResolver: withResolver.map((k) => index.indexed.get(k)[0]),
        ambiguous: ambiguous.map((k) => index.indexed.get(k)[0]),
      },
    });
  }

  return {
    rows,
    broken: rows.filter((r) => !r.ok),
    unresolved: rows.filter((r) => r.unresolvedParams.length > 0),
    badLevels: rows.filter((r) => (r.badLevels || []).length > 0),
    ignoredLevels: rows.filter((r) => (r.ignoredLevels || []).length > 0),
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
        `skill "${r.name}" (${r.file}): ${u.endpoint} takes {{${u.param}}} but no GET on the same resource ends at {{${u.param}}}, so that identifier cannot be resolved before approval.`
      );
    }
  }
  for (const r of report.badLevels || []) {
    for (const b of r.badLevels) {
      lines.push(
        `skill "${r.name}" (${r.file}${b.line ? `:${b.line}` : ''}): "[${b.declared}]" is not a level (${ENDPOINT_LEVELS.join(', ')}), so ${b.endpoint} reads as unclassified and will be refused. Fix: correct the level.`
      );
    }
  }
  for (const r of report.ignoredLevels || []) {
    for (const b of r.ignoredLevels) {
      lines.push(
        `  skill "${r.name}" (${r.file}${b.line ? `:${b.line}` : ''}): "[${b.declared}]" on ${b.endpoint} has no effect, only writes are classified.`
      );
    }
  }
  return lines;
}

/**
 * The countdown to zero unclassified writes (design section 5, "declare
 * first, enable second"). Unlike formatReport this is NOT quiet when
 * healthy: the gate change merges only when this reads 0 on the host, so 0
 * has to be printed to be read.
 *
 * One line per skill that has writes, then the total. Each skill line carries
 * the counts the design owes beside the diagnostic: writes parsed, writes
 * unclassified, identifiers indexed, identifiers with a resolver.
 *
 * @returns {{ unclassified: number, writes: number, lines: string[] }}
 */
export function formatCountdown(report) {
  const lines = [];
  let writes = 0;
  let unclassified = 0;
  let skills = 0;
  for (const r of report.rows || []) {
    const c = r.counts;
    if (!c || c.writes === 0) continue;
    skills++;
    writes += c.writes;
    unclassified += c.unclassified;
    const ids = c.indexed.length > 0 ? ` (${c.indexed.join(', ')})` : '';
    const amb = c.ambiguous.length > 0 ? `, ambiguous: ${c.ambiguous.join(', ')}` : '';
    lines.push(
      `  skill "${r.name}" (${r.file}): ${c.writes} writes, ${c.unclassified} unclassified; ` +
      `identifiers indexed ${c.indexed.length}${ids}, with a resolver ${c.withResolver.length}${amb}`
    );
  }
  lines.push(
    `identifier gate countdown: ${unclassified} of ${writes} skill writes unclassified across ${skills} skills.` +
    (unclassified > 0
      ? ' The identifier gate refuses an unclassified write outright, so it merges only when this reads 0.'
      : '')
  );
  return { unclassified, writes, lines };
}
