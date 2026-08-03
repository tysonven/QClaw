# n8n invalid resource/operation audit

n8n emits `{}` instead of erroring when a node is configured with a `resource` or
`operation` value that does not exist on its node type. The failure is silent at
runtime, so this defect class is invisible by default. Found 2026-08-03 via
`LinkedIn Feed Monitor` (`operation: "getAll"` on a node that only declares
`operation: create`), which had been returning `{}` for the life of the workflow.

## Usage

1. Extract ground truth from the running container (loads every installed node
   class and reads `description.properties` — core packages *and* community
   nodes under `~/.n8n/nodes/node_modules`):

   ```sh
   docker cp extract_nodedefs.js <n8n-container>:/tmp/
   docker exec <n8n-container> node /tmp/extract_nodedefs.js > nodedefs.json
   ```

2. Dump all workflows next to it as `all_wf.json`:

   ```sh
   curl -sS -H "X-N8N-API-KEY: $N8N_API_KEY" \
     'https://webhook.flowos.tech/api/v1/workflows?limit=250' > all_wf.json
   ```

3. Audit:

   ```sh
   python3 audit_resources.py          # writes audit_findings.json
   ```

## Notes

- Node-type lookup **must** be case-insensitive: workflows store
  `n8n-nodes-base.youtube` while the node declares itself `youTube`.
- Nodes whose `resource`/`operation` is an n8n expression (`=...`) are skipped —
  they cannot be resolved statically.
- Severity keys off `workflow.active`: a defect in an active workflow is CRITICAL.
- Exit is informational; wire a non-zero exit on CRITICAL if used as a CI gate.

## Baseline (2026-08-03)

1248 nodes / 81 workflows / 544 node types / 0 unrecognised types / 0 load errors
→ 3 defects, all in `LinkedIn Engagement Automation`, all `n8n-nodes-base.linkedIn`.
