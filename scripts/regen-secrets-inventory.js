#!/usr/bin/env node

/**
 * Regenerate the secrets inventory table inside LOCATIONS.md.
 *
 * Reads key NAMES ONLY from the three credential stores and rewrites the
 * region between the BEGIN/END GENERATED markers in LOCATIONS.md. Values are
 * never read, never held in memory, and never written.
 *
 * Stores:
 *   1. `~/.quantumclaw/.secrets.enc`  (encrypted store, flat JSON, root 0600)
 *   2. `~/.quantumclaw/.env`          (process env, root 0600)
 *   3. n8n `user_api_keys.label`      (different host, read over `ssh n8n`)
 *
 * Why this exists: the 2026-08-19 estate audit found 73 of 79 credentials had
 * no LOCATIONS.md entry, because the secrets section named file locations and
 * never keys. A hand-maintained list would drift back to that state within
 * weeks. Anything unrecognised renders as [needs Tyson input] automatically,
 * so a NEW key shows up in the table on the next run without anyone
 * remembering to add it. That auto-surfacing is the point of the script.
 *
 * Usage:
 *   sudo node scripts/regen-secrets-inventory.js          # rewrite LOCATIONS.md
 *   sudo node scripts/regen-secrets-inventory.js --check   # exit 1 if stale
 *   sudo node scripts/regen-secrets-inventory.js --stdout  # print, write nothing
 *
 * Needs root: both local stores are 0600 root-owned. Store 3 needs the `ssh n8n`
 * alias; if the host is unreachable the run ABORTS rather than silently
 * emitting a table missing a whole store.
 *
 * To document a key: add it to PURPOSES below. Do not hand-edit the table.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..');
const LOCATIONS = join(REPO_ROOT, 'LOCATIONS.md');

const BEGIN = '<!-- BEGIN GENERATED: secrets-inventory -->';
const END = '<!-- END GENERATED: secrets-inventory -->';

const UNKNOWN = '[needs Tyson input]';

/**
 * Known purposes. A key absent from this map renders as [needs Tyson input].
 *
 * Only assert what is actually established in code, a canonical doc, or the
 * build log. A confident-sounding guess in this column is worse than the
 * placeholder: the placeholder gets fixed, a wrong purpose gets trusted.
 */
