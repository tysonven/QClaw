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
 *   - registers the 3 read tools plus the 5 gated write tools added
 *     2026-07-16 (PR #58 gate live; commit 977bc28) — and nothing
 *     destructive (no DELETE endpoints)
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

  // Endpoint surface: 3 reads + 5 gated writes (2026-07-16), nothing destructive.
  const methods = fsc.endpoints.map(e => e.method);
  check('ghl-fsc has exactly 8 endpoints', fsc.endpoints.length === 8,
    `got ${fsc.endpoints.length}: ${methods.join(',')}`);
  check('ghl-fsc has 3 GET endpoints', methods.filter(m => m === 'GET').length === 3,
    `methods: ${methods.join(',')}`);
  check('ghl-fsc has 4 POST + 1 PUT write endpoints',
    methods.filter(m => m === 'POST').length === 4 && methods.filter(m => m === 'PUT').length === 1,
    `methods: ${methods.join(',')}`);
  check('ghl-fsc has NO destructive endpoints (DELETE/PATCH)',
    !methods.some(m => m === 'DELETE' || m === 'PATCH'), `methods: ${methods.join(',')}`);

  // Tool generation: 8 tools, write verbs present but no delete_.
  const tools = skillToTools(fsc);
  const names = tools.map(t => t.name);
  check('ghl-fsc generates 8 tools', tools.length === 8, names.join(','));
  check('ghl-fsc registers no delete_ tools',
    !names.some(n => n.includes('__delete')), names.join(','));

  // The three read surfaces are present.
  check('ghl-fsc has a contact search tool',
    names.some(n => n.includes('contacts') && n.includes('query')), names.join(','));
  check('ghl-fsc has a get-contact-by-id tool',
    names.some(n => n === 'ghl-fsc__get_contacts_id'), names.join(','));
  check('ghl-fsc has an opportunities list tool',
    names.some(n => n.includes('opportunities')), names.join(','));

  // The five write surfaces are present (gated at runtime by ApprovalGate — PR #58).
  check('ghl-fsc has a create-contact tool',
    names.some(n => n.startsWith('ghl-fsc__create_contacts_locationid')), names.join(','));
  check('ghl-fsc has an update-contact tool',
    names.some(n => n === 'ghl-fsc__update_contacts_id'), names.join(','));
  check('ghl-fsc has an add-note tool',
    names.some(n => n === 'ghl-fsc__create_contacts_id_notes'), names.join(','));
  check('ghl-fsc has a create-task tool',
    names.some(n => n === 'ghl-fsc__create_contacts_id_tasks'), names.join(','));
  check('ghl-fsc has an email-draft tool',
    names.some(n => n === 'ghl-fsc__create_conversations_messages'), names.join(','));

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
