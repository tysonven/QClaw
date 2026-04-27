import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';

const envPath = '/root/.quantumclaw/.env';
const env = {};
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
  if (m) env[m[1]] = m[2];
}

const BUCKET = 'crete-projects';
const KEY = 'photos/library.json';
const OLD_PUB = 'https://pub-70c436931e9e4611a135e7405c596611.r2.dev/crete-projects/';
const NEW_PUB = 'https://media.creteprojects.com/';
const OLD_KEY_PREFIX = 'crete-projects/';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

(async () => {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
  const buf = await streamToBuffer(obj.Body);
  const data = JSON.parse(buf.toString('utf-8'));

  const photos = data.photos || [];
  let urlFixes = 0, keyFixes = 0;
  for (const p of photos) {
    if (typeof p.public_url === 'string' && p.public_url.startsWith(OLD_PUB)) {
      p.public_url = NEW_PUB + p.public_url.slice(OLD_PUB.length);
      urlFixes++;
    }
    if (typeof p.r2_key === 'string' && p.r2_key.startsWith(OLD_KEY_PREFIX)) {
      p.r2_key = p.r2_key.slice(OLD_KEY_PREFIX.length);
      keyFixes++;
    }
  }

  const out = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: KEY,
    Body: out,
    ContentType: 'application/json',
  }));

  console.log(`Updated ${photos.length} entries: ${urlFixes} public_url, ${keyFixes} r2_key`);
  console.log('Sample[0]:', JSON.stringify(photos[0], null, 2));
})();
