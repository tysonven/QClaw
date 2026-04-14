#!/bin/bash
# Upload files to Cloudflare R2 via S3-compatible API
# Usage: ./upload-to-r2.sh /path/to/local/file.mp4 episodes/filename.mp4

export $(grep "^R2_" /root/.quantumclaw/.env | xargs)
export PATH="/home/flowos/.local/bin:$PATH"
export HOME="/home/flowos"

LOCAL_FILE=$1
R2_KEY=$2

if [ -z "$LOCAL_FILE" ] || [ -z "$R2_KEY" ]; then
  echo "Usage: $0 <local_file> <r2_key>"
  echo "Example: $0 /tmp/episode.mp4 episodes/episode.mp4"
  exit 1
fi

if [ ! -f "$LOCAL_FILE" ]; then
  echo "Error: File not found: $LOCAL_FILE"
  exit 1
fi

FILE_SIZE=$(du -h "$LOCAL_FILE" | cut -f1)
echo "Uploading $LOCAL_FILE ($FILE_SIZE) to R2 bucket emma-content-studio at $R2_KEY..."

aws s3 cp "$LOCAL_FILE" "s3://emma-content-studio/$R2_KEY" \
  --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --region auto \
  --no-progress

if [ $? -eq 0 ]; then
  echo "Done. Public URL: https://pub-70c436931e9e4611a135e7405c596611.r2.dev/$R2_KEY"
else
  echo "Upload failed."
  exit 1
fi
