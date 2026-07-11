#!/usr/bin/env node
/**
 * Phase 1 — migrate n8n workflow nodes off the Supabase publishable anon key onto the
 * service-role key, per docs/runbooks/supabase-anon-rls-remediation-2026-07-11.md.
 *
 * PURE LOCAL TRANSFORM. This script NEVER connects to n8n or the database. It reads
 * exported `nodes` JSON (the value of workflow_entity.nodes), rewrites the Supabase nodes,
 * and (optionally) writes the transformed JSON to an output dir. Applying the result to the
 * live n8n DB is a separate, manual psql step in the runbook — nothing here touches prod.
 *
 * Two node shapes are handled:
 *   1. httpRequest nodes with inline `apikey` / `Authorization: Bearer {{$env.SUPABASE_ANON_KEY}}`
 *      headers  -> switch to a reusable httpCustomAuth credential (which injects both headers
 *      from the service-role key). Inline anon headers are removed; Content-Type/Prefer kept.
 *      The no-op "Supabase FSC" httpHeaderAuth credential (Nd2uuX5t9KEwbQPv) is dropped.
 *   2. code nodes that reference `$env.SUPABASE_ANON_KEY` in jsCode (Trading Position Monitor)
 *      -> swap the env var to `$env.SUPABASE_SERVICE_ROLE_KEY` in place. Code nodes cannot use
 *      an n8n credential for arbitrary fetch(), so the env var is the migration point.
 *
 * Usage:
 *   # dry-run report only (no writes):
 *   node phase1-anon-to-service-role.mjs --in <exportDir>
 *   # produce transformed nodes for deploy:
 *   node phase1-anon-to-service-role.mjs --in <exportDir> --out <outDir> \
 *        --cred-id <n8nCredentialId> --cred-name "Supabase Service Role (main)"
 *
 * <exportDir> holds one `<workflowId>.nodes.json` per workflow (read-only export via psql).
 * Idempotent: nodes already on httpCustomAuth / already swapped are reported as "skip".
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ANON = "SUPABASE_ANON_KEY";
const SERVICE = "SUPABASE_SERVICE_ROLE_KEY";
const FSC_NOOP_CRED_ID = "Nd2uuX5t9KEwbQPv"; // empty httpHeaderAuth "Supabase FSC" — a no-op, safe to drop

function parseArgs(argv) {
  const a = { in: null, out: null, credId: "__CRED_ID__", credName: "Supabase Service Role (main)" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--in") a.in = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--cred-id") a.credId = argv[++i];
    else if (k === "--cred-name") a.credName = argv[++i];
  }
  return a;
}

const isAnonValue = (v) => typeof v === "string" && v.includes(ANON);

/** Transform one node in place. Returns a change record, or null if the node is untouched. */
function migrateNode(node, credId, credName) {
  // ---- Shape 2: code node using $env.SUPABASE_ANON_KEY ----
  if (node.type === "n8n-nodes-base.code") {
    const code = node.parameters?.jsCode;
    if (typeof code === "string" && code.includes(ANON)) {
      const count = (code.match(new RegExp(ANON, "g")) || []).length;
      node.parameters.jsCode = code.split(ANON).join(SERVICE);
      return { node: node.name, kind: "code", detail: `swapped ${count}× $env.${ANON} -> $env.${SERVICE}` };
    }
    return null;
  }

  // ---- Shape 1: httpRequest node with inline anon headers ----
  if (node.type !== "n8n-nodes-base.httpRequest") return null;
  const pr = node.parameters || (node.parameters = {});
  const params = pr.headerParameters?.parameters;
  if (!Array.isArray(params)) return null;
  if (!params.some((h) => isAnonValue(h.value))) return null; // no anon header -> skip (idempotent)

  const removed = params
    .filter((h) => (h.name === "apikey" || h.name === "Authorization") && isAnonValue(h.value))
    .map((h) => h.name);
  const kept = params.filter((h) => !((h.name === "apikey" || h.name === "Authorization") && isAnonValue(h.value)));

  // Defensive: any anon-valued header we did NOT remove (unexpected name) is flagged, not silently kept.
  const strays = kept.filter((h) => isAnonValue(h.value)).map((h) => h.name);

  if (kept.length) {
    pr.headerParameters.parameters = kept;
    pr.sendHeaders = true;
  } else {
    delete pr.headerParameters;
    pr.sendHeaders = false;
  }
  pr.authentication = "genericCredentialType";
  pr.genericAuthType = "httpCustomAuth";

  const creds = node.credentials || (node.credentials = {});
  let droppedFsc = false;
  if (creds.httpHeaderAuth && creds.httpHeaderAuth.id === FSC_NOOP_CRED_ID) {
    delete creds.httpHeaderAuth;
    droppedFsc = true;
  }
  creds.httpCustomAuth = { id: credId, name: credName };

  return {
    node: node.name,
    kind: "http",
    method: pr.method || "GET",
    removed,
    kept: kept.map((h) => h.name),
    droppedFsc,
    strays,
  };
}

function migrateNodes(nodes, credId, credName) {
  const changes = [];
  for (const node of nodes) {
    const c = migrateNode(node, credId, credName);
    if (c) changes.push(c);
  }
  return changes;
}

// ---- CLI ----
const args = parseArgs(process.argv.slice(2));
if (!args.in) {
  console.error("usage: node phase1-anon-to-service-role.mjs --in <dir> [--out <dir>] [--cred-id ID] [--cred-name NAME]");
  process.exit(2);
}
const dryRun = !args.out;
if (!dryRun && args.credId === "__CRED_ID__") {
  console.error("refusing to write with placeholder --cred-id. Pass the real n8n credential id (create the credential first).");
  process.exit(1);
}
if (args.out && !existsSync(args.out)) mkdirSync(args.out, { recursive: true });

const files = readdirSync(args.in).filter((f) => f.endsWith(".nodes.json")).sort();
let totalHttp = 0, totalCode = 0, totalStray = 0;

console.log(`Phase 1 anon->service-role transform  (${dryRun ? "DRY-RUN — no files written" : "WRITE mode -> " + args.out})`);
console.log(`credential: httpCustomAuth id=${args.credId} name="${args.credName}"\n`);

for (const f of files) {
  const id = f.replace(".nodes.json", "");
  const nodes = JSON.parse(readFileSync(join(args.in, f), "utf8"));
  const changes = migrateNodes(nodes, args.credId, args.credName);
  if (!changes.length) { console.log(`• ${id}: no anon nodes (skip)`); continue; }

  console.log(`• ${id}: ${changes.length} node(s) changed`);
  for (const c of changes) {
    if (c.kind === "code") {
      totalCode++;
      console.log(`    [code] "${c.node}": ${c.detail}`);
    } else {
      totalHttp++;
      console.log(`    [http ${c.method}] "${c.node}": -headers[${c.removed.join(",")}] +httpCustomAuth` +
        `${c.kept.length ? ` keep[${c.kept.join(",")}]` : " sendHeaders=false"}${c.droppedFsc ? " (dropped FSC no-op)" : ""}`);
      if (c.strays.length) { totalStray++; console.log(`    ⚠️  STRAY anon header not removed: ${c.strays.join(",")} — review`); }
    }
  }
  if (!dryRun) writeFileSync(join(args.out, f), JSON.stringify(nodes));
}

console.log(`\nsummary: ${totalHttp} httpRequest node(s) -> httpCustomAuth, ${totalCode} code node(s) env-swapped` +
  `${totalStray ? `, ${totalStray} STRAY (needs review)` : ""}.`);
