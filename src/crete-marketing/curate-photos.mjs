/**
 * Crete Projects — Stock Photo Library Curator
 *
 * Downloads curated Unsplash photos, centre-crops to 1080×1080,
 * uploads to R2, and generates library.json index.
 *
 * All Unsplash photos are free for commercial use under the Unsplash License.
 */

import { createCanvas, loadImage } from 'canvas';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SIZE = 1080;

const PHOTOS = [
  // Theme: Land Sourcing / Agriculture (8)
  { id: 'photo-001', filename: 'olive-grove-01.jpg',      theme: 'Land Sourcing', folder: 'agriculture', url: 'https://images.unsplash.com/photo-1609763951640-c0d7bd98b257',  credit: 'Unsplash (olive grove)' },
  { id: 'photo-002', filename: 'herb-garden-01.jpg',      theme: 'Land Sourcing', folder: 'agriculture', url: 'https://images.unsplash.com/photo-1767978769767-dab3701ecdf1',  credit: 'Unsplash (herb garden)' },
  { id: 'photo-003', filename: 'terraces-01.jpg',         theme: 'Land Sourcing', folder: 'agriculture', url: 'https://images.unsplash.com/photo-1616382093586-84ed7932c216',  credit: 'Unsplash (terraces)' },
  { id: 'photo-004', filename: 'citrus-orchard-01.jpg',   theme: 'Land Sourcing', folder: 'agriculture', url: 'https://images.unsplash.com/photo-1683110752705-f474b57bebc6',  credit: 'Unsplash (citrus)' },
  { id: 'photo-005', filename: 'beekeeping-01.jpg',       theme: 'Land Sourcing', folder: 'agriculture', url: 'https://images.unsplash.com/photo-1623018697148-8350cf18e64e',  credit: 'Unsplash (beekeeping)' },
  { id: 'photo-006', filename: 'earth-closeup-01.jpg',    theme: 'Land Sourcing', folder: 'agriculture', url: 'https://images.unsplash.com/photo-1666204629747-dcf45c4290e1',  credit: 'Unsplash (earth)' },
  { id: 'photo-007', filename: 'farmland-sunrise-01.jpg', theme: 'Land Sourcing', folder: 'agriculture', url: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef',  credit: 'Unsplash (farmland sunrise)' },
  { id: 'photo-008', filename: 'harvest-scene-01.jpg',    theme: 'Land Sourcing', folder: 'agriculture', url: 'https://images.unsplash.com/photo-1535379453347-1ffd615e2e08',  credit: 'Unsplash (harvest)' },

  // Theme: Village Restoration (6)
  { id: 'photo-009', filename: 'stone-building-01.jpg',   theme: 'Village Restoration', folder: 'village', url: 'https://images.unsplash.com/photo-1567410265504-c1b25f246b99',  credit: 'Unsplash (stone building)' },
  { id: 'photo-010', filename: 'stone-archway-01.jpg',    theme: 'Village Restoration', folder: 'village', url: 'https://images.unsplash.com/photo-1596062142925-a7c580c0e5e9',  credit: 'Unsplash (stone archway)' },
  { id: 'photo-011', filename: 'courtyard-01.jpg',        theme: 'Village Restoration', folder: 'village', url: 'https://images.unsplash.com/photo-1776083928944-f427c6f1f738',  credit: 'Unsplash (courtyard)' },
  { id: 'photo-012', filename: 'village-street-01.jpg',   theme: 'Village Restoration', folder: 'village', url: 'https://images.unsplash.com/photo-1536514072410-5019a3c69182',  credit: 'Unsplash (village street)' },
  { id: 'photo-013', filename: 'stone-wall-01.jpg',       theme: 'Village Restoration', folder: 'village', url: 'https://images.unsplash.com/photo-1536566482680-fca31930a0bd',  credit: 'Unsplash (stone wall)' },
  { id: 'photo-014', filename: 'wooden-door-01.jpg',      theme: 'Village Restoration', folder: 'village', url: 'https://images.unsplash.com/photo-1630579083524-e3ac854edb46',  credit: 'Unsplash (wooden door)' },

  // Theme: Health & Wellness (4)
  { id: 'photo-015', filename: 'outdoor-yoga-01.jpg',     theme: 'Health & Wellness', folder: 'wellness', url: 'https://images.unsplash.com/photo-1593152961455-b943e1cea86b',  credit: 'Unsplash (outdoor yoga)' },
  { id: 'photo-016', filename: 'natural-pool-01.jpg',     theme: 'Health & Wellness', folder: 'wellness', url: 'https://images.unsplash.com/photo-1662613339294-1c323abe6298',  credit: 'Unsplash (natural pool)' },
  { id: 'photo-017', filename: 'sauna-01.jpg',            theme: 'Health & Wellness', folder: 'wellness', url: 'https://images.unsplash.com/photo-1717356495389-6ab1e5ff9d84',  credit: 'Unsplash (sauna)' },
  { id: 'photo-018', filename: 'healthy-food-01.jpg',     theme: 'Health & Wellness', folder: 'wellness', url: 'https://images.unsplash.com/photo-1653611540493-b3a896319fbf',  credit: 'Unsplash (healthy food)' },

  // Theme: Crete General / Lifestyle (4)
  { id: 'photo-019', filename: 'mountain-landscape-01.jpg', theme: 'Crete General', folder: 'lifestyle', url: 'https://images.unsplash.com/photo-1650888755082-3c4490ddae4b',  credit: 'Unsplash (Crete mountains)' },
  { id: 'photo-020', filename: 'coastline-01.jpg',        theme: 'Crete General', folder: 'lifestyle', url: 'https://images.unsplash.com/photo-1562532418-ad84d8df5124',  credit: 'Unsplash (coastline)' },
  { id: 'photo-021', filename: 'sunset-01.jpg',           theme: 'Crete General', folder: 'lifestyle', url: 'https://images.unsplash.com/photo-1554213808-9c5bab0f624e',  credit: 'Unsplash (sunset)' },
  { id: 'photo-022', filename: 'village-panorama-01.jpg', theme: 'Crete General', folder: 'lifestyle', url: 'https://images.unsplash.com/photo-1736618626048-251e4e27dad0',  credit: 'Unsplash (village panorama)' },
];

function cropToSquare(img) {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  const srcSize = Math.min(img.width, img.height);
  const sx = (img.width - srcSize) / 2;
  const sy = (img.height - srcSize) / 2;
  ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, SIZE, SIZE);
  return canvas.toBuffer('image/jpeg', { quality: 0.88 });
}

