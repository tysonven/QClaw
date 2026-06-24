/**
 * Slice 6b — specialist registry (pure data layer).
 *
 * Parses FLOW_OS_SPECIALISTS.md (the canonical specialist registry) into a
 * structured Map<id, SpecialistEntry>. This module does NOT load skills or
 * register tools — it is a read-only parse. Tool scoping + skill wiring land in
 * Slice 6c/6d; the `skills` field here is a provisional name-derived placeholder.
 *
 * Two entry shapes exist in the source doc:
 *   1. Active specialists — under a business-unit `## ` section, each carrying the
 *      standard field block (`Belongs to`, `Runs on`, `Status`). 15 of these.
 *   2. Deferred specialists — under `## Deferred specialists`, a different mini
 *      schema (`Trigger to build` / `Anticipated scope`, no Status). 3 of these.
 *      They are parsed with status='deferred' so isStub holds for them too.
 *
 * Total parsed: 18 (15 active + 3 deferred). See Slice 6b audit U1-B.
 *
 * Design note (Slice 6b U1-A): `isLive`/`isStub` reflect the file's Status field
 * verbatim (the file currently marks 5 entries `live`). Whether a specialist
 * actually takes the live dispatch path is a SEPARATE runtime gate owned by the
 * delegate_to tool (QCLAW_SPECIALIST_LIVE_IDS allowlist, empty in 6b) — not this
 * module. This keeps the registry truthful to the source doc.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'FLOW_OS_SPECIALISTS.md');

const VALID_STATUS = new Set(['live', 'scaffolded', 'deferred']);

// `Belongs to:` / section name → canonical businessUnit token.
const BUSINESS_UNIT_MAP = {
  'flow os': 'flow_os',
  'flow states collective': 'fsc',
  'sproutcode': 'sproutcode',
  'crete': 'crete',
  'personal': 'personal',
  'shared': 'shared',
};

// `## ` section header (lowercased) → businessUnit, for active specialists.
const SECTION_UNIT = {
  'flow os': 'flow_os',
  'flow states collective': 'fsc',
  'sproutcode': 'sproutcode',
  'crete': 'crete',
  'personal': 'personal',
  'shared': 'shared',
};

const DEFERRED_SECTION = 'deferred specialists';
// Non-specialist `## ` sections — any `### ` under these is ignored.
const SKIP_SECTIONS = new Set([
  'how to read this file', 'maintenance', 'phase 4 reconciliation tasks', 'maintenance log',
]);

// Trailing role tokens stripped when deriving a provisional skill slug.
const ROLE_SUFFIXES = new Set(['operator', 'specialist', 'bot']);

// Slice 6c: every specialist (live, scaffolded, or deferred) carries the
// read-only observation skill — it declares the typed observation builtins
// (read_file/grep_repo/list_dir/git_status) that replace shell_exec for
// specialists. Appended to the provisional name-derived slug(s).
const UNIVERSAL_SKILLS = ['specialist-observation'];

let _cache = null; // Map<id, SpecialistEntry> — populated on first load, reused.

/** kebab-case an entry's display name (em/en dashes → hyphen, collapse). */
function kebab(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[—–]/g, '-')      // em/en dash → hyphen
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Canonicalise a `Belongs to:` value (strip parenthetical/qualifier) → token. */
function normaliseBusinessUnit(belongsTo, sectionUnit) {
  let s = String(belongsTo || '').toLowerCase();
  s = s.replace(/\(.*$/, '');             // drop "(primary scope: …)"
  s = s.replace(/[—:.].*$/, '');          // drop trailing qualifiers
  s = s.trim();
  return BUSINESS_UNIT_MAP[s] || sectionUnit || 'shared';
}

/** Deferred entries carry no Belongs to — infer the unit from the name. */
function deriveDeferredUnit(name) {
  const n = String(name || '').toLowerCase();
  if (/\bfsc\b/.test(n)) return 'fsc';
  if (/flow os/.test(n)) return 'flow_os';
  if (/sproutcode/.test(n)) return 'sproutcode';
  if (/\bcrete\b/.test(n)) return 'crete';
  return 'shared';
}

/** Provisional skill slug from the id (strip a trailing role token). 6c/6d wires real skills. */
function deriveSkills(id) {
  const parts = String(id).split('-');
  if (parts.length > 1 && ROLE_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  return [parts.join('-')];
}

/** First alpha word of a Status value ("scaffolded — load-bearing…" → "scaffolded"). */
function parseStatusWord(raw) {
  const m = String(raw || '').match(/[a-zA-Z]+/);
  return m ? m[0].toLowerCase() : null;
}

function buildEntry(cur) {
  const id = kebab(cur.displayName);
  if (!id) return null;
  let status;
  if (cur.statusRaw != null) status = parseStatusWord(cur.statusRaw);
  else if (cur.deferred) status = 'deferred';
  else status = null;
  if (!status || !VALID_STATUS.has(status)) return null;

  const businessUnit = cur.deferred
    ? deriveDeferredUnit(cur.displayName)
    : normaliseBusinessUnit(cur.belongsTo, cur.sectionUnit);

  return {
    id,
    displayName: cur.displayName,
    businessUnit,
    status,
    agentName: id,
    skills: [...deriveSkills(id), ...UNIVERSAL_SKILLS],
    runsOn: cur.runsOn ? String(cur.runsOn).trim() : '',
    isLive: status === 'live',
    isStub: status === 'scaffolded' || status === 'deferred',
  };
}

/**
 * Parse FLOW_OS_SPECIALISTS.md into Map<id, SpecialistEntry>. Throws (never
 * silently empty) if the file cannot be read. Caches the result module-wide.
 */
export function loadSpecialistRegistry(filePath = DEFAULT_PATH) {
  let text;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`loadSpecialistRegistry: cannot read specialist registry at "${filePath}": ${err.message}`);
  }

  const lines = text.split(/\r?\n/);
  const map = new Map();
  let sectionUnit = null;   // businessUnit for the current active section, or null
  let inDeferred = false;
  let skipSection = false;
  let cur = null;

  const commit = () => {
    if (!cur) return;
    const entry = buildEntry(cur);
    if (entry) map.set(entry.id, entry);
    cur = null;
  };

  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      commit();
      if (skipSection) { cur = null; continue; }     // ### under a non-specialist section
      if (sectionUnit == null && !inDeferred) { cur = null; continue; }
      cur = {
        displayName: line.replace(/^###\s+/, '').trim(),
        belongsTo: null, runsOn: null, statusRaw: null,
        sectionUnit, deferred: inDeferred,
      };
      continue;
    }
    if (/^##\s+/.test(line)) {
      commit();
      const name = line.replace(/^##\s+/, '').trim().toLowerCase();
      inDeferred = name === DEFERRED_SECTION;
      skipSection = SKIP_SECTIONS.has(name);
      sectionUnit = SECTION_UNIT[name] || null;
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = line.match(/^\s*-\s*\*\*Belongs to:\*\*\s*(.+)$/))) cur.belongsTo = m[1].trim();
    else if ((m = line.match(/^\s*-\s*\*\*Runs on:\*\*\s*(.+)$/))) cur.runsOn = m[1].trim();
    else if ((m = line.match(/^\s*-\s*\*\*Status:\*\*\s*(.+)$/))) cur.statusRaw = m[1].trim();
  }
  commit();

  _cache = map;
  return map;
}

function _ensureLoaded() {
  if (!_cache) loadSpecialistRegistry();
  return _cache;
}

/** Look up a specialist by id (or display name). Returns null for unknown. */
export function getSpecialist(name) {
  if (!name) return null;
  const map = _ensureLoaded();
  return map.get(name) || map.get(kebab(name)) || null;
}

/** All parsed specialists (15 active + 3 deferred). */
export function listSpecialists() {
  return [..._ensureLoaded().values()];
}

/** Test seam — drop the module cache so a fresh parse can be forced. */
export function _resetCache() { _cache = null; }
