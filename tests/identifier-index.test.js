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
 * objects (which carry no endpoints and so produce an empty index).
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
} = await import('../src/agents/skill-diagnostics.js');
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

  // 1a. Additive on the estate. Every line of every real skill file that
  // carries no bracket reads the same under the new grammar as under the old
  // one. A relative property, so no real file can move it.
  let compared = 0;
  const disagreements = [];
  for (const s of realSkills()) {
    for (const raw of s.content.split('\n')) {
      const t = raw.trim();
      if (t.startsWith('[')) continue;
      const old = t.match(PRE_PREFIX_GRAMMAR);
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

  // 1b. A declaration never drops an endpoint. Prefix every write in every
  // real skill that parses and register the tools: identical names, identical
  // count. This is the property that has to hold on the day the declarations
  // land, checked against every real file today.
  let prefixedWrites = 0;
  const dropped = [];
  for (const s of realSkills()) {
    const plain = parseSkill(s.name, s.content, null);
    if (!plain) continue;
    const declared = s.content.split('\n').map((l) => {
      const t = l.trim();
      const e = parseEndpointLine(t);
      if (e && WRITE.includes(e.method)) { prefixedWrites++; return `[mutating] ${t}`; }
      return l;
    }).join('\n');
    const withLevels = parseSkill(s.name, declared, null);
    const a = skillToTools(plain).map((t) => t.name).join(',');
    const b = withLevels ? skillToTools(withLevels).map((t) => t.name).join(',') : '(skill parsed to null)';
    if (a !== b) dropped.push(`${s.name}: ${a} != ${b}`);
    else if (withLevels.endpoints.some((e) => WRITE.includes(e.method) && e.level !== 'mutating')) {
      dropped.push(`${s.name}: a prefixed write did not carry its level`);
    }
  }
  check('PRECONDITION: real writes were prefixed', prefixedWrites >= 40, `prefixed ${prefixedWrites}`);
  check('declaring every real write registers exactly the same tools, each carrying its level',
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
      formatCountdown(report).unclassified === 1, JSON.stringify(formatCountdown(report).lines));
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
    !q.indexed.has('query') && !q.indexed.has('expand') && !q.indexed.has('status'),
    JSON.stringify([...q.indexed.keys()]));
  check('CAPABILITY: a GET that ends at a parameter only in its query string is not a resolver',
    q.resolvers.length === 1 && q.resolvers[0].resource === '/widgets/{{widget_id}}',
    JSON.stringify(q.resolvers));
  check('CAPABILITY: a resolver whose query string follows the parameter still resolves',
    pathParamResolver(q, '/widgets/{{widget_id}}/close', 'widget_id')?.resource === '/widgets/{{widget_id}}');
  check('CAPABILITY: a body field named "query" has no resolver',
    bodyFieldResolvers(q, 'query').length === 0);

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
    t.indexed.size === 0 && t.resolvers.length === 0 && bodyFieldResolvers(t, 'location_id').length === 0,
    JSON.stringify({ indexed: [...t.indexed.keys()], resolvers: t.resolvers }));

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

  // CAPABILITY: the same GET written twice is one resolver, not an ambiguity.
  const dup = deriveIdentifierIndex(parseSkill('d', skillText([
    'GET /workflows/{{id}} - one workflow',
    'GET /workflows/{{id}} - one workflow',
  ]), null).endpoints);
  check('CAPABILITY: a duplicated GET line is one resolver', bodyFieldResolvers(dup, 'id').length === 1);

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
    !fsc.indexed.has('query'), JSON.stringify([...fsc.indexed.keys()]));
  check('LIVE ghl-fsc: a body contactId resolves through GET /contacts/{{contact_id}}',
    bodyFieldResolvers(fsc, 'contactId').map((r) => r.resource).join() === '/contacts/{{contact_id}}');
  const n8n = live('n8n-api');
  check('LIVE n8n-api: workflow_id and status (query-string filters) are not indexed',
    !n8n.indexed.has('workflowid') && !n8n.indexed.has('status'), JSON.stringify([...n8n.indexed.keys()]));
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

  const reg = registerReal('trading-api', read('trading-api'));
  const closeCtx = reg.getSkillToolContext(MANUAL_CLOSE);
  check('registered from the real file: manual-close is unclassified (no declaration yet)',
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

  // The same file with manual-close declared: the declaration travels from
  // the file line to the registry entry.
  const declaredContent = read('trading-api').replace(
    /^POST \/positions\/manual-close /m, '[financial] POST /positions/manual-close ');
  check('PRECONDITION: the declaration edit changed the file', declaredContent !== read('trading-api'));
  const regDeclared = registerReal('trading-api', declaredContent);
  check('a [financial] declaration reaches the registry entry',
    regDeclared.getSkillToolContext(MANUAL_CLOSE).level === 'financial',
    JSON.stringify(regDeclared.getSkillToolContext(MANUAL_CLOSE).level));
  check('...and only that endpoint: /hold stays unclassified',
    regDeclared.getSkillToolContext(HOLD).level === 'unclassified');

  const regDelete = registerReal('synth', skillText([
    'GET /widgets/{{widget_id}} - one',
    'DELETE /widgets/{{widget_id}} - delete',
  ]));
  check('an undeclared DELETE registers as destructive',
    regDelete.getSkillToolContext(TOOL('synth', 'synth__delete_widgets_id')).level === 'destructive',
    JSON.stringify([...regDelete._apiTools.keys()]));

  // The trap, stated: a hand-built skill object with no endpoints (the shape
  // the older gate tests use) produces an EMPTY index. Such a fixture cannot
  // prove anything about resolution, and the gate tests must not use it.
  const handBuilt = new ToolRegistry({}, {});
  handBuilt.registerSkillTool('charlie', 'ghl', { name: 'ghl', baseUrl: 'https://x.test', headers: {} },
    { name: 'ghl__create_notes', method: 'POST', path: '/contacts/{{contact_id}}/notes', description: 'n', inputSchema: { type: 'object', properties: {} } });
  const hbCtx = handBuilt.getSkillToolContext('charlie__ghl__ghl__create_notes');
  check('a hand-built skill with no endpoints has an index, and it is empty',
    hbCtx.identifierIndex && hbCtx.identifierIndex.resolvers.length === 0 && hbCtx.level === 'unclassified');

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
  const before = formatCountdown(inspectSkills([{ name: 'w', content: three(''), filename: 'w.md' }], null));
  check('CAPABILITY: counts writes and unclassified (declared and undeclared DELETE are not unclassified)',
    before.writes === 3 && before.unclassified === 1, JSON.stringify(before));
  check('CAPABILITY: the per-skill line carries writes, unclassified, identifiers indexed and with a resolver',
    before.lines.some((l) => l.includes('"w" (w.md): 3 writes, 1 unclassified; identifiers indexed 1 (widget_id), with a resolver 1')),
    JSON.stringify(before.lines));
  check('CAPABILITY: the total says 1 of 3 and why it matters',
    before.lines.some((l) => l.startsWith('identifier gate countdown: 1 of 3 ') && /merges only when this reads 0/.test(l)),
    JSON.stringify(before.lines));
  const after = formatCountdown(inspectSkills([{ name: 'w', content: three('[mutating] '), filename: 'w.md' }], null));
  check('CAPABILITY: at zero the countdown still prints, and says 0',
    after.unclassified === 0 && after.lines.some((l) => l.startsWith('identifier gate countdown: 0 of 3 ')),
    JSON.stringify(after.lines));

  // LIVE: the countdown counts every parsed write, no more and no fewer.
  const liveCount = formatCountdown(allLive);
  const parsedWrites = realSkills()
    .map((s) => parseSkill(s.name, s.content, null))
    .filter(Boolean)
    .reduce((acc, p) => acc + p.endpoints.filter((e) => WRITE.includes(e.method)).length, 0);
  check('LIVE: the countdown counts exactly the writes the parser registers',
    liveCount.writes === parsedWrites && liveCount.unclassified <= liveCount.writes,
    `countdown ${liveCount.writes}, parser ${parsedWrites}`);

  // The boot seam. Agent.load() is what runs on the host: it must register
  // the tools with their levels AND print the countdown, including at zero.
  for (const [label, content, want] of [
    ['one undeclared write', three(''), 'identifier gate countdown: 1 of 3 '],
    ['all declared', three('[mutating] '), 'identifier gate countdown: 0 of 3 '],
  ]) {
    const agentDir = mkdtempSync(join(TMP, 'agent-'));
    mkdirSync(join(agentDir, 'skills'));
    writeFileSync(join(agentDir, 'skills', 'w.md'), content);
    const registry = new ToolRegistry({}, {});
    const agent = new Agent('charlie', agentDir, { toolRegistry: registry, secrets: { get: async () => null } });
    const printed = [];
    const realLog = console.log;
    console.log = (...args) => { printed.push(args.join(' ')); };
    try {
      await agent.load();
    } finally {
      console.log = realLog;
    }
    check(`boot (${label}): Agent.load() prints the countdown`,
      printed.some((l) => l.includes(want)), JSON.stringify(printed.filter((l) => l.includes('countdown'))));
    check(`boot (${label}): Agent.load() registers the create tool with its effective level`,
      registry.getSkillToolContext('charlie__w__w__create_widgets').level === (label === 'all declared' ? 'mutating' : 'unclassified'),
      JSON.stringify(registry.getSkillToolContext('charlie__w__w__create_widgets').level));
  }
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