const PURPOSES = {
  // --- encrypted store ---------------------------------------------------
  agex_private_key: 'AGEX action-signing key for `charlie`. Consumed by `src/tools/executor.js` gates.',
  anthropic_api_key: 'Anthropic API key for Charlie\'s runtime. See `ANTHROPIC_API_SURFACE.md`.',
  ccdispatch_github_token: 'GitHub token for the unprivileged `ccdispatch` user (Slice 5 dispatcher).',
  'claude-code-ig-fix_agex_private_key': 'AGEX signing key for sub-agent `claude-code-ig-fix`.',
  cloudflare_tunnel_token: `Cloudflare Tunnel credential. Tunnel target ${UNKNOWN}.`,
  dashboard_auth_token: 'Dashboard bearer token. Source of truth is `~/.quantumclaw/config.json` `dashboard.authToken`; re-minted by `qclaw dashboard` on 24h expiry.',
  'dispatch-zeta_agex_private_key': 'AGEX signing key for sub-agent `dispatch-zeta`.',
  ghl_api_key: `Legacy unscoped GHL key, predates the per-brand split. Still-in-use status ${UNKNOWN}.`,
  ghl_location_id: `Legacy unscoped GHL location id, pairs with \`ghl_api_key\`. Still-in-use status ${UNKNOWN}.`,
  ghl_crete_api_key: 'GHL private integration token, Crete sub-account. Used by skill `ghl-crete.md`.',
  ghl_crete_location_id: 'GHL location id, Crete sub-account.',
  ghl_flowos_api_key: 'GHL private integration token, Flow OS sub-account. Used by skill `ghl-flowos.md`.',
  ghl_flowos_location_id: 'GHL location id, Flow OS sub-account.',
  ghl_fsc_api_key: 'GHL private integration token, FSC sub-account. Used by skill `ghl-fsc.md`.',
  ghl_fsc_location_id: 'GHL location id, FSC sub-account.',
  ghl_kairos_api_key: 'GHL private integration token, Kairos Wines sub-account. Used by skill `ghl-kairos.md`.',
  ghl_kairos_location_id: 'GHL location id, Kairos Wines sub-account.',
  ghl_sproutcode_api_key: 'GHL private integration token, SproutCode sub-account. Used by skill `ghl-sproutcode.md`.',
  ghl_sproutcode_location_id: 'GHL location id, SproutCode sub-account.',
  'n8n-workflow-fixer_agex_private_key': 'AGEX signing key for sub-agent `n8n-workflow-fixer`.',
  n8n_api_key: `n8n REST API key held in the encrypted store. Relationship to the \`.env\` \`N8N_API_KEY\` ${UNKNOWN}.`,
  n8n_router_token: UNKNOWN,
  patcher_agex_private_key: 'AGEX signing key for sub-agent `patcher`.',
  'post-auditor_agex_private_key': 'AGEX signing key for sub-agent `post-auditor`.',
  stripe_api_key: `Stripe API key. Account and live/test mode ${UNKNOWN}.`,
  telegram_bot_token: 'Charlie\'s Telegram bot token (encrypted-store copy).',

  // --- .env --------------------------------------------------------------
  ANTHROPIC_ADMIN_API_KEY: 'Anthropic Admin Cost API, read by `src/observability/anthropic-spend-poller.js` (Slice 3g). Distinct from the runtime key.',
  ANTHROPIC_API_KEY: 'Anthropic API key for Charlie\'s runtime.',
  ANTHROPIC_ORG_ID: 'Anthropic org id, required alongside the admin key by the spend poller.',
  ASSEMBLYAI_API_KEY: `AssemblyAI transcription. Consumer ${UNKNOWN} (no call site in this repo).`,
  BUZZSPROUT_API_TOKEN: `Buzzsprout podcast API. Which show, and which workflow publishes ${UNKNOWN}.`,
  BUZZSPROUT_PODCAST_ID: `Buzzsprout show id, pairs with \`BUZZSPROUT_API_TOKEN\`. Which show ${UNKNOWN}.`,
  CCDISPATCH_GITHUB_TOKEN: 'GitHub token for the `ccdispatch` dispatcher user (`.env` copy).',
  CONTENT_STUDIO_PUBLISH_TOKEN: `Content Studio publish auth. Consumer ${UNKNOWN}.`,
  CRETE_R2_BUCKET_NAME: 'Cloudflare R2 bucket name, Crete Marketing.',
  CRETE_R2_PUBLIC_URL: 'Cloudflare R2 public base URL, Crete Marketing.',
  DASHBOARD_SESSION_SECRET: 'Session signing secret for the dashboard (`src/dashboard/server.js`).',
  FLOWOS_R2_ACCESS_KEY_ID: 'Cloudflare R2 access key, Flow OS GHL Marketing bucket.',
  FLOWOS_R2_BUCKET_NAME: 'Cloudflare R2 bucket name, Flow OS GHL Marketing.',
  FLOWOS_R2_PUBLIC_URL: 'Cloudflare R2 public base URL, Flow OS GHL Marketing.',
  FLOWOS_R2_SECRET_ACCESS_KEY: 'Cloudflare R2 secret key, Flow OS GHL Marketing bucket.',
  GHL_FLOWOS_NOTIFY_CONTACT_ID: 'GHL contact id that Flow OS notifications are sent to.',
  GHL_FLOWOS_USER_ID: 'GHL user id used as the actor on Flow OS sub-account writes.',
  GHL_FSC_API_KEY: 'GHL private integration token, FSC sub-account (`.env` copy).',
  GHL_FSC_LOCATION_ID: 'GHL location id, FSC sub-account (`.env` copy).',
  GHL_FSC_NOTIFY_CONTACT_ID: 'GHL contact id that FSC notifications are sent to.',
  GHL_FSC_USER_ID: 'GHL user id used as the actor on FSC sub-account writes.',
  META_IG_ACCOUNT_ID: `Instagram account id for Meta Graph publishing. Which brand account ${UNKNOWN}.`,
  META_PAGE_ACCESS_TOKEN: `Meta Page access token. Which page, and expiry policy ${UNKNOWN}.`,
  META_PAGE_ID: `Meta Page id. Which page ${UNKNOWN}.`,
  N8N_API_KEY: 'n8n REST API key. Verified 2026-08-20 to be the key labelled "quantum claw api v2" in n8n (sha256 match).',
  N8N_BASE_URL: 'n8n REST API base URL.',
  N8N_SSH_KEY: 'SSH key path/material for reaching the n8n droplet from qclaw.',
  NOTIFY_EMAIL: `Destination address for email notifications. Which sender/workflow ${UNKNOWN}.`,
  OWNER_TELEGRAM_CHAT_ID: 'Tyson\'s Telegram chat id. Alert destination for Charlie and the trade engine.',
  POLYMARKET_FUNDER_ADDRESS: 'Polymarket funder (share-holding) address. Kept on qclaw after the relay migration because `config.py` `REQUIRED_KEYS` and `get_balance.py` still demand it. Order placement itself uses the relay copy.',
  POLYMARKET_PRIVATE_KEY: 'Polymarket signer key. **Kept in parallel on qclaw, not used for order placement** since the relay migration (Slice-6 removal deferred). The authoritative signing copy lives on the Amsterdam relay.',
  QCLAW_GATES_ENABLED: 'Master kill-switch for the Slice 4 verification gates.',
  QCLAW_SPECIALIST_LIVE_IDS: 'Specialist live-id allowlist. Emptied 2026-08-14, so all `delegate_to` calls route to the stub. Host config, not in git.',
  R2_ACCESS_KEY_ID: `Cloudflare R2 access key, default/unprefixed bucket. Which bucket ${UNKNOWN}.`,
  R2_ACCOUNT_ID: 'Cloudflare R2 account id.',
  R2_BUCKET_NAME: `Cloudflare R2 bucket name, default/unprefixed. Which consumer ${UNKNOWN}.`,
  R2_SECRET_ACCESS_KEY: `Cloudflare R2 secret key, default/unprefixed bucket. Which bucket ${UNKNOWN}.`,
  RELAY_SHARED_SECRET: 'Bearer secret for `POST /execute` on the Amsterdam Polymarket relay. Constant-time compared relay-side, fails closed.',
  RELAY_URL: 'Amsterdam relay base URL. Defaults to `http://68.183.13.219:8000` in `src/trading/execute_trade.py`.',
  SUPABASE_ANON_KEY: 'Supabase anon key, project `fdabygmromuqtysitodp`.',
  SUPABASE_SERVICE_ROLE_KEY: 'Supabase service-role key, project `fdabygmromuqtysitodp`. Required by every service-role-only table (spend, liveness, dispatch, trading).',
  SUPABASE_URL: 'Supabase REST base URL, project `fdabygmromuqtysitodp`.',
  TELEGRAM_BOT_TOKEN: 'Charlie\'s Telegram bot token.',
  TRADE_TELEGRAM_BOT_TOKEN: 'Separate Telegram bot for trade-engine alerts (`src/trade_engine/monitor.py`). Deliberately not Charlie\'s bot.',
  TRADING_WEBHOOK_SECRET: `Shared secret on the trading webhook path. Which caller ${UNKNOWN}.`,
  WP_APP_PASSWORD: `WordPress application password. Which site ${UNKNOWN}.`,
  WP_SITE_URL: `WordPress site base URL. Which site ${UNKNOWN}.`,
  WP_USERNAME: `WordPress username. Which site ${UNKNOWN}.`,

  // --- n8n API keys (labels, not env names) ------------------------------
  'quantum claw api v2': 'QClaw\'s n8n REST access. Confirmed 2026-08-20 to be the same key as `.env` `N8N_API_KEY` (sha256 match). Created 2026-07-01.',
  'manus API': 'Unscoped key polled every 5 min by the Manus-hosted n8n Health Dashboard. **DECOMMISSION-PENDING**: revoke once the heartbeat Telegram alerter is proven. Created 2026-03-16.',
  'MCP Server API Key': `${UNKNOWN}. Created 2026-01-02.`,
  'n8n mcp': `${UNKNOWN}. Created 2025-07-15, the oldest key in the store.`,
  'n8n query key v2': `${UNKNOWN}. Created 2026-04-20.`,
};

