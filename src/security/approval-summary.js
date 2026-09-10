/**
 * QuantumClaw Approval Summary
 *
 * What an approval prompt is ABOUT, rendered so the operator sees the
 * identifiers first, whole, and in a fixed place, then the subject those
 * identifiers resolve to, then everything else.
 *
 * Why this exists (audit 2026-09-10 of the 2026-08-27 incident):
 *
 *   requestApproval built the prompt as
 *     `${toolName}(${JSON.stringify(toolArgs).slice(0, 200)})`
 *   and the Telegram notifier sliced that again to 200 including the 64
 *   character tool name. A skill tool's whole body travels as one JSON
 *   string named `data`, so after the `{"data":"` wrapper and the escaping
 *   of every quote, at most 189 characters of body survived, and only 124
 *   on the Action line. Three of the four manual-close prompts ever sent
 *   were cut mid-JSON in the live approvals table. With `position_id`
 *   placed last in the body, which the model decides, the id was not shown
 *   at all. An operator who cannot see the identifier is not consenting to
 *   anything in particular.
 *
 * Rules:
 *   - Identifiers are never cut for length (bounded only by
 *     MAX_IDENTIFIER_CHARS, far above any real id, so the message cannot be
 *     weaponised against Telegram's 4096 limit).
 *   - The subject block (what the identifiers resolve to) is never cut.
 *   - The remaining fields are shown in full while they fit and truncated
 *     with an explicit marker when they do not.
 *   - "No identifiers found" is printed as such, never left implicit.
 *
 * What counts as an identifier is a NAME heuristic (IDENTIFIER_NAME_RE)
 * plus every `{{param}}` in the tool's path. That is a rendering aid, not a
 * validation rule: a field the heuristic misses still appears under
 * Arguments. The skill-declared identifier convention that replaces the
 * heuristic for validation is a separate design (fix 2 of the audit).
 */

export const IDENTIFIER_NAME_RE = /(^id$|^ids$|_id$|_ids$|Id$|Ids$|^uuid$|_uuid$|_url$|Url$)/;

// Per identifier value. Real ids are under 100 characters; this bound only
// stops a hostile or broken caller from filling the whole prompt with one.
export const MAX_IDENTIFIER_CHARS = 1024;

// Budget for the Arguments block in the stored detail and the first render.
export const DEFAULT_FIELDS_BUDGET = 2500;

// Telegram sendMessage hard limit for `text`.
export const TELEGRAM_TEXT_LIMIT = 4096;

function stringifyValue(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Names of `{{param}}` placeholders in a skill endpoint path, excluding
 * `{{secrets.*}}` and `{{config.*}}` which are resolved by the registry.
 */
export function pathParamNames(path) {
  const names = [];
  if (typeof path !== 'string') return names;
  for (const m of path.matchAll(/\{\{([^}]+)\}\}/g)) {
    const name = m[1].trim();
    if (name.startsWith('secrets.') || name.startsWith('config.')) continue;
    names.push(name);
  }
  return names;
}

/**
 * Split a tool call's arguments into identifiers and other fields.
 *
 * Order is deterministic and independent of the order the model chose:
 * path params first (in path order), then body identifiers (in body order),
 * then top-level identifiers. Within Arguments, body order is preserved.
 *
 * @param {{ args: object, path?: string }} input
 * @returns {{ identifiers: Array<{name:string,value:string,source:'path'|'body'|'arg'}>,
 *             fields: Array<{name:string,value:string}>,
 *             parseError: string|null }}
 */
export function extractIdentifiers({ args, path }) {
  const identifiers = [];
  const fields = [];
  let parseError = null;
  const a = isPlainObject(args) ? args : {};
  const consumed = new Set();

  for (const name of pathParamNames(path)) {
    if (a[name] === undefined) continue;
    identifiers.push({ name, value: stringifyValue(a[name]), source: 'path' });
    consumed.add(name);
  }

  // The skill-parser schema carries the whole request body as one JSON
  // string called `data` (skill-parser.js:193-195). Look inside it.
  if (a.data !== undefined) {
    consumed.add('data');
    let body = a.data;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        parseError = 'data is not valid JSON';
        fields.push({ name: 'data', value: String(a.data) });
        body = null;
      }
    }
    if (isPlainObject(body)) {
      for (const [name, value] of Object.entries(body)) {
        if (IDENTIFIER_NAME_RE.test(name)) {
          identifiers.push({ name, value: stringifyValue(value), source: 'body' });
        } else {
          fields.push({ name, value: stringifyValue(value) });
        }
      }
    } else if (body !== null && parseError === null) {
      // Array or scalar payloads are sent verbatim as the body.
      fields.push({ name: 'data', value: stringifyValue(body) });
    }
  }

  for (const [name, value] of Object.entries(a)) {
    if (consumed.has(name)) continue;
    if (IDENTIFIER_NAME_RE.test(name)) {
      identifiers.push({ name, value: stringifyValue(value), source: 'arg' });
    } else {
      fields.push({ name, value: stringifyValue(value) });
    }
  }

  return { identifiers, fields, parseError };
}

