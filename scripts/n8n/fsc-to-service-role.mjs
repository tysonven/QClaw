#!/usr/bin/env node
/**
 * Repoint n8n nodes off the "Supabase FSC" credential (Nd2uuX5t9KEwbQPv — which
 * hardcodes the ANON key) onto the fixed service-role credential
 * fgbywZowo5p5iu9F ("Supabase Service Role (main)"), per
 * docs/runbooks/supabase-service-role-cred-fix-2026-07-14.md.
 *
 * PURE LOCAL TRANSFORM — never connects to n8n. Reads exported `nodes` JSON
 * (workflow_entity.nodes) and rewrites the FSC-cred'd httpRequest nodes:
 *   - credentials.httpHeaderAuth (FSC)  ->  credentials.httpCustomAuth (fgbyw)
 *   - authentication = genericCredentialType ; genericAuthType = httpCustomAuth
 *   - strip inline `apikey` / `Authorization` header params (incl. the broken
 *     `apikey=undefined` in Weekly Analyst); keep Content-Type / Prefer / Accept.
 * Applying the result to the live DB is a separate, manual psql step (runbook).
 *
 * Usage:
 *   node fsc-to-service-role.mjs --in <exportDir>            # dry-run report
 *   node fsc-to-service-role.mjs --in <dir> --out <dir>      # write transformed nodes
 * Idempotent: nodes already on httpCustomAuth are skipped.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const FSC_ID = "Nd2uuX5t9KEwbQPv";           // "Supabase FSC" (httpHeaderAuth = anon key)
const CRED_ID = "fgbywZowo5p5iu9F";           // fixed service-role cred
const CRED_NAME = "Supabase Service Role (main)";

const args = (() => {
  const a = { in: null, out: null };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "--in") a.in = v[++i];
    else if (v[i] === "--out") a.out = v[++i];
  }
  return a;
})();
if (!args.in) { console.error("usage: fsc-to-service-role.mjs --in <dir> [--out <dir>]"); process.exit(2); }
const dryRun = !args.out;
if (args.out && !existsSync(args.out)) mkdirSync(args.out, { recursive: true });

const isAuthHeader = (name) => /^(apikey|authorization)$/i.test(String(name));

/** Transform one node in place; return a change record or null. */
function migrateNode(node) {
  if (node.type !== "n8n-nodes-base.httpRequest") return null;
  const creds = node.credentials || {};
  if (creds.httpHeaderAuth?.id !== FSC_ID) return null; // only FSC-cred'd nodes

  const pr = node.parameters || (node.parameters = {});
  const params = pr.headerParameters?.parameters;
  let removed = [];
  if (Array.isArray(params)) {
    removed = params.filter((h) => isAuthHeader(h.name)).map((h) => `${h.name}=${String(h.value).slice(0, 12)}`);
    const kept = params.filter((h) => !isAuthHeader(h.name));
    if (kept.length) { pr.headerParameters.parameters = kept; pr.sendHeaders = true; }
    else { delete pr.headerParameters; if ("sendHeaders" in pr) pr.sendHeaders = false; }
  }
  pr.authentication = "genericCredentialType";
  pr.genericAuthType = "httpCustomAuth";
  delete creds.httpHeaderAuth;
  creds.httpCustomAuth = { id: CRED_ID, name: CRED_NAME };
  node.credentials = creds;

  const table = String(pr.url || "").replace(/.*\/rest\/v1\//, "").replace(/\?.*/, "").slice(0, 30);
  return { node: node.name, method: pr.method || "GET", table, removed };
}

const files = readdirSync(args.in).filter((f) => f.endsWith(".nodes.json")).sort();
let totalNodes = 0, totalWf = 0;
console.log(`FSC -> service-role transform  (${dryRun ? "DRY-RUN — no files written" : "WRITE -> " + args.out})`);
console.log(`  ${FSC_ID} (FSC/anon)  ->  ${CRED_ID} ("${CRED_NAME}")\n`);
for (const f of files) {
  const id = f.replace(".nodes.json", "");
  const nodes = JSON.parse(readFileSync(join(args.in, f), "utf8"));
  const changes = nodes.map(migrateNode).filter(Boolean);
  if (!changes.length) { console.log(`• ${id}: no FSC nodes (skip)`); continue; }
  totalWf++; totalNodes += changes.length;
  console.log(`• ${id}: ${changes.length} node(s)`);
  for (const c of changes) {
    console.log(`    [${c.method}] "${c.node}" -> ${c.table}  (FSC→fgbyw${c.removed.length ? `, -headers[${c.removed.join(",")}]` : ""})`);
  }
  if (!dryRun) writeFileSync(join(args.out, f), JSON.stringify(nodes));
}
console.log(`\nsummary: ${totalNodes} FSC node(s) across ${totalWf} workflow(s) repointed to service-role.`);
