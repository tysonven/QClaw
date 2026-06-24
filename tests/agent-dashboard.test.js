/**
 * Slice 6c Unit 5 — /api/agents specialist-metadata tests.
 * Run: node tests/agent-dashboard.test.js
 *
 * Exercises the REAL GET /api/agents handler (no HTTP server): inject a
 * route-capturing fake app, run _setupAPI(), invoke the captured handler with
 * a fake req/res. Asserts status/businessUnit/isSpecialist surface for a
 * specialist and are null/false for a normal agent.
 *
 * Frontend (ui.html badges) is a visual change — noted in the build log, no
 * automated test (per brief).
 */

import { DashboardServer } from '../src/dashboard/server.js';
import { Agent, AgentRegistry } from '../src/agents/registry.js';

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };

// Route-capturing fake express app — records the last handler per "METHOD path".
function fakeApp() {
  const routes = {};
  const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'use', 'options', 'head', 'all'];
  return new Proxy({ routes }, {
    get(t, prop) {
      if (prop === 'routes') return t.routes;
      if (httpMethods.includes(prop)) {
        return (path, ...handlers) => {
          if (typeof path === 'string' && handlers.length) routes[`${prop} ${path}`] = handlers[handlers.length - 1];
        };
      }
      return () => {}; // tolerate any other app.* call during setup
    },
  });
}

// Fake qclaw with just what /api/agents touches.
const reg = new AgentRegistry({ agent: { name: 'qclaw' } }, {});
reg.register(new Agent('charlie', '/ws/charlie', {}));
reg.register(Agent.createSpecialist(
  { agentName: 'qa-operator', businessUnit: 'flow_os', status: 'live', isLive: true, isStub: false }, {}
));
reg.register(Agent.createSpecialist(
  { agentName: 'lead-handler-flow-os', businessUnit: 'flow_os', status: 'scaffolded', isLive: false, isStub: true }, {}
));

const qclaw = {
  config: { models: { primary: { model: 'claude-haiku-4-5', provider: 'anthropic' } } },
  agents: reg,
  memory: { getThreads: () => [] },
};

console.log('Unit 5 — /api/agents specialist metadata');
const server = new DashboardServer(qclaw);
server.app = fakeApp();
server._setupAPI();

const handler = server.app.routes['get /api/agents'];
check('GET /api/agents handler registered', typeof handler === 'function');

let body;
handler({}, { json: (x) => { body = x; }, status: () => ({ json: () => {} }) });
check('handler returns an array', Array.isArray(body), typeof body);

const qa = body.find(a => a.name === 'qa-operator');
const lead = body.find(a => a.name === 'lead-handler-flow-os');
const charlie = body.find(a => a.name === 'charlie');

check('specialist: status surfaced', qa && qa.status === 'live', qa?.status);
check('specialist: businessUnit surfaced', qa && qa.businessUnit === 'flow_os', qa?.businessUnit);
check('specialist: isSpecialist true', qa && qa.isSpecialist === true);
check('stub specialist: status = stub', lead && lead.status === 'stub', lead?.status);

check('non-specialist charlie: status null', charlie && charlie.status === null, String(charlie?.status));
check('non-specialist charlie: businessUnit null', charlie && charlie.businessUnit === null, String(charlie?.businessUnit));
check('non-specialist charlie: isSpecialist false', charlie && charlie.isSpecialist === false);
check('existing fields intact (model/provider/threads/messages)',
  charlie && charlie.model === 'claude-haiku-4-5' && charlie.provider === 'anthropic' && charlie.threads === 0 && charlie.messages === 0);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