async function main() {
  const envPath = join(process.env.HOME || '/root', '.quantumclaw', '.env');
  const envVars = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m) envVars[m[1]] = m[2];
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${envVars.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: envVars.R2_ACCESS_KEY_ID, secretAccessKey: envVars.R2_SECRET_ACCESS_KEY }
  });
  const bucket = envVars.R2_BUCKET_NAME || 'emma-content-studio';

  const library = { photos: [] };
  let success = 0, failed = 0;

  for (const photo of PHOTOS) {
    const dlUrl = `${photo.url}?w=1200&h=1200&fit=crop&crop=center&auto=format&q=80`;
    const r2Key = `crete-projects/photos/${photo.folder}/${photo.filename}`;
    const publicUrl = `https://pub-70c436931e9e4611a135e7405c596611.r2.dev/${r2Key}`;

    try {
      process.stdout.write(`  ${photo.id} ${photo.filename} ... `);
      const resp = await fetch(dlUrl, { redirect: 'follow' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const img = await loadImage(buf);
      const cropped = cropToSquare(img);

      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: r2Key, Body: cropped, ContentType: 'image/jpeg'
      }));

      library.photos.push({
        id: photo.id, filename: photo.filename, theme: photo.theme,
        r2_key: r2Key, public_url: publicUrl, credit: photo.credit
      });
      console.log(`✓ (${(cropped.length / 1024).toFixed(0)} KB)`);
      success++;
    } catch (err) {
      console.log(`✗ ${err.message}`);
      failed++;
    }
  }

  const libraryJson = JSON.stringify(library, null, 2);
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: 'crete-projects/photos/library.json',
    Body: Buffer.from(libraryJson), ContentType: 'application/json'
  }));
  writeFileSync('/tmp/crete-photo-library.json', libraryJson);

  console.log(`\nDone: ${success} uploaded, ${failed} failed`);
  console.log(`Library: https://pub-70c436931e9e4611a135e7405c596611.r2.dev/crete-projects/photos/library.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
