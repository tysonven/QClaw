/**
 * Phase 5 Session 1 — n8n_workflow_list builtin.
 * Run: node tests/n8n-workflow-list.test.js
 *
 * Projects full n8n workflow objects → {id, name, active}; paginates via
 * nextCursor; filters active_only / name_contains; surfaces truncation.
 */

import { createN8nWorkflowListTool } from '../src/tools/n8n-workflow-list.js';

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };

// A full-fat workflow object like the real API returns (heavy fields present).
const fat = (id, name, active) => ({
  id, name, active, isArchived: false,
  nodes: [{ a: 'x'.repeat(500) }], connections: { big: 'y'.repeat(500) },
  settings: {}, staticData: null, pinData: {}, versionId: 'v', tags: [],
});

console.log('projects to {id,name,active} and drops heavy fields:');
{
  const tool = createN8nWorkflowListTool({
    fetchPage: async () => ({ data: [fat('w1', 'Morning Light', true), fat('w2', 'Clipper', false)], nextCursor: null }),
  });
  const out = JSON.parse(await tool.fn({}));
  check('count = 2', out.count === 2);
  check('not truncated', out.truncated === false);
  check('item keys are exactly id,name,active',
    out.workflows.every(w => JSON.stringify(Object.keys(w).sort()) === '["active","id","name"]'), JSON.stringify(out.workflows[0]));
  check('values projected correctly', out.workflows[0].id === 'w1' && out.workflows[0].name === 'Morning Light' && out.workflows[0].active === true);
  const size = JSON.stringify(out).length;
  check('payload is small (heavy fields stripped)', size < 400, `size=${size}`);
}

console.log('paginates across nextCursor:');
{
  let calls = 0;
  const tool = createN8nWorkflowListTool({
    fetchPage: async (cursor) => {
      calls++;
      if (!cursor) return { data: [fat('a', 'A', true)], nextCursor: 'CUR2' };
      return { data: [fat('b', 'B', false)], nextCursor: null };
    },
  });
  const out = JSON.parse(await tool.fn({}));
  check('followed cursor across 2 pages', calls === 2 && out.count === 2);
  check('merged both pages', out.workflows.map(w => w.id).join(',') === 'a,b');
}

console.log('active_only + name_contains filters:');
{
  const tool = createN8nWorkflowListTool({
    fetchPage: async () => ({ data: [fat('a', 'Alpha', true), fat('b', 'Beta', false), fat('c', 'Alpaca', true)], nextCursor: null }),
  });
  const actives = JSON.parse(await tool.fn({ active_only: true }));
  check('active_only returns only active', actives.count === 2 && actives.workflows.every(w => w.active));
  const named = JSON.parse(await tool.fn({ name_contains: 'alp' }));
  check('name_contains case-insensitive substring', named.count === 2 && named.workflows.map(w => w.id).sort().join(',') === 'a,c');
}

console.log('surfaces truncation at the page backstop (no silent cap):');
{
  const tool = createN8nWorkflowListTool({
    fetchPage: async () => ({ data: [fat('x', 'X', true)], nextCursor: 'ALWAYS' }), // never ends
  });
  const out = JSON.parse(await tool.fn({}));
  check('truncated flag set when cursor still remains', out.truncated === true);
  check('page backstop caps the loop (count = MAX_PAGES 20)', out.count === 20, `count=${out.count}`);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
