# Ads Agency

## Overview
Route all ad creation, copy, research and optimisation requests to the n8n ads agency workflows via webhook.

## Endpoints
Base URL: https://webhook.flowos.tech

POST /webhook/ad-creation-agent - Full conversational ad creation flow (account → campaign → copy → asset → build)
POST /webhook/meta-ads-copy-agent - Generate 5 ad copy variants
POST /webhook/meta-ads-creative-brief - Generate a creative brief for a video ad
POST /webhook/competitor-research - Research competitor ad strategies or manage swipe file

## Routing
When user says "create ad", "make ad", or "build ad":
- Call POST https://webhook.flowos.tech/webhook/ad-creation-agent
- Include in payload: the user's chatId (1375806243), userId, and their exact message
- Tell the user: "Starting ad creation — check Telegram for the conversation flow"

When user says "research [brand]", "competitor research", or "swipe file":
- Call POST https://webhook.flowos.tech/webhook/competitor-research
- Body: {"chatId": 1375806243, "userId": 1375806243, "text": "[exact user message]", "brand": "[extract brand name — everything after 'research ']", "researchIntent": "research"}
- If user says "research Nike", brand = "Nike", researchIntent = "research"
- If user says "swipe file", researchIntent = "list"
- Tell the user: "Scout is researching — check Telegram for results"

## When to use
- User says "create ad", "make an ad", "build an ad" → POST /webhook/ad-creation-agent
- User says "write copy", "ad copy", "copy variants" → POST /webhook/meta-ads-copy-agent
- User says "creative brief", "video brief", "reel brief" → POST /webhook/meta-ads-creative-brief
- User says "research [brand]", "swipe file", "competitor ads" → POST /webhook/competitor-research

## Payload Format
All endpoints accept JSON. For ad-creation-agent, forward the user's chatId, userId, and message text.

For copy agent:
{"offer": "...", "angle": "...", "audience": "coaches and health professionals", "platform": "Meta", "format": "feed ad", "creator": "tyson or emma"}

For competitor research:
{"chatId": 1375806243, "userId": 1375806243, "text": "research [brand name]", "brand": "[brand name]", "researchIntent": "research"}

## Permissions
- http: [webhook.flowos.tech]
- shell: none
- file: none
