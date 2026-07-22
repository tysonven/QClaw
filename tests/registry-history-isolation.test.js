/**
 * History isolation tests — H1 hotfix, 2026-05-14.
 *
 * Run: node tests/registry-history-isolation.test.js
 *
 * Locks in the channel + userId filter contract that
 * src/agents/registry.js _processNonReflex now relies on. Before this
 * fix, getHistory(agent, limit) returned the agent's most recent N
 * messages across all channels — so heartbeat / CLI / dashboard writes
 * could pollute a live Telegram conversation. The fix passes
 * { channel: context?.channel, userId: context?.userId } at
 * src/agents/registry.js:306.
 *
 * These tests exercise the underlying memory.getHistory filter path
 * (JSON-store fallback, same filter logic as the SQL path) to ensure
 * the contract holds.
 *
 * Audit ref: /tmp/memory_drop_diagnostic_audit.md
 */

import { MemoryManager } from '../src/memory/manager.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

const tmp = mkdtempSync(join(tmpdir(), 'qclaw-history-iso-'));

// Construct a minimal MemoryManager backed by the JSON store. We skip
// the full connect() path (SQLite native module / Cognee / vector init)
// because we're testing the getHistory filter contract only.
const memory = new MemoryManager({ _dir: tmp }, {});
memory._jsonStore = { conversations: [], context: {} };
memory._jsonStorePath = join(tmp, 'memory.json');
memory._saveJsonStore = () => {}; // no-op for test

// Seed conversations across channels and users.
memory.addMessage('charlie', 'user',      'cli-msg-1',   { channel: 'cli',       userId: 'X' });
memory.addMessage('charlie', 'user',      'tg-msg-1',    { channel: 'telegram',  userId: 'X' });
memory.addMessage('charlie', 'assistant', 'tg-reply-1',  { channel: 'telegram',  userId: 'X' });
memory.addMessage('charlie', 'user',      'cli-msg-2',   { channel: 'cli',       userId: 'Y' });
memory.addMessage('charlie', 'user',      'tg-msg-2',    { channel: 'telegram',  userId: 'X' });
memory.addMessage('charlie', 'user',      'dash-msg-1',  { channel: 'dashboard', userId: 'X' });

// ─── Channel + userId filter (the H1 fix contract) ─────────────────────
const tgX = memory.getHistory('charlie', 20, { channel: 'telegram', userId: 'X' });
check('channel+userId filter returns only matching channel',
  tgX.length === 3 && tgX.every(m => m.channel === 'telegram'),
  `got: ${tgX.map(m => `${m.channel}:${m.userId}`).join(', ')}`);
check('channel+userId filter returns only matching userId',
  tgX.every(m => m.userId === 'X'));
check('channel+userId filter does NOT leak CLI entries with same userId',
  !tgX.some(m => m.channel === 'cli'));
check('channel+userId filter does NOT leak dashboard entries with same userId',
  !tgX.some(m => m.channel === 'dashboard'));
check('channel+userId filter does NOT leak other-user entries on same channel',
  !tgX.some(m => m.userId === 'Y'));

// ─── Channel-only filter (multi-user scenario) ─────────────────────────
const allTg = memory.getHistory('charlie', 20, { channel: 'telegram' });
check('channel-only filter returns all matching channel across users',
  allTg.length === 3 && allTg.every(m => m.channel === 'telegram'),
  `got: ${allTg.map(m => `${m.channel}:${m.userId}`).join(', ')}`);

// ─── userId-only filter (legacy callers that don't track channel) ──────
const allX = memory.getHistory('charlie', 20, { userId: 'X' });
check('userId-only filter returns all matching userId across channels',
  allX.length === 5 && allX.every(m => m.userId === 'X'),
  `got: ${allX.map(m => `${m.channel}:${m.userId}`).join(', ')}`);

// ─── Unfiltered call (heartbeat / auto-learn legitimate cross-channel) ──
const all = memory.getHistory('charlie', 20);
check('unfiltered call returns all agent messages (cross-channel)',
  all.length === 6, `got ${all.length} messages`);

