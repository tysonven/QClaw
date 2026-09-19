/**
 * QuantumClaw — Skill Parser
 *
 * Converts markdown skill files into executable HTTP tools.
 *
 * Skill format (markdown):
 *
 * ```markdown
 * # Stripe Billing
 *
 * ## Auth
 * Base URL: https://api.stripe.com/v1
 * Header: Authorization: Bearer {{secrets.stripe_api_key}}
 *
 * ## Endpoints
 * GET /customers - List customers
 * POST /customers - Create customer
 * GET /invoices - List invoices
 * POST /invoices - Create invoice
 *
 * ## Permissions
 * - http: [api.stripe.com]
 * - shell: none
 * - file: none
 *
 * ## Usage Notes
 * - Never expose API keys
 * - Confirm amounts before creating charges
 * ```
 *
 * This parser extracts:
 *   - Base URL
 *   - Headers (with secret interpolation)
 *   - Endpoints → converted to tool definitions
 */

/**
 * The endpoint line grammar, defined ONCE.
 *
 *   [level] METHOD /path - description
 *
 * `[level]` is optional and declares what a write does, for the identifier
 * gate (docs/identifier-resolution-design.md section 5). It is one of
 * ENDPOINT_LEVELS. An undeclared write is not given a level here: it reads as
 * unclassified, which the gate refuses (see effectiveWriteLevel in
 * skill-diagnostics.js).
 *
 * WHY THIS LIVES IN ONE PLACE: until 2026-09-18 this grammar was written out
 * four times, in this parser, twice in skill-diagnostics.js and in the
 * `qclaw skill list` endpoint count, plus a copy in its test. Adding a prefix
 * to a format defined in four places is how a skill goes silent: the parser
 * drops a line it does not match and returns no tool for it, with no error,
 * which is exactly how ads-agency, content-studio and clipper sat broken from
 * the day they were written (#149, #150, #151). Every reader of an endpoint
 * line imports from here.
 *
 * THE SEPARATOR NEEDS WHITESPACE ON BOTH SIDES (` - `). With `\s*-\s*` the
 * path could backtrack to a hyphen inside itself: an em dash in the
 * manual-close line parsed as `POST /positions/manual` with a description
 * starting "close", replacing the real /positions/manual tool and deleting
 * manual-close without a word. Seven real writes have hyphenated paths (#192).
 *
 * A WELL-FORMED bracket holding something that is not one of ENDPOINT_LEVELS
 * (a typo, an empty `[]`) does NOT drop the endpoint. The tool still
 * registers, the write reads as unclassified (DELETE included), and
 * `declaredLevel` keeps the raw token so the boot diagnostic can name it.
 */
export const ENDPOINT_LEVELS = Object.freeze(['financial', 'destructive', 'mutating']);

const ENDPOINT_LINE_RE = /^(?:\[([^\]]*)\]\s*)?(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)\s+-\s+(.+)/i;

// Looser: a line that LOOKS like an endpoint (verb then something), used only
// by diagnose() to explain why a skill that registered nothing did not parse.
const ENDPOINT_LIKE_RE = /^(?:\[[^\]]*\]\s*)?(GET|POST|PUT|PATCH|DELETE)\s+\S/i;

/**
 * Parse one endpoint line. Returns null when the line is not an endpoint.
 * @param {string} line
 * @returns {{ method: string, path: string, description: string,
 *             level: string|null, declaredLevel: string|null }|null}
 *   `level` is the declared level when it is valid, else null.
 *   `declaredLevel` is the raw bracket content, or null when there was none.
 */
export function parseEndpointLine(line) {
  const m = String(line ?? '').trim().match(ENDPOINT_LINE_RE);
  if (!m) return null;
  const [, rawLevel, method, path, description] = m;
  const declaredLevel = rawLevel === undefined ? null : rawLevel.trim();
  const candidate = declaredLevel === null ? null : declaredLevel.toLowerCase();
  return {
    method: method.toUpperCase(),
    path: path.trim(),
    description: description.trim(),
    level: candidate !== null && ENDPOINT_LEVELS.includes(candidate) ? candidate : null,
    declaredLevel,
  };
}

