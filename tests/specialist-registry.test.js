/**
 * Slice 6b Unit 1 — specialist registry parser tests.
 * Run: node tests/specialist-registry.test.js
 *
 * Covers: parses 15 active + 3 deferred from the real FLOW_OS_SPECIALISTS.md,
 * status fidelity, businessUnit mapping, getSpecialist null for unknown,
 * isStub/isLive polarity, throws-with-clear-message on missing file.
 */

import {
  loadSpecialistRegistry, getSpecialist, listSpecialists, _resetCache,
} from '../src/agents/specialist-registry.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };

const REAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'FLOW_OS_SPECIALISTS.md');

console.log('parse the real registry:');
_resetCache();
const map = loadSpecialistRegistry(REAL);
const all = [...map.values()];
const active = all.filter(s => s.status !== 'deferred');
const deferred = all.filter(s => s.status === 'deferred');
check('parses 18 total (15 active + 3 deferred)', all.length === 18, `got ${all.length}`);
check('15 active specialists', active.length === 15, `got ${active.length}`);
check('3 deferred specialists', deferred.length === 3, `got ${deferred.length}`);
check('every entry has a kebab id', all.every(s => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.id)));
check('agentName === id (scope principal)', all.every(s => s.agentName === s.id));
check('every status is in the enum', all.every(s => ['live', 'scaffolded', 'deferred'].includes(s.status)));

console.log('status fidelity (verbatim from file):');
check('content-studio-operator is live', getSpecialist('content-studio-operator')?.status === 'live');
check('community-manager-fsc is live', getSpecialist('community-manager-fsc')?.status === 'live');
check('build-specialist is scaffolded', getSpecialist('build-specialist')?.status === 'scaffolded');
check('ad-agency-operator is scaffolded', getSpecialist('ad-agency-operator')?.status === 'scaffolded');
check('file marks 5 entries live (QA, GHL Support Bot, Content Studio, CM-FSC, Trading)',
  active.filter(s => s.status === 'live').length === 5,
  `got ${active.filter(s => s.status === 'live').length}`);

console.log('businessUnit mapping:');
check('content-studio-operator → fsc (Flow States Collective)', getSpecialist('content-studio-operator')?.businessUnit === 'fsc');
check('build-specialist → flow_os', getSpecialist('build-specialist')?.businessUnit === 'flow_os');
check('trading-operator → personal (strips parenthetical)', getSpecialist('trading-operator')?.businessUnit === 'personal');
check('ad-agency-operator → shared (strips parenthetical)', getSpecialist('ad-agency-operator')?.businessUnit === 'shared');
check('sproutcode-operator → sproutcode', getSpecialist('sproutcode-operator')?.businessUnit === 'sproutcode');
check('crete-marketing-operator → crete', getSpecialist('crete-marketing-operator')?.businessUnit === 'crete');

console.log('skills derivation (provisional, 6c/6d wires real):');
// Slice 6c: every entry now also carries the universal 'specialist-observation' skill.
check('content-studio-operator → ["content-studio","specialist-observation"]', JSON.stringify(getSpecialist('content-studio-operator')?.skills) === '["content-studio","specialist-observation"]');
check('every specialist carries specialist-observation', listSpecialists().every(s => s.skills.includes('specialist-observation')));

console.log('getSpecialist lookups:');
check('by display name resolves', getSpecialist('Content Studio Operator')?.id === 'content-studio-operator');
check('unknown name → null', getSpecialist('nonexistent-specialist') === null);
check('empty name → null', getSpecialist('') === null);
check('null name → null', getSpecialist(null) === null);

console.log('isStub / isLive polarity:');
check('live → isLive true, isStub false', (() => { const s = getSpecialist('content-studio-operator'); return s.isLive === true && s.isStub === false; })());
check('scaffolded → isStub true, isLive false', (() => { const s = getSpecialist('build-specialist'); return s.isStub === true && s.isLive === false; })());
check('deferred → isStub true, isLive false', deferred.every(s => s.isStub === true && s.isLive === false));
check('deferred entries have status deferred', deferred.every(s => s.status === 'deferred'));
check('a known deferred entry present (stripe-operator)', !!getSpecialist('stripe-operator') && getSpecialist('stripe-operator').status === 'deferred');

console.log('listSpecialists:');
check('listSpecialists returns all 18', listSpecialists().length === 18);

console.log('error handling:');
let threw = false, msg = '';
try { _resetCache(); loadSpecialistRegistry('/no/such/file/FLOW_OS_SPECIALISTS.md'); }
catch (e) { threw = true; msg = e.message; }
check('throws on missing file', threw);
check('error message names the path + is clear', /cannot read specialist registry/.test(msg) && /no\/such\/file/.test(msg), msg);

// restore cache for any later consumer in the same process
_resetCache(); loadSpecialistRegistry(REAL);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