function capIdentifier(value) {
  const s = String(value);
  if (s.length <= MAX_IDENTIFIER_CHARS) return s;
  return `${s.slice(0, MAX_IDENTIFIER_CHARS)} [+${s.length - MAX_IDENTIFIER_CHARS} chars, identifier longer than ${MAX_IDENTIFIER_CHARS}]`;
}

/**
 * Build the summary object for one tool call. Pure: no lookups here. The
 * caller attaches `subject` lines from a resolver afterwards.
 */
export function buildApprovalSummary({ agent, toolName, toolArgs, context = {} }) {
  const method = String(context?.httpMethod ?? '').trim().toUpperCase() || null;
  const path = typeof context?.path === 'string' ? context.path : null;
  const skill = typeof context?.skill === 'string' ? context.skill : null;
  const { identifiers, fields, parseError } = extractIdentifiers({ args: toolArgs, path });
  return {
    agent: String(agent ?? 'unknown'),
    toolName: String(toolName ?? ''),
    method,
    path,
    skill,
    identifiers,
    fields,
    parseError,
    subject: [],
    subjectStatus: 'none',
  };
}

/**
 * Render the stored/notified detail text. Identifiers and subject are
 * complete; the Arguments block is bounded by `fieldsBudget` characters and
 * says so when it was cut.
 */
export function renderApprovalDetail(summary, { fieldsBudget = DEFAULT_FIELDS_BUDGET } = {}) {
  const s = summary || {};
  const lines = [];

  const verb = s.method && s.path ? `${s.method} ${s.path}` : (s.toolName || 'unknown tool');
  const skillNote = s.skill ? ` (skill ${s.skill})` : '';
  lines.push(`${s.agent || 'unknown'} wants to ${verb}${skillNote}`);

  if (Array.isArray(s.identifiers) && s.identifiers.length > 0) {
    lines.push('Identifiers:');
    for (const ident of s.identifiers) {
      lines.push(`  ${ident.name} = ${capIdentifier(ident.value)}  [${ident.source}]`);
    }
  } else {
    lines.push('Identifiers: none found in the arguments');
  }

  if (Array.isArray(s.subject) && s.subject.length > 0) {
    lines.push('Subject:');
    for (const line of s.subject) lines.push(`  ${line}`);
  }

  const fieldLines = [];
  if (s.parseError) fieldLines.push(`  (${s.parseError})`);
  for (const f of (Array.isArray(s.fields) ? s.fields : [])) {
    fieldLines.push(`  ${f.name} = ${f.value}`);
  }
  if (fieldLines.length > 0) {
    lines.push('Arguments:');
    let block = fieldLines.join('\n');
    if (block.length > fieldsBudget) {
      const omitted = block.length - fieldsBudget;
      block = `${block.slice(0, Math.max(0, fieldsBudget))}\n  [+${omitted} chars not shown]`;
    }
    lines.push(block);
  } else if (!s.parseError) {
    lines.push('Arguments: none');
  }

  return lines.join('\n');
}

/**
 * The Telegram message. Fits TELEGRAM_TEXT_LIMIT by shrinking the Arguments
 * block only; identifiers and subject are never traded for space.
 */
export function renderTelegramText({ id, tool, agent, riskLevel, summary, detail }) {
  const header =
    `⚠️ Approval needed [${id}]\n` +
    `Tool: ${tool}\n` +
    `Agent: ${agent}\n` +
    `Risk: ${riskLevel}\n\n`;
  const footer = `\n\nReply ✅ ${id} or ❌ ${id}. Auto-denies after 10 min.`;
  const room = TELEGRAM_TEXT_LIMIT - header.length - footer.length;

  let body = typeof detail === 'string' ? detail : renderApprovalDetail(summary);
  if (body.length > room && summary) {
    // Shrink the Arguments block until the whole message fits.
    let budget = DEFAULT_FIELDS_BUDGET;
    while (body.length > room && budget > 0) {
      budget = Math.max(0, budget - 200);
      body = renderApprovalDetail(summary, { fieldsBudget: budget });
    }
  }
  if (body.length > room) {
    // Only reachable with identifiers near MAX_IDENTIFIER_CHARS each. Cut
    // the tail and say so rather than let Telegram reject the send silently.
    body = `${body.slice(0, Math.max(0, room - 40))}\n[message cut to fit Telegram]`;
  }
  return `${header}${body}${footer}`;
}