const QDIR = join(homedir(), '.quantumclaw');

/** Key names from the encrypted store. Flat JSON: top-level keys are the names. */
function readEncryptedStore() {
  const raw = JSON.parse(readFileSync(join(QDIR, '.secrets.enc'), 'utf8'));
  // Object.keys only. The encrypted values are never touched.
  return Object.keys(raw).sort((a, b) => a.localeCompare(b));
}

/**
 * Key names from .env.
 *
 * Captures only the text LEFT of the first `=`, so a value can never enter the
 * output even by accident. Blank lines and comments are skipped.
 */
function readEnvStore() {
  const text = readFileSync(join(QDIR, '.env'), 'utf8');
  const names = [];
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (m) names.push(m[1]);
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * API key labels from n8n's Postgres, over the `ssh n8n` alias.
 *
 * Selects `label` and `createdAt` only. `apiKey` is never in the query, so the
 * JWT cannot reach this process. Throws on any failure: a table silently
 * missing a third of the estate is the exact failure this script exists to
 * prevent, so an unreachable host must abort the run, not degrade it.
 */
function readN8nStore() {
  const sql =
    'SELECT label FROM user_api_keys ORDER BY label;';
  const out = execFileSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'n8n',
      `docker exec n8n-postgres psql -U n8nuser -d n8n -tAc ${JSON.stringify(sql)}`],
    { encoding: 'utf8', timeout: 30000 }
  );
  const labels = out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (labels.length === 0) throw new Error('n8n returned zero API keys, refusing to emit an empty store');
  return labels.sort((a, b) => a.localeCompare(b));
}

