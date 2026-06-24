/**
 * Slice 6c — specialist Agent wiring tests.
 * Run: node tests/specialist-agent.test.js
 *
 * Unit 1: Agent metadata fields + Agent.createSpecialist lightweight factory.
 * (Unit 2 register()/has() and Unit 4 conflict-skip smoke appended in those units.)
 */

import { Agent, AgentRegistry } from '../src/agents/registry.js';

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };
function throws(fn) { try { fn(); return null; } catch (e) { return e; } }

const services = {}; // createSpecialist must not touch services or disk

// SpecialistEntry fakes (shape per specialist-registry.js buildEntry()).
const STUB = { agentName: 'build-specialist', businessUnit: 'flow_os', status: 'scaffolded', isLive: false, isStub: true };
const DEFERRED = { agentName: 'crete-ops-specialist', businessUnit: 'crete', status: 'deferred', isLive: false, isStub: true };
const LIVE = { agentName: 'content-studio-operator', businessUnit: 'flow_os', status: 'live', isLive: true, isStub: false };

console.log('Unit 1 — Agent.createSpecialist');
{
  const stub = Agent.createSpecialist(STUB, services);
  check('stub: status = stub', stub.status === 'stub', stub.status);
  check('stub: businessUnit carried through', stub.businessUnit === 'flow_os', stub.businessUnit);
  check('stub: name = agentName', stub.name === 'build-specialist', stub.name);

  const deferred = Agent.createSpecialist(DEFERRED, services);
  check('deferred: status = deferred', deferred.status === 'deferred', deferred.status);

  const live = Agent.createSpecialist(LIVE, services);
  check('live: status = live', live.status === 'live', live.status);

  check('isSpecialist is true', stub.isSpecialist === true);
  check('skills is [] (not null/undefined)', Array.isArray(stub.skills) && stub.skills.length === 0);
  check('aid is null (no aid.json loaded)', stub.aid === null);
  check('dir is null (no workspace dir)', stub.dir === null);
  check('soul is empty (no SOUL.md read)', stub.soul === '');
}

console.log('Unit 1 — regression: disk-backed Agent unaffected');
{
  const echo = new Agent('echo', '/some/workspace/echo', services);
  check('disk agent: status defaults null', echo.status === null);
  check('disk agent: businessUnit defaults null', echo.businessUnit === null);
  check('disk agent: isSpecialist defaults false', echo.isSpecialist === false);
  check('disk agent: dir preserved', echo.dir === '/some/workspace/echo');
  check('disk agent: skills [] (load not auto-called)', Array.isArray(echo.skills) && echo.skills.length === 0);
}

console.log('Unit 2 — AgentRegistry.register() / has()');
{
  // Minimal config so the defaultName getter doesn't throw.
  const reg = new AgentRegistry({ agent: { name: 'qclaw' } }, services);
  const spec = Agent.createSpecialist(STUB, services);

  check('has() false before register', reg.has('build-specialist') === false);
  const ret = reg.register(spec);
  check('register returns the agent', ret === spec);
  check('register adds to list()', reg.list().includes('build-specialist'));
  check('has() true after register', reg.has('build-specialist') === true);
  check('get() returns the specialist (not the charlie fallback)', reg.get('build-specialist') === spec);

  const dupErr = throws(() => reg.register(Agent.createSpecialist(STUB, services)));
  check('register throws on duplicate name', !!dupErr && /already registered/.test(dupErr.message), dupErr?.message);
  check('has() false for unknown name', reg.has('nope-specialist') === false);
}

console.log('Unit 4 — boot conflict-skip logic (has()-guard before register)');
{
  // Mirror the index.js boot loop: a specialist whose agentName collides with
  // an existing agent must be skipped, never overwriting charlie/echo.
  const reg = new AgentRegistry({ agent: { name: 'qclaw' } }, services);
  reg.register(new Agent('charlie', '/ws/charlie', services)); // stands in for loadAll's charlie

  const entries = [
    { agentName: 'charlie', businessUnit: 'flow_os', status: 'live', isLive: true, isStub: false }, // collides
    { agentName: 'qa-operator', businessUnit: 'flow_os', status: 'scaffolded', isLive: false, isStub: true },
  ];
  let registered = 0, skipped = 0;
  for (const entry of entries) {
    if (reg.has(entry.agentName)) { skipped++; continue; }
    reg.register(Agent.createSpecialist(entry, services));
    registered++;
  }
  check('collision with existing agent skipped', skipped === 1);
  check('non-colliding specialist registered', registered === 1 && reg.has('qa-operator'));
  check('existing charlie not overwritten', reg.get('charlie').isSpecialist === false);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
