#!/bin/bash
# Receive a file (scp to /tmp/) then upload to R2
# Usage: ./receive-and-upload.sh /tmp/theflowlane-ep05-Brand_Positioning.mp4

export $(grep "^R2_" /root/.quantumclaw/.env | xargs)
export PATH="/home/flowos/.local/bin:$PATH"
export HOME="/home/flowos"

LOCAL_FILE=$1
FILENAME=$(basename "$LOCAL_FILE")
R2_KEY="episodes/$FILENAME"

if [ -z "$LOCAL_FILE" ]; then
  echo "Usage: $0 <local_file>"
  echo "Example: $0 /tmp/theflowlane-ep05-Brand_Positioning.mp4"
  exit 1
fi

if [ ! -f "$LOCAL_FILE" ]; then
  echo "Error: File not found: $LOCAL_FILE"
  exit 1
fi

FILE_SIZE=$(du -h "$LOCAL_FILE" | cut -f1)
echo "Uploading $FILENAME ($FILE_SIZE) to R2 bucket emma-content-studio..."

aws s3 cp "$LOCAL_FILE" "s3://emma-content-studio/$R2_KEY" \
  --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --region auto

if [ $? -ne 0 ]; then
  echo "Upload failed."
  exit 1
fi

echo ""
echo "Upload complete."
echo "R2 key: $R2_KEY"
echo "Public URL: https://pub-70c436931e9e4611a135e7405c596611.r2.dev/$R2_KEY"
echo ""
echo "Trigger Content Studio with:"
echo "curl -X POST https://webhook.flowos.tech/webhook/content-studio-pipeline \\"
echo "  -H Content-Type: application/json \\"
echo "  -d {"chatId":1375806243,"episodeTitle":"The Flow Lane - Brand Positioning","episodeDescription":"Episode 5","r2FileKey":""}"
