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
  endpointsSection,
  endpointToolSuffix,
  ENDPOINT_LEVELS,
} from './skill-parser.js';

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * The level a write is treated as having. Declaring earns leniency; the
 * default is the safe one (design section 5, constraint 1):
 *
 *   declared valid level   -> that level
 *   a bracket that is NOT  -> 'unclassified', DELETE included. Someone tried
 *   a level (a typo, `[]`)    to declare and got it wrong; that must cost a
 *                             refusal, never the undeclared-DELETE leniency
 *                             below (#184 cold review, finding 3)
 *   undeclared DELETE      -> 'destructive', so omission never weakens what a
 *                             DELETE already got (it was always high risk)
 *   any other undeclared   -> 'unclassified', which the gate refuses outright,
 *   write                     identifiers or not. NOT defaulted to 'mutating':
 *                             that is the value that would make a forgotten
 *                             declaration silent.
 *   GET                    -> null; reads are not classified
 *
 * @param {string} method
 * @param {string|null|undefined} declared - the RAW bracket token as written
 *   (null or undefined when there was no bracket). Matched case-insensitively
 *   after trimming, the same way the parser reads it.
 * @returns {'financial'|'destructive'|'mutating'|'unclassified'|null}
 */
export function effectiveWriteLevel(method, declared) {
  const m = String(method ?? '').trim().toUpperCase();
  if (!WRITE_METHODS.includes(m)) return null;
  if (declared === null || declared === undefined) return m === 'DELETE' ? 'destructive' : 'unclassified';
  const token = String(declared).trim().toLowerCase();
  return ENDPOINT_LEVELS.includes(token) ? token : 'unclassified';
}

// What a parsed endpoint or tool definition declared: the raw bracket token
// when the parser recorded one, else a valid level set directly, else nothing.
function declaredOf(e) {
  return e?.declaredLevel ?? e?.level ?? null;
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

// `{{param}}` names in a path, excluding the registry's own templates. Each
// name once, in first-occurrence order.
function placeholderNames(path) {
  const out = [];
  for (const m of String(path ?? '').matchAll(/\{\{([^}]+)\}\}/g)) {
    const n = m[1].trim();
    if (n.startsWith('secrets.') || n.startsWith('config.')) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The identifier names in an endpoint path: `{{param}}` placeholders before
 * any query string, excluding `{{secrets.*}}` and `{{config.*}}`. THE rule;
 * the approval prompt's pathParamNames (approval-summary.js) calls this, so
 * what the prompt shows as a path identifier and what the index can resolve
 * are decided in one place (#184 cold review, finding 6).
 * @param {string} path
 * @returns {string[]}
 */
export function pathIdentifierNames(path) {
  return placeholderNames(pathOnly(path));
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
 *     because `customer` does not look like an id. KNOWN GAP. Undeclared, the
 *     gate would refuse it outright, but that control is an accident of
 *     nobody having declared it: declaring ANY level lets a `customer` value
 *     through with no check at all. So on 2026-09-18 the endpoint line was
 *     REMOVED from stripe.md, not left undeclared (reason #181; stripe.md
 *     says so where the line was). Removed and undeclared are different
 *     states. Re-adding the line reopens the gap: close it before or with
 *     that change, not after.
 *
 * The returned index is frozen all the way down. One index is shared by every
 * tool of a skill and handed to the gate by reference, so nothing downstream
 * may be able to edit what part two will trust.
 *
 * @param {Array<{method: string, path: string, level?: string|null,
 *                declaredLevel?: string|null, line?: number}>} endpoints
 * @returns {{
 *   endpoints: string[],                       // "METHOD path" for every endpoint derived from
 *   indexed: Record<string, string[]>,         // normalised name -> spellings seen in paths
 *   resolvers: Array<{ method: 'GET', path: string, resource: string, param: string,
 *                      key: string, params: string[] }>,
 *   writes: Array<{ method: string, path: string, line: number|null,
 *                   declaredLevel: string|null, level: string,
 *                   pathParams: Array<{ param: string, resolver: object|null }> }>,
 * }}
 */
export function deriveIdentifierIndex(endpoints) {
  const eps = Array.isArray(endpoints) ? endpoints : [];

  const indexed = {};
  for (const e of eps) {
    for (const n of pathIdentifierNames(e.path)) {
      const key = normaliseIdentifierName(n);
      if (!indexed[key]) indexed[key] = [];
      if (!indexed[key].includes(n)) indexed[key].push(n);
    }
  }
  for (const key of Object.keys(indexed)) Object.freeze(indexed[key]);

  const resolvers = [];
  const seen = new Set();
  for (const e of eps) {
    // Only a GET resolves. A PUT or PATCH ending at the parameter is a write
    // on that entity, not a way to read it.
    if (String(e.method).toUpperCase() !== 'GET') continue;
    const resource = trimTrailingSlash(pathOnly(e.path));
    const m = resource.match(/\{\{([^}]+)\}\}$/);
    if (!m) continue;
    const param = m[1].trim();
    if (param.startsWith('secrets.') || param.startsWith('config.')) continue;
    if (seen.has(resource)) continue; // one resource written twice is one resolver
    seen.add(resource);
    resolvers.push(Object.freeze({
      method: 'GET',
      path: e.path,
      resource,
      param,
      key: normaliseIdentifierName(param),
      params: Object.freeze(placeholderNames(resource)),
    }));
  }

  const writes = [];
  for (const e of eps) {
    const method = String(e.method).toUpperCase();
    if (!WRITE_METHODS.includes(method)) continue;
    const pathParams = pathIdentifierNames(e.path).map((param) => Object.freeze({
      param,
      resolver: pathParamResolver({ resolvers }, e.path, param),
    }));
    writes.push(Object.freeze({
      method,
      path: e.path,
      line: e.line ?? null,
      declaredLevel: e.declaredLevel ?? null,
      level: effectiveWriteLevel(method, declaredOf(e)),
      pathParams: Object.freeze(pathParams),
    }));
  }

  return Object.freeze({
    endpoints: Object.freeze(eps.map((e) => `${String(e.method).toUpperCase()} ${e.path}`)),
    indexed: Object.freeze(indexed),
    resolvers: Object.freeze(resolvers),
    writes: Object.freeze(writes),
  });
}

/**
 * Was this index derived from a skill that declares this endpoint? The
 * registry hands a tool its skill's index only when it was, so an index that
 * was never derived from the tool's own skill (an empty endpoint list, another
 * skill's endpoints, a stale cache) reaches the gate as NO index rather than
 * as an index with nothing in it. "Never derived" and "nothing to resolve"
 * are different states and must not collapse (#184 cold review, finding 4).
 */
export function indexCoversEndpoint(index, method, path) {
  return Array.isArray(index?.endpoints)
    && index.endpoints.includes(`${String(method ?? '').toUpperCase()} ${path}`);
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
  // Which lines are in `## Endpoints` comes from the one section rule the
  // parser uses (skill-parser.js endpointsSection), not from this loop.
  const endpointLineNumbers = new Set(endpointsSection(content).map((l) => l.line));
  const sawEndpointsHeading = lines.some((l) => /^##\s+Endpoints\b/.test(l.trim()));
  const verbLines = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('## Auth')) { section = 'auth'; continue; }
    if (t.startsWith('## Endpoints')) { section = 'endpoints'; continue; }
    if (t.startsWith('## Permissions')) { section = 'permissions'; continue; }
    if (t.startsWith('## Usage Notes') || t.startsWith('## Source')) { section = 'notes'; continue; }
    if (t.startsWith('## ')) { section = 'other'; continue; }

    if (t.startsWith('Base URL:') && baseUrlLine === null) {
      baseUrlLine = i + 1;
      baseUrlSection = section;
    }
    if (looksLikeEndpointLine(t)) verbLines.push({ n: i + 1, text: t, inEndpoints: endpointLineNumbers.has(i + 1) });
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
  // Every endpoint line parses, yet nothing registered: they all collide on
  // tool names, which parseSkill refuses as a group.
  const suffixes = matching.map((v) => endpointToolSuffix(parseEndpointLine(v.text)));
  if (matching.length > 0 && suffixes.every((k) => suffixes.filter((o) => o === k).length > 1)) {
    return {
      reason: `every endpoint line shares its tool name with another (e.g. "${suffixes[0]}"), so none registered`,
      line: matching[0].n,
      hint: 'remove the duplicate lines, or change paths or methods so each endpoint gets its own tool name',
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
    const pathIds = index.writes.flatMap((w) => w.pathParams);
    // Two different questions, counted separately so neither reads as the
    // other. A write's PATH identifier resolves on its own resource (keyed on
    // the endpoint). A BODY field has no resource, so it resolves by name, and
    // only when exactly one GET ends at that name: two (n8n-api's {{id}} on
    // workflows and executions) is ambiguous, not resolvable.
    const keys = Object.keys(index.indexed);
    const resolverCount = (k) => index.resolvers.filter((r) => r.key === k).length;
    const first = (k) => index.indexed[k][0];

    rows.push({
      file, name: skill.name, ok: tools.length > 0, tools: tools.length, signals,
      reason: tools.length > 0 ? null : 'parsed but produced no tools',
      line: null, hint: null, unresolvedParams,
      badLevels, ignoredLevels,
      invalid: parsed.invalidEndpointLines || [],
      counts: {
        writes,
        unclassified,
        indexed: keys.map(first),
        pathIdentifiers: pathIds.length,
        pathResolvable: pathIds.filter((p) => p.resolver).length,
        bodyResolvable: keys.filter((k) => resolverCount(k) === 1).map(first),
        ambiguous: keys.filter((k) => resolverCount(k) > 1).map(first),
        invalid: (parsed.invalidEndpointLines || []).length,
      },
    });
  }

  return {
    rows,
    broken: rows.filter((r) => !r.ok),
    unresolved: rows.filter((r) => r.unresolvedParams.length > 0),
    badLevels: rows.filter((r) => (r.badLevels || []).length > 0),
    ignoredLevels: rows.filter((r) => (r.ignoredLevels || []).length > 0),
    invalid: rows.filter((r) => (r.invalid || []).length > 0),
  };
}

// A line quoted in the report, with invisible characters spelled out, so a
// line holding only a zero-width space is not shown as "".
function visible(text) {
  return JSON.stringify(String(text ?? ''))
    .replace(/[\u00AD\u200B-\u200F\u2028\u2029\u2060-\u2064\uFEFF]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
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
  for (const r of report.invalid || []) {
    for (const m of r.invalid) {
      const where = `skill "${r.name}" (${r.file}:${m.line})`;
      if (m.reason === 'collision') {
        lines.push(
          `${where}: this endpoint and line(s) ${m.with.join(', ')} get the same tool name "${m.tool}", so none of them registered and the countdown is INCOMPLETE: ${visible(m.text)}. Fix: remove the duplicate, or change a path or method so each endpoint gets its own tool name.`
        );
      } else if (m.reason === 'outside') {
        lines.push(
          `${where}: this endpoint line is outside "## Endpoints", so it registered nothing and the countdown is INCOMPLETE: ${visible(m.text)}. Fix: move it under "## Endpoints", or start it with "# " if it is an example.`
        );
      } else {
        lines.push(
          `${where}: this line in "## Endpoints" is not an endpoint, a "#" comment or blank, so it registered nothing and the countdown is INCOMPLETE: ${visible(m.text)}. Fix: write an endpoint as "[level] METHOD /path - description" with " - " between path and description, or start prose with "# ".`
        );
      }
    }
  }
  return lines;
}

/**
 * The countdown to zero unclassified writes (design section 5, "declare
 * first, enable second"). Unlike formatReport this is NOT quiet when there is
 * something to count: the gate change merges only when this reads 0 on the
 * host, so 0 has to be printed to be read.
 *
 * WHY IT IS LABELLED, DATED, SUPPRESSED AND SOMETIMES INCOMPLETE. The merge
 * condition is "Charlie's line reads 0", and two cold reviews of #184 found
 * three ways it could read 0 while wrong. It is the vacuity class, inside the
 * mechanism built to close it:
 *
 *   - a line in `## Endpoints` that failed to parse left both sides of
 *     "U of W", so the count shrank with nothing saying why;
 *   - a skill that registered NOTHING (a broken `Base URL:`, a misspelt
 *     heading) left the count entirely, taking all its writes with it;
 *   - every agent printed a total, and an agent with no skills (echo, on the
 *     host) printed "0 of 0" on every boot.
 *
 * So: any invalid line or any skill that registered nothing makes the total
 * INCOMPLETE, and that line carries no count of writes at all. The line names
 * its agent. An agent with nothing to count prints nothing. And the line
 * carries the date, because the boot log's timestamps are time of day only,
 * and an earlier boot's 0 must not be read as the current one.
 *
 * @param {object} report - from inspectSkills
 * @param {string} [agent] - the agent whose skills these are, for the label
 * @param {Date} [now] - the boot time printed on the line
 * @returns {{ unclassified: number, writes: number, invalid: number,
 *             broken: number, incomplete: boolean, lines: string[] }}
 */
export function formatCountdown(report, agent = null, now = new Date()) {
  const lines = [];
  let writes = 0;
  let unclassified = 0;
  let invalid = 0;
  let broken = 0;
  let skills = 0;
  for (const r of report.rows || []) {
    if (!r.ok) {
      // Declares an HTTP surface and registered nothing: its writes, however
      // many, are uncounted. Named in the report above; counted here.
      broken++;
      skills++;
      lines.push(`  skill "${r.name}" (${r.file}): registered nothing (named above), so none of its writes are counted`);
      continue;
    }
    const c = r.counts;
    if (!c || (c.writes === 0 && c.invalid === 0)) continue;
    skills++;
    writes += c.writes;
    unclassified += c.unclassified;
    invalid += c.invalid;
    const ids = c.indexed.length > 0 ? ` (${c.indexed.join(', ')})` : '';
    const body = c.bodyResolvable.length > 0 ? ` (${c.bodyResolvable.join(', ')})` : '';
    const amb = c.ambiguous.length > 0 ? `, ambiguous: ${c.ambiguous.join(', ')}` : '';
    const bad = c.invalid > 0 ? `; ${c.invalid} endpoint line(s) invalid` : '';
    lines.push(
      `  skill "${r.name}" (${r.file}): ${c.writes} writes, ${c.unclassified} unclassified; ` +
      `identifiers indexed ${c.indexed.length}${ids}; ` +
      `write path identifiers ${c.pathIdentifiers}, ${c.pathResolvable} resolvable on their own resource; ` +
      `body-resolvable names ${c.bodyResolvable.length}${body}${amb}${bad}`
    );
  }
  const incomplete = invalid > 0 || broken > 0;
  if (skills === 0) return { unclassified, writes, invalid, broken, incomplete, lines };

  const label = agent ? ` (${agent})` : '';
  const at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const prefix = `identifier gate countdown${label} at ${at}: `;
  if (incomplete) {
    const why = [
      broken > 0 ? `${broken} skill(s) registered nothing` : null,
      invalid > 0 ? `${invalid} endpoint line(s) are invalid` : null,
    ].filter(Boolean).join(' and ');
    lines.push(`${prefix}INCOMPLETE. ${why} (named above). No count of writes is given until they are fixed.`);
  } else {
    lines.push(
      `${prefix}${unclassified} of ${writes} skill writes unclassified across ${skills} skills.` +
      (unclassified > 0 ? ' The identifier gate refuses an unclassified write outright, so it merges only when this reads 0.' : '')
    );
  }
  return { unclassified, writes, invalid, broken, incomplete, lines };
}
