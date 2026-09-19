// #184 mutation round three, AS RUN. Target: QClaw 6fac6cb.
// Result recorded in #184: of 78, 76 killed and 2 NOT APPLIED (M16 and N6:
// their target code had been rewritten). Those two were re-targeted in
// r3b-6fac6cb.mjs and killed, giving 79 applied, 79 killed.
export const tests = ['tests/identifier-index.test.js', 'tests/cli-skill-list.test.js', 'tests/skill-diagnostics.test.js', 'tests/approval-summary.test.js', 'tests/approval-gate.test.js', 'tests/skill-write-timeout.test.js'];

import { mutants as round2 } from './r2-f41612d.mjs';
const P = 'src/agents/skill-parser.js', D = 'src/agents/skill-diagnostics.js', A = 'src/agents/registry.js';
// Round two's mutants of the heuristic detector are dropped: the detector is gone.
const dropped = ['N1 ', 'N2 ', 'N3 ', 'N4 ', 'N5 ', 'N16 '];
const kept = round2.filter(([label]) => !dropped.some((d) => label.startsWith(d)));
export const mutants = [
  ...kept,
  ['G1 separator back to \\s*-\\s*', P, "(\\/\\S*)\\s+-\\s+(.+)/i;", "(\\/\\S*)\\s*-\\s*(.+)/i;"],
  ['G2 no whitespace needed after the hyphen', P, "(\\/\\S*)\\s+-\\s+(.+)/i;", "(\\/\\S*)\\s+-\\s*(.+)/i;"],
  ['G3 no whitespace needed before the hyphen', P, "(\\/\\S*)\\s+-\\s+(.+)/i;", "(\\/\\S*)\\s*-\\s+(.+)/i;"],
  ['S1 invalid lines read as blank', P, "return parseEndpointLine(t) ? 'endpoint' : 'invalid';", "return parseEndpointLine(t) ? 'endpoint' : 'blank';"],
  ['S2 blank lines read as invalid', P, "if (!t) return 'blank';", "if (!t) return 'invalid';"],
  ['S3 section never ends at another heading (#183 back)', P, "if (/^##\\s/.test(t)) { inside = /^##\\s+Endpoints\\b/.test(t); continue; }", "if (/^##\\s+Endpoints\\b/.test(t)) { inside = true; continue; }"],
  ['S4 CLI counts every non-blank line', P, ".filter((l) => classifyEndpointsLine(l.text) === 'endpoint').length;", ".filter((l) => classifyEndpointsLine(l.text) !== 'blank').length;"],
  ['S5 parser does not record invalid lines', P, "else if (kind === 'invalid') skill.invalidEndpointLines.push({ line, text });", "else if (false) skill.invalidEndpointLines.push({ line, text });"],
  ['S6 invalid line number off by one', P, "skill.invalidEndpointLines.push({ line, text });", "skill.invalidEndpointLines.push({ line: line - 1, text });"],
  ['S7 invalid lines not counted', D, "invalid: (parsed.invalidEndpointLines || []).length,", "invalid: 0,"],
  ['B1 broken skills skipped by the countdown', D, "    if (!r.ok) {", "    if (false) {"],
  ['B2 broken skills do not make it INCOMPLETE', D, "const incomplete = invalid > 0 || broken > 0;", "const incomplete = invalid > 0;"],
  ['B3 INCOMPLETE line carries a count', D, "No count of writes is given until they are fixed.", "Of the rest, ${unclassified} of ${writes} skill writes unclassified."],
  ['B4 INCOMPLETE never printed', D, "  if (incomplete) {", "  if (false) {"],
  ['T1 date is a constant', D, "const at = now.toISOString().replace(/\\.\\d{3}Z$/, 'Z');", "const at = '2026-09-18T00:00:00Z';"],
  ['T2 date dropped from the line', D, "const prefix = `identifier gate countdown${label} at ${at}: `;", "const prefix = `identifier gate countdown${label}: `;"],
  ['T3 the given time is ignored', D, "const at = now.toISOString().replace(/\\.\\d{3}Z$/, 'Z');", "const at = new Date(Date.now() - 3600000).toISOString().replace(/\\.\\d{3}Z$/, 'Z');"],
  ['K19 unclassified not summed', D, "    unclassified += c.unclassified;", "    unclassified = c.unclassified;"],
  ['K19b writes not summed', D, "    writes += c.writes;", "    writes = c.writes;"],
  ['K20 invalid lines not summed', D, "    invalid += c.invalid;", "    invalid = c.invalid;"],
  ['K17 boot counts the first skill only', A, "const report = inspectSkills(this.skills, this.services.secrets);", "const report = inspectSkills(this.skills.slice(0, 1), this.services.secrets);"],
  ['K1 countdown always logs as info', A, "const logCountdown = countdown.unclassified > 0 || countdown.incomplete ? log.warn : log.info;", "const logCountdown = log.info;"],
  ['K1b INCOMPLETE logs as info', A, "const logCountdown = countdown.unclassified > 0 || countdown.incomplete ? log.warn : log.info;", "const logCountdown = countdown.unclassified > 0 ? log.warn : log.info;"],
  ['K2 label hardcoded to charlie', A, "formatCountdown(report, this.name)", "formatCountdown(report, 'charlie')"],
  ['K3 boot prints only the total', A, "for (const line of countdown.lines) logCountdown(line);", "for (const line of countdown.lines.slice(-1)) logCountdown(line);"],
  ['K6 INCOMPLETE suppressed when writes are unclassified', D, "const incomplete = invalid > 0 || broken > 0;", "const incomplete = (invalid > 0 || broken > 0) && unclassified === 0;"],
  ['K14 a bracket containing a level word reads as it (gate)', D, "  return ENDPOINT_LEVELS.includes(token) ? token : 'unclassified';", "  return ENDPOINT_LEVELS.find((l) => token.includes(l)) ?? 'unclassified';"],
  ['K14b a bracket containing a level word reads as it (parser)', P, "level: candidate !== null && ENDPOINT_LEVELS.includes(candidate) ? candidate : null,", "level: ENDPOINT_LEVELS.find((l) => candidate?.includes(l)) ?? null,"],
];
export default mutants;