// ─── Undefined-vs-missing options (heartbeat pattern parity) ───────────
// registry.js passes { channel: context?.channel, userId: context?.userId }
// where both keys are PRESENT but their values may be undefined for
// non-Telegram callers. Filter behaviour must match the unfiltered case.
const undefBoth = memory.getHistory('charlie', 20, { channel: undefined, userId: undefined });
check('undefined channel + undefined userId behaves like unfiltered',
  undefBoth.length === 6,
  `got ${undefBoth.length}; expected 6 (parity with unfiltered)`);

// ─── Limit honoured under filter ───────────────────────────────────────
const tgLimited = memory.getHistory('charlie', 2, { channel: 'telegram', userId: 'X' });
check('limit honoured alongside filter',
  tgLimited.length === 2 && tgLimited.every(m => m.channel === 'telegram'),
  `got ${tgLimited.length}`);

// ─── Numeric userId coercion (2026-07-22 fix) ──────────────────────────
// grammY ctx.from.id is a NUMBER; addMessage stores user_id as TEXT
// (String(context.userId) at the registry.js call site). Pre-fix, a
// numeric userId returned 0 rows on the SQL path (numeric bind vs TEXT
// storage) and failed strict === on this JSON path — zero Telegram
// history on every turn since the H1 fix shipped (2026-05-14).
memory.addMessage('charlie', 'user', 'tg-numeric-1', { channel: 'telegram', userId: '1375806243' });
const numericJson = memory.getHistory('charlie', 20, { channel: 'telegram', userId: 1375806243 });
check('numeric userId is coerced to string for store compatibility (JSON path)',
  numericJson.length === 1 && numericJson[0].content === 'tg-numeric-1',
  `got ${numericJson.length} rows`);
const stringJson = memory.getHistory('charlie', 20, { channel: 'telegram', userId: '1375806243' });
check('numeric and string userId return identical rows (JSON path)',
  numericJson.length === stringJson.length &&
  numericJson.every((m, i) => m.content === stringJson[i].content));

// ─── Same contract on the SQLite path (the production path) ────────────
// The original H1 suite only exercised the JSON-store fallback; production
// runs better-sqlite3, where the bug actually lived. Skip (with a notice)
// only where the native module is unavailable (e.g. Termux fallback).
try {
  const { default: Database } = await import('better-sqlite3');
  const sqlMemory = new MemoryManager({ _dir: tmp }, {});
  sqlMemory.db = new Database(join(tmp, 'history-iso.db'));
  sqlMemory.db.exec(`CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    model TEXT, tier TEXT, tokens INTEGER,
    channel TEXT, user_id TEXT, username TEXT)`);
  sqlMemory.addMessage('charlie', 'user',      'sql-tg-1',    { channel: 'telegram', userId: '1375806243' });
  sqlMemory.addMessage('charlie', 'assistant', 'sql-tg-r1',   { channel: 'telegram', userId: '1375806243' });
  sqlMemory.addMessage('charlie', 'user',      'sql-dash-1',  { channel: 'dashboard', userId: null });
  const asNumber = sqlMemory.getHistory('charlie', 20, { channel: 'telegram', userId: 1375806243 });
  const asString = sqlMemory.getHistory('charlie', 20, { channel: 'telegram', userId: '1375806243' });
  check('numeric userId is coerced to string for SQLite bind compatibility',
    asNumber.length === 2 && asNumber[0].content === 'sql-tg-1',
    `got ${asNumber.length} rows`);
  check('numeric and string userId return identical rows (SQLite path)',
    asNumber.length === asString.length &&
    asNumber.every((m, i) => m.content === asString[i].content),
    `number=${asNumber.length} string=${asString.length}`);
  sqlMemory.db.close();
} catch (err) {
  console.log(`  - SQLite-path checks skipped (better-sqlite3 unavailable: ${err.message})`);
}

// ─── Cleanup ───────────────────────────────────────────────────────────
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
