# n8n Router
## Auth
Base URL: https://webhook.flowos.tech
Header: X-QCLAW-TOKEN: {{secrets.n8n_router_token}}
## Endpoints
POST /webhook/qclaw-router - Route operational actions to n8n workflows
POST /webhook/qclaw-google-sheets - Append/read Google Sheets ops data
POST /webhook/qclaw-trello - Create/update Trello cards
POST /webhook/qclaw-social - Queue social publishing (FB/IG/LinkedIn)
POST /webhook/qclaw-wordpress - Draft/publish WordPress content
POST /webhook/qclaw-youtube - Trigger YouTube metadata workflows
## Payload Format
All requests to /webhook/qclaw-router must send a flat JSON body:
{"action": "social"}
{"action": "content"}
{"action": "contact"}
Never nest the payload inside a "data" key. Never stringify the JSON. Send flat JSON directly.
## Permissions
- http: [webhook.flowos.tech]
- shell: none
- file: none
## Usage Notes
- Use this instead of direct API calls when n8n has existing workflows
- All webhooks expect JSON payloads
- Social/WordPress posts should be queued for review unless explicitly told to publish live
- Check workflow execution status via n8n UI if webhook returns 200 but action doesn't complete
