/**
 * The identifier index and the endpoint level: parser, derivation,
 * registration, and the boot countdown, each tested where it joins the next.
 *
 * Design: docs/identifier-resolution-design.md (PR #144), sections 4 and 5,
 * and the "Read first" decision of 2026-09-10: a resolve counts only when the
 * ENTITY comes back, and the resolver keys on the ENDPOINT, not the parameter
 * name. This file covers the half that decides WHICH GET to ask. Asking it,
 * and refusing or prompting on the answer, is the gate change, which ships
 * separately and only once the countdown below reads 0 on the host.
 *
 * Fixture discipline (build log 2026-09-11, #164): a CAPABILITY is proved on
 * a synthetic skill nothing in the estate can edit. A LIVE FILE assertion says
 * what is true of a real skill file today, is labelled as such, and is the
 * only kind expected to move when an endpoint is added or declared.
 *
 * The trap this is built around (#143, build log 2026-09-10): a gate test that
 * drives the gate directly passes with the wiring absent. So the index is
 * asserted through registerSkillTool, through getSkillToolContext, through
 * ToolExecutor.run into the gate's own check(), and through Agent.load() into
 * the boot log, using real parsed skill files rather than hand-built skill
 * objects (which carry no endpoints, and so get no index at all).
 *
 * Run: node tests/identifier-index.test.js
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// registerSkillTool appends to tool-call.log. Keep it off the real one.
const TMP = mkdtempSync(join(tmpdir(), 'qclaw-identifier-index-'));
process.env.QCLAW_TOOL_CALL_LOG_PATH = join(TMP, 'tool-call.log');

const {
  parseSkill,
  skillToTools,
  parseEndpointLine,
  countEndpointLines,
  ENDPOINT_LEVELS,
} = await import('../src/agents/skill-parser.js');
const {
  deriveIdentifierIndex,
  pathParamResolver,
  bodyFieldResolvers,
  effectiveWriteLevel,
  normaliseIdentifierName,
  inspectSkills,
  formatReport,
  formatCountdown,
  indexCoversEndpoint,
  pathIdentifierNames,
} = await import('../src/agents/skill-diagnostics.js');
const { endpointsSection, classifyEndpointsLine } = await import('../src/agents/skill-parser.js');
const { pathParamNames, extractIdentifiers } = await import('../src/security/approval-summary.js');
const { registerSpecialistSkills } = await import('../src/agents/specialist-loader.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { ToolExecutor } = await import('../src/tools/executor.js');
const { ApprovalGate } = await import('../src/security/approval-gate.js');
const { ExecApprovals } = await import('../src/security/approvals.js');
const { Agent } = await import('../src/agents/registry.js');

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agents', 'skills');

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

const read = (name) => readFileSync(join(SKILLS_DIR, `${name}.md`), 'utf8');
const realSkills = () => readdirSync(SKILLS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => ({ name: f.replace(/\.md$/, ''), content: read(f.replace(/\.md$/, '')), filename: f }));
const WRITE = ['POST', 'PUT', 'PATCH', 'DELETE'];

// The endpoint grammar exactly as it stood before the level prefix
// (src/agents/skill-parser.js:98 at QClaw main 3621d09). A reference only:
// production code must never import a copy of the grammar.
const PRE_PREFIX_GRAMMAR = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s]*)\s*-\s*(.+)/i;

// Report-level countdown checks run at a fixed time so the dated prefix is
// exact. Boot-level checks run at the real time and match any date.
const NOW = new Date('2026-09-19T00:00:00Z');
const countdown = (report, agent = null) => formatCountdown(report, agent, NOW);
const CD = (agent = null) => `identifier gate countdown${agent ? ` (${agent})` : ''} at 2026-09-19T00:00:00Z: `;
const CDRE = (agent, rest) => new RegExp(`identifier gate countdown \\(${agent}\\) at \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z: ${rest}`);

const skillText = (endpointLines) => [
  '## Auth',
  'Base URL: https://example.test',
  '',
  '## Endpoints',
  ...endpointLines,
].join('\n');

async function main() {
  // ── 1. The grammar, and the parser seam ──────────────────────────────
  console.log('grammar:');

  // 1a. Additive on the estate. Every line of every real skill file reads the
  // same under the new grammar as under the old one, once any level prefix is
  // taken off for the old grammar's sake. A relative property, so no real
  // file, declared or not, can move it.
  const stripLevel = (t) => t.replace(/^\[[^\]]*\]\s*/, '');
  let compared = 0;
  const disagreements = [];
  for (const s of realSkills()) {
    for (const raw of s.content.split('\n')) {
      const t = raw.trim();
      const old = stripLevel(t).match(PRE_PREFIX_GRAMMAR);
      const neu = parseEndpointLine(t);
      if (old) compared++;
      const same = old === null
        ? neu === null
        : neu !== null && neu.method === old[1].toUpperCase() && neu.path === old[2].trim() && neu.description === old[3].trim();
      if (!same) disagreements.push(`${s.filename}: ${t}`);
    }
  }
  check('PRECONDITION: the estate has endpoint lines to compare', compared > 40, `compared ${compared}`);
  check('an unprefixed line parses exactly as it did before the prefix existed',
    disagreements.length === 0, disagreements.slice(0, 3).join(' | '));

  // 1b. A declaration never drops an endpoint. Each real skill that parses is
  // registered three ways: as it stands, with every level prefix stripped,
  // and with every write re-declared. Identical tool names all three ways,
  // however many of its writes the real file happens to declare today.
  let rewrittenWrites = 0;
  const dropped = [];
  const toolNames = (name, content) => {
    const p = parseSkill(name, content, null);
    return p ? skillToTools(p).map((t) => t.name).join(',') : '(skill parsed to null)';
  };
  for (const s of realSkills()) {
    if (!parseSkill(s.name, s.content, null)) continue;
    const rewrite = (declare) => s.content.split('\n').map((l) => {
      const e = parseEndpointLine(l.trim());
      if (!e || !WRITE.includes(e.method)) return l;
      rewrittenWrites++;
      return declare ? `[mutating] ${stripLevel(l.trim())}` : stripLevel(l.trim());
    }).join('\n');
    const asIs = toolNames(s.name, s.content);
    const stripped = toolNames(s.name, rewrite(false));
    const declaredAll = rewrite(true);
    const redeclared = toolNames(s.name, declaredAll);
    if (asIs !== stripped || asIs !== redeclared) dropped.push(`${s.name}: ${asIs} | ${stripped} | ${redeclared}`);
    else if (parseSkill(s.name, declaredAll, null).endpoints.some((e) => WRITE.includes(e.method) && e.level !== 'mutating')) {
      dropped.push(`${s.name}: a re-declared write did not carry its level`);
    }
  }
  check('PRECONDITION: real writes were rewritten', rewrittenWrites >= 80, `rewritten ${rewrittenWrites}`);
  check('declared, stripped or re-declared, every real skill registers exactly the same tools',
    dropped.length === 0, dropped.slice(0, 2).join(' | '));

  // 1c. Each level, and an undeclared write, on a synthetic skill.
  const synthLevels = parseSkill('synth', skillText([
    'GET /widgets/{{widget_id}} - get one',
    '[financial] POST /widgets/{{widget_id}}/pay - pay',
    '[destructive] DELETE /widgets/{{widget_id}} - delete',
    '[mutating] PUT /widgets/{{widget_id}} - update',
    'PATCH /widgets/{{widget_id}}/note - undeclared',
    '[Financial] POST /widgets/{{widget_id}}/refund - capitalised level',
  ]), null);
  check('every level parses and the undeclared write keeps a null level',
    JSON.stringify(synthLevels?.endpoints.map((e) => e.level))
      === JSON.stringify([null, 'financial', 'destructive', 'mutating', null, 'financial']),
    JSON.stringify(synthLevels?.endpoints.map((e) => e.level)));
  check('the tool carries the declared level', skillToTools(synthLevels).find((t) => t.path === '/widgets/{{widget_id}}/pay')?.level === 'financial');
  check('the parser records each endpoint\'s file line (for the boot diagnostic)',
    JSON.stringify(synthLevels?.endpoints.map((e) => e.line)) === JSON.stringify([5, 6, 7, 8, 9, 10]),
    JSON.stringify(synthLevels?.endpoints.map((e) => e.line)));

  // 1d. A bracket that is not a level keeps the endpoint, reads unclassified,
  // and is named at boot with its line. A typo must cost a loud refusal,
  // never a missing tool.
  for (const bad of ['finacial', '', 'high']) {
    const content = skillText([
      'GET /widgets/{{widget_id}} - get one',
      `[${bad}] POST /widgets/{{widget_id}}/pay - pay`,
    ]);
    const parsed = parseSkill('synth', content, null);
    const pay = parsed?.endpoints.find((e) => e.path === '/widgets/{{widget_id}}/pay');
    check(`"[${bad}]": the endpoint is kept, level null, raw token kept`,
      pay && pay.level === null && pay.declaredLevel === bad, JSON.stringify(pay));
    check(`"[${bad}]": the tool still registers`, skillToTools(parsed).some((t) => t.path === '/widgets/{{widget_id}}/pay'));
    const report = inspectSkills([{ name: 'synth', content, filename: 'synth.md' }], null);
    const lines = formatReport(report);
    check(`"[${bad}]": the boot report names the file, the line and the token`,
      lines.some((l) => l.includes('synth.md:6') && l.includes(`"[${bad}]"`) && /unclassified/.test(l)),
      JSON.stringify(lines));
    check(`"[${bad}]": the countdown counts it as unclassified`,
      countdown(report).unclassified === 1, JSON.stringify(countdown(report).lines));
  }

  // 1e. A level on a GET does nothing, and says so.
  const getLevel = skillText(['[financial] GET /widgets/{{widget_id}} - get one', 'POST /widgets - create']);
  const getReport = inspectSkills([{ name: 'synth', content: getLevel, filename: 'synth.md' }], null);
  check('a level on a GET is reported as having no effect, not as a bad level',
    getReport.badLevels.length === 0 && formatReport(getReport).some((l) => l.includes('synth.md:5') && /no effect/.test(l)),
    JSON.stringify(formatReport(getReport)));

  // 1f. The diagnostics read prefixed lines by the same grammar. A prefixed
  // endpoint line with an em dash must be diagnosed as the dash, on its line.
  // A private copy of the old grammar in the diagnostics would not see the
  // line at all and blame the section instead.
  const dashed = skillText(['[mutating] POST /clip — make a clip']);
  const dashReport = inspectSkills([{ name: 'clipx', content: dashed, filename: 'clipx.md' }], null);
  check('diagnose: a prefixed em-dash line is named as the dash, with its line',
    dashReport.broken[0] && /dash/.test(dashReport.broken[0].reason) && dashReport.broken[0].line === 5,
    JSON.stringify(dashReport.broken[0]));

  // 1g. `qclaw skill list` counts by the parser's grammar.
  const countMe = [
    '# Thing', '', '## Endpoints',
    '[financial] POST /a - a',
    'GET /b - b',
    '[mutating] PUT /c/{{c_id}} - c',
    'POST /d — em dash, not an endpoint',
    '', '## Permissions', 'GET /e - after the section, not counted',
  ].join('\n');
  check('countEndpointLines counts prefixed lines and skips a line the parser rejects',
    countEndpointLines(countMe) === 3, `got ${countEndpointLines(countMe)}`);

  // ── 2. Derivation: WHICH GET resolves an identifier ──────────────────
  console.log('derivation:');

  // CAPABILITY: the query string is stripped. A query-string parameter is
  // never an identifier and never a resolver.
  const q = deriveIdentifierIndex(parseSkill('q', skillText([
    'GET /widgets/?locationId={{secrets.loc}}&query={{query}} - search',
    'GET /widgets/{{widget_id}}?expand={{expand}} - one widget',
    'POST /widgets/{{widget_id}}/close - close',
    'GET /runs?widgetId={{widget_id}}&status={{status}} - filter runs',
  ]), null).endpoints);
  check('CAPABILITY: query-string parameters are not indexed (query, expand, status)',
    !('query' in q.indexed) && !('expand' in q.indexed) && !('status' in q.indexed),
    JSON.stringify(Object.keys(q.indexed)));
  check('CAPABILITY: a GET that ends at a parameter only in its query string is not a resolver',
    q.resolvers.length === 1 && q.resolvers[0].resource === '/widgets/{{widget_id}}',
    JSON.stringify(q.resolvers));
  check('CAPABILITY: a resolver whose query string follows the parameter still resolves',
    pathParamResolver(q, '/widgets/{{widget_id}}/close', 'widget_id')?.resource === '/widgets/{{widget_id}}');
  check('CAPABILITY: a body field named "query" has no resolver',
    bodyFieldResolvers(q, 'query').length === 0);
  const qWrite = deriveIdentifierIndex(parseSkill('qw', skillText([
    'GET /widgets/{{widget_id}} - one widget',
    'POST /widgets/{{widget_id}}/close?reason={{reason_id}} - close with a reason',
  ]), null).endpoints);
  check('CAPABILITY: a {{param}} in a WRITE\'s query string is not one of its path identifiers',
    JSON.stringify(qWrite.writes[0]?.pathParams.map((p) => p.param)) === '["widget_id"]',
    JSON.stringify(qWrite.writes[0]?.pathParams));

  // CAPABILITY: keyed on the endpoint. `{{id}}` on one resource never
  // resolves through a GET on another.
  const k = deriveIdentifierIndex(parseSkill('k', skillText([
    'GET /workflows/{{id}} - one workflow',
    'GET /executions/{{id}} - one execution',
    'DELETE /workflows/{{id}} - delete a workflow',
    'POST /deals/{{id}}/close - close a deal',
  ]), null).endpoints);
  const byPath = (p) => k.writes.find((w) => w.path === p);
  check('CAPABILITY: a write resolves through the GET on its own resource',
    byPath('/workflows/{{id}}')?.pathParams[0]?.resolver?.resource === '/workflows/{{id}}',
    JSON.stringify(byPath('/workflows/{{id}}')));
  check('CAPABILITY: {{id}} on /deals does not resolve through /workflows or /executions',
    byPath('/deals/{{id}}/close')?.pathParams[0]?.resolver === null,
    JSON.stringify(byPath('/deals/{{id}}/close')));
  check('CAPABILITY: the boot report flags that write as unresolvable',
    inspectSkills([{ name: 'k', content: skillText([
      'GET /workflows/{{id}} - one workflow',
      'POST /deals/{{id}}/close - close a deal',
    ]), filename: 'k.md' }], null).unresolved[0]?.unresolvedParams.some((u) => u.endpoint === 'POST /deals/{{id}}/close'));
  check('CAPABILITY: a body field "id" matches two resolvers, which the caller must treat as ambiguous',
    bodyFieldResolvers(k, 'id').length === 2, JSON.stringify(bodyFieldResolvers(k, 'id')));

  // CAPABILITY: registry templates are neither identifiers nor resolvers.
  const t = deriveIdentifierIndex(parseSkill('t', skillText([
    'GET /locations/{{secrets.location_id}} - this location',
    'GET /me/{{config.dashboard.authToken}} - not a real endpoint',
    'POST /locations/{{secrets.location_id}}/notes - add a note',
  ]), null).endpoints);
  check('CAPABILITY: {{secrets.*}} and {{config.*}} are not indexed and resolve nothing',
    Object.keys(t.indexed).length === 0 && t.resolvers.length === 0 && bodyFieldResolvers(t, 'location_id').length === 0,
    JSON.stringify({ indexed: Object.keys(t.indexed), resolvers: t.resolvers }));

  // CAPABILITY: body spelling meets path spelling.
  const n = deriveIdentifierIndex(parseSkill('n', skillText([
    'GET /contacts/{{contact_id}}/ - one contact (trailing slash)',
    'PUT /contacts/{{contact_id}} - update',
    'POST /conversations/messages - send',
  ]), null).endpoints);
  for (const spelling of ['contactId', 'contact_id', 'contact-id', 'CONTACT_ID']) {
    check(`CAPABILITY: body field "${spelling}" resolves through /contacts/{{contact_id}}`,
      bodyFieldResolvers(n, spelling).map((r) => r.resource).join() === '/contacts/{{contact_id}}');
  }
  check('CAPABILITY: a trailing slash on the resolver does not hide it',
    pathParamResolver(n, '/contacts/{{contact_id}}', 'contact_id')?.resource === '/contacts/{{contact_id}}');
  check('CAPABILITY: "customer" does not normalise to "customer_id" (the known Stripe gap)',
    normaliseIdentifierName('customer') !== normaliseIdentifierName('customer_id'));

  // The same GET written twice collides on its tool name, so the parser
  // refuses both (decided 2026-09-19). The derivation still treats one
  // resource written twice as one resolver when handed endpoints directly.
  const dupContent = skillText(['GET /workflows/{{id}} - one workflow', 'GET /workflows/{{id}} - one workflow']);
  check('an identical duplicate line is refused by the parser, both copies',
    parseSkill('d', dupContent, null) === null
      && inspectSkills([{ name: 'd', content: dupContent, filename: 'd.md' }], null).broken.length === 1);
  const dup = deriveIdentifierIndex([
    { method: 'GET', path: '/workflows/{{id}}' }, { method: 'GET', path: '/workflows/{{id}}' },
  ]);
  check('CAPABILITY: handed directly, one resource written twice is one resolver', bodyFieldResolvers(dup, 'id').length === 1);

  // The effective level. Declaring earns leniency; the default is the safe one.
  const table = [
    ['POST', null, 'unclassified'], ['PUT', null, 'unclassified'], ['PATCH', null, 'unclassified'],
    ['DELETE', null, 'destructive'],
    ['POST', 'financial', 'financial'], ['POST', 'mutating', 'mutating'], ['DELETE', 'mutating', 'mutating'],
    ['POST', 'finacial', 'unclassified'], ['GET', null, null], ['GET', 'financial', null],
  ];
  const wrong = table.filter(([m, l, want]) => effectiveWriteLevel(m, l) !== want);
  check('effectiveWriteLevel: undeclared write unclassified, undeclared DELETE destructive, GET null',
    wrong.length === 0, JSON.stringify(wrong.map(([m, l, want]) => [m, l, want, effectiveWriteLevel(m, l)])));
  check('ENDPOINT_LEVELS is exactly the three decided levels',
    JSON.stringify([...ENDPOINT_LEVELS]) === JSON.stringify(['financial', 'destructive', 'mutating']));

  // LIVE FILE. What the real files say today. Expected to move as endpoints
  // are added or removed; fix only these when they do.
  const live = (name) => deriveIdentifierIndex(parseSkill(name, read(name), null).endpoints);
  const trading = live('trading-api');
  check('LIVE trading-api: /hold resolves through GET /positions/{{position_id}} (added in #142)',
    pathParamResolver(trading, '/positions/{{position_id}}/hold', 'position_id')?.resource === '/positions/{{position_id}}');
  check('LIVE trading-api: body position_id (manual-close) has exactly one resolver; /alerts is not one',
    bodyFieldResolvers(trading, 'position_id').map((r) => r.resource).join() === '/positions/{{position_id}}',
    JSON.stringify(bodyFieldResolvers(trading, 'position_id')));
  check('LIVE trading-api: market_url and condition_id are invisible to the index',
    bodyFieldResolvers(trading, 'market_url').length === 0 && bodyFieldResolvers(trading, 'condition_id').length === 0);
  const fsc = live('ghl-fsc');
  check('LIVE ghl-fsc: {{query}} on the contact search is not indexed',
    !('query' in fsc.indexed), JSON.stringify(Object.keys(fsc.indexed)));
  check('LIVE ghl-fsc: a body contactId resolves through GET /contacts/{{contact_id}}',
    bodyFieldResolvers(fsc, 'contactId').map((r) => r.resource).join() === '/contacts/{{contact_id}}');
  const n8n = live('n8n-api');
  check('LIVE n8n-api: workflow_id and status (query-string filters) are not indexed',
    !('workflowid' in n8n.indexed) && !('status' in n8n.indexed), JSON.stringify(Object.keys(n8n.indexed)));
  check('LIVE n8n-api: a body "id" is ambiguous between workflows and executions',
    bodyFieldResolvers(n8n, 'id').length === 2, JSON.stringify(bodyFieldResolvers(n8n, 'id')));
  const stripe = live('stripe');
  check('LIVE stripe: "customer" has no resolver (known gap, see deriveIdentifierIndex)',
    bodyFieldResolvers(stripe, 'customer').length === 0 && bodyFieldResolvers(stripe, 'customer_id').length === 1);
  const allLive = inspectSkills(realSkills(), null);
  check('LIVE: every write path identifier in the estate has a same-resource resolver',
    allLive.unresolved.length === 0, JSON.stringify(allLive.unresolved.map((r) => r.unresolvedParams)));
  // Always true, and worth CI's attention: a declared level with a typo in a
  // real skill file fails here, before it reaches the host. A typo made on
  // the host is caught at boot by the same report.
  check('LIVE: no real skill file declares a level that is not a level',
    allLive.badLevels.length === 0, JSON.stringify(allLive.badLevels.map((r) => r.badLevels)));

  // ── 3. Registration: the index exists where the gate will read it ────
  console.log('registration:');

  const TOOL = (skill, def) => `charlie__${skill}__${def}`;
  const MANUAL_CLOSE = TOOL('trading-api', 'trading-api__create_positions_manual_close');
  const HOLD = TOOL('trading-api', 'trading-api__create_positions_id_hold');
  const POSITION = TOOL('trading-api', 'trading-api__get_positions_id');

  const registerReal = (name, content) => {
    const r = new ToolRegistry({}, {});
    const parsed = parseSkill(name, content, null);
    for (const tool of skillToTools(parsed)) r.registerSkillTool('charlie', name, parsed, tool);
    return r;
  };

  // The real trading-api.md with every level stripped: what an undeclared
  // skill registers as. Derived from the real file so the endpoints are real,
  // stripped so no declaration made in the file can move these checks.
  const stripLevels = (content) => content.split('\n')
    .map((l) => (parseEndpointLine(l.trim()) ? stripLevel(l.trim()) : l)).join('\n');
  const undeclaredTrading = stripLevels(read('trading-api'));
  check('PRECONDITION: stripping leaves the undeclared endpoint lines',
    /^POST \/positions\/manual-close /m.test(undeclaredTrading));
  const reg = registerReal('trading-api', undeclaredTrading);
  const closeCtx = reg.getSkillToolContext(MANUAL_CLOSE);
  check('registered from the real file, undeclared: manual-close is unclassified',
    closeCtx.level === 'unclassified', JSON.stringify({ level: closeCtx.level }));
  check('registered from the real file: the index resolves a body position_id',
    bodyFieldResolvers(closeCtx.identifierIndex, 'position_id').length === 1,
    JSON.stringify(closeCtx.identifierIndex?.resolvers));
  check('registered from the real file: /hold resolves its path param through the index on its context',
    pathParamResolver(reg.getSkillToolContext(HOLD).identifierIndex, '/positions/{{position_id}}/hold', 'position_id')?.resource === '/positions/{{position_id}}');
  check('a GET tool has no level', reg.getSkillToolContext(POSITION).level === null,
    JSON.stringify(reg.getSkillToolContext(POSITION).level));
  check('every tool of one skill shares ONE index object',
    closeCtx.identifierIndex === reg.getSkillToolContext(HOLD).identifierIndex
      && closeCtx.identifierIndex === reg.getSkillToolContext(POSITION).identifierIndex);

  // The same undeclared file with ONLY manual-close declared: the declaration
  // travels from the file line to the registry entry, and no further.
  const declaredContent = undeclaredTrading.replace(
    /^POST \/positions\/manual-close /m, '[financial] POST /positions/manual-close ');
  check('PRECONDITION: the declaration edit changed the file', declaredContent !== undeclaredTrading);
  const regDeclared = registerReal('trading-api', declaredContent);
  check('a [financial] declaration reaches the registry entry',
    regDeclared.getSkillToolContext(MANUAL_CLOSE).level === 'financial',
    JSON.stringify(regDeclared.getSkillToolContext(MANUAL_CLOSE).level));
  check('...and only that endpoint: /hold stays unclassified',
    regDeclared.getSkillToolContext(HOLD).level === 'unclassified');

  // LIVE FILE: the declarations as decided on 2026-09-18. Expected to move
  // only when a level is re-decided; fix these, not the checks above.
  const regLive = registerReal('trading-api', read('trading-api'));
  check('LIVE trading-api.md: manual-close is declared financial',
    regLive.getSkillToolContext(MANUAL_CLOSE).level === 'financial');
  check('LIVE trading-api.md: /positions/manual is declared mutating (decided 2026-09-18)',
    regLive.getSkillToolContext(TOOL('trading-api', 'trading-api__create_positions_manual')).level === 'mutating');
  check('LIVE stripe.md: POST /invoices is removed, and says so where the line was',
    !parseSkill('stripe', read('stripe'), null).endpoints.some((e) => e.method === 'POST' && e.path === '/invoices')
      && /^# POST \/invoices is REMOVED, not undeclared/m.test(read('stripe')));

  const regDelete = registerReal('synth', skillText([
    'GET /widgets/{{widget_id}} - one',
    'DELETE /widgets/{{widget_id}} - delete',
  ]));
  check('an undeclared DELETE registers as destructive',
    regDelete.getSkillToolContext(TOOL('synth', 'synth__delete_widgets_id')).level === 'destructive',
    JSON.stringify([...regDelete._apiTools.keys()]));

  // "Never derived" and "nothing to resolve" are different states and must
  // not collapse (#184 cold review, finding 4). A hand-built skill object with
  // no endpoints (the shape the older gate tests use) was never derived from
  // anything that declares the tool's endpoint: it gets NO index. A real skill
  // with writes and no identifiers gets an index that covers its endpoint and
  // has nothing in it.
  const handBuilt = new ToolRegistry({}, {});
  handBuilt.registerSkillTool('charlie', 'ghl', { name: 'ghl', baseUrl: 'https://x.test', headers: {} },
    { name: 'ghl__create_notes', method: 'POST', path: '/contacts/{{contact_id}}/notes', description: 'n', inputSchema: { type: 'object', properties: {} } });
  const hbCtx = handBuilt.getSkillToolContext('charlie__ghl__ghl__create_notes');
  check('never derived: a hand-built skill with no endpoints reaches the gate with NO index',
    hbCtx.identifierIndex === null && hbCtx.level === 'unclassified', JSON.stringify(hbCtx.identifierIndex));
  const regNothing = registerReal('hooks', skillText(['[mutating] POST /webhook/a - fire a', '[mutating] POST /webhook/b - fire b']));
  const nothingCtx = regNothing.getSkillToolContext(TOOL('hooks', 'hooks__create_webhook_a'));
  check('nothing to resolve: a real skill with no identifiers gets an index that covers it and is empty',
    nothingCtx.identifierIndex !== null && indexCoversEndpoint(nothingCtx.identifierIndex, 'POST', '/webhook/a')
      && nothingCtx.identifierIndex.resolvers.length === 0 && Object.keys(nothingCtx.identifierIndex.indexed).length === 0,
    JSON.stringify(nothingCtx.identifierIndex));

  check('indexCoversEndpoint: true for the skill\'s own endpoint, false for one it does not declare',
    indexCoversEndpoint(closeCtx.identifierIndex, 'POST', '/positions/manual-close')
      && !indexCoversEndpoint(closeCtx.identifierIndex, 'POST', '/positions/not-declared')
      && !indexCoversEndpoint(closeCtx.identifierIndex, 'GET', '/positions/manual-close'));
  const mismatch = new ToolRegistry({}, {});
  const parsedTrading = parseSkill('trading-api', undeclaredTrading, null);
  mismatch.registerSkillTool('charlie', 'trading-api', parsedTrading,
    { name: 'trading-api__create_elsewhere', method: 'POST', path: '/elsewhere/{{position_id}}', description: 'x', inputSchema: { type: 'object', properties: {} } });
  check('a tool whose endpoint its skill does not declare gets NO index, even though the skill has one',
    mismatch.getSkillToolContext('charlie__trading-api__trading-api__create_elsewhere').identifierIndex === null);

  // A stale index is a wrong index. Re-registering a skill of the same name
  // with different endpoints must not reuse the earlier derivation.
  const regA = registerReal('w', skillText(['GET /a/{{a_id}} - one a', '[mutating] POST /a/{{a_id}}/x - x']));
  const regB = registerReal('w', skillText(['GET /b/{{b_id}} - one b', '[mutating] POST /b/{{b_id}}/x - x']));
  check('PRECONDITION: the first registration resolved its own resource',
    bodyFieldResolvers(regA.getSkillToolContext(TOOL('w', 'w__create_a_id_x')).identifierIndex, 'a_id').length === 1);
  check('a re-parsed skill of the same name gets its OWN index, not a cached one',
    bodyFieldResolvers(regB.getSkillToolContext(TOOL('w', 'w__create_b_id_x')).identifierIndex, 'b_id').length === 1,
    JSON.stringify(regB.getSkillToolContext(TOOL('w', 'w__create_b_id_x')).identifierIndex));

  // The index is shared by every tool of a skill and handed out by
  // reference; nothing downstream may be able to edit it.
  const frozenIdx = reg.getSkillToolContext(MANUAL_CLOSE).identifierIndex;
  let mutated = false;
  try { frozenIdx.resolvers.push({ resource: '/evil' }); mutated = true; } catch { /* frozen */ }
  try { frozenIdx.indexed.evil = ['evil']; mutated = true; } catch { /* frozen */ }
  try { frozenIdx.resolvers[0].resource = '/evil'; mutated = true; } catch { /* frozen */ }
  check('the index is frozen: resolvers, names and resolver objects cannot be edited',
    !mutated && Object.isFrozen(frozenIdx) && frozenIdx.resolvers[0].resource === '/positions/{{position_id}}');

  // The executor seam. Real registry, real parsed file, real gate check():
  // the level and the index must reach both check() and requestApproval()
  // through ToolExecutor.run. Only the model turn and the human are stubbed.
  const approvalsDir = join(TMP, 'approvals');
  mkdirSync(approvalsDir, { recursive: true });
  for (const [label, registry, wantLevel] of [
    ['undeclared', reg, 'unclassified'],
    ['declared [financial]', regDeclared, 'financial'],
  ]) {
    const approvals = new ExecApprovals({ _dir: approvalsDir });
    approvals.attach(null);
    const gate = new ApprovalGate(approvals);
    let checkCtx = null;
    let approvalCtx = null;
    const realCheck = gate.check.bind(gate);
    gate.check = async (name, args, ctx) => { checkCtx = ctx; return realCheck(name, args, ctx); };
    gate.requestApproval = async (agent, toolName, toolArgs, riskLevel, ctx) => {
      approvalCtx = ctx;
      return { approved: false, reason: 'denied-by-test' };
    };
    const fetched = [];
    const realFetch = global.fetch;
    global.fetch = async (url) => { fetched.push(String(url)); throw new Error('no network in this test'); };

    const executor = new ToolExecutor({ primary: { provider: 'anthropic', model: 'test' } }, registry, { approvalGate: gate });
    let turn = 0;
    executor._completionWithTools = async () => (++turn === 1
      ? { content: '', usage: {}, model: 'test', toolCalls: [{ id: 't1', name: MANUAL_CLOSE,
          args: { data: JSON.stringify({ position_id: 'solana-110-aug-2026', exit_price: 0.5 }) } }] }
      : { content: 'done', toolCalls: [], usage: {}, model: 'test' });
    executor._appendAnthropicToolLoop = (msgs) => msgs;
    try {
      await executor.run([{ role: 'user', content: 'close it' }], { agent: 'charlie' });
    } finally {
      global.fetch = realFetch;
    }

    check(`executor seam (${label}): check() receives the level`,
      checkCtx?.level === wantLevel, JSON.stringify(checkCtx?.level));
    check(`executor seam (${label}): check() receives the index, and it resolves position_id`,
      bodyFieldResolvers(checkCtx?.identifierIndex, 'position_id').length === 1);
    check(`executor seam (${label}): requestApproval() receives the same level and index`,
      approvalCtx?.level === wantLevel && approvalCtx?.identifierIndex === checkCtx?.identifierIndex);
    check(`executor seam (${label}): nothing was fetched (denied before the write)`,
      fetched.length === 0, JSON.stringify(fetched));
  }

  // ── 4. The countdown ─────────────────────────────────────────────────
  console.log('countdown:');

  const three = (post) => skillText([
    'GET /widgets/{{widget_id}} - one',
    '[financial] POST /widgets/{{widget_id}}/pay - pay',
    `${post}POST /widgets - create`,
    'DELETE /widgets/{{widget_id}} - delete',
  ]);
  const before = countdown(inspectSkills([{ name: 'w', content: three(''), filename: 'w.md' }], null));
  check('CAPABILITY: counts writes and unclassified (declared and undeclared DELETE are not unclassified)',
    before.writes === 3 && before.unclassified === 1, JSON.stringify(before));
  check('CAPABILITY: the per-skill line says what it counts, path and body separately',
    before.lines.some((l) => l.includes('"w" (w.md): 3 writes, 1 unclassified; identifiers indexed 1 (widget_id); '
      + 'write path identifiers 2, 2 resolvable on their own resource; body-resolvable names 1 (widget_id)')),
    JSON.stringify(before.lines));
  check('CAPABILITY: the total says 1 of 3 and why it matters',
    before.lines.some((l) => l.startsWith(`${CD()}1 of 3 `) && /merges only when this reads 0/.test(l)),
    JSON.stringify(before.lines));
  check('CAPABILITY: the total names the agent when given one',
    countdown(inspectSkills([{ name: 'w', content: three(''), filename: 'w.md' }], null), 'charlie')
      .lines.some((l) => l.startsWith(`${CD('charlie')}1 of 3 `)));
  const ambiguousSkill = skillText([
    'GET /workflows/{{id}} - one workflow',
    'GET /executions/{{id}} - one execution',
    'POST /workflows - create',
  ]);
  const amb = countdown(inspectSkills([{ name: 'a', content: ambiguousSkill, filename: 'a.md' }], null));
  check('CAPABILITY: a name two GETs end at is ambiguous, not body-resolvable',
    amb.lines.some((l) => l.includes('body-resolvable names 0, ambiguous: id')), JSON.stringify(amb.lines));
  // Path and body are different questions: a v2 write whose only GET is v1
  // has an unresolvable PATH identifier while the NAME is body-resolvable.
  // The line must not print a resolver count that reads as covering the write.
  const v1v2 = countdown(inspectSkills([{ name: 'v', content: skillText([
    'GET /v1/contacts/{{contact_id}} - one contact',
    '[mutating] POST /v2/contacts/{{contact_id}}/notes - note',
  ]), filename: 'v.md' }], null));
  check('CAPABILITY: a write path identifier with no same-resource GET is counted unresolvable on the line',
    v1v2.lines.some((l) => l.includes('write path identifiers 1, 0 resolvable on their own resource')), JSON.stringify(v1v2.lines));
  const after = countdown(inspectSkills([{ name: 'w', content: three('[mutating] '), filename: 'w.md' }], null));
  check('CAPABILITY: at zero the countdown still prints, and says 0',
    after.unclassified === 0 && after.lines.some((l) => l.startsWith(`${CD()}0 of 3 `)),
    JSON.stringify(after.lines));
  const nothing = countdown(inspectSkills([], null), 'echo');
  check('CAPABILITY: an agent with nothing to count prints NOTHING, never "0 of 0"',
    nothing.lines.length === 0, JSON.stringify(nothing.lines));
  const onlyReads = countdown(inspectSkills([{ name: 'r', content: skillText(['GET /widgets/{{widget_id}} - one']), filename: 'r.md' }], null), 'echo');
  check('CAPABILITY: an agent whose skills only read prints nothing either',
    onlyReads.lines.length === 0, JSON.stringify(onlyReads.lines));
  const declaredCase = countdown(inspectSkills([{ name: 'c', content: skillText(['[Mutating] POST /widgets - create']), filename: 'c.md' }], null));
  check('CAPABILITY: a level written in another case counts as declared, not unclassified',
    declaredCase.unclassified === 0 && declaredCase.writes === 1, JSON.stringify(declaredCase));

  // LIVE: the countdown counts every parsed write, no more and no fewer.
  const liveCount = countdown(allLive);
  const parsedWrites = realSkills()
    .map((s) => parseSkill(s.name, s.content, null))
    .filter(Boolean)
    .reduce((acc, p) => acc + p.endpoints.filter((e) => WRITE.includes(e.method)).length, 0);
  check('LIVE: the countdown counts exactly the writes the parser registers',
    liveCount.writes === parsedWrites && liveCount.unclassified <= liveCount.writes,
    `countdown ${liveCount.writes}, parser ${parsedWrites}`);
  check('LIVE: no skill that parses has a line in ## Endpoints that is not an endpoint, comment or blank',
    allLive.invalid.length === 0, JSON.stringify(allLive.invalid.map((r) => r.invalid)));

  // The boot seam. Agent.load() is what runs on the host: it must register
  // the tools with their levels AND an index that resolves, and print the
  // countdown labelled with the agent, including at zero.
  const boot = async (agentName, files) => {
    const agentDir = mkdtempSync(join(TMP, 'agent-'));
    mkdirSync(join(agentDir, 'skills'));
    for (const [f, content] of Object.entries(files)) writeFileSync(join(agentDir, 'skills', f), content);
    const registry = new ToolRegistry({}, {});
    const agent = new Agent(agentName, agentDir, { toolRegistry: registry, secrets: { get: async () => null } });
    const printed = [];
    const realLog = console.log;
    console.log = (...args) => { printed.push(args.join(' ')); };
    try { await agent.load(); } finally { console.log = realLog; }
    return { registry, printed };
  };
  for (const [label, content, want] of [
    ['one undeclared write', three(''), CDRE('charlie', '1 of 3 ')],
    ['all declared', three('[mutating] '), CDRE('charlie', '0 of 3 ')],
  ]) {
    const { registry, printed } = await boot('charlie', { 'w.md': content });
    const ctx = registry.getSkillToolContext('charlie__w__w__create_widgets_id_pay');
    check(`boot (${label}): Agent.load() prints the countdown, labelled with the agent`,
      printed.some((l) => want.test(l)), JSON.stringify(printed.filter((l) => l.includes('countdown'))));
    check(`boot (${label}): Agent.load() registers the create tool with its effective level`,
      registry.getSkillToolContext('charlie__w__w__create_widgets').level === (label === 'all declared' ? 'mutating' : 'unclassified'),
      JSON.stringify(registry.getSkillToolContext('charlie__w__w__create_widgets').level));
    check(`boot (${label}): the booted tool's index covers its endpoint and resolves its path identifier`,
      ctx.identifierIndex !== null
        && pathParamResolver(ctx.identifierIndex, '/widgets/{{widget_id}}/pay', 'widget_id')?.resource === '/widgets/{{widget_id}}',
      JSON.stringify(ctx.identifierIndex));
  }
  // Two skills in one boot: each tool must get its OWN skill's index.
  const two = await boot('charlie', {
    'w.md': three('[mutating] '),
    'g.md': skillText(['GET /gadgets/{{gadget_id}} - one', '[mutating] POST /gadgets/{{gadget_id}}/spin - spin']),
  });
  const gCtx = two.registry.getSkillToolContext('charlie__g__g__create_gadgets_id_spin');
  const wCtx = two.registry.getSkillToolContext('charlie__w__w__create_widgets_id_pay');
  check('boot (two skills): each tool resolves through its own skill\'s index',
    bodyFieldResolvers(gCtx.identifierIndex, 'gadget_id').length === 1 && bodyFieldResolvers(wCtx.identifierIndex, 'widget_id').length === 1
      && bodyFieldResolvers(gCtx.identifierIndex, 'widget_id').length === 0,
    JSON.stringify({ g: gCtx.identifierIndex?.resolvers, w: wCtx.identifierIndex?.resolvers }));
  // An agent with an empty skills directory (echo, on the host) must print
  // no countdown at all: its "0 of 0" would read as the answer.
  const echoBoot = await boot('echo', {});
  check('boot (echo, empty skills directory): no countdown line is printed',
    !echoBoot.printed.some((l) => l.includes('identifier gate countdown')), JSON.stringify(echoBoot.printed));
  // An invalid line at boot: named with its line, and the countdown says
  // INCOMPLETE instead of a number that could be read as done.
  const badBoot = await boot('charlie', { 'w.md': three('[mutating] ').replace('[financial] POST', '[financial POST') });
  check('boot (invalid line): the report names the file and line',
    badBoot.printed.some((l) => l.includes('w.md:6') && l.includes('is not an endpoint')), JSON.stringify(badBoot.printed.filter((l) => l.includes('w.md'))));
  check('boot (invalid line): the countdown says INCOMPLETE and carries no count',
    badBoot.printed.some((l) => CDRE('charlie', 'INCOMPLETE').test(l))
      && !badBoot.printed.some((l) => /identifier gate countdown.*\d+ of \d+/.test(l)),
    JSON.stringify(badBoot.printed.filter((l) => l.includes('countdown'))));

  // The specialist registration path gets the same index.
  const specDir = mkdtempSync(join(TMP, 'spec-'));
  writeFileSync(join(specDir, 'w.md'), three('[mutating] '));
  const specRegistry = new ToolRegistry({}, {});
  const specEntry = { agentName: 'widget-operator', businessUnit: 'test', status: 'live', isLive: true, skills: ['w'] };
  const spec = Agent.createSpecialist(specEntry, { toolRegistry: specRegistry });
  registerSpecialistSkills(spec, { toolRegistry: specRegistry, secrets: {} }, { skillsDir: specDir, getEntry: () => specEntry });
  const specCtx = specRegistry.getSkillToolContext('widget-operator__w__w__create_widgets_id_pay');
  check('specialist path: a specialist-registered tool gets an index that resolves',
    specCtx.level === 'financial'
      && pathParamResolver(specCtx.identifierIndex, '/widgets/{{widget_id}}/pay', 'widget_id')?.resource === '/widgets/{{widget_id}}',
    JSON.stringify({ level: specCtx.level, index: specCtx.identifierIndex }));

  // ── 5. The cold review's findings, one check each ───────────────────
  console.log('cold review:');

  // Finding 1: every spelling the review found that dropped a write silently
  // is now named at boot, and makes the countdown INCOMPLETE.
  const variants = [
    '[mutating POST /widgets/{{widget_id}}/pay - pay',
    '[[mutating]] POST /widgets/{{widget_id}}/pay - pay',
    '[mutating]] POST /widgets/{{widget_id}}/pay - pay',
    '[mutating] [financial] POST /widgets/{{widget_id}}/pay - pay',
    '[mutating][financial] POST /widgets/{{widget_id}}/pay - pay',
    '(mutating) POST /widgets/{{widget_id}}/pay - pay',
    '{mutating} POST /widgets/{{widget_id}}/pay - pay',
    '<mutating> POST /widgets/{{widget_id}}/pay - pay',
    '［mutating］ POST /widgets/{{widget_id}}/pay - pay',
    '【mutating】 POST /widgets/{{widget_id}}/pay - pay',
    '`[mutating]` POST /widgets/{{widget_id}}/pay - pay',
    '- [mutating] POST /widgets/{{widget_id}}/pay - pay',
    '[mutating] - POST /widgets/{{widget_id}}/pay - pay',
    'POST [mutating] /widgets/{{widget_id}}/pay - pay',
    '​[mutating] POST /widgets/{{widget_id}}/pay - pay',
    '[mutating]​ POST /widgets/{{widget_id}}/pay - pay',
    '[mutating] POST /widgets/{{widget_id}}/pay — pay',
    '[mutating] POST /widgets/{{widget_id}}/pay – pay',
    'POST /widgets/{{widget_id}}/pay',
  ];
  const silent = [];
  for (const v of variants) {
    const content = skillText(['GET /widgets/{{widget_id}} - one', v]);
    const report = inspectSkills([{ name: 'w', content, filename: 'w.md' }], null);
    const lines = formatReport(report);
    const cd = countdown(report, 'charlie');
    const named = lines.some((l) => l.includes('w.md:6') && l.includes('is not an endpoint'));
    const incomplete = cd.lines.some((l) => l.startsWith(`${CD('charlie')}INCOMPLETE`));
    const readsZero = cd.lines.some((l) => /^identifier gate countdown.*\d+ of \d+/.test(l));
    if (!named || !incomplete || readsZero) silent.push(JSON.stringify(v));
  }
  check(`finding 1: all ${variants.length} malformed spellings are named at boot and make the countdown INCOMPLETE`,
    silent.length === 0, silent.join(' | '));
  // The strict rule (decided 2026-09-19): ## Endpoints may hold endpoints,
  // "#" comments and blank lines. Prose inside it is invalid BY DESIGN.
  const strictContent = [
    '## Auth', 'Base URL: https://example.test', '',
    '## Endpoints',
    'GET /widgets/{{widget_id}} - one',
    '# a comment mentioning POST /widgets, never an endpoint',
    '',
    'All requests to /webhook/x must send a flat JSON body:',
    '',
    '## Payload Format',
    'Get details at /docs before calling anything',
    'POST /widgets - an endpoint line under another heading',
  ].join('\n');
  const strict = inspectSkills([{ name: 'w', content: strictContent, filename: 'w.md' }], null);
  check('strict rule: a comment and a blank line are fine; prose inside ## Endpoints is named, by design',
    JSON.stringify(strict.invalid[0]?.invalid.filter((m) => m.reason === 'invalid').map((m) => m.line)) === '[8]', JSON.stringify(strict.invalid));
  check('outside rule: an endpoint line under a later heading is named, not silently dropped (decided 2026-09-19)',
    JSON.stringify(strict.invalid[0]?.invalid.filter((m) => m.reason === 'outside').map((m) => m.line)) === '[12]'
      && countdown(strict, 'charlie').incomplete, JSON.stringify(strict.invalid));
  check('strict rule (#183): the section ends at the next ## heading, for the parser, the CLI and the index alike',
    parseSkill('w', strictContent, null).endpoints.map((e) => e.path).join() === '/widgets/{{widget_id}}'
      && countEndpointLines(strictContent) === 1
      && endpointsSection(strictContent).every((l) => l.line >= 5 && l.line <= 9),
    JSON.stringify(endpointsSection(strictContent)));
  check('classifyEndpointsLine: endpoint, comment, blank, and everything else invalid',
    ['GET /a - b', '# x', '   ', 'prose'].map(classifyEndpointsLine).join() === 'endpoint,comment,blank,invalid');

  // Finding 3: a bracket that is not a level makes ANY write unclassified,
  // DELETE included, everywhere it is read.
  for (const bad of ['mutatin', '']) {
    const content = skillText(['GET /widgets/{{widget_id}} - one', `[${bad}] DELETE /widgets/{{widget_id}} - delete`]);
    const r = registerReal('w', content);
    const report = inspectSkills([{ name: 'w', content, filename: 'w.md' }], null);
    check(`finding 3: "[${bad}] DELETE" is unclassified in the registry, the report and the countdown alike`,
      r.getSkillToolContext(TOOL('w', 'w__delete_widgets_id')).level === 'unclassified'
        && formatReport(report).some((l) => /reads as unclassified/.test(l))
        && countdown(report).unclassified === 1,
      JSON.stringify({ level: r.getSkillToolContext(TOOL('w', 'w__delete_widgets_id')).level, cd: countdown(report).lines }));
  }
  const table2 = [
    ['DELETE', 'mutatin', 'unclassified'], ['DELETE', '', 'unclassified'], ['DELETE', 'destructive', 'destructive'],
    ['POST', ' Mutating ', 'mutating'], ['POST', 'MUTATING', 'mutating'],
  ];
  const wrong2 = table2.filter(([m, l, want]) => effectiveWriteLevel(m, l) !== want);
  check('finding 3: effectiveWriteLevel reads the RAW token (trimmed, any case); a bad one is unclassified',
    wrong2.length === 0, JSON.stringify(wrong2.map(([m, l, want]) => [m, l, want, effectiveWriteLevel(m, l)])));
  check('grammar: a space inside the bracket and none after it both parse',
    parseEndpointLine('[ mutating ] POST /w - d')?.level === 'mutating' && parseEndpointLine('[mutating]POST /w - d')?.level === 'mutating');

  // Finding 5: the same-resource property against near misses.
  const putOnly = deriveIdentifierIndex(parseSkill('p', skillText(['[mutating] PUT /contacts/{{contact_id}} - update']), null).endpoints);
  check('finding 5 (X2): a PUT ending at the parameter is not a resolver',
    putOnly.resolvers.length === 0 && bodyFieldResolvers(putOnly, 'contactId').length === 0, JSON.stringify(putOnly.resolvers));
  const mixed = deriveIdentifierIndex(parseSkill('m', skillText([
    'GET /a/{{a_id}} - a', '[mutating] PATCH /b/{{b_id}} - b', 'GET /orgs/{{org_id}}/members/{{member_id}}?expand={{expand}} - member',
  ]), null).endpoints);
  check('finding 5 (X2): every resolver records that it is a GET',
    mixed.resolvers.length === 2 && mixed.resolvers.every((r) => r.method === 'GET'), JSON.stringify(mixed.resolvers));
  const member = mixed.resolvers.find((r) => r.param === 'member_id');
  check('finding 5 (X8, X9): a resolver keeps every path parameter, and its original path with the query',
    JSON.stringify(member?.params) === '["org_id","member_id"]'
      && member?.path === '/orgs/{{org_id}}/members/{{member_id}}?expand={{expand}}'
      && member?.resource === '/orgs/{{org_id}}/members/{{member_id}}',
    JSON.stringify(member));
  const v12 = deriveIdentifierIndex(parseSkill('v', skillText([
    'GET /v1/contacts/{{contact_id}} - one contact', '[mutating] POST /v2/contacts/{{contact_id}}/notes - note',
  ]), null).endpoints);
  check('finding 5 (X3): a v2 write does not resolve through the v1 GET',
    pathParamResolver(v12, '/v2/contacts/{{contact_id}}/notes', 'contact_id') === null);
  const twoSep = deriveIdentifierIndex(parseSkill('t', skillText(['GET /records/{{contact_record_id}} - one']), null).endpoints);
  check('finding 5 (X4): a name with two separators normalises fully',
    ['contactRecordId', 'contact-record-id', 'CONTACT_RECORD_ID'].every((n) => bodyFieldResolvers(twoSep, n).length === 1));
  const variantsOfOne = deriveIdentifierIndex([
    { method: 'GET', path: '/w/{{id}}' }, { method: 'GET', path: '/w/{{id}}/' }, { method: 'GET', path: '/w/{{id}}?expand=1' },
  ]);
  check('finding 5 (X5): one resource written three ways is one resolver',
    variantsOfOne.resolvers.length === 1, JSON.stringify(variantsOfOne.resolvers));
  const repeated = deriveIdentifierIndex(parseSkill('r', skillText([
    'GET /teams/{{team_id}} - one team', '[mutating] POST /teams/{{team_id}}/copy/{{team_id}} - copy',
  ]), null).endpoints);
  check('finding 5 (X6, 12): a parameter repeated in a write path is one identifier, resolved at its first occurrence',
    repeated.writes[0].pathParams.length === 1 && repeated.writes[0].pathParams[0].resolver?.resource === '/teams/{{team_id}}',
    JSON.stringify(repeated.writes[0].pathParams));

  // Finding 6: one rule for path identifiers, in the prompt and the index.
  const paths = [
    '/widgets/{{widget_id}}/close?reason={{reason_id}}',
    '/contacts/?locationId={{secrets.x}}&query={{query}}',
    '/orgs/{{org_id}}/members/{{member_id}}?expand={{expand}}',
    ...realSkills().map((s) => parseSkill(s.name, s.content, null)).filter(Boolean).flatMap((p) => p.endpoints.map((e) => e.path)),
  ];
  const disagree = paths.filter((p) => JSON.stringify(pathParamNames(p)) !== JSON.stringify(pathIdentifierNames(p)));
  check('finding 6: the prompt\'s pathParamNames and the index agree on every path, real and synthetic',
    disagree.length === 0, disagree.slice(0, 3).join(' | '));
  const ex = extractIdentifiers({ args: { reason_id: 'r1', widget_id: 'w1' }, path: '/widgets/{{widget_id}}/close?reason={{reason_id}}' });
  check('finding 6: a query-string placeholder is not shown as a PATH identifier in the prompt',
    ex.identifiers.find((i) => i.name === 'widget_id')?.source === 'path'
      && ex.identifiers.find((i) => i.name === 'reason_id')?.source !== 'path',
    JSON.stringify(ex.identifiers));

  // ── 6. The second cold review's findings ────────────────────────────
  console.log('cold review, round two:');

  // Finding 1 (#192): a dash typo on a HYPHENATED path must never register a
  // shorter path. Every write line with a hyphen in its path, in the real
  // files, under every variant: the damaged line registers nothing, nothing
  // else changes, and the line is named.
  const hyphenCases = [];
  for (const name of ['trading-api', 'n8n-router']) {
    const content = read(name);
    const base = parseSkill(name, content, null);
    const basePaths = base.endpoints.map((e) => `${e.method} ${e.path}`).sort();
    const lines = content.split('\n');
    for (const e of base.endpoints.filter((x) => WRITE.includes(x.method) && x.path.includes('-'))) {
      const orig = lines[e.line - 1];
      const variants = {
        'em dash': orig.replace(' - ', ' — '),
        'en dash': orig.replace(' - ', ' – '),
        'no description': orig.slice(0, orig.indexOf(' - ')),
        'no space before the hyphen': orig.replace(' - ', '- '),
        'no space after the hyphen': orig.replace(' - ', ' -'),
        'level after the path': orig.replace(/^\[([^\]]*)\] (\S+) (\S+) - /, '$2 $3 [$1] - '),
      };
      for (const [what, line] of Object.entries(variants)) {
        if (line === orig) { hyphenCases.push(`${name}:${e.line} ${what}: variant did not apply`); continue; }
        const damaged = lines.map((l, i) => (i === e.line - 1 ? line : l)).join('\n');
        const p = parseSkill(name, damaged, null);
        const want = basePaths.filter((x) => x !== `${e.method} ${e.path}`);
        const got = p.endpoints.map((x) => `${x.method} ${x.path}`).sort();
        const named = p.invalidEndpointLines.some((m) => m.line === e.line);
        if (JSON.stringify(got) !== JSON.stringify(want) || !named) hyphenCases.push(`${name}:${e.line} ${what}: ${JSON.stringify(got.filter((x) => !basePaths.includes(x)))} named=${named}`);
      }
    }
  }
  check('finding 1 (#192): on all seven real hyphenated writes, no dash variant registers a shorter path, and each is named',
    hyphenCases.length === 0, hyphenCases.slice(0, 4).join(' | '));

  // Finding 3: the typos the heuristic missed are invalid under the strict
  // rule, named, and make the countdown INCOMPLETE with no count.
  const missed = [
    'financial POST /widgets/{{widget_id}}/pay - pay',
    'mutating: PUT /widgets/{{widget_id}} - update',
    '[mutating] PTU /widgets/{{widget_id}} - update',
    '1. [mutating] POST /widgets/{{widget_id}}/pay - pay',
    '[mutating] POST widgets/{{widget_id}}/pay - pay',
    '[mutating post /widgets/{{widget_id}}/pay - pay',
    'PO​ST /widgets/{{widget_id}}/pay - pay',
    '[mutating] POST /widgets/{{widget_id}}/pay -',
  ];
  const stillSilent = [];
  for (const v of missed) {
    const report = inspectSkills([{ name: 'w', content: skillText(['GET /widgets/{{widget_id}} - one', v]), filename: 'w.md' }], null);
    const cd = countdown(report, 'charlie');
    const ok = formatReport(report).some((l) => l.includes('w.md:6')) && cd.incomplete
      && cd.lines.some((l) => l.startsWith(`${CD('charlie')}INCOMPLETE`)) && !cd.lines.some((l) => /countdown.*\d+ of \d+/.test(l));
    if (!ok) stillSilent.push(JSON.stringify(v));
  }
  check(`finding 3: all ${missed.length} typos the heuristic missed are named and make the countdown INCOMPLETE`,
    stillSilent.length === 0, stillSilent.join(' | '));

  // Finding 2 (decision A): a skill that registers NOTHING is incomplete, not
  // absent. Each of these breaks one real skill beside a healthy one.
  const healthy = { name: 'ghl-fsc', content: read('ghl-fsc'), filename: 'ghl-fsc.md' };
  const breakages = {
    'Base URL typed "Base URL -"': ['trading-api', read('trading-api').replace('Base URL: http://localhost:4003', 'Base URL - http://localhost:4003')],
    'heading typed "## Endpoint"': ['ghl', read('ghl').replace('## Endpoints', '## Endpoint')],
    'every endpoint line broken': ['n8n-router', read('n8n-router').replace(/^\[mutating\] POST/gm, '[mutating POST')],
  };
  for (const [what, [name, content]] of Object.entries(breakages)) {
    check(`PRECONDITION (${what}): the edit changed ${name}.md`, content !== read(name));
    const report = inspectSkills([{ name, content, filename: `${name}.md` }, healthy], null);
    const cd = countdown(report, 'charlie');
    check(`finding 2 (${what}): the countdown is INCOMPLETE, names the skill, and gives no count`,
      cd.incomplete && cd.broken === 1
        && cd.lines.some((l) => l.includes(`"${name}"`) && l.includes('registered nothing'))
        && cd.lines.some((l) => l.startsWith(`${CD('charlie')}INCOMPLETE. 1 skill(s) registered nothing`))
        && !cd.lines.some((l) => /countdown.*\d+ of \d+/.test(l)),
      JSON.stringify(cd.lines.slice(-2)));
  }
  // LIVE: today ads-agency, content-studio and clipper register nothing
  // (#149 to #151), so the countdown over the real files is INCOMPLETE. That
  // is expected until they land; it is what stops part two merging first.
  const liveCd = countdown(allLive, 'charlie');
  check('LIVE: the real files read INCOMPLETE, naming exactly the skills the report says registered nothing',
    liveCd.incomplete === (allLive.broken.length > 0)
      && allLive.broken.every((r) => liveCd.lines.some((l) => l.includes(`"${r.name}"`) && l.includes('registered nothing'))),
    JSON.stringify({ broken: allLive.broken.map((r) => r.name), last: liveCd.lines.at(-1) }));

  // Finding 4: the total across more than one skill IS the merge line.
  const undeclared1 = skillText(['GET /a/{{a_id}} - a', 'POST /a/{{a_id}}/x - x', '[mutating] POST /a - make']);
  const undeclared2 = skillText(['GET /b/{{b_id}} - b', 'POST /b/{{b_id}}/y - y']);
  const twoSkills = countdown(inspectSkills([
    { name: 'a', content: undeclared1, filename: 'a.md' },
    { name: 'b', content: undeclared2, filename: 'b.md' },
  ], null), 'charlie');
  check('finding 4: unclassified writes are summed across skills (1 + 1 of 2 + 1)',
    twoSkills.unclassified === 2 && twoSkills.writes === 3 && twoSkills.lines.some((l) => l.startsWith(`${CD('charlie')}2 of 3 `)),
    JSON.stringify(twoSkills.lines.at(-1)));
  const invalidFirst = countdown(inspectSkills([
    { name: 'a', content: undeclared1 + '\n[mutating POST /a/broken - x', filename: 'a.md' },
    { name: 'b', content: skillText(['[mutating] POST /b - make']), filename: 'b.md' },
  ], null), 'charlie');
  check('finding 4: an invalid line in the FIRST skill still makes the total INCOMPLETE when a later skill is clean',
    invalidFirst.incomplete && invalidFirst.lines.some((l) => l.startsWith(`${CD('charlie')}INCOMPLETE`)),
    JSON.stringify(invalidFirst.lines.at(-1)));
  const bothWays = countdown(inspectSkills([{ name: 'a', content: undeclared1 + '\nprose in the section', filename: 'a.md' }], null), 'charlie');
  check('finding 5 (K6): INCOMPLETE also when writes are unclassified, and still with no count',
    bothWays.unclassified === 1 && bothWays.lines.some((l) => l.startsWith(`${CD('charlie')}INCOMPLETE`))
      && !bothWays.lines.some((l) => /countdown.*\d+ of \d+/.test(l)));

  // Finding 5: levels that merely contain a level word are not levels.
  const lookalikes = ['not mutating', 'mutating?', 'financially', 'mutating destructive', 'non-financial'];
  check('finding 5 (K14): a bracket that only contains a level word is unclassified',
    lookalikes.every((t) => effectiveWriteLevel('POST', t) === 'unclassified')
      && lookalikes.every((t) => parseEndpointLine(`[${t}] POST /w - d`)?.level === null),
    JSON.stringify(lookalikes.map((t) => [t, effectiveWriteLevel('POST', t)])));

  // Findings 4 and 5 at boot: the sum, the label, the per-skill lines, the
  // log level and the date, as Agent.load() prints them.
  const multiBoot = await boot('charlie', { 'a.md': undeclared1, 'b.md': undeclared2 });
  check('boot (two skills, one undeclared write each): the total is 2 of 3',
    multiBoot.printed.some((l) => CDRE('charlie', '2 of 3 ').test(l)), JSON.stringify(multiBoot.printed.filter((l) => l.includes('countdown'))));
  check('boot: the per-skill lines are printed, not only the total',
    multiBoot.printed.some((l) => l.includes('skill "a" (a.md): 2 writes, 1 unclassified'))
      && multiBoot.printed.some((l) => l.includes('skill "b" (b.md): 1 writes, 1 unclassified')));
  check('boot: a nonzero countdown logs as a warning',
    multiBoot.printed.some((l) => CDRE('charlie', '2 of 3 ').test(l) && l.includes('⚠')));
  const zeroBoot = await boot('charlie', { 'w.md': three('[mutating] ') });
  check('boot: a zero countdown logs as info, not a warning',
    zeroBoot.printed.some((l) => CDRE('charlie', '0 of 3 ').test(l) && l.includes('▸') && !l.includes('⚠')));
  const otherBoot = await boot('ops', { 'w.md': three('') });
  check('boot: the label is the booting agent\'s name, not a constant',
    otherBoot.printed.some((l) => CDRE('ops', '1 of 3 ').test(l)) && !otherBoot.printed.some((l) => l.includes('(charlie)')),
    JSON.stringify(otherBoot.printed.filter((l) => l.includes('countdown'))));
  const stamp = multiBoot.printed.map((l) => /countdown \(charlie\) at (\S+Z):/.exec(l)?.[1]).find(Boolean);
  check('boot: the countdown carries the boot time as an ISO date, so an earlier boot\'s line cannot pass for this one',
    !!stamp && Math.abs(Date.parse(stamp) - Date.now()) < 120000, String(stamp));
  const brokenBoot = await boot('charlie', { 'w.md': three('[mutating] '), 't.md': read('trading-api').replace('Base URL: ', 'Base URL - ') });
  check('boot: a skill that registers nothing makes the countdown INCOMPLETE, as a warning, with no count',
    brokenBoot.printed.some((l) => CDRE('charlie', 'INCOMPLETE. 1 skill\\(s\\) registered nothing').test(l) && l.includes('⚠'))
      && !brokenBoot.printed.some((l) => /countdown.*\d+ of \d+/.test(l)),
    JSON.stringify(brokenBoot.printed.filter((l) => l.includes('countdown'))));

  // ── 7. The third cold review's findings ─────────────────────────────
  console.log('cold review, round three:');

  // Finding 1: two endpoints with the same tool name. The registry would keep
  // one silently, so every line in the group is refused and named.
  const tradingText = read('trading-api');
  const stale = tradingText.replace('## Permissions', '[mutating] POST /positions/manual-close - Close a position (old wording)\n\n## Permissions');
  check('PRECONDITION: the stale duplicate was added', stale !== tradingText);
  const staleParsed = parseSkill('trading-api', stale, null);
  const staleReport = inspectSkills([{ name: 'trading-api', content: stale, filename: 'trading-api.md' }], null);
  const staleCd = countdown(staleReport, 'charlie');
  check('finding 1 (A): a stale duplicate of manual-close refuses BOTH lines; neither registers',
    !staleParsed.endpoints.some((e) => e.path === '/positions/manual-close')
      && staleParsed.invalidEndpointLines.filter((m) => m.reason === 'collision').length === 2,
    JSON.stringify(staleParsed.invalidEndpointLines));
  check('finding 1 (A): both are named with the line they collide with, and the countdown is INCOMPLETE with no count',
    formatReport(staleReport).filter((l) => l.includes('get the same tool name "create_positions_manual_close"')).length === 2
      && staleCd.incomplete && !staleCd.lines.some((l) => /countdown.*\d+ of \d+/.test(l)),
    JSON.stringify(formatReport(staleReport).filter((l) => l.includes('tool name'))));
  const regStale = new ToolRegistry({}, {});
  for (const t of skillToTools(staleParsed)) regStale.registerSkillTool('charlie', 'trading-api', staleParsed, t);
  check('finding 1 (A): the registry holds no manual-close tool at all, so nothing reaches the gate at the wrong level',
    !regStale._apiTools.has(MANUAL_CLOSE));
  const alias = parseSkill('trading-api', tradingText.replace('## Permissions', '[mutating] POST /positions/manual_close - legacy alias\n\n## Permissions'), null);
  check('finding 1 (B): a path differing only in - versus _ collides and is refused, both lines',
    !alias.endpoints.some((e) => e.path.startsWith('/positions/manual') && e.path.includes('close'))
      && alias.invalidEndpointLines.filter((m) => m.reason === 'collision').length === 2);
  const putPatch = parseSkill('c', skillText([
    'GET /contacts/{{contact_id}} - one',
    '[destructive] PUT /contacts/{{contact_id}} - replace',
    '[mutating] PATCH /contacts/{{contact_id}} - patch',
  ]), null);
  check('finding 1 (C): a PUT and a PATCH on one path collide; neither registers, both are named',
    !putPatch.endpoints.some((e) => e.method !== 'GET')
      && JSON.stringify(putPatch.invalidEndpointLines.map((m) => [m.line, m.reason, m.with])) === '[[6,"collision",[7]],[7,"collision",[6]]]',
    JSON.stringify(putPatch.invalidEndpointLines));
  const collisionOnly = skillText(['[mutating] POST /a - one', '[mutating] POST /a - two']);
  const colReport = inspectSkills([{ name: 'k', content: collisionOnly, filename: 'k.md' }], null);
  check('finding 1: a skill whose only endpoints collide registers nothing, and diagnose names the collision',
    colReport.broken.length === 1 && /tool name/.test(colReport.broken[0].reason) && colReport.broken[0].line === 5,
    JSON.stringify(colReport.broken[0]));
  check('LIVE: no real skill has a collision (n8n-api.md\'s duplicate line was removed 2026-09-19)',
    realSkills().every((sk) => !(parseSkill(sk.name, sk.content, null)?.invalidEndpointLines || []).some((m) => m.reason === 'collision')));

  // Finding 4 survivors, each now pinned.
  const allBroken = countdown(inspectSkills([
    { name: 't', content: read('trading-api').replace('Base URL: ', 'Base URL - '), filename: 't.md' },
  ], null), 'ops');
  check('K1/K2: an agent whose only HTTP skills are all broken still prints INCOMPLETE, not nothing',
    allBroken.lines.some((l) => l.startsWith(`${CD('ops')}INCOMPLETE. 1 skill(s) registered nothing`)), JSON.stringify(allBroken.lines));
  for (const [what, line] of [['a quote line', '> [mutating] POST /q - quoted'], ['an HTML comment', '<!-- [mutating] POST /h - hidden -->'], ['a code fence', '```']]) {
    const p = parseSkill('w', skillText(['GET /widgets/{{widget_id}} - one', line]), null);
    check(`C1/C2/C4: ${what} inside ## Endpoints is invalid and named, never a comment`,
      p.invalidEndpointLines.some((m) => m.line === 6 && m.reason === 'invalid'), JSON.stringify(p.invalidEndpointLines));
  }
  const fenced = parseSkill('w', skillText(['GET /widgets/{{widget_id}} - one', '```', '[mutating] POST /example - an example in a fence', '```']), null);
  check('C4: an endpoint inside a code fence in ## Endpoints is named with the fence lines (the fence is not a comment)',
    fenced.invalidEndpointLines.filter((m) => m.reason === 'invalid').map((m) => m.line).join() === '6,8', JSON.stringify(fenced.invalidEndpointLines));
  const sub = parseSkill('w', skillText(['GET /widgets/{{widget_id}} - one', '### Writes', '[mutating] POST /widgets - make']), null);
  check('S5: a ### sub-heading inside ## Endpoints is a comment; endpoints below it still register',
    sub.endpoints.map((e) => e.path).join() === '/widgets/{{widget_id}},/widgets' && sub.invalidEndpointLines.length === 0);
  const twoSections = ['## Auth', 'Base URL: https://x.test', '', '## Endpoints', 'GET /a/{{a_id}} - a', '', '## Permissions', '- http: [x.test]', '', '## Endpoints', '[mutating] POST /b - b'].join('\n');
  check('S6: a second ## Endpoints section is read too, by the parser and the CLI',
    parseSkill('w', twoSections, null).endpoints.map((e) => e.path).join() === '/a/{{a_id}},/b' && countEndpointLines(twoSections) === 2);
  const onlyBaseUrl = { name: 'b', content: ['# b', '## Setup', 'Base URL: https://x.test', 'Some prose.'].join('\n'), filename: 'b.md' };
  check('B2: a Base URL line alone marks a file as an HTTP skill, so its failure is named',
    inspectSkills([onlyBaseUrl], null).broken.length === 1, JSON.stringify(inspectSkills([onlyBaseUrl], null).rows));
  const twoInvalid = inspectSkills([{ name: 'w', content: skillText(['GET /widgets/{{widget_id}} - one', 'prose one', 'prose two']), filename: 'w.md' }], null);
  check('C6: every invalid line is named, not only the first',
    formatReport(twoInvalid).filter((l) => l.includes('is not an endpoint')).length === 2);
  check('G5: a lower-case verb still parses (the grammar is case-insensitive on the verb)',
    parseEndpointLine('[mutating] post /w - d')?.method === 'POST');
  const v2 = ['## Auth', 'Base URL: https://x.test', '', '## Endpoints', 'GET /a - a', '', '## EndpointsV2', '[mutating] POST /b - b'].join('\n');
  check('S2: "## EndpointsV2" is not the Endpoints section; its endpoint line is named as outside',
    parseSkill('w', v2, null).invalidEndpointLines.some((m) => m.line === 8 && m.reason === 'outside'));
  const lower = ['## Auth', 'Base URL: https://x.test', '', '## endpoints', 'GET /a - a'].join('\n');
  check('S3: "## endpoints" (lower case) is not the section: the skill registers nothing and is named broken',
    parseSkill('w', lower, null) === null && inspectSkills([{ name: 'w', content: lower, filename: 'w.md' }], null).broken.length === 1);
  const diagSection = ['## Auth', 'Base URL: https://x.test', '', '## Endpoints', '# nothing yet', '', '## Routing', 'POST /x — prose about routing'].join('\n');
  check('X1/X2: diagnose uses the shared section rule: a line under a later heading is not blamed as an endpoint line',
    /contains no METHOD \/path lines/.test(inspectSkills([{ name: 'w', content: diagSection, filename: 'w.md' }], null).broken[0]?.reason || ''),
    JSON.stringify(inspectSkills([{ name: 'w', content: diagSection, filename: 'w.md' }], null).broken[0]));
  const longLine = 'prose ' + 'x'.repeat(300) + ' END';
  check('R1: the named text is not truncated',
    formatReport(inspectSkills([{ name: 'w', content: skillText(['GET /a - a', longLine]), filename: 'w.md' }], null)).some((l) => l.includes(' END"')));
  // Finding 7: invisible characters are spelled out, so a line holding only a
  // zero-width space is not shown as "".
  const zw = formatReport(inspectSkills([{ name: 'w', content: skillText(['GET /a - a', '​']), filename: 'w.md' }], null));
  check('finding 7: a line holding only a zero-width space is shown as "\\u200B", not as ""',
    zw.some((l) => l.includes('"\\u200B"')), JSON.stringify(zw));
}

try {
  await main();
} catch (err) {
  console.error('unexpected:', err);
  failed++;
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
