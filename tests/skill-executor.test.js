/**
 * Generic Skill HTTP Executor — body serialisation + error propagation.
 * Covers the P5S6 fix: consumedArgs excluded from non-GET bodies, `data`
 * string payload parsed and lifted to the body root, and every failure
 * (non-2xx HTTP status AND transport/timeout errors) thrown out of the
 * catch-all instead of returned as success-shaped strings.
 *
 * Also covers the {{config.X}} template resolver: allowlisted paths resolve
 * from the live in-memory config at call time (no restart needed to pick up
 * a rotated dashboard.authToken), non-allowlisted paths and missing keys
 * resolve to an empty string rather than leaking an unrelated config value.
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

// Mutable so a test can rotate a value mid-run, the way `qclaw dashboard`
// re-mints dashboard.authToken on the live object.
const CONFIG = {
  dashboard: { authToken: 'live-token-v1', pin: '1234', tunnelToken: 'tunnel-secret' },
};

const fakeThis = {
  secrets: { get: async (k) => SECRETS[k] },
  config: CONFIG,
  _resolveConfigTemplates: ToolRegistry.prototype._resolveConfigTemplates,
};

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

  // ── 7. Transport errors (network, AbortSignal timeout) now throw (marked)
  // so the executor records error:true — closes the audit.db result_status gap
  // completely, not just for HTTP-status failures.
  global.fetch = async () => { throw new Error('socket hang up'); };
  let threw7 = null;
  try { await exec(PRESET, notesToolDef(), args1); } catch (e) { threw7 = e; }
  check('network error throws', threw7 !== null);
  check('network error throw is rethrow-marked', threw7?.rethrow === true, String(threw7?.rethrow));
  check('network error message preserves API-error context',
    threw7 !== null && threw7.message.includes('API error') && threw7.message.includes('socket hang up'), threw7?.message);

  // AbortSignal.timeout surfaces as an AbortError — must throw too, not swallow.
  global.fetch = async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; };
  let threw7b = null;
  try { await exec(PRESET, notesToolDef(), args1); } catch (e) { threw7b = e; }
  check('AbortError/timeout throws and is rethrow-marked',
    threw7b?.rethrow === true && threw7b.message.includes('aborted'), threw7b?.message);

  // ── 8. {{config.X}}: allowlisted path resolves from the live config object
  const CONFIG_PRESET = {
    name: 'skill:trading-api',
    baseUrl: 'http://localhost:4000/api/trading',
    headers: { 'Authorization': 'Bearer {{config.dashboard.authToken}}' },
  };
  const cfgDef = { name: 'trading-api__get_config', method: 'GET', path: '/config' };

  global.fetch = realFetch;
  mockFetch({ ok: true, status: 200, text: JSON.stringify({ trading_enabled: true }) });
  await exec(CONFIG_PRESET, cfgDef, {});
  check('config template resolves from live config',
    lastCall.opts.headers['Authorization'] === 'Bearer live-token-v1',
    lastCall.opts.headers['Authorization']);

  // ── 9. A rotated token is picked up on the next call — no restart, no drift
  CONFIG.dashboard.authToken = 'live-token-v2';
  mockFetch({ ok: true, status: 200, text: '{}' });
  await exec(CONFIG_PRESET, cfgDef, {});
  check('rotated token picked up without re-registration',
    lastCall.opts.headers['Authorization'] === 'Bearer live-token-v2',
    lastCall.opts.headers['Authorization']);

  // ── 10. Non-allowlisted config paths resolve to empty, not to the value
  mockFetch({ ok: true, status: 200, text: '{}' });
  await exec({ ...CONFIG_PRESET, headers: { 'X-Pin': 'pin={{config.dashboard.pin}}' } }, cfgDef, {});
  check('non-allowlisted config path resolves to empty',
    lastCall.opts.headers['X-Pin'] === 'pin=', lastCall.opts.headers['X-Pin']);

  mockFetch({ ok: true, status: 200, text: '{}' });
  await exec({ ...CONFIG_PRESET, headers: { 'X-T': '{{config.dashboard.tunnelToken}}' } }, cfgDef, {});
  check('tunnelToken is not reachable from a skill template',
    lastCall.opts.headers['X-T'] === '', lastCall.opts.headers['X-T']);

  // Prototype-walk attempt is blocked by the allowlist, not by the dot-path
  mockFetch({ ok: true, status: 200, text: '{}' });
  await exec({ ...CONFIG_PRESET, headers: { 'X-P': '{{config.constructor.name}}' } }, cfgDef, {});
  check('prototype walk resolves to empty', lastCall.opts.headers['X-P'] === '', lastCall.opts.headers['X-P']);

  // ── 11. Missing allowlisted key → empty string (fails at remote auth, not locally)
  const missingThis = {
    secrets: fakeThis.secrets,
    config: {},
    _resolveConfigTemplates: ToolRegistry.prototype._resolveConfigTemplates,
  };
  mockFetch({ ok: true, status: 200, text: '{}' });
  await ToolRegistry.prototype._executeAPITool.call(missingThis, CONFIG_PRESET, cfgDef, {});
  check('missing config key resolves to empty string',
    lastCall.opts.headers['Authorization'] === 'Bearer ', lastCall.opts.headers['Authorization']);

  // ── 12. URL-position templates resolve too, and coexist with {{secrets.X}}
  mockFetch({ ok: true, status: 200, text: '{}' });
  await exec(
    { ...CONFIG_PRESET, headers: {} },
    { name: 'trading-api__get_config', method: 'GET', path: '/config?token={{config.dashboard.authToken}}' },
    {},
  );
  check('config template resolves in the URL',
    lastCall.url === 'http://localhost:4000/api/trading/config?token=live-token-v2', lastCall.url);

  mockFetch({ ok: true, status: 200, text: '{}' });
  await exec(
    { ...PRESET, headers: { 'Authorization': 'Bearer {{secrets.ghl_fsc_api_key}}', 'X-Dash': '{{config.dashboard.authToken}}' } },
    notesToolDef(),
    { contact_id: 'X', data: '{}' },
  );
  check('secrets and config templates coexist across headers',
    lastCall.opts.headers['Authorization'] === 'Bearer test-api-key' &&
    lastCall.opts.headers['X-Dash'] === 'live-token-v2',
    JSON.stringify(lastCall.opts.headers));

  // ── 13. Headers with no template are passed through untouched
  mockFetch({ ok: true, status: 200, text: '{}' });
  await exec({ ...CONFIG_PRESET, headers: { 'Version': '2021-07-28' } }, cfgDef, {});
  check('literal headers unchanged', lastCall.opts.headers['Version'] === '2021-07-28', lastCall.opts.headers['Version']);

  global.fetch = realFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
