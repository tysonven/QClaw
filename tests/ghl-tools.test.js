/**
 * GHL FSC tools tests (Phase 5 Session 3).
 *
 * Run: node tests/ghl-tools.test.js
 *
 * Verifies the FSC GoHighLevel skill (src/agents/skills/ghl-fsc.md):
 *   - parses into executable HTTP tools via the skill-parser path
 *     (the live mechanism — see charlie__ghl__ghl__* in production)
 *   - authenticates with the FSC secret keys (ghl_fsc_api_key /
 *     ghl_fsc_location_id), NOT the Flow OS ghl_api_key
 *   - is READ-ONLY this slice (no POST/PUT/PATCH/DELETE endpoints —
 *     writes are deferred until skill HTTP write tools are gated)
 *   - registers exactly the three read tools (search / get / list)
 *
 * Also guards that the Flow OS ghl.md skill still resolves to
 * ghl_api_key (this slice deliberately did NOT rename it).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { parseSkill, skillToTools } from '../src/agents/skill-parser.js';

const __filename = fileURLToPath(import.meta.url);
const SKILLS_DIR = join(dirname(__filename), '..', 'src', 'agents', 'skills');

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

const stubSecrets = { get: async () => null };

// ── FSC skill ──────────────────────────────────────────────────────────
const fscRaw = readFileSync(join(SKILLS_DIR, 'ghl-fsc.md'), 'utf-8');
const fsc = parseSkill('ghl-fsc', fscRaw, stubSecrets);

check('ghl-fsc.md parses into an HTTP skill', fsc !== null,
  'parseSkill returned null — missing Base URL or Endpoints');

if (fsc) {
  check('ghl-fsc base URL is the LeadConnector host',
    fsc.baseUrl === 'https://services.leadconnectorhq.com', `got ${fsc.baseUrl}`);

  const auth = fsc.headers['Authorization'] || '';
  check('ghl-fsc auth uses {{secrets.ghl_fsc_api_key}}',
    auth.includes('{{secrets.ghl_fsc_api_key}}'), `got "${auth}"`);
  check('ghl-fsc auth does NOT use the Flow OS ghl_api_key',
    !auth.includes('{{secrets.ghl_api_key}}'), `got "${auth}"`);

  const locHeader = fsc.headers['Location-Id'] || '';
  check('ghl-fsc Location-Id header uses {{secrets.ghl_fsc_location_id}}',
    locHeader.includes('{{secrets.ghl_fsc_location_id}}'), `got "${locHeader}"`);

  // Read-only lock: every endpoint must be GET this slice.
  const methods = fsc.endpoints.map(e => e.method);
  check('ghl-fsc has exactly 3 endpoints', fsc.endpoints.length === 3,
    `got ${fsc.endpoints.length}: ${methods.join(',')}`);
  check('ghl-fsc is READ-ONLY (all endpoints GET)',
    methods.length > 0 && methods.every(m => m === 'GET'),
    `methods: ${methods.join(',')}`);

  // Tool generation: three read tools, no mutating verbs.
  const tools = skillToTools(fsc);
  const names = tools.map(t => t.name);
  check('ghl-fsc generates 3 tools', tools.length === 3, names.join(','));
  check('ghl-fsc tool names all use the get_ verb (reads)',
    names.length > 0 && names.every(n => n.startsWith('ghl-fsc__get')),
    names.join(','));
  check('ghl-fsc registers NO write tools (create/update/delete)',
    !names.some(n => /__(create|update|delete)/.test(n)), names.join(','));

  // The three intended read surfaces are present.
  check('ghl-fsc has a contact search tool',
    names.some(n => n.includes('contacts') && n.includes('query')), names.join(','));
  check('ghl-fsc has a get-contact-by-id tool',
    names.some(n => n === 'ghl-fsc__get_contacts_id'), names.join(','));
  check('ghl-fsc has an opportunities list tool',
    names.some(n => n.includes('opportunities')), names.join(','));

  // Registered (agent-scoped) names stay within a safe length bound.
  const registered = names.map(n => `charlie__ghl-fsc__${n}`);
  check('registered FSC tool names are within the tool-name bound (≤70)',
    registered.every(n => n.length <= 70),
    registered.map(n => `${n}(${n.length})`).join(' '));
}

// ── Flow OS ghl.md unchanged (this slice left it on ghl_api_key) ────────
const ghlRaw = readFileSync(join(SKILLS_DIR, 'ghl.md'), 'utf-8');
const ghl = parseSkill('ghl', ghlRaw, stubSecrets);
check('ghl.md still parses into an HTTP skill', ghl !== null);
if (ghl) {
  const ghlAuth = ghl.headers['Authorization'] || '';
  check('ghl.md still resolves to the Flow OS ghl_api_key',
    ghlAuth.includes('{{secrets.ghl_api_key}}'), `got "${ghlAuth}"`);
  check('ghl.md is untouched by the FSC rename (no ghl_fsc_api_key)',
    !ghlAuth.includes('ghl_fsc_api_key'), `got "${ghlAuth}"`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
