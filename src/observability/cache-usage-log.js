/**
 * Slice 3f — cache-usage.log observability writer.
 *
 * One JSONL line per `_anthropicWithTools` API call (including each tool-loop
 * iteration within a single user turn). Captures the Anthropic usage block
 * plus enough provenance to compute cold-re-prime rate per /tmp/slice3f_design.md
 * §6.2.
 *
 * Path: `~/.quantumclaw/cache-usage.log` (mode 0o600). Override via
 * `QCLAW_CACHE_USAGE_LOG_PATH` env var for tests. Size-based rotation at
 * 50 MB, keeps two generations (cache-usage.log + cache-usage.log.1).
 *
 * Token-scrub on `user_id` (defence-in-depth — Slice 3e finding #8 pattern):
 * any Anthropic key prefix (sk-(ant-)?<vendor>-), bearer prefix, or
 * Telegram bot-token shape (<8+digits>:<30+url-safe>) replaces with
 * '<scrubbed>'. No raw token text reaches disk.
 */

import { existsSync, appendFileSync, chmodSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { log } from '../core/logger.js';

const DEFAULT_PATH = join(homedir(), '.quantumclaw', 'cache-usage.log');
const ROTATION_BYTES = 50 * 1024 * 1024; // 50 MB
const MODE = 0o600;

// Token-scrub regexes (defence-in-depth — never trust input). The user_id
// field receives a stringified Telegram numeric id in production, but the
// scrub guards against accidental token leakage through context plumbing.
const SCRUB_PATTERNS = [
  /^sk-(ant-)?[a-z0-9]+-/i,            // Anthropic key prefixes
  /^Bearer\s+/i,                        // Bearer auth prefix
  /^\d{8,}:[A-Za-z0-9_-]{30,}$/,        // Telegram bot token shape
];

function _scrub(value) {
  if (value == null) return value;
  const s = String(value);
  for (const re of SCRUB_PATTERNS) {
    if (re.test(s)) return '<scrubbed>';
  }
  return s;
}

// Process-local state. Tests reset via __resetCacheUsageLogForTests().
let _lastWriteTs = null;        // ms timestamp of previous append
let _ephemeralWarned = false;   // one-time warn flag

export function __resetCacheUsageLogForTests() {
  _lastWriteTs = null;
  _ephemeralWarned = false;
}

function _path() {
  return process.env.QCLAW_CACHE_USAGE_LOG_PATH || DEFAULT_PATH;
}

function _rotateIfNeeded(path) {
  try {
    if (!existsSync(path)) return;
    const st = statSync(path);
    if (st.size <= ROTATION_BYTES) return;
    renameSync(path, path + '.1');
  } catch (err) {
    // Best-effort — rotation failures are non-fatal. The next append will
    // continue using the existing file (potentially > 50 MB until manual
    // cleanup); cache-usage.log writing must never block Charlie's hot path.
    log.debug?.(`cache-usage.log rotation failed: ${err.message}`);
  }
}

/**
 * Hash a tools array's name-ordering. Same names + same order → identical
 * hash. Changes detect Map iteration shuffles across pm2 reloads
 * (/tmp/slice3f_design.md §3.1.1). Returns the first 8 hex chars.
 */
export function toolsHash(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  try {
    const names = tools.map(t => (typeof t === 'object' && t && t.name) ? String(t.name) : '');
    return createHash('sha256').update(names.join('|')).digest('hex').slice(0, 8);
  } catch {
    return '';
  }
}

/**
 * Append one cache-usage record.
 *
 * record: {
 *   model, channel, userId, input_tokens, output_tokens,
 *   cache_creation_input_tokens, cache_read_input_tokens,
 *   ephemeral_5m_input_tokens, ephemeral_1h_input_tokens,
 *   ephemeral_extraction_failed,
 *   bootstrap_cache_hit, bootstrap_present, cache_control_emitted,
 *   tools (Array), tools_count, had_on_demand_skills,
 *   tool_loop_iteration, cache_control_rejection_message,
 *   runtime_invariant_failed, fail_open_triggered, fail_open_reason
 * }
 *
 * All fields are optional except `model`; defaults applied per design §7.2.
 */
export function appendCacheUsage(record = {}) {
  const path = _path();
  try {
    _rotateIfNeeded(path);

    const now = Date.now();
    const ts = new Date(now).toISOString();

    const secondsSinceLastCall = _lastWriteTs == null
      ? null
      : Math.max(0, Math.round((now - _lastWriteTs) / 1000));

    const tools = Array.isArray(record.tools) ? record.tools : null;
    const computedToolsHash = record.tools_hash !== undefined
      ? record.tools_hash
      : (tools ? toolsHash(tools) : '');
    const computedToolsCount = record.tools_count !== undefined
      ? record.tools_count
      : (tools ? tools.length : 0);

    const entry = {
      ts,
      model: record.model || null,
      channel: record.channel || 'unknown',
      user_id: _scrub(record.userId ?? null),
      input_tokens: record.input_tokens || 0,
      output_tokens: record.output_tokens || 0,
      cache_creation_input_tokens: record.cache_creation_input_tokens || 0,
      cache_read_input_tokens: record.cache_read_input_tokens || 0,
      ephemeral_5m_input_tokens: record.ephemeral_5m_input_tokens || 0,
      ephemeral_1h_input_tokens: record.ephemeral_1h_input_tokens || 0,
      bootstrap_cache_hit: !!record.bootstrap_cache_hit,
      bootstrap_present: record.bootstrap_present !== false,
      cache_control_emitted: !!record.cache_control_emitted,
      tools_count: computedToolsCount,
      tools_hash: computedToolsHash,
      had_on_demand_skills: !!record.had_on_demand_skills,
      tool_loop_iteration: record.tool_loop_iteration || 1,
      seconds_since_last_call: secondsSinceLastCall,
    };

    // Slice 3f §8.1 — fail-open observability: when cache_control was
    // structurally rejected by Anthropic, persist the API error message on
    // every subsequent entry until process restart.
    if (record.cache_control_rejection_message) {
      entry.cache_control_rejection_message = String(record.cache_control_rejection_message).slice(0, 500);
    }
    if (record.runtime_invariant_failed) entry.runtime_invariant_failed = true;
    if (record.fail_open_triggered) {
      entry.fail_open_triggered = true;
      if (record.fail_open_reason) entry.fail_open_reason = String(record.fail_open_reason).slice(0, 200);
    }
    if (record.ephemeral_extraction_failed) entry.ephemeral_extraction_failed = true;

    // One-time warn when cache_creation_input_tokens > 0 but no ephemeral
    // bucket is reported — exposed via the explicit flag for callers that
    // want their own logging surface.
    if (record.ephemeral_extraction_failed && !_ephemeralWarned) {
      _ephemeralWarned = true;
      log.warn?.(`[slice3f] ephemeral_*_input_tokens absent at both nested + top-level paths; logging zeros until schema confirmed`);
    }

    const fileExistedBefore = existsSync(path);
    appendFileSync(path, JSON.stringify(entry) + '\n', { mode: MODE });
    if (!fileExistedBefore) {
      try { chmodSync(path, MODE); } catch { /* defensive */ }
    }
    _lastWriteTs = now;
  } catch (err) {
    log.debug?.(`cache-usage.log append failed: ${err.message}`);
  }
}
