/* Runs INSIDE the n8n container.
 * Loads every installed node's compiled description and emits, per node type,
 * the declared `resource` values and the declared `operation` values together
 * with the resources each operation is scoped to via displayOptions.
 * Output: single JSON blob on stdout.
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['/usr/local/lib/node_modules/n8n/node_modules', '/home/node/.n8n/nodes/node_modules'];
// discover every package that declares n8n nodes, core + community
const PKGS = [];
for (const R of ROOTS) {
  let tops = [];
  try { tops = fs.readdirSync(R); } catch (e) { continue; }
  for (const t of tops) {
    if (t.startsWith('@')) {
      let subs = []; try { subs = fs.readdirSync(path.join(R, t)); } catch (e) {}
      for (const s2 of subs) PKGS.push([R, `${t}/${s2}`]);
    } else PKGS.push([R, t]);
  }
}

const out = {};
const errors = [];

function collect(desc, typeName) {
  if (!desc || !Array.isArray(desc.properties)) return;
  const entry = out[typeName] || { resources: new Set(), operations: new Set(), opsByResource: {} };
  for (const p of desc.properties) {
    if (p.name !== 'resource' && p.name !== 'operation') continue;
    const opts = Array.isArray(p.options) ? p.options : [];
    const vals = opts.map(o => o.value).filter(v => typeof v === 'string');
    if (p.name === 'resource') {
      vals.forEach(v => entry.resources.add(v));
    } else {
      vals.forEach(v => entry.operations.add(v));
      // which resource(s) is this operation block shown for?
      const show = p.displayOptions && p.displayOptions.show;
      const forRes = (show && Array.isArray(show.resource)) ? show.resource : ['*'];
      for (const r of forRes) {
        entry.opsByResource[r] = entry.opsByResource[r] || new Set();
        vals.forEach(v => entry.opsByResource[r].add(v));
      }
    }
  }
  // default resource (used when a workflow node omits `resource`)
  const rp = desc.properties.find(p => p.name === 'resource');
  if (rp && typeof rp.default === 'string') entry.defaultResource = rp.default;
  out[typeName] = entry;
}

for (const [ROOT, pkg] of PKGS) {
  let pj;
  try { pj = JSON.parse(fs.readFileSync(path.join(ROOT, pkg, 'package.json'), 'utf8')); }
  catch (e) { continue; }
  const nodeFiles = (pj.n8n && pj.n8n.nodes) || [];
  if (!nodeFiles.length) continue;
  for (const rel of nodeFiles) {
    const abs = path.join(ROOT, pkg, rel);
    let mod;
    try { mod = require(abs); }
    catch (e) { errors.push(`${rel}: ${e.message.slice(0, 90)}`); continue; }
    for (const key of Object.keys(mod)) {
      const Cls = mod[key];
      if (typeof Cls !== 'function') continue;
      let inst;
      try { inst = new Cls(); } catch (e) { continue; }
      // plain node
      if (inst.description && inst.description.name) {
        const t = `${pkg}.${inst.description.name}`;
        collect(inst.description, t);
      }
      // versioned node: description on the wrapper, real descs in nodeVersions
      if (inst.nodeVersions) {
        const base = inst.baseDescription || inst.description || {};
        const t = `${pkg}.${base.name}`;
        for (const v of Object.keys(inst.nodeVersions)) {
          const nv = inst.nodeVersions[v];
          if (nv && nv.description) collect(nv.description, t);
        }
      }
    }
  }
}

const ser = {};
for (const [k, v] of Object.entries(out)) {
  ser[k] = {
    resources: [...v.resources].sort(),
    operations: [...v.operations].sort(),
    defaultResource: v.defaultResource || null,
    opsByResource: Object.fromEntries(
      Object.entries(v.opsByResource).map(([r, s]) => [r, [...s].sort()])),
  };
}
process.stdout.write(JSON.stringify({ nodeTypes: ser, loadErrors: errors.slice(0, 15) }));
