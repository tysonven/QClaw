---
title: Content Studio
---

# Content Studio Skill

Charlie uses this skill to trigger, monitor, and report on Emma Maidment's
content pipeline.

## Pipeline Overview

One webhook call takes a podcast episode from R2 storage to:
- Buzzsprout (audio upload)
- AssemblyAI (transcription)
- WordPress (HTML blog draft)
- Substack (newsletter draft)
- LinkedIn (posted via Blotato)
- YouTube (unlisted upload)
- Supabase (job record with all URLs)
- Telegram (start + completion notifications)

## Triggering a Run

Workflow ID: Qf39NEOEgz2W0uls
Webhook: POST https://webhook.flowos.tech/webhook/content-studio

Required body:
{
  "episodeTitle": "Episode title here",
  "episodeDescription": "Short description",
  "r2FileKey": "episodes/FILENAME.mp4",
  "chatId": 1375806243
}

r2FileKey must be the exact path of the video in Cloudflare R2.
The pipeline takes ~3-5 minutes due to AssemblyAI transcription.

## Checking Job Status

Table: content_studio_jobs (Supabase project fdabygmromuqtysitodp)
Key columns: status, wordpress_post_url, youtube_url, buzzsprout_episode_id,
             linkedin_post_url, transcript_text, clip_selections

Query recent jobs:
GET /rest/v1/content_studio_jobs?order=created_at.desc&limit=10

Status values: processing | complete | error

## Key Services & Credentials

- Buzzsprout account: 1946225 (Emma's podcast feed)
- LinkedIn: posts to Emma's personal profile (member ID 194094731) via Blotato
- YouTube: uploads to Emma's channel (UCvUdyddTC_Njz52NNotKQWw), unlisted by default
- WordPress: flowstatescollective.com, posts as draft
- Substack: draft only, Emma publishes manually

## Content Rules (hardcoded in prompts)

- All content written in first person as Emma Maidment
- No em dashes anywhere
- No hashtags
- Blog post: Sonnet model (best quality)
- Substack + LinkedIn: Haiku model (speed + cost)

## Rules

1. Never trigger the pipeline without a valid r2FileKey — the file must
   already be uploaded to R2 before calling the webhook.
2. YouTube videos are unlisted after upload — Emma must manually publish.
3. If a job shows status "error", check the error_message column in Supabase
   before re-triggering.
4. Do not hardcode Buzzsprout IDs, WordPress post IDs, or YouTube video IDs
   in any responses — always fetch from Supabase job record.
