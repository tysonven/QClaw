---
title: Clipper
---

# Clipper Skill

Charlie uses this skill to trigger and monitor video clip generation
for podcast episodes.

## Service

Clipper worker: http://localhost:4002
PM2 process: clipper-worker
Source: /root/QClaw/src/clipper/main.py

## Endpoints

POST /clip — start a clip job
GET  /clip/{job_id} — check job status and get results
GET  /health — verify service is running

## Triggering a Clip Job

Required fields:
- video_url: public R2 URL of the source video
- transcript: AssemblyAI words array (word-level timestamps)
- episode_title: for job tracking
- num_clips: number of clips to generate (default 5)
- caption_style: optional, defaults to white Montserrat on black

Returns: { job_id, status: "queued" }

## Checking Job Status

GET /clip/{job_id} returns full job record.
Status values: queued | processing | complete | error

When complete, clips array contains:
[{
  clip_url: R2 public URL,
  start_ms, end_ms,
  caption_text,
  virality_score,
  hook_title
}]

Jobs also stored in Supabase table: clip_jobs
(project fdabygmromuqtysitodp)

## Caption Style Options

font, font_size, color (hex), outline_color (hex), outline_width,
position (bottom/top/center), highlight_color (hex),
animation (word_by_word/static)

Default preset: white Montserrat Bold, gold word highlights,
black outline, bottom position.

## Rules

1. Always check clipper-worker is running before triggering jobs.
2. Clip jobs are async — always poll until complete, do not assume 
   instant completion. Large videos can take 2-5 minutes.
3. If status is "error", check error_message field and report to Tyson.
4. Clip files are stored at R2 path: clips/{job_id}/clip_{n}.mp4
5. Never delete clip files from R2 without explicit instruction.
