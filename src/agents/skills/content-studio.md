---
name: content-studio
category: on-demand
surface: prompt
keywords: [content, podcast, reel, buzzsprout]
description: Route podcast episode processing to n8n content-studio pipeline (combination trigger Emma + keyword in router)
---

# Content Studio

## Routing
When user says "new episode", "episode uploaded", "process episode", 
or "content studio [filename]":
POST https://webhook.flowos.tech/webhook/content-studio-pipeline
Body: {
  "r2FileKey": "episodes/[filename]",
  "episodeTitle": [extract title if mentioned, else ask],
  "episodeDescription": [extract description if mentioned, else ""],
  "chatId": 1375806243
}

## Permissions
- http: [webhook.flowos.tech]
