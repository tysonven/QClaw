---
name: ghl-fsc
category: on-demand
surface: both
keywords: [fsc, "flow states", "flow states collective", coaching, emma, members, "fsc contact", "fsc lead", "fsc opportunity"]
tools: [ghl_fsc__search_contacts, ghl_fsc__get_contact, ghl_fsc__list_opportunities]
description: FSC GoHighLevel CRM — contacts and opportunities (read-only this slice; write tools deferred pending an approval gate)
---

# GoHighLevel — Flow States Collective (FSC)

<!--
  Replica of the Flow OS `ghl` skill, scoped to the Flow States Collective
  GHL location (secrets.ghl_fsc_location_id). This is the TEMPLATE pattern for
  the remaining brands (Flow OS, Crete, SproutCode) — copy this file and swap
  the secret key names (ghl_<brand>_api_key / ghl_<brand>_location_id).

  READ-ONLY this slice. Write endpoints (create/update contact, add note,
  create task, email draft) are DEFERRED. Skill-defined HTTP write tools are
  currently ungated — ApprovalGate.check() only gates shell_exec, destructive
  shell verbs and Stripe charges, so a skill write tool would return
  requiresApproval:false and execute autonomously. Writes must route through an
  approval gate before FSC write endpoints are enabled here, otherwise Charlie
  could fire external-CRM writes without Tyson's approval, which violates the
  "surface proposals, never autonomous" constraint. See the matching TODO in
  src/security/approval-gate.js.
-->

## Auth
Base URL: https://services.leadconnectorhq.com
Header: Authorization: Bearer {{secrets.ghl_fsc_api_key}}
Header: Version: 2021-07-28
Header: Location-Id: {{secrets.ghl_fsc_location_id}}

## Endpoints
GET /contacts/?locationId={{secrets.ghl_fsc_location_id}}&query={{query}} - Search FSC contacts by name, email or phone
GET /contacts/{{contact_id}} - Get a single FSC contact by ID
GET /opportunities/search?location_id={{secrets.ghl_fsc_location_id}} - List FSC opportunities

## Permissions
- http: [services.leadconnectorhq.com]
- shell: none
- file: none

## Usage Notes
- Read-only surface. Write endpoints (create/update contact, add note, create task, email draft) are DEFERRED this slice — they require an approval gate on skill HTTP write tools before they can be enabled (see the header comment and the TODO in src/security/approval-gate.js).
- Always search by email before proposing to create a contact (dedup rule) — this carries into the write slice; never create a contact without a prior email search.
- Location scoping is per-endpoint: contacts require the `locationId` query parameter (camelCase); opportunities require `location_id` (snake_case). The Location-Id header alone is not sufficient for these two endpoints.
- Email in GHL cannot be sent to arbitrary addresses — the conversations/messages endpoint requires a contactId, so a contact must exist first. GHL_FSC_NOTIFY_CONTACT_ID (.env) is Tyson's internal FSC contact used for operator notifications.
- British English in all notes and communications.
- This file is the template for Flow OS, Crete and SproutCode — replicate it with the matching per-brand secret key names.
