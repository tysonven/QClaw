/**
 * A skill that declares an HTTP surface and registers nothing must say so.
 *
 * Four skill files presented as HTTP surfaces and registered zero tools, on
 * every boot since the day each was created. Verified against the live
 * tool-call.log on 2026-09-10, where ten skills register and these never
 * appear. The services behind three of them were live the whole time: four
 * n8n webhooks answering, and clipper-worker serving 200 on :4002.
 *
 * `parseSkill` returns null and nothing reported it.
 *
 * These tests use the REAL skill files as fixtures, not hand-written strings,
 * because a hand-written fixture proves the diagnostic can explain a file I
 * wrote to be explained. The real files are the ones that fooled everybody.
 *
 * The prose-only skills matter as much as the broken ones: a diagnostic that
 * shouts about `identity.md` gets muted, and a muted diagnostic is the
 * original defect wearing a hat.
 *
 * Run: node tests/skill-diagnostics.test.js
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  declaresHttpSurface,
  diagnose,
  inspectSkills,
  formatReport,
} from '../src/agents/skill-diagnostics.js';

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agents', 'skills');

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

const read = (n) => readFileSync(join(SKILLS, `${n}.md`), 'utf8');
const skill = (n) => ({ name: n, content: read(n), filename: `${n}.md` });

function main() {
  // ── 1. The signal is derived, and it separates the two groups ──
  //
  // Broken-but-intending on one side, legitimately prose-only on the other.
  for (const n of ['ads-agency', 'content-studio', 'clipper', 'trading-api', 'ghl-fsc', 'stripe']) {
    const { intends, signals } = declaresHttpSurface(read(n));
    check(`${n}: recognised as declaring an HTTP surface`, intends === true, JSON.stringify(signals));
  }
  for (const n of ['identity', 'build', 'lanes', 'delegation', 'security', 'task-queue', 'business-intelligence']) {
    check(`${n}: correctly NOT treated as an HTTP surface`,
      declaresHttpSurface(read(n)).intends === false,
      JSON.stringify(declaresHttpSurface(read(n)).signals));
  }

  // task-queue is the one that could plausibly be misread. It has a
  // `POST /rest/v1/charlie_tasks` line, but under "Creating Tasks
  // Programmatically", and the file is surface: prompt. It was routed 9 times
  // as prompt content in the live log, which is it working.
  check('task-queue has a POST line and is still not an HTTP surface',
    read('task-queue').includes('POST /rest/v1/charlie_tasks')
      && declaresHttpSurface(read('task-queue')).intends === false);

  // business-intelligence is the other near-miss, and it caught a real flaw in
  // an earlier version of this heuristic. Its permission line reads
  // "http: Inherited from Echo's skills (GHL, Stripe, n8n)", a sentence rather
  // than a host list, and treating any non-"none" value as a signal reported a
  // healthy prompt-only skill as broken.
  check('business-intelligence: a prose http permission is not a host list',
    read('business-intelligence').includes("Inherited from Echo's skills")
      && declaresHttpSurface(read('business-intelligence')).intends === false,
    JSON.stringify(declaresHttpSurface(read('business-intelligence')).signals));
  check('a real host list IS still a signal, so the tightening did not gut it',
    declaresHttpSurface('- http: [services.leadconnectorhq.com]').intends === true
      && declaresHttpSurface('- http: [localhost:4003]').intends === true);
  check('http: none is still not a signal',
    declaresHttpSurface('- http: none').intends === false);

  // ── 2. Every real skill file is classified, none crash ──
  const all = readdirSync(SKILLS).filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: f.replace(/\.md$/, ''), content: readFileSync(join(SKILLS, f), 'utf8'), filename: f }));
  let threw = null;
  let report;
  try { report = inspectSkills(all, null); } catch (e) { threw = e; }
  check('inspectSkills survives every real skill file', threw === null, String(threw));

  const brokenNames = report.broken.map((r) => r.name).sort();
  check('exactly the three known-broken skills are reported',
    JSON.stringify(brokenNames) === JSON.stringify(['ads-agency', 'clipper', 'content-studio']),
    JSON.stringify(brokenNames));

  const okNames = report.rows.filter((r) => r.ok).map((r) => r.name).sort();
  check('the ten working HTTP skills are reported healthy',
    okNames.length >= 8 && okNames.includes('trading-api') && okNames.includes('ghl-fsc')
      && okNames.includes('stripe') && okNames.includes('n8n-router'),
    JSON.stringify(okNames));

  check('no prose-only skill appears in the report at all',
    !report.rows.some((r) => ['identity', 'build', 'lanes', 'task-queue', 'security'].includes(r.name)),
    JSON.stringify(report.rows.map((r) => r.name)));

  // ── 3. The cause is specific and actionable, per file ──
  //
  // Pinned per skill because a diagnostic that says "failed to parse" for all
  // three is the same as no diagnostic. The three causes are different.
  const ads = diagnose(read('ads-agency'));
  check('ads-agency: names the Base URL section placement as the cause',
    /Base URL/.test(ads.reason) && /## Auth/.test(ads.reason), ads.reason);
  check('ads-agency: reports the line number of the Base URL',
    ads.line === 14, `got ${ads.line}`);
  check('ads-agency: hint says to move it under ## Auth',
    /## Auth/.test(ads.hint), ads.hint);

  const cs = diagnose(read('content-studio'));
  check('content-studio: same cause, its own line number',
    /Base URL/.test(cs.reason) && cs.line === 21, `${cs.reason} line ${cs.line}`);

  const clip = diagnose(read('clipper'));
  check('clipper: names the missing Base URL, which it hits first',
    /no "Base URL:" line/.test(clip.reason), clip.reason);

  // clipper has a second, independent defect: em-dash endpoint lines. Once the
  // base URL is supplied, that is what it fails on. A fix for one is not a fix
  // for the other, and the diagnostic must say so at each stage.
  const clipWithBase = read('clipper').replace('## Service', '## Auth\nBase URL: http://localhost:4002\n\n## Service');
  const clip2 = diagnose(clipWithBase);
  check('clipper: with a Base URL added, the em dash becomes the reported cause',
    /dash/.test(clip2.reason), clip2.reason);
  check('clipper: the em-dash hint names the hyphen-minus fix',
    /hyphen/.test(clip2.hint), clip2.hint);
  check('clipper: reports the line of the first offending endpoint',
    typeof clip2.line === 'number' && clip2.line > 0, `got ${clip2.line}`);

  // ── 4. Fixing a file really does clear it ──
  //
  // The mutation-proof direction: not "the diagnostic fires", but "it stops
  // firing for the right reason". A check that only ever sees red cannot tell
  // a working diagnostic from a stuck one.
  const adsFixed = read('ads-agency').replace(
    '## Endpoints\nBase URL: https://webhook.flowos.tech',
    '## Auth\nBase URL: https://webhook.flowos.tech\n\n## Endpoints'
  );
  check('PRECONDITION: the ads-agency fix actually changed the file',
    adsFixed !== read('ads-agency'));
  const fixedReport = inspectSkills([{ name: 'ads-agency', content: adsFixed, filename: 'ads-agency.md' }], null);
  check('ads-agency: moving Base URL under ## Auth clears the error',
    fixedReport.broken.length === 0, JSON.stringify(fixedReport.broken.map((b) => b.reason)));
  check('ads-agency: and it then registers its four webhook tools',
    fixedReport.rows[0]?.tools === 4, `got ${fixedReport.rows[0]?.tools}`);

  // ── 5. Unresolvable path identifiers ──
  //
  // This once conflated two things in one assertion against the live
  // trading-api.md, and it broke the moment that file changed: #142 added
  // GET /positions/{{position_id}}, so position_id started resolving and the
  // "it is unresolvable" assertion, which read the live file, flipped. That is
  // the same defect this whole suite exists to catch (a fixture that reads real
  // estate a later edit can move), so the two things are now separate.
  //
  //  - CAPABILITY: the diagnostic detects a write path identifier with no GET
  //    ending at it. Proved against a SYNTHETIC skill nothing in the estate can
  //    change. This is the assertion worth keeping forever.
  //  - LIVE FILE: what is true of trading-api.md right now. Expected to move as
  //    endpoints are added or removed; when it does, fix THIS assertion only and
  //    leave the capability one above untouched.

  // CAPABILITY (estate-immune): a made-up skill whose write path parameter has
  // no GET ending at it. widget_id can never be resolved, no matter what any
  // real skill file grows to.
  const synthUnresolvable = [
    '## Auth',
    'Base URL: https://example.test',
    '',
    '## Endpoints',
    'POST /widgets/{{widget_id}}/close - close one widget by id',
    'GET /widgets/alerts - list alerts; note this GET does NOT end at widget_id',
  ].join('\n');
  const synth = inspectSkills([{ name: 'synth-api', content: synthUnresolvable, filename: 'synth-api.md' }], null);
  check('CAPABILITY: a write path id with no GET ending at it is flagged unresolvable',
    synth.rows[0]?.unresolvedParams.some((u) => u.param === 'widget_id'),
    JSON.stringify(synth.rows[0]?.unresolvedParams));
  check('CAPABILITY: the report explains the unresolvable id in words, not a code',
    formatReport(synth).some((l) => l.includes('widget_id') && l.includes('cannot be resolved before approval')),
    JSON.stringify(formatReport(synth).filter((l) => l.includes('widget_id'))));

  // LIVE FILE: trading-api.md now RESOLVES position_id, because it declares
  // GET /positions/{{position_id}} (added in #142, the 404-on-non-id resolver).
  // This reflects the current endpoints and is EXPECTED to change. If a future
  // edit removes that GET, this flips; fix it here. The capability above does
  // not move, because it never reads a file the estate can edit.
  const tradingRow = report.rows.find((r) => r.name === 'trading-api');
  check('LIVE trading-api.md: position_id resolves (GET /positions/{{position_id}} present)',
    tradingRow && !tradingRow.unresolvedParams.some((u) => u.param === 'position_id'),
    JSON.stringify(tradingRow?.unresolvedParams));

  const ghlRow = report.rows.find((r) => r.name === 'ghl-fsc');
  check('ghl-fsc: contact_id resolves, so nothing is reported',
    ghlRow?.unresolvedParams.length === 0, JSON.stringify(ghlRow?.unresolvedParams));

  // ── 6. The boot output ──
  const lines = formatReport(report);
  check('report names each broken skill and its file',
    ['ads-agency', 'content-studio', 'clipper'].every((n) => lines.some((l) => l.includes(`"${n}"`))),
    JSON.stringify(lines.slice(0, 2)));
  check('report includes a file:line for ads-agency',
    lines.some((l) => l.includes('ads-agency.md:14')),
    JSON.stringify(lines.find((l) => l.includes('ads-agency'))));
  check('report says what looked like an HTTP skill',
    lines.some((l) => l.includes('it looked like an HTTP skill because of')));
  // position_id resolves in the live trading-api.md now (GET present, #142), so
  // the real report must NOT flag it. The words-not-code formatting of an
  // unresolvable id is proved in section 5 on the synthetic fixture, where no
  // endpoint edit can move it.
  check('report does NOT flag position_id now that the live file resolves it',
    !lines.some((l) => l.includes('position_id') && l.includes('cannot be resolved before approval')),
    JSON.stringify(lines.filter((l) => l.includes('position_id'))));

  const clean = formatReport(inspectSkills([skill('ghl-fsc')], null));
  check('a healthy estate produces NO output, so the diagnostic stays loud',
    clean.length === 0, JSON.stringify(clean));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

if (!existsSync(SKILLS)) {
  console.error(`skills dir missing at ${SKILLS}`);
  process.exit(1);
}
main();
