"""
QClaw Clipper — Automated viral clip extraction microservice.

Takes podcast video files, uses Claude to select viral segments,
cuts them with FFmpeg, burns captions, and uploads to R2.
"""

import os
import re
import json
import uuid
import glob
import subprocess
import threading
import logging
from datetime import datetime, timezone
from typing import Optional, List

import httpx
import anthropic
import boto3
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

def load_env(path: str):
    """Parse a .env file into os.environ (no dotenv dependency)."""
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip())
    except FileNotFoundError:
        pass

load_env("/root/.quantumclaw/.env")

R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://fdabygmromuqtysitodp.supabase.co")
SUPABASE_ANON_KEY = os.environ.get(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZkYWJ5Z21yb211cXR5c2l0b2RwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk2NjI2OTQsImV4cCI6MjA3NTIzODY5NH0.6JJMkPXBufpLxlisH1ig32Xm8YM3p0jcXRlBzx5x8Dk",
)

R2_PUBLIC_BASE = "https://pub-70c436931e9e4611a135e7405c596611.r2.dev"

if not ANTHROPIC_API_KEY:
    raise RuntimeError("ANTHROPIC_API_KEY not set")

# ---------------------------------------------------------------------------
# Clients
# ---------------------------------------------------------------------------

claude = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name="auto",
)

log = logging.getLogger("clipper")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

SUPA_HEADERS = {
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "apikey": SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
}

def supa_url(path: str = "") -> str:
    return f"{SUPABASE_URL}/rest/v1/clip_jobs{path}"

def db_insert(record: dict) -> dict:
    headers = {**SUPA_HEADERS, "Prefer": "return=representation"}
    r = httpx.post(supa_url(), headers=headers, json=record, timeout=30)
    r.raise_for_status()
    return r.json()[0]

def db_update(job_id: str, patch: dict) -> dict:
    patch["updated_at"] = _now()
    headers = {**SUPA_HEADERS, "Prefer": "return=representation"}
    r = httpx.patch(supa_url(f"?id=eq.{job_id}"), headers=headers, json=patch, timeout=30)
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else patch

def db_get(job_id: str) -> Optional[dict]:
    r = httpx.get(supa_url(f"?id=eq.{job_id}"), headers=SUPA_HEADERS, timeout=30)
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else None

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="QClaw Clipper", version="1.0.0")


class ClipRequest(BaseModel):
    video_url: Optional[str] = None
    r2_file_key: str
    episode_title: str
    transcript: List[dict]   # [{text, start, end, confidence}, ...]
    num_clips: int = 5
    caption_style: Optional[str] = None  # None or "word_by_word"


class ClipResponse(BaseModel):
    job_id: str
    status: str


@app.get("/health")
def health():
    return {"status": "ok", "service": "clipper"}


@app.post("/clip", response_model=ClipResponse)
def create_clip_job(req: ClipRequest):
    job_id = str(uuid.uuid4())

    db_insert({
        "id": job_id,
        "status": "queued",
        "episode_title": req.episode_title,
        "r2_file_key": req.r2_file_key,
        "video_url": req.video_url or f"{R2_PUBLIC_BASE}/{req.r2_file_key}",
        "transcript": req.transcript,
        "num_clips": req.num_clips,
    })

    # Launch background worker
    t = threading.Thread(target=run_clip_job, args=(job_id, req), daemon=True)
    t.start()

    return ClipResponse(job_id=job_id, status="queued")


@app.get("/clip/{job_id}")
def get_clip_job(job_id: str):
    record = db_get(job_id)
    if not record:
        raise HTTPException(status_code=404, detail="Job not found")
    return record


# ---------------------------------------------------------------------------
# Background clip job
# ---------------------------------------------------------------------------

def run_clip_job(job_id: str, req: ClipRequest):
    """Full clip pipeline — runs in a background thread."""
    try:
        db_update(job_id, {"status": "processing"})

        # Step 1 — Select segments with Claude
        log.info(f"[{job_id}] Step 1: Selecting segments with Claude")
        segments = select_segments(req.transcript, req.episode_title, req.num_clips)
        log.info(f"[{job_id}] Claude selected {len(segments)} segments")

        # Step 2 — Download source video from R2
        log.info(f"[{job_id}] Step 2: Downloading video from R2")
        input_path = f"/tmp/{job_id}_input.mp4"
        s3.download_file(R2_BUCKET_NAME, req.r2_file_key, input_path)

        clips_result = []

        for n, seg in enumerate(segments):
            start_ms = seg["start_ms"]
            end_ms = seg["end_ms"]
            start_s = start_ms / 1000.0
            end_s = end_ms / 1000.0

            # Step 3 — Cut clip
            log.info(f"[{job_id}] Step 3: Cutting clip {n}")
            raw_clip = f"/tmp/{job_id}_clip_{n}.mp4"
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", input_path,
                    "-ss", str(start_s),
                    "-to", str(end_s),
                    "-c", "copy",
                    raw_clip,
                ],
                check=True,
                capture_output=True,
            )

            # Step 4 — Generate SRT and burn captions
            log.info(f"[{job_id}] Step 4: Burning captions on clip {n}")
            srt_path = f"/tmp/{job_id}_clip_{n}.srt"
            captioned_path = f"/tmp/{job_id}_captioned_{n}.mp4"
            generate_srt(req.transcript, start_ms, end_ms, srt_path, req.caption_style)
            burn_captions(raw_clip, srt_path, captioned_path)

            # Step 5 — Upload to R2
            log.info(f"[{job_id}] Step 5: Uploading clip {n} to R2")
            r2_key = f"clips/{job_id}/clip_{n}.mp4"
            s3.upload_file(
                captioned_path,
                R2_BUCKET_NAME,
                r2_key,
                ExtraArgs={"ContentType": "video/mp4"},
            )

            clips_result.append({
                "index": n,
                "hook_title": seg.get("hook_title", ""),
                "caption_text": seg.get("caption_text", ""),
                "virality_score": seg.get("virality_score", 0),
                "start_ms": start_ms,
                "end_ms": end_ms,
                "duration_s": round(end_s - start_s, 2),
                "r2_key": r2_key,
                "public_url": f"{R2_PUBLIC_BASE}/{r2_key}",
            })

        # Step 6 — Update job as complete
        log.info(f"[{job_id}] Step 6: Updating job — complete")
        db_update(job_id, {
            "status": "complete",
            "clips": clips_result,
        })

    except Exception as e:
        log.error(f"[{job_id}] Job failed: {e}")
        try:
            db_update(job_id, {
                "status": "error",
                "error_message": str(e),
            })
        except Exception:
            pass
    finally:
        cleanup(job_id)


