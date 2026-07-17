/**
 * Generic Skill HTTP Executor — body serialisation + error propagation.
 * Covers the P5S6 fix: consumedArgs excluded from non-GET bodies, `data`
 * string payload parsed and lifted to the body root, non-2xx responses
 * thrown (escaping the catch-all) instead of returned as success strings.
 * Run: node tests/skill-executor.test.js
 */

import { ToolRegistry } from '../src/tools/registry.js';

let passed = 0;
let failed = 0;

function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

const SECRETS = {
  ghl_fsc_api_key: 'test-api-key',
  ghl_fsc_location_id: 'LOC123',
};

const fakeThis = { secrets: { get: async (k) => SECRETS[k] } };

const PRESET = {
  name: 'skill:ghl-fsc',
  baseUrl: 'https://services.example.com',
  headers: {
    'Authorization': 'Bearer {{secrets.ghl_fsc_api_key}}',
    'Version': '2021-07-28',
  },
};

function notesToolDef() {
  return { name: 'ghl-fsc__create_contacts_id_notes', method: 'POST', path: '/contacts/{{contact_id}}/notes' };
}

const realFetch = global.fetch;
let lastCall = null;

function mockFetch(response) {
  lastCall = null;
  global.fetch = async (url, opts) => {
    lastCall = { url, opts };
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.text,
    };
  };
}

async function main() {
  const exec = (preset, toolDef, args) =>
    ToolRegistry.prototype._executeAPITool.call(fakeThis, preset, toolDef, args);

  // ── 1. POST: path param consumed, data string parsed + lifted to root
  mockFetch({ ok: true, status: 201, text: JSON.stringify({ id: 'note1' }) });
  const args1 = {
    contact_id: 'SbPJpeihuGK3RT6bspyq',
    data: JSON.stringify({ body: 'test note', userId: 'XGcW' }),
  };
  const r1 = await exec(PRESET, notesToolDef(), args1);
  check('POST url has path param substituted', lastCall.url === 'https://services.example.com/contacts/SbPJpeihuGK3RT6bspyq/notes', lastCall?.url);
  const sent1 = JSON.parse(lastCall.opts.body);
  check('POST body excludes consumed contact_id', !('contact_id' in sent1), lastCall.opts.body);
  check('POST body has no data wrapper', !('data' in sent1), lastCall.opts.body);
  check('POST body fields lifted to root', sent1.body === 'test note' && sent1.userId === 'XGcW', lastCall.opts.body);
  check('Content-Type set', lastCall.opts.headers['Content-Type'] === 'application/json');
  check('Auth header resolved from secrets', lastCall.opts.headers['Authorization'] === 'Bearer test-api-key');
  check('2xx returns response JSON string', typeof r1 === 'string' && r1.includes('note1'), r1);

  // ── 2. POST: invalid data JSON → validation string, no HTTP call
  mockFetch({ ok: true, status: 200, text: '{}' });
  const r2 = await exec(PRESET, notesToolDef(), { contact_id: 'X', data: '{not json' });
  check('invalid data returns validation error string', typeof r2 === 'string' && r2.includes('data field is not valid JSON'), r2);
  check('invalid data sends no HTTP request', lastCall === null);

  // ── 3. non-2xx throws (escapes the catch-all)
  mockFetch({ ok: false, status: 422, text: '{"message":["property x should not exist"]}' });
  let threw3 = null;
  try { await exec(PRESET, notesToolDef(), args1); } catch (err) { threw3 = err; }
  check('non-2xx throws', threw3 !== null);
  check('thrown message carries status + body', threw3 !== null && threw3.message.includes('HTTP 422') && threw3.message.includes('should not exist'), threw3?.message);

  // ── 4. GET path unchanged: secrets resolved, consumed args skipped, extras as query
  mockFetch({ ok: true, status: 200, text: JSON.stringify({ contacts: [] }) });
  const getDef = { name: 'ghl-fsc__get_contacts', method: 'GET', path: '/contacts/?locationId={{secrets.ghl_fsc_location_id}}&query={{query}}' };
  const r4 = await exec(PRESET, getDef, { query: 'emma', limit: 5 });
  check('GET url resolves secret + consumed param', lastCall.url.startsWith('https://services.example.com/contacts/?locationId=LOC123&query=emma'), lastCall.url);
  check('GET appends unconsumed args as query', lastCall.url.includes('limit=5'), lastCall.url);
  check('GET sends no body', lastCall.opts.body === undefined);
  check('GET returns compact JSON', typeof r4 === 'string' && r4.includes('contacts'), r4);

  // ── 5. GET non-2xx also throws now
  mockFetch({ ok: false, status: 401, text: 'unauthorized' });
  let threw5 = null;
  try { await exec(PRESET, getDef, { query: 'x' }); } catch (err) { threw5 = err; }
  check('GET non-2xx throws', threw5 !== null && threw5.message.includes('HTTP 401'), threw5?.message);

  // ── 6. Array data payload sent verbatim as body
  mockFetch({ ok: true, status: 200, text: '{}' });
  await exec(PRESET, notesToolDef(), { contact_id: 'X', data: '[1,2,3]' });
  check('array data is the body verbatim', lastCall.opts.body === '[1,2,3]', lastCall.opts.body);

  // ── 7. Unmarked errors (network etc.) still return the legacy string
  lastCall = null;
  global.fetch = async () => { throw new Error('socket hang up'); };
  const r7 = await exec(PRESET, notesToolDef(), args1);
  check('network error returns legacy API-error string', typeof r7 === 'string' && r7.includes('API error') && r7.includes('socket hang up'), r7);

  global.fetch = realFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
