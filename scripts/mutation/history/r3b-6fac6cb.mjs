// #184 mutation round three, the two re-targeted mutants plus one, AS RUN.
// Target: QClaw 6fac6cb. Result: 3 mutants, all killed.
export const tests = ['tests/identifier-index.test.js', 'tests/cli-skill-list.test.js', 'tests/skill-diagnostics.test.js', 'tests/approval-summary.test.js', 'tests/approval-gate.test.js', 'tests/skill-write-timeout.test.js'];

const P = 'src/agents/skill-parser.js', D = 'src/agents/skill-diagnostics.js';
export const mutants = [
  ['M16 parser endpoint line off by one', P, "skill.endpoints.push({ ...parseEndpointLine(text), line });", "skill.endpoints.push({ ...parseEndpointLine(text), line: line - 1 });"],
  ['M16b section line numbers off by one', P, "if (inside) out.push({ line: i + 1, text: t });", "if (inside) out.push({ line: i, text: t });"],
  ['N6 empty agent prints a countdown', D, "  if (skills === 0) return { unclassified, writes, invalid, broken, incomplete, lines };\n", ""],
];
export default mutants;
