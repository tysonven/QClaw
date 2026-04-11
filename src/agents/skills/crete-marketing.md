# Crete Marketing

## Overview
Crete Projects marketing content queue. Dashboard tab at agentboardroom.flowos.tech (🌿 Crete Marketing).

## Supabase Table
`crete_content_queue` — stores generated marketing content for review.
- Status values: pending_review, approved, rejected, published, failed
- Platforms: instagram, facebook, linkedin, ghl_email, wordpress

## How to check for pending content
Query Supabase:
GET https://fdabygmromuqtysitodp.supabase.co/rest/v1/crete_content_queue?status=eq.pending_review&order=created_at.desc
Headers: Authorization + apikey (same as other Supabase calls)

## What to tell Tyson
- If items are pending: "You have [N] Crete content items waiting for review at agentboardroom.flowos.tech"
- If nothing pending: "No Crete content pending review right now"

## Related systems
- n8n workflows generate content on schedule and handle publish/regenerate
- Dashboard approve/reject buttons trigger n8n webhooks
- Telegram notifications fire on new pending_review items