/** True when a line looks like an endpoint line, whether or not it parses. */
export function looksLikeEndpointLine(line) {
  return ENDPOINT_LIKE_RE.test(String(line ?? '').trim());
}

/**
 * Where `## Endpoints` is, defined ONCE (#183). The section starts at a
 * level-two heading `## Endpoints` and ends at the next level-two heading of
 * any other name. The parser, the boot diagnostics and `qclaw skill list` all
 * read the section through this, so they cannot disagree about which lines
 * are in it. (Until 2026-09-19 the parser kept reading endpoints under any
 * heading it did not recognise, while the other two stopped at it.)
 *
 * @param {string} content
 * @returns {Array<{ line: number, text: string }>} every line inside the
 *   section, 1-based line numbers, text trimmed, headings excluded
 */
export function endpointsSection(content) {
  const out = [];
  let inside = false;
  const lines = String(content ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^##\s/.test(t)) { inside = /^##\s+Endpoints\b/.test(t); continue; }
    if (inside) out.push({ line: i + 1, text: t });
  }
  return out;
}

/**
 * What a line inside `## Endpoints` may be, declared rather than guessed:
 * an endpoint, a `#` comment, or blank. ANYTHING ELSE IS INVALID, prose
 * included, by design (decided 2026-09-19).
 *
 * The previous rule tried to recognise what a malformed endpoint looks like,
 * and each cold review of #184 found spellings it missed: a bare level word,
 * a misspelt verb, a numbered line, a path without its slash, a lower-case
 * verb. Guessing loses to the next variant, so the section now says what it
 * may contain and everything else is named at boot. Prose that belongs in
 * the section is written as a `#` comment.
 *
 * @returns {'endpoint'|'comment'|'blank'|'invalid'}
 */
export function classifyEndpointsLine(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'blank';
  if (t.startsWith('#')) return 'comment';
  return parseEndpointLine(t) ? 'endpoint' : 'invalid';
}

/**
 * Count the endpoint lines in `## Endpoints`, by the same section rule and
 * grammar the parser registers tools from. Used by `qclaw skill list`.
 * @param {string} content
 * @returns {number}
 */
export function countEndpointLines(content) {
  return endpointsSection(content).filter((l) => classifyEndpointsLine(l.text) === 'endpoint').length;
}

/**
 * Parse a skill markdown file into an executable tool config
 * @param {string} name - Skill name (from filename)
 * @param {string} content - Markdown content
 * @param {object} secrets - Secrets manager (for interpolation)
 * @returns {object|null} - Parsed skill config or null if invalid
 */
