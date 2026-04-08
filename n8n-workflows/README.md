# n8n Workflow Backups

These JSON files are exported backups of all QClaw n8n workflows.
Update after every workflow change with:
  curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
    "https://webhook.flowos.tech/api/v1/workflows/{ID}" \
    > {filename}.json

To restore after data loss, import via n8n UI or API.
