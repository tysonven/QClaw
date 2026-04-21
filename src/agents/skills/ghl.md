# GoHighLevel CRM
## Auth
Base URL: https://services.leadconnectorhq.com
Header: Authorization: Bearer {{secrets.ghl_api_key}}
Header: Version: 2021-07-28
Header: Location-Id: {{secrets.ghl_location_id}}
## Endpoints
GET /contacts/?locationId={{secrets.ghl_location_id}}&limit=25 - List contacts
GET /contacts/search?locationId={{secrets.ghl_location_id}}&query={{query}} - Search contacts by name/email
GET /contacts/{{contact_id}} - Get contact by ID
POST /contacts/ - Create contact
PUT /contacts/{{contact_id}} - Update contact
GET /opportunities/search?locationId={{secrets.ghl_location_id}} - Search opportunities
POST /opportunities/ - Create opportunity
POST /tasks/ - Create task
POST /notes/ - Create note
## Permissions
- http: [services.leadconnectorhq.com]
- shell: none
- file: none
## Usage Notes
- Always check for duplicate contacts before creating (search by email/phone)
- Location-Id header is required for all requests
- Use British English in notes/communications
