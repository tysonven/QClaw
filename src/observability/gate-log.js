/**
 * Slice 4 — gate.log writer.
 *
 * One JSONL line per verification-gate firing. Append-only, mode 0600, path
 * `~/.quantumclaw/gate.log` (override `QCLAW_GATE_LOG_PATH`), size-based
 * rotation at 50 MB keeping one generation (`.1`) — matching the
 * cache-usage-log.js pattern.
 *
 * Claim/response text is free-form prose, so secrets are scrubbed with the
 * GLOBAL/UNANCHORED scrubber (a key can appear mid-string) reused from the
 * Slice 3g poller — NOT the anchored whole-value `_scrub` in cache-usage-log.js.
 *
 * Design ref: /tmp/slice4_design.md §8.
 */

import { existsSync, appendFileSync, chmodSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { log } from '../core/logger.js';
import { scrubSecrets } from './anthropic-spend-poller.js';

const DEFAULT_PATH = join(homedir(), '.quantumclaw', 'gate.log');
const ROTATION_BYTES = 50 * 1024 * 1024;
const MODE = 0o600;

function _path() {
  return process.env.QCLAW_GATE_LOG_PATH || DEFAULT_PATH;
}

function _rotateIfNeeded(path) {
  try {
    if (!existsSync(path)) return;
    if (statSync(path).size <= ROTATION_BYTES) return;
    renameSync(path, path + '.1');
  } catch (err) {
    log.debug?.(`gate.log rotation failed: ${err.message}`);
  }
}

/** Boolean or null. Never coerce an absent field to false. */
const _bool = (v) => (typeof v === 'boolean' ? v : null);

/**
 * Append one gate record. Never throws (logging must not break the regeneration
 * loop). Scrubs `claim` + `rewritten_claim` before write.
 *
 * record: { gate, claim, verification_attempted, verified, result, action,
 *           attempt, rewritten_claim?, fired?, check?, backed?, path?, sourced?,
 *           entity_free? }
 *
 * Two row kinds share this schema, told apart by `fired`:
 *
 *  - `fired: true`  = a gate firing, the only kind that existed before. Every
 *    pre-existing field keeps its exact meaning, so existing greps still work.
 *  - `fired: false` = an OBSERVATION: one matchEvidence call that did not (on its
 *    own) fire the gate. These are new. They exist because a claim backed by the
 *    no-entity fallback passes silently, so the evidence path that backed it was
 *    unrecorded and uncountable.
 *
 * The evidence fields are null on rows that have no such notion (Gate 4's phantom
 * tool names, Gate 5's identifier provenance, a gate that threw): those gates do
 * not call matchEvidence, so there is no path to report. Null means "not
 * applicable", not "no evidence", hence _bool rather than a `!!` coercion, which
 * would have silently reported every such row as backed:false.
 */
/**
 * Map one runGates outcome to the rows that describe it. Pure, so the content
 * policy below is a tested invariant rather than a comment inside a callback.
 *
 * FIRING rows carry claim text, exactly as they always have.
 * OBSERVATION rows carry NONE.
 *
 * That asymmetry is the point. Before observations existed, gate.log held claim
 * text only for claims that FAILED. Observations fire on every gated turn
 * including passes, so logging their text would have widened the file to most of
 * Charlie's real output, including replies quoting customer names, amounts and
 * emails. scrubSecrets covers API keys and Telegram tokens, not PII. Nulling the
 * claim keeps the content envelope exactly where it was while still recording
 * which evidence path backed what.
 *
 * Nothing analytic is lost: gate + check + backed + path + entity_free is the
 * payload, and sentence-shape analysis belongs in the replay harness, which reads
 * memory.db directly instead of persisting a second copy here.
 */
export function gateLogRows(gateOut = {}, attempt = 0) {
  const rows = [];
  for (const g of (gateOut.gates || [])) {
    if (g.fired) {
      for (const c of (g.claims || [])) {
        rows.push({
          gate: g.gate, claim: c.text || String(c),
          verification_attempted: c.verification_attempted !== false,
          verified: false, result: gateOut.result, action: g.action, attempt,
          fired: true,
        });
      }
    }
    // Gates 4 and 5 do not call matchEvidence, so they report no observations.
    for (const o of (g.observations || [])) {
      rows.push({
        gate: g.gate, claim: null,          // never the sentence: see above
        verification_attempted: true, verified: false,
        result: gateOut.result, action: g.action, attempt,
        fired: false, check: o.check, backed: o.backed,
        path: o.path, sourced: o.sourced, entity_free: o.entity_free,
      });
    }
  }
  return rows;
}

export function appendGateLog(record = {}) {
  const path = _path();
  try {
    _rotateIfNeeded(path);
    const entry = {
      ts: new Date().toISOString(),
      gate: record.gate || null,
      claim: record.claim != null ? scrubSecrets(String(record.claim)).slice(0, 500) : null,
      verification_attempted: !!record.verification_attempted,
      verified: !!record.verified,
      result: record.result || null,            // 'pass'|'soft_fail'|'hard_fail'
      action: record.action || null,            // 'rewrite'|'reprompt'|'escalate'|'fail_closed_slice5_pending'|...
      attempt: record.attempt ?? 0,
      // ── instrumentation (Unit 1) ──
      fired: _bool(record.fired),               // true = gate firing, false = observation
      check: record.check || null,              // 'completion'|'ran'|'ok'|'dispatch'|'outcome'
      backed: _bool(record.backed),
      path: record.path || null,                // EVIDENCE_PATH value, or null
      sourced: record.sourced || null,          // 'bootstrap' when the snapshot backed it
      entity_free: _bool(record.entity_free),
    };
    if (record.rewritten_claim != null) {
      entry.rewritten_claim = scrubSecrets(String(record.rewritten_claim)).slice(0, 500);
    }
    const existedBefore = existsSync(path);
    appendFileSync(path, JSON.stringify(entry) + '\n', { mode: MODE });
    if (!existedBefore) { try { chmodSync(path, MODE); } catch { /* defensive */ } }
  } catch (err) {
    log.debug?.(`gate.log append failed: ${err.message}`);
  }
}
