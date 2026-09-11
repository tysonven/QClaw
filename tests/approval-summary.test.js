/**
 * Approval prompt — the identifiers must be visible, whole, and first.
 *
 * The 2026-08-27 incident: three approval prompts for one close, each with a
 * different identifier, one of them composed from chat text. The prompt was
 * built as `${toolName}(${JSON.stringify(args).slice(0, 200)})` and then
 * sliced to 200 again by the notifier, including the 64-character tool name.
 * A skill tool's whole body travels as one escaped JSON string named `data`,
 * so at most 189 body characters reached the Detail block and 124 the Action
 * line. Live approvals rows 122, 123 and 125 are all cut mid-JSON, and with
 * position_id last in the body it vanished entirely.
 *
 * These tests pin the property, not the shape: a value the OLD renderer
 * could not show must be present in the NEW one, character for character,
 * at body sizes where truncation is guaranteed. Fixtures use distinct
 * non-default values (a 96-char note, a 220-char note, ids in first and last
 * position) so a renderer that happened to show a short payload cannot pass.
 *
 * Run: node tests/approval-summary.test.js
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecApprovals } from '../src/security/approvals.js';
import { ApprovalGate } from '../src/security/approval-gate.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutor } from '../src/tools/executor.js';
import {
  buildApprovalSummary,
  extractIdentifiers,
  pathParamNames,
  renderApprovalDetail,
  renderTelegramText,
  MAX_IDENTIFIER_CHARS,
  TELEGRAM_TEXT_LIMIT,
} from '../src/security/approval-summary.js';
import {
  registerSubjectResolver,
  resolveSubject,
  makeTradingApiPositionResolver,
  __clearSubjectResolversForTests,
} from '../src/security/subject-resolvers.js';

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

const CLOSE_TOOL = 'charlie__trading-api__trading-api__create_positions_manual_close';
const REAL_ID = 'b3cecdef-9948-40c7-9691-1b9c4ce579bc';
const COMPOSED_ID = 'solana-110-aug-2026';

// The exact payload behind live approval row 123 (2026-08-27 20:57:57).
const INCIDENT_DATA = '{"position_id": "solana-110-aug-2026", "exit_price": 0.863, "exit_usdc": 17.86, "exit_reason": "manual close", "note": "Solana $110 August target - position closed by Tyson"}';

// The renderer this replaces, reproduced so the tests measure a real
// difference rather than asserting against a remembered one.
function oldRender({ id, tool, agent, riskLevel, args }) {
  const action = `${tool}(${JSON.stringify(args).slice(0, 200)})`;
  const detail = `Agent ${agent} wants to execute: ${action}`;
  return `⚠️ Approval needed [${id}]\nTool: ${tool}\nAgent: ${agent}\nRisk: ${riskLevel}\n` +
    `Action: ${String(action).slice(0, 200)}\n` +
    `\nDetail:\n${String(detail).slice(0, 500)}\n` +
    `\nReply ✅ ${id} or ❌ ${id} — auto-denies after 10 min.`;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'qclaw-approval-summary-'));

  // ── 1. extractIdentifiers ────────────────────────────────────
  const parsed = extractIdentifiers({
    args: { data: INCIDENT_DATA },
    path: '/positions/manual-close',
  });
  check('body position_id is classified as an identifier',
    parsed.identifiers.some(i => i.name === 'position_id' && i.value === COMPOSED_ID),
    JSON.stringify(parsed.identifiers));
  check('non-identifier money fields stay under fields',
    parsed.fields.some(f => f.name === 'exit_usdc' && f.value === '17.86')
      && parsed.fields.some(f => f.name === 'exit_price'),
    JSON.stringify(parsed.fields));
  check('no false parse error on valid JSON', parsed.parseError === null);

  const pathParsed = extractIdentifiers({
    args: { position_id: REAL_ID, data: '{"hold": true}' },
    path: '/positions/{{position_id}}/hold',
  });
  check('path param is an identifier tagged source=path',
    pathParsed.identifiers.length === 1
      && pathParsed.identifiers[0].source === 'path'
      && pathParsed.identifiers[0].value === REAL_ID,
    JSON.stringify(pathParsed.identifiers));
  check('pathParamNames ignores {{secrets.*}} and {{config.*}}',
    JSON.stringify(pathParamNames('/contacts/?locationId={{secrets.x}}&t={{config.y}}&c={{contact_id}}')) === '["contact_id"]');

  const urlParsed = extractIdentifiers({ args: { data: '{"market_url": "https://polymarket.com/event/x"}' } });
  check('market_url is treated as an identifier (row 125 keyed on it)',
    urlParsed.identifiers.some(i => i.name === 'market_url'));

  const badJson = extractIdentifiers({ args: { data: 'this is not json' } });
  check('unparseable data reports parseError and still shows the raw value',
    badJson.parseError === 'data is not valid JSON'
      && badJson.fields.some(f => f.value === 'this is not json'));

  const ghlParsed = extractIdentifiers({
    args: { contact_id: 'ocQHyuzHvysMo5N5VsXc', data: '{"firstName":"A"}' },
    path: '/contacts/{{contact_id}}',
  });
  check('GHL contact_id path identifier is extracted the same way',
    ghlParsed.identifiers.length === 1 && ghlParsed.identifiers[0].name === 'contact_id');

  // ── 2. The regression the incident is named for ──────────────
  // position_id LAST in the body, plus a long note: the old renderer cannot
  // show the id at any of its two cut points; the new one must.
  const idLastArgs = {
    data: JSON.stringify({
      exit_price: 0.863,
      exit_usdc: 17.86,
      exit_reason: 'manual close',
      note: 'Solana above 110 by end of August, closed by hand on Polymarket this evening after the take-profit alert fired',
      position_id: REAL_ID,
    }),
  };
  const oldText = oldRender({ id: 124, tool: CLOSE_TOOL, agent: 'charlie', riskLevel: 'medium', args: idLastArgs });
  check('PRECONDITION: the old renderer hides the id entirely when it is last',
    !oldText.includes(REAL_ID),
    'fixture is too small to force truncation — the test would prove nothing');

  const idLastSummary = buildApprovalSummary({
    agent: 'charlie', toolName: CLOSE_TOOL, toolArgs: idLastArgs,
    context: { httpMethod: 'POST', path: '/positions/manual-close', skill: 'trading-api' },
  });
  const idLastText = renderTelegramText({
    id: 124, tool: CLOSE_TOOL, agent: 'charlie', riskLevel: 'medium',
    summary: idLastSummary, detail: renderApprovalDetail(idLastSummary),
  });
  check('NEW: the id is present in full when it is last in the body',
    idLastText.includes(REAL_ID), idLastText);
  check('NEW: the id appears before the note it was buried behind',
    idLastText.indexOf(REAL_ID) < idLastText.indexOf('closed by hand on Polymarket'));

  // Field order must not change what the operator sees.
  const idFirstArgs = {
    data: JSON.stringify({
      position_id: REAL_ID,
      exit_price: 0.863,
      exit_usdc: 17.86,
      exit_reason: 'manual close',
      note: 'Solana above 110 by end of August, closed by hand on Polymarket this evening after the take-profit alert fired',
    }),
  };
  const idFirstSummary = buildApprovalSummary({
    agent: 'charlie', toolName: CLOSE_TOOL, toolArgs: idFirstArgs,
    context: { httpMethod: 'POST', path: '/positions/manual-close', skill: 'trading-api' },
  });
  const identLine = (t) => t.split('\n').find(l => l.includes('position_id ='));
  check('rendering is independent of the field order the model chose',
    identLine(renderApprovalDetail(idFirstSummary)) === identLine(renderApprovalDetail(idLastSummary)),
    `${identLine(renderApprovalDetail(idFirstSummary))} vs ${identLine(renderApprovalDetail(idLastSummary))}`);

  // ── 3. Identifiers survive a payload far past any cut ─────────
  const hugeArgs = {
    data: JSON.stringify({
      exit_price: 0.863,
      note: 'x'.repeat(4000),
      position_id: REAL_ID,
    }),
  };
  const hugeSummary = buildApprovalSummary({
    agent: 'charlie', toolName: CLOSE_TOOL, toolArgs: hugeArgs,
    context: { httpMethod: 'POST', path: '/positions/manual-close', skill: 'trading-api' },
  });
  const hugeText = renderTelegramText({
    id: 200, tool: CLOSE_TOOL, agent: 'charlie', riskLevel: 'medium',
    summary: hugeSummary, detail: renderApprovalDetail(hugeSummary),
  });
  check('4000-char note: identifier still shown in full',
    hugeText.includes(REAL_ID));
  check('4000-char note: message fits the Telegram limit',
    hugeText.length <= TELEGRAM_TEXT_LIMIT, `length ${hugeText.length}`);
  check('4000-char note: truncation is declared, not silent',
    /not shown|cut to fit/.test(hugeText), hugeText.slice(-200));
  check('4000-char note: the reply instruction survives',
    hugeText.includes('Reply ✅ 200'));

  // A hostile identifier cannot crowd the message out.
  const hostileSummary = buildApprovalSummary({
    agent: 'charlie', toolName: CLOSE_TOOL,
    toolArgs: { data: JSON.stringify({ position_id: 'z'.repeat(9000) }) },
    context: { httpMethod: 'POST', path: '/positions/manual-close', skill: 'trading-api' },
  });
  const hostileText = renderTelegramText({
    id: 201, tool: CLOSE_TOOL, agent: 'charlie', riskLevel: 'medium',
    summary: hostileSummary, detail: renderApprovalDetail(hostileSummary),
  });
  check('a 9000-char identifier is capped and the cap is declared',
    hostileText.includes(`identifier longer than ${MAX_IDENTIFIER_CHARS}`)
      && hostileText.length <= TELEGRAM_TEXT_LIMIT,
    `length ${hostileText.length}`);

  // ── 4. Absence is stated ─────────────────────────────────────
  const noIdSummary = buildApprovalSummary({
    agent: 'charlie', toolName: 'charlie__trading-api__trading-api__create_monitor_run',
    toolArgs: {}, context: { httpMethod: 'POST', path: '/monitor/run', skill: 'trading-api' },
  });
  check('no identifiers is printed explicitly, not left blank',
    renderApprovalDetail(noIdSummary).includes('Identifiers: none found'));

  // ── 5. Subject resolution ────────────────────────────────────
  __clearSubjectResolversForTests();
  const engineRow = {
    position: {
      id: REAL_ID, direction: 'YES', entry_price: 0.483, shares: 20.7,
      usdc_amount: 10.36, opened_at: '2026-08-27T12:15:30+00:00', status: 'open',
    },
    status: 'open',
    question: 'Will Solana reach $110 in August?',
    unresolved_alert_count: 1,
  };
  const fetchOk = async (url) => ({
    ok: true, status: 200, text: async () => JSON.stringify(engineRow), url,
  });
  registerSubjectResolver('trading-api', makeTradingApiPositionResolver({ fetchImpl: fetchOk }));

  const resolved = await resolveSubject({
    skill: 'trading-api', toolName: CLOSE_TOOL, identifiers: [{ name: 'position_id', value: REAL_ID, source: 'body' }],
    args: {}, baseUrl: 'http://localhost:4003',
  });
  check('subject names the market and the open/closed state',
    resolved.status === 'resolved'
      && resolved.lines[0].includes('Will Solana reach $110 in August?')
      && resolved.lines[0].includes('OPEN'),
    JSON.stringify(resolved.lines));
  check('subject reports the live alert count',
    resolved.lines[0].includes('1 live alert'));

  const fetch404 = async () => ({
    ok: false, status: 404,
    text: async () => JSON.stringify({ error: `no position with id ${COMPOSED_ID}` }),
  });
  registerSubjectResolver('trading-api', makeTradingApiPositionResolver({ fetchImpl: fetch404 }));
  const unresolvable = await resolveSubject({
    skill: 'trading-api', toolName: CLOSE_TOOL,
    identifiers: [{ name: 'position_id', value: COMPOSED_ID, source: 'body' }],
    args: {}, baseUrl: 'http://localhost:4003',
  });
  check('a composed id resolves to NOT FOUND, stated in the prompt',
    unresolvable.lines[0].includes('NOT FOUND'), JSON.stringify(unresolvable.lines));

  registerSubjectResolver('trading-api', async () => { throw new Error('engine down'); });
  const failedLookup = await resolveSubject({
    skill: 'trading-api', toolName: CLOSE_TOOL,
    identifiers: [{ name: 'position_id', value: REAL_ID, source: 'body' }],
    args: {}, baseUrl: 'http://localhost:4003',
  });
  check('a failed lookup is labelled, not rendered as a clean subject',
    failedLookup.status === 'failed' && failedLookup.lines[0].includes('subject lookup failed'),
    JSON.stringify(failedLookup));

  registerSubjectResolver('trading-api', () => new Promise(() => {}));
  const timedOut = await resolveSubject({
    skill: 'trading-api', toolName: CLOSE_TOOL,
    identifiers: [{ name: 'position_id', value: REAL_ID, source: 'body' }],
    args: {}, baseUrl: 'http://localhost:4003',
  }, { timeoutMs: 50 });
  check('a hanging resolver times out and is labelled',
    timedOut.status === 'failed' && timedOut.lines[0].includes('timed out'),
    JSON.stringify(timedOut));

  const noResolver = await resolveSubject({
    skill: 'ghl-fsc', toolName: 'charlie__ghl-fsc__ghl-fsc__update_contacts_id',
    identifiers: [{ name: 'contact_id', value: 'abc' }], args: {},
  });
  check('a skill with no resolver yields no_resolver, not an error',
    noResolver.status === 'no_resolver' && noResolver.lines.length === 0);

  // ── 6. End to end through the gate ───────────────────────────
  __clearSubjectResolversForTests();
  registerSubjectResolver('trading-api', makeTradingApiPositionResolver({ fetchImpl: fetchOk }));
  const approvals = new ExecApprovals({ _dir: dir });
  approvals.attach(null);
  const gate = new ApprovalGate(approvals);
  const notified = [];
  gate.setNotifier(async (payload) => { notified.push(payload); });

  const p = gate.requestApproval('charlie', CLOSE_TOOL, idLastArgs, 'medium', {
    httpMethod: 'POST', path: '/positions/manual-close', skill: 'trading-api',
    baseUrl: 'http://localhost:4003',
  });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  check('gate fired the notifier once', notified.length === 1, `got ${notified.length}`);
  check('notifier payload carries the structured summary',
    notified[0]?.summary?.identifiers?.[0]?.value === REAL_ID,
    JSON.stringify(notified[0]?.summary?.identifiers));
  check('stored detail contains the identifier in full',
    String(notified[0]?.detail || '').includes(REAL_ID));
  check('stored detail contains the resolved subject',
    String(notified[0]?.detail || '').includes('Will Solana reach $110 in August?'));
  check('action keeps its compact one-line shape for existing consumers',
    String(notified[0]?.action || '').startsWith(`${CLOSE_TOOL}(`)
      && !String(notified[0]?.action || '').includes('\n'),
    notified[0]?.action);

  const row = approvals.recent(1)[0];
  check('the approvals row stores the identifier-first detail',
    String(row?.detail || '').includes(REAL_ID) && String(row.detail).includes('Identifiers:'),
    String(row?.detail || '').slice(0, 200));

  approvals.approve(notified[0].id, 'tg:test');
  const result = await p;
  check('the approval still resolves through the normal path', result?.approved === true);

  // ── 7. The executor seam actually carries path/skill/baseUrl ─
  // Without this the gate is correct and unreachable: getSkillToolContext
  // could be unwired and every assertion above would still pass, because
  // they hand the context to requestApproval by hand.
  const seamRegistry = new ToolRegistry({}, {});
  const seamSkill = { name: 'trading-api', baseUrl: 'http://localhost:4003', headers: {} };
  seamRegistry.registerSkillTool('charlie', 'trading-api', seamSkill, {
    name: 'trading-api__create_positions_manual_close',
    method: 'POST',
    path: '/positions/manual-close',
    description: 'close',
    inputSchema: { type: 'object', properties: {} },
  });
  seamRegistry.registerSkillTool('charlie', 'trading-api', seamSkill, {
    name: 'trading-api__create_positions_id_hold',
    method: 'POST',
    path: '/positions/{{position_id}}/hold',
    description: 'hold',
    inputSchema: { type: 'object', properties: {} },
  });
  seamRegistry.registerBuiltin('read_file', { description: 'r', fn: async () => 'ok', scope: 'shared' });
  // A non-skill API preset. This one lives in _apiTools alongside the skill
  // tools, so it is the case that actually exercises the `skill:` prefix
  // discriminator; a builtin is filtered out one line earlier by the
  // entry lookup and proves nothing about it.
  seamRegistry._apiTools.set('NewsAPI__get_headlines', {
    preset: { name: 'NewsAPI', type: 'api', baseUrl: 'https://newsapi.org/v2' },
    toolDef: { name: 'get_headlines', method: 'GET', path: '/top-headlines' },
    scope: 'shared',
  });
  // A preset whose display name merely CONTAINS "skill", lower-case and NOT
  // at the start. The contract is a `skill:` PREFIX (registerSkillTool builds
  // it), and only a fixture like this can tell a prefix test from a substring
  // test: with NewsAPI alone, startsWith('skill:') and includes('skill')
  // agree on every input. Case matters too — a capitalised "Skillshare" is
  // still invisible to includes('skill'), so the probe must be lower-case.
  seamRegistry._apiTools.set('Courses__get_courses', {
    preset: { name: 'courses via skillshare', type: 'api', baseUrl: 'https://api.skillshare.invalid' },
    toolDef: { name: 'get_courses', method: 'GET', path: '/courses' },
    scope: 'shared',
  });

  const ctx = seamRegistry.getSkillToolContext('charlie__trading-api__trading-api__create_positions_manual_close');
  check('registry exposes path, skill and baseUrl for a skill tool',
    ctx.path === '/positions/manual-close' && ctx.skill === 'trading-api'
      && ctx.baseUrl === 'http://localhost:4003',
    JSON.stringify(ctx));
  check('registry returns {} for a builtin (not in _apiTools at all)',
    JSON.stringify(seamRegistry.getSkillToolContext('read_file')) === '{}');
  check('registry returns {} for a NON-SKILL preset that does live in _apiTools',
    JSON.stringify(seamRegistry.getSkillToolContext('NewsAPI__get_headlines')) === '{}',
    JSON.stringify(seamRegistry.getSkillToolContext('NewsAPI__get_headlines')));
  check('registry returns {} for an unknown tool name',
    JSON.stringify(seamRegistry.getSkillToolContext('does__not__exist')) === '{}');
  check('registry returns {} for a preset merely NAMED like a skill (prefix, not substring)',
    JSON.stringify(seamRegistry.getSkillToolContext('Courses__get_courses')) === '{}',
    JSON.stringify(seamRegistry.getSkillToolContext('Courses__get_courses')));

  const seamApprovals = new ExecApprovals({ _dir: dir });
  seamApprovals.attach(null);
  const seamGate = new ApprovalGate(seamApprovals);
  let seenContext = null;
  seamGate.requestApproval = async (agent, toolName, toolArgs, riskLevel, context) => {
    seenContext = context;
    return { approved: false, reason: 'denied-by-test' };
  };
  const seamExecutor = new ToolExecutor({ primary: { provider: 'anthropic', model: 't' } },
    seamRegistry, { approvalGate: seamGate });
  let seamTurn = 0;
  seamExecutor._completionWithTools = async () => {
    seamTurn++;
    if (seamTurn === 1) {
      return {
        content: '',
        toolCalls: [{
          id: 't1',
          name: 'charlie__trading-api__trading-api__create_positions_manual_close',
          args: { data: JSON.stringify({ position_id: REAL_ID, exit_price: 0.863 }) },
        }],
        usage: {}, model: 't',
      };
    }
    return { content: 'done', toolCalls: [], usage: {}, model: 't' };
  };
  seamExecutor._appendAnthropicToolLoop = (msgs) => msgs;
  await seamExecutor.run([{ role: 'user', content: 'close it' }], {});

  check('executor passes the endpoint path through to requestApproval',
    seenContext?.path === '/positions/manual-close', JSON.stringify(seenContext));
  check('executor passes the owning skill through to requestApproval',
    seenContext?.skill === 'trading-api', JSON.stringify(seenContext));
  check('executor passes the base URL through, so the subject can be resolved',
    seenContext?.baseUrl === 'http://localhost:4003', JSON.stringify(seenContext));
  check('executor still passes httpMethod (existing gate behaviour intact)',
    seenContext?.httpMethod === 'POST', JSON.stringify(seenContext));

  // ── 8. shell_exec keeps its own detail (no summary) ──────────
  const shellNotified = [];
  const gate2 = new ApprovalGate(approvals);
  gate2.setNotifier(async (payload) => { shellNotified.push(payload); });
  const p2 = gate2.requestInlineApproval({
    agent: 'charlie', tool: 'shell_exec', action: 'rm -rf /tmp/x',
    detail: 'Agent charlie wants to run: rm -rf /tmp/x', riskLevel: 'high',
  });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  check('inline callers without a summary still notify',
    shellNotified.length === 1 && shellNotified[0].summary === null,
    JSON.stringify(shellNotified[0]?.summary));
  const shellText = renderTelegramText({
    id: shellNotified[0].id, tool: 'shell_exec', agent: 'charlie',
    riskLevel: 'high', summary: null, detail: shellNotified[0].detail,
  });
  check('a summary-less prompt still renders the command and the reply line',
    shellText.includes('rm -rf /tmp/x') && shellText.includes('Reply ✅'));
  approvals.deny(shellNotified[0].id, 'tg:test', 'no');
  await p2;

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
