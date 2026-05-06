/**
 * Shared .env loader.
 *
 * QClaw does not depend on `dotenv`. This helper parses the secrets file
 * the same way dashboard/server.js used to inline. Extracted so the
 * bootstrap probes (Layer 5) and any future caller share one parser.
 *
 * Returns an object of key→value strings. Missing file returns {}.
 * Values with surrounding quotes are unquoted. Lines starting with `#`
 * and blank lines are ignored. No shell expansion — keys with `$` in
 * the value (e.g. JWTs) are returned verbatim.
 */

import { readFileSync } from 'fs';

const DEFAULT_ENV_PATH = '/root/.quantumclaw/.env';

export function readEnvFile(path = DEFAULT_ENV_PATH) {
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

let _cached = null;

export function getEnv(path = DEFAULT_ENV_PATH) {
  if (_cached) return _cached;
  _cached = readEnvFile(path);
  return _cached;
}

export function clearEnvCache() {
  _cached = null;
}
