import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand,
         CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";

const [,, LOCAL, KEY] = process.argv;
if (!LOCAL || !KEY) { console.error("usage: node upload-to-r2-multipart.mjs <local> <r2_key>"); process.exit(1); }

const env = {};
for (const l of readFileSync("/root/.quantumclaw/.env","utf-8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.+)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g,"");
}
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});
const Bucket = env.R2_BUCKET_NAME || "emma-content-studio";

const PART = 16 * 1024 * 1024;     // 16 MB parts
const CONC = 4;                     // 4 in flight
const size = statSync(LOCAL).size;
const numParts = Math.ceil(size / PART);
console.log(`Uploading ${LOCAL} (${(size/1024/1024).toFixed(1)} MB) → s3://${Bucket}/${KEY} in ${numParts} parts`);

const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: KEY, ContentType: "video/mp4" }));
const fd = openSync(LOCAL, "r");
const parts = new Array(numParts);
let next = 1, done = 0;

async function worker() {
  while (true) {
    const n = next++; if (n > numParts) return;
    const off = (n-1) * PART; const len = Math.min(PART, size - off);
    const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, off);
    const { ETag } = await s3.send(new UploadPartCommand({ Bucket, Key: KEY, UploadId, PartNumber: n, Body: buf }));
    parts[n-1] = { ETag, PartNumber: n };
    done++; process.stdout.write(`\r  ${done}/${numParts} parts`);
  }
}
try {
  await Promise.all(Array.from({length: CONC}, worker));
  closeSync(fd);
  await s3.send(new CompleteMultipartUploadCommand({ Bucket, Key: KEY, UploadId, MultipartUpload: { Parts: parts } }));
  console.log(`\nDone. https://pub-70c436931e9e4611a135e7405c596611.r2.dev/${KEY}`);
} catch (e) {
  closeSync(fd);
  console.error(`\nFAILED: ${e.message}. Aborting multipart upload to avoid orphan…`);
  await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: KEY, UploadId }));
  process.exit(1);
}