/** Markdown table cell escape. Key names are tame, but a `|` would break the row. */
function cell(s) {
  return String(s).replace(/\|/g, '\\|');
}

function buildTable() {
  const stores = [
    { name: '`.secrets.enc`', where: '`/root/.quantumclaw/.secrets.enc` (qclaw, root 0600)', keys: readEncryptedStore() },
    { name: '`.env`', where: '`/root/.quantumclaw/.env` (qclaw, root 0600)', keys: readEnvStore() },
    { name: 'n8n API keys', where: 'n8n Postgres `user_api_keys` on `157.230.216.158`', keys: readN8nStore() },
  ];

  const total = stores.reduce((n, s) => n + s.keys.length, 0);
  const documented = stores.reduce(
    (n, s) => n + s.keys.filter((k) => PURPOSES[k] && !PURPOSES[k].includes(UNKNOWN)).length, 0
  );

  const lines = [];
  lines.push(`Generated by \`scripts/regen-secrets-inventory.js\`. **Do not hand-edit** this`);
  lines.push(`section; edit the \`PURPOSES\` map in the script and re-run it. Names only, never`);
  lines.push(`values. A key not in the map renders as ${UNKNOWN}, so a newly added`);
  lines.push(`credential surfaces here automatically on the next run.`);
  lines.push('');
  lines.push(`**${total} credentials across 3 stores. ${documented} fully documented, ${total - documented} carrying a ${UNKNOWN} marker.**`);
  lines.push('');

  for (const store of stores) {
    // H4: these nest under the hand-written "### Credential inventory" heading.
    lines.push(`#### ${store.name} (${store.keys.length})`);
    lines.push('');
    lines.push(store.where);
    lines.push('');
    lines.push('| Key | Purpose |');
    lines.push('|---|---|');
    for (const k of store.keys) {
      lines.push(`| \`${cell(k)}\` | ${PURPOSES[k] || UNKNOWN} |`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function main() {
  const args = process.argv.slice(2);
  const table = buildTable();

  if (args.includes('--stdout')) {
    process.stdout.write(`${table}\n`);
    return;
  }

  const doc = readFileSync(LOCATIONS, 'utf8');
  const b = doc.indexOf(BEGIN);
  const e = doc.indexOf(END);
  if (b === -1 || e === -1 || e < b) {
    console.error(`ERROR: markers not found in ${LOCATIONS}. Expected:\n  ${BEGIN}\n  ${END}`);
    process.exit(2);
  }

  const next = `${doc.slice(0, b + BEGIN.length)}\n\n${table}\n\n${doc.slice(e)}`;

  if (args.includes('--check')) {
    if (next !== doc) {
      console.error('STALE: LOCATIONS.md secrets inventory does not match the live stores. Re-run without --check.');
      process.exit(1);
    }
    console.log('OK: secrets inventory is current.');
    return;
  }

  if (next === doc) {
    console.log('No change: secrets inventory already current.');
    return;
  }
  writeFileSync(LOCATIONS, next);
  console.log(`Rewrote secrets inventory in ${LOCATIONS}`);
}

main();
