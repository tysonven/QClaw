// One-shot migration: emma-content-studio/crete-projects/* -> crete-projects/*
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';

const envPath = '/root/.quantumclaw/.env';
const env = {};
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
  if (m) env[m[1]] = m[2];
}

const OLD_BUCKET = 'emma-content-studio';
const NEW_BUCKET = 'crete-projects';
const PREFIX = 'crete-projects/';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
};

function guessContentType(key) {
  const dot = key.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return CONTENT_TYPES[key.slice(dot).toLowerCase()] || 'application/octet-stream';
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function listAll() {
  const keys = [];
  let ContinuationToken;
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: OLD_BUCKET,
      Prefix: PREFIX,
      ContinuationToken,
    }));
    for (const obj of resp.Contents || []) keys.push(obj.Key);
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

async function copyOne(srcKey) {
  const dstKey = srcKey.slice(PREFIX.length);
  if (!dstKey) return { srcKey, skipped: 'prefix-only' };
  const contentType = guessContentType(srcKey);

  const obj = await s3.send(new GetObjectCommand({ Bucket: OLD_BUCKET, Key: srcKey }));
  const body = await streamToBuffer(obj.Body);

  await s3.send(new PutObjectCommand({
    Bucket: NEW_BUCKET,
    Key: dstKey,
    Body: body,
    ContentType: obj.ContentType || contentType,
  }));

  return { srcKey, dstKey, bytes: body.length, contentType: obj.ContentType || contentType };
}

(async () => {
  const keys = await listAll();
  console.log(`Found ${keys.length} objects in ${OLD_BUCKET}/${PREFIX}`);
  let ok = 0, fail = 0, totalBytes = 0;
  for (const k of keys) {
    try {
      const r = await copyOne(k);
      if (r.skipped) {
        console.log(`  SKIP ${r.srcKey} (${r.skipped})`);
        continue;
      }
      ok++;
      totalBytes += r.bytes;
      console.log(`  OK   ${r.srcKey} -> ${NEW_BUCKET}/${r.dstKey}  (${r.bytes}B, ${r.contentType})`);
    } catch (e) {
      fail++;
      console.error(`  FAIL ${k}: ${e.message}`);
    }
  }
  console.log(`\nCopied ${ok}/${keys.length} files, ${fail} failed, ${totalBytes} bytes total`);
  process.exit(fail > 0 ? 1 : 0);
})();