# ---------------------------------------------------------------------------
# Step 1 — Claude segment selection
# ---------------------------------------------------------------------------

def select_segments(transcript: List[dict], episode_title: str, num_clips: int) -> list:
    """Ask Claude Haiku to pick the best viral segments."""

    # Build transcript text with timestamps
    lines = []
    for w in transcript:
        lines.append(f"[{w['start']}ms] {w['text']}")
    transcript_text = " ".join(lines)

    user_prompt = (
        f"Episode title: {episode_title}\n\n"
        f"Transcript (word-level timestamps in milliseconds):\n{transcript_text}\n\n"
        f"Select the {num_clips} best viral clip segments. Each clip should be 30–90 seconds long.\n"
        f"Return ONLY a JSON array (no other text) with this schema:\n"
        f'[{{"start_ms": int, "end_ms": int, "hook_title": "string", "caption_text": "string", "virality_score": 1-10}}]'
    )

    resp = claude.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        system="You are an expert social media editor. Given a podcast transcript with word-level timestamps (milliseconds), select the best viral clip segments. Return only valid JSON.",
        messages=[{"role": "user", "content": user_prompt}],
    )

    raw = resp.content[0].text

    # Extract JSON from markdown code block if present
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if m:
        raw = m.group(1).strip()

    segments = json.loads(raw)

    if not isinstance(segments, list):
        raise ValueError("Claude did not return a JSON array")

    return segments


# ---------------------------------------------------------------------------
# Step 4 helpers — SRT generation & caption burning
# ---------------------------------------------------------------------------

def _ms_to_srt_ts(ms: int) -> str:
    """Convert milliseconds to SRT timestamp HH:MM:SS,mmm."""
    total_s, millis = divmod(ms, 1000)
    mins, secs = divmod(total_s, 60)
    hours, mins = divmod(mins, 60)
    return f"{int(hours):02d}:{int(mins):02d}:{int(secs):02d},{int(millis):03d}"


def generate_srt(
    transcript: List[dict],
    start_ms: int,
    end_ms: int,
    srt_path: str,
    caption_style: Optional[str] = None,
):
    """Generate an SRT file from transcript words within the clip range."""

    # Filter words in range
    words = [w for w in transcript if w["end"] >= start_ms and w["start"] <= end_ms]
    if not words:
        # Write empty SRT
        with open(srt_path, "w") as f:
            pass
        return

    # Offset times so clip starts at 0
    offset = start_ms

    entries = []
    if caption_style == "word_by_word":
        for i, w in enumerate(words):
            entries.append({
                "index": i + 1,
                "start": max(0, w["start"] - offset),
                "end": w["end"] - offset,
                "text": w["text"],
            })
    else:
        # Group into ~5-word chunks
        chunk_size = 5
        for i in range(0, len(words), chunk_size):
            chunk = words[i : i + chunk_size]
            entries.append({
                "index": len(entries) + 1,
                "start": max(0, chunk[0]["start"] - offset),
                "end": chunk[-1]["end"] - offset,
                "text": " ".join(w["text"] for w in chunk),
            })

    with open(srt_path, "w") as f:
        for e in entries:
            f.write(f"{e['index']}\n")
            f.write(f"{_ms_to_srt_ts(e['start'])} --> {_ms_to_srt_ts(e['end'])}\n")
            f.write(f"{e['text']}\n\n")


def burn_captions(input_path: str, srt_path: str, output_path: str):
    """Burn SRT subtitles onto video using FFmpeg."""
    # Escape special chars in path for FFmpeg subtitle filter
    escaped_srt = srt_path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")

    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", input_path,
            "-vf",
            f"subtitles={escaped_srt}:force_style='FontName=Arial,FontSize=24,"
            f"PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Alignment=2'",
            "-c:a", "copy",
            output_path,
        ],
        check=True,
        capture_output=True,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def cleanup(job_id: str):
    """Remove all temp files for this job."""
    for f in glob.glob(f"/tmp/{job_id}_*"):
        try:
            os.remove(f)
        except OSError:
            pass