export function parseSkill(name, content, secrets) {
  try {
    const lines = content.split('\n');
    const skill = {
      name,
      baseUrl: null,
      headers: {},
      endpoints: [],
      // Endpoint lines that register nothing, each with its reason:
      //   'invalid'   in `## Endpoints` but not an endpoint, comment or blank
      //   'collision' an endpoint whose tool name another endpoint also gets
      //   'outside'   an endpoint line outside `## Endpoints`
      // The boot report names each one and the countdown reads INCOMPLETE:
      // otherwise a write that did not register drops out of the count, which
      // then reads lower than the truth.
      invalidEndpointLines: [],
      permissions: { http: [], shell: [], file: [] },
      notes: [],
    };

    let section = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Detect sections
      if (line.startsWith('## Auth')) {
        section = 'auth';
        continue;
      }
      if (line.startsWith('## Endpoints')) {
        section = 'endpoints';
        continue;
      }
      if (line.startsWith('## Permissions')) {
        section = 'permissions';
        continue;
      }
      if (line.startsWith('## Usage Notes') || line.startsWith('## Source')) {
        section = 'notes';
        continue;
      }

      // Parse based on section
      if (section === 'auth') {
        // Base URL: https://api.stripe.com/v1
        if (line.startsWith('Base URL:')) {
          skill.baseUrl = line.replace('Base URL:', '').trim();
        }
        // Header: Authorization: Bearer {{secrets.stripe_api_key}}
        if (line.startsWith('Header:')) {
          const headerLine = line.replace('Header:', '').trim();
          const [key, ...valueParts] = headerLine.split(':');
          const value = valueParts.join(':').trim();
          skill.headers[key.trim()] = value;
        }
      }

      if (section === 'permissions') {
        // - http: [api.stripe.com]
        // - shell: none
        // - file: [~/workspace/**]
        const match = line.match(/^-\s+(http|shell|file):\s*(.+)/i);
        if (match) {
          const [, type, value] = match;
          if (value === 'none') {
            skill.permissions[type] = [];
          } else {
            const cleaned = value.replace(/[\[\]]/g, '').trim();
            skill.permissions[type] = cleaned.split(',').map(v => v.trim()).filter(Boolean);
          }
        }
      }

      if (section === 'notes' && line.startsWith('- ')) {
        skill.notes.push(line.replace(/^-\s*/, ''));
      }
    }

    // Endpoints are read through the one section rule (endpointsSection),
    // never by this loop's section tracking, so every reader agrees on which
    // lines are in `## Endpoints`.
    //   GET /customers - List customers
    //   [mutating] POST /customers - Create customer
    const sectionLines = endpointsSection(content);
    for (const { line, text } of sectionLines) {
      const kind = classifyEndpointsLine(text);
      if (kind === 'endpoint') skill.endpoints.push({ ...parseEndpointLine(text), line });
      else if (kind === 'invalid') skill.invalidEndpointLines.push({ line, text, reason: 'invalid' });
    }

    // Two endpoints that would get the same tool name: the registry would keep
    // one and drop the other with no error, so a stale duplicate of a line can
    // silently replace its level, or a PUT and a PATCH on one path can leave
    // one of them with no tool. Neither line can be trusted over the other, so
    // EVERY endpoint in the group is refused and named (decided 2026-09-19).
    // An identical duplicate is refused too: merging it would be a rule that
    // guesses again.
    const byName = new Map();
    for (const e of skill.endpoints) {
      const k = endpointToolSuffix(e);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(e);
    }
    const colliding = new Set();
    for (const [tool, group] of byName) {
      if (group.length < 2) continue;
      for (const e of group) {
        colliding.add(e);
        skill.invalidEndpointLines.push({
          line: e.line, text: lines[e.line - 1].trim(), reason: 'collision', tool,
          with: group.filter((o) => o !== e).map((o) => o.line),
        });
      }
    }
    skill.endpoints = skill.endpoints.filter((e) => !colliding.has(e));

    // An endpoint line OUTSIDE `## Endpoints` registers nothing. Silent, that
    // is the zero-tool failure of #149 to #151 on a single line, so it is
    // named too (decided 2026-09-19). Headings and `#` comments never count.
    const inSection = new Set(sectionLines.map((l) => l.line));
    for (let i = 0; i < lines.length; i++) {
      if (inSection.has(i + 1)) continue;
      const t = lines[i].trim();
      if (t.startsWith('#')) continue;
      if (parseEndpointLine(t)) skill.invalidEndpointLines.push({ line: i + 1, text: t, reason: 'outside' });
    }
    skill.invalidEndpointLines.sort((a, b) => a.line - b.line);

    // Validate
    if (!skill.baseUrl || skill.endpoints.length === 0) {
      return null; // Invalid skill — missing critical fields
    }

    return skill;
  } catch (err) {
    return null;
  }
}

/**
 * Convert a parsed skill into tool definitions for the LLM
 * @param {object} skill - Parsed skill config
 * @returns {array} - Array of tool definitions
 */
/**
 * The part of a tool's name that comes from its endpoint, defined ONCE:
 *   GET /customers                  -> get_customers
 *   POST /customers/{{id}}/notes    -> create_customers_id_notes
 * PUT and PATCH both read as `update`, any `{{param}}` reads as `id`, and
 * `-`, `/` and `_` all read as `_`, so two different endpoints can get the
 * same name. The registry keeps only the last tool of a name, silently, so
 * parseSkill refuses every endpoint in a colliding group (see below).
 */
