/**
 * Slice 6c Unit 3 — specialist skill loader tests.
 * Run: node tests/specialist-loader.test.js
 *
 * Covers: HTTP skill → registerSkillTool under the specialist's agentName with
 * scope [agentName] (not 'charlie'); prompt skill → content pushed, no tools;
 * missing skill → graceful skip (no throw, no push); SSOT path resolution.
 *
 * Uses /tmp fixtures + a skillsDir DI override (Rule 5 CI-parity: no hardcoded
 * /root path on the happy path).
 */

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Route the tool-call log to /tmp before importing the registry.
process.env.QCLAW_TOOL_CALL_LOG_PATH = join(tmpdir(), `6c-toolcall-${process.pid}.log`);

const { registerSpecialistSkills, SKILLS_DIR } = await import('../src/agents/specialist-loader.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { Agent } = await import('../src/agents/registry.js');

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };
function throws(fn) { try { fn(); return null; } catch (e) { return e; } }

const fix = mkdtempSync(join(tmpdir(), '6c-skills-'));

// HTTP skill fixture — parseSkill needs Base URL + ≥1 endpoint.
writeFileSync(join(fix, 'fake-http.md'), `# Fake HTTP Skill

## Auth
Base URL: https://api.example.com/v1
Header: Authorization: Bearer {{secrets.fake_key}}

## Endpoints
GET /things - List things
POST /things - Create a thing
`);

// Prompt-surface skill fixture — frontmatter only, no Auth/Endpoints → parseSkill null.
writeFileSync(join(fix, 'fake-prompt.md'), `---
name: fake-prompt
category: on-demand
surface: prompt
keywords: [foo, bar]
description: A routing-only skill with no HTTP endpoints
---

# Fake Prompt Skill

## Routing
When the user says foo, do bar.
`);

const SPEC_NAME = 'content-studio-operator';
const mkSpec = () => Agent.createSpecialist(
  { agentName: SPEC_NAME, businessUnit: 'flow_os', status: 'live', isLive: true, isStub: false }, {}
);

console.log('Unit 3 — HTTP skill registers tools scoped to the specialist');
{
  const treg = new ToolRegistry({}, {});
  const spec = mkSpec();
  registerSpecialistSkills(spec, { toolRegistry: treg, secrets: {} }, {
    skillsDir: fix,
    getEntry: () => ({ skills: ['fake-http'] }),
  });

  const listed = treg.listTools().filter(t => t.name.startsWith(`${SPEC_NAME}__fake-http__`));
  check('registered ≥1 HTTP tool', listed.length >= 1, `got ${listed.length}`);
  check('tool name namespaced under specialist', listed.every(t => t.name.startsWith(`${SPEC_NAME}__`)));
  check('scope is [specialist.agentName] not [charlie]',
    listed.length > 0 && listed.every(t => Array.isArray(t.scope) && t.scope.length === 1 && t.scope[0] === SPEC_NAME),
    JSON.stringify(listed.map(t => t.scope)));
  check('no tool scoped to charlie', listed.every(t => !(Array.isArray(t.scope) && t.scope.includes('charlie'))));
  check('specialist.skills records the slug', spec.skills.some(s => s.name === 'fake-http'));
}

console.log('Unit 3 — prompt skill: content pushed, no tools registered');
{
  const treg = new ToolRegistry({}, {});
  const spec = mkSpec();
  registerSpecialistSkills(spec, { toolRegistry: treg, secrets: {} }, {
    skillsDir: fix,
    getEntry: () => ({ skills: ['fake-prompt'] }),
  });

  check('prompt skill content pushed to specialist.skills', spec.skills.some(s => s.name === 'fake-prompt'));
  check('prompt skill content non-empty', spec.skills.find(s => s.name === 'fake-prompt')?.content.includes('Routing'));
  check('no tools registered for prompt skill', treg.listTools().filter(t => t.name.startsWith(`${SPEC_NAME}__`)).length === 0);
}

console.log('Unit 3 — missing skill: graceful skip');
{
  const treg = new ToolRegistry({}, {});
  const spec = mkSpec();
  const err = throws(() => registerSpecialistSkills(spec, { toolRegistry: treg, secrets: {} }, {
    skillsDir: fix,
    getEntry: () => ({ skills: ['does-not-exist'] }),
  }));
  check('missing skill does not throw', err === null, err?.message);
  check('missing skill pushes nothing', spec.skills.length === 0);
  check('missing skill registers no tools', treg.listTools().length === 0);
}

console.log('Unit 3 — SSOT path (not the stale symlink dir)');
{
  check('SKILLS_DIR resolves to src/agents/skills', SKILLS_DIR.includes(join('src', 'agents', 'skills')), SKILLS_DIR);
  check('SKILLS_DIR is not the runtime symlink dir', !SKILLS_DIR.includes(join('.quantumclaw', 'workspace')), SKILLS_DIR);
}

rmSync(fix, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
