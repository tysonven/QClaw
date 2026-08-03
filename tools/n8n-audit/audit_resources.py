#!/usr/bin/env python3
"""Finding C — instance-wide audit for nodes whose resource/operation values
do not exist on their node type.

n8n emits {} instead of erroring for an unknown operation, so this defect class
is invisible at runtime. Ground truth comes from extract_nodedefs.js, which
loads the compiled node classes inside the container and reads
description.properties — not from a hand-maintained list.

Reports counts and severity only.
"""
import json, os, collections

_HERE = os.path.dirname(os.path.abspath(__file__))
_RAW = json.load(open(os.path.join(_HERE, 'nodedefs.json')))['nodeTypes']
# n8n resolves node types case-insensitively (workflows store
# 'n8n-nodes-base.youtube'; the node declares itself as 'youTube').
DEFS_CI = {k.lower(): v for k, v in _RAW.items()}
DEFS = _RAW
WFS = json.load(open(os.path.join(_HERE, 'all_wf.json')))['data']


def is_expr(v):
    return isinstance(v, str) and v.startswith('=')


findings = []
skipped_expr = 0
unknown_type = collections.Counter()

for wf in WFS:
    for n in wf.get('nodes') or []:
        t = n.get('type', '')
        d = DEFS_CI.get(t.lower())
        if d is None:
            unknown_type[t] += 1
            continue
        # node type has no resource/operation concept at all
        if not d['resources'] and not d['operations']:
            continue

        p = n.get('parameters') or {}
        res, op = p.get('resource'), p.get('operation')
        if is_expr(res) or is_expr(op):
            skipped_expr += 1
            continue
        eff_res = res if res is not None else d.get('defaultResource')

        problems = []
        if res is not None and d['resources'] and res not in d['resources']:
            problems.append(('invalid_resource', res, d['resources']))
        if op is not None and d['operations'] and op not in d['operations']:
            problems.append(('invalid_operation', op, d['operations']))
        # operation exists somewhere on the node but not under this resource
        if (op is not None and not any(k == 'invalid_operation' for k, _, _ in problems)
                and eff_res and d['opsByResource']):
            allowed = set(d['opsByResource'].get(eff_res, [])) | set(d['opsByResource'].get('*', []))
            if allowed and op not in allowed:
                problems.append(('operation_wrong_resource', f'{eff_res}/{op}', sorted(allowed)))

        for kind, bad, valid in problems:
            sev = ('CRITICAL' if (wf.get('active') and kind != 'operation_wrong_resource')
                   else 'HIGH' if wf.get('active')
                   else 'MEDIUM')
            findings.append({'severity': sev, 'kind': kind, 'workflow': wf.get('name'),
                             'workflow_id': wf.get('id'), 'active': bool(wf.get('active')),
                             'node': n.get('name'), 'type': t, 'bad': bad, 'valid': valid})

json.dump(findings, open(os.path.join(_HERE, 'audit_findings.json'), 'w'), indent=2)

print(f"workflows scanned      : {len(WFS)}")
print(f"nodes scanned          : {sum(len(w.get('nodes') or []) for w in WFS)}")
print(f"node types with defs   : {len(DEFS)}")
print(f"skipped (expression)   : {skipped_expr}")
print(f"unrecognised node types: {len(unknown_type)} distinct"
      + (f"  e.g. {list(unknown_type)[:3]}" if unknown_type else ""))
print()
print(f"TOTAL DEFECTS          : {len(findings)}")
by_sev = collections.Counter(f['severity'] for f in findings)
for s in ('CRITICAL', 'HIGH', 'MEDIUM'):
    if by_sev.get(s):
        print(f"  {s:9s}: {by_sev[s]}")
print()
by_kind = collections.Counter(f['kind'] for f in findings)
for k, c in by_kind.most_common():
    print(f"  {k:26s}: {c}")
print()
aw = {f['workflow'] for f in findings if f['active']}
iw = {f['workflow'] for f in findings if not f['active']}
print(f"distinct workflows affected: {len(aw | iw)}  ({len(aw)} active, {len(iw)} inactive)")
print(f"distinct node types affected: {len({f['type'] for f in findings})}")