export function endpointToolSuffix(endpoint) {
  const pathSlug = String(endpoint.path ?? '')
    .replace(/\{.*?\}/g, 'id') // Replace {{customer_id}} with id
    .replace(/[^a-z0-9_]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();

  const methodVerb = endpoint.method === 'GET' ? 'get' :
                     endpoint.method === 'POST' ? 'create' :
                     endpoint.method === 'PUT' ? 'update' :
                     endpoint.method === 'PATCH' ? 'update' :
                     endpoint.method === 'DELETE' ? 'delete' : 'call';

  return `${methodVerb}${pathSlug ? '_' + pathSlug : ''}`;
}

export function skillToTools(skill) {
  const tools = [];

  for (const endpoint of skill.endpoints) {
    const toolName = `${skill.name}__${endpointToolSuffix(endpoint)}`;

    // Extract path parameters (e.g. {{customer_id}}) — skip {{secrets.*}} which are resolved at runtime
    const pathParams = [];
    const paramMatches = endpoint.path.matchAll(/\{\{([^}]+)\}\}/g);
    for (const match of paramMatches) {
      if (!match[1].startsWith('secrets.')) {
        pathParams.push(match[1]);
      }
    }

    // Build input schema
    const properties = {};
    const required = [];

    for (const param of pathParams) {
      properties[param] = {
        type: 'string',
        description: `The ${param.replace(/_/g, ' ')}`,
      };
      required.push(param);
    }

    // Add query/body parameters for GET/POST
    if (endpoint.method === 'GET') {
      properties.limit = { type: 'number', description: 'Maximum number of results (default 10)' };
    }
    if (endpoint.method === 'POST' || endpoint.method === 'PUT' || endpoint.method === 'PATCH') {
      properties.data = { type: 'string', description: 'JSON payload for the request body' };
    }

    const inputSchema = {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };

    tools.push({
      name: toolName,
      description: endpoint.description,
      inputSchema,
      skill: skill.name,
      method: endpoint.method,
      path: endpoint.path,
      // The declared level, or null, and the raw bracket token, so a bracket
      // that is not a level reads as unclassified rather than as undeclared.
      // Never sent to the model: the registry formats only name, description
      // and inputSchema.
      level: endpoint.level ?? null,
      declaredLevel: endpoint.declaredLevel ?? null,
    });
  }

  return tools;
}

/**
 * Execute a skill tool — makes the HTTP request
 * @param {object} tool - Tool definition (from skillToTools)
 * @param {object} skill - Parsed skill config
 * @param {object} args - Tool call arguments from LLM
 * @param {object} secrets - Secrets manager (for header interpolation)
 * @returns {string} - Tool result
 */
export async function executeSkillTool(tool, skill, args, secrets) {
  try {
    // Build URL — replace path params
    let url = skill.baseUrl + tool.path;
    for (const param of Object.keys(args)) {
      url = url.replace(`{{${param}}}`, encodeURIComponent(args[param]));
    }

    // Add query params for GET requests
    if (tool.method === 'GET' && args.limit) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}limit=${args.limit}`;
    }

    // Build headers — interpolate secrets
    const headers = {};
    for (const [key, value] of Object.entries(skill.headers)) {
      let resolved = value;
      // Replace {{secrets.key}} with actual secret
      const secretMatches = value.matchAll(/\{\{secrets\.([^}]+)\}\}/g);
      for (const match of secretMatches) {
        const secretKey = match[1];
        const secretValue = await secrets.get(secretKey);
        if (secretValue) {
          resolved = resolved.replace(match[0], secretValue);
        } else {
          return `Error: Missing secret "${secretKey}" required for ${skill.name}`;
        }
      }
      headers[key] = resolved;
    }

    // Build request options
    const options = {
      method: tool.method,
      headers,
      signal: AbortSignal.timeout(15000),
    };

    // Add body for POST/PUT/PATCH
    if ((tool.method === 'POST' || tool.method === 'PUT' || tool.method === 'PATCH') && args.data) {
      options.body = args.data;
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    // Execute request
    const res = await fetch(url, options);
    const text = await res.text();

    if (!res.ok) {
      return `HTTP ${res.status}: ${text.slice(0, 500)}`;
    }

    // Try to parse JSON, otherwise return raw text
    try {
      const json = JSON.parse(text);
      return JSON.stringify(json, null, 2).slice(0, 4000);
    } catch {
      return text.slice(0, 4000);
    }
  } catch (err) {
    return `Error executing ${tool.name}: ${err.message}`;
  }
}
