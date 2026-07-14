/**
 * Flow OS — Marketing Image Card Generator
 *
 * Generates branded 1080×1350 (4:5) PNG cards for GHL Marketing posts.
 * Three card types:
 *   - editorial: dark card — pill label, accent bar, headline + body
 *   - stat:      dark card — large stat number, label, hook line
 *   - feature:   light teal card — badge, headline + body, feature callout strip
 *
 * Standalone module — no imports from crete-marketing.
 *
 * Usage (CLI):
 *   node generate-image-card.js --card_type editorial --post_type pain-led \
 *     --headline "..." --subtext "..." --output /tmp/card.png
 *
 * Usage (module):
 *   import { generateImageCard } from './generate-image-card.js';
 *   const buffer = await generateImageCard({ card_type: 'editorial', headline: '...' });
 */

import { createCanvas, loadImage } from 'canvas';
import { writeFileSync } from 'fs';
import { parseArgs } from 'util';

// ─── Brand Palette ───────────────────────────────────────────
const DARK_BG     = '#1a2a2a';
const LIGHT_BG    = '#e8f2f2';
const TEAL_ACCENT = '#99cccc';
const CREAM_TEXT  = '#eae5da';
const TEAL_DEEP   = '#2a7070';
const TEAL_DARK   = '#1a3a3a';
const TEAL_BODY   = '#3a5a5a';
const TEAL_MID    = '#2a5a5a';

const WIDTH  = 1080;
const HEIGHT = 1350;
const PAD    = 100;
const TEXT_W = WIDTH - PAD * 2;
const FOOTER_H = 150;

const CARD_TYPES = ['editorial', 'stat', 'feature'];

// Brand assets are fetched from the public CDN URL — no credentials needed here.
const PUBLIC_BASE = (process.env.FLOWOS_R2_PUBLIC_URL || 'https://media.flowos.tech').replace(/\/+$/, '');
const LOGO_URL = `${PUBLIC_BASE}/brand/logo-mark.png`;

// ─── Helpers ─────────────────────────────────────────────────

/** Strip dangerous chars; keep printable text + common punctuation + emojis. */
export function sanitise(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')   // strip control chars
    .replace(/\s+[–—―]\s+/g, ' - ')
    .replace(/[–—―]/g, '-')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 2000);
}

function invalid(msg) {
  const err = new Error(msg);
  err.statusCode = 422;
  return err;
}

/** Word-wrap text to maxWidth; truncate with ellipsis beyond maxLines. */
function wrapText(ctx, text, maxWidth, maxLines = Infinity) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') { lines.push(''); continue; }
    const words = paragraph.split(/\s+/);
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1].replace(/[\s.,;:!?]+$/, '');
    while (last && ctx.measureText(last + '…').width > maxWidth) {
      last = last.slice(0, -1).trimEnd();
    }
    kept[maxLines - 1] = last + '…';
    return kept;
  }
  return lines;
}

/** Draw text with manual letter-spacing (node-canvas has no letterSpacing). */
function drawTrackedText(ctx, text, x, y, tracking) {
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + tracking;
  }
}

function measureTracked(ctx, text, tracking) {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + tracking;
  return w - tracking;
}

/** Rounded-rect path (node-canvas lacks ctx.roundRect on older builds). */
function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Subtle radial glow in a corner. */
function drawRadialGlow(ctx, cx, cy, radius, rgba) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  g.addColorStop(0, rgba);
  g.addColorStop(1, 'rgba(153,204,204,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

// ─── Logo (fetched once from R2 public URL, cached in memory) ─

let _logoPromise = null;
function getLogoMark() {
  if (!_logoPromise) {
    _logoPromise = (async () => {
      const res = await fetch(LOGO_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return await loadImage(buf);
    })().catch(err => {
      console.warn(`[flowos-marketing] logo-mark unavailable (${err.message}); rendering text-only footer`);
      _logoPromise = null; // allow retry on next generation
      return null;
    });
  }
  return _logoPromise;
}

/** Recolour the logomark to a flat tint (silhouette) at the given height. */
function tintedLogo(logo, color, height) {
  const w = Math.round(logo.width * (height / logo.height));
  const c = createCanvas(w, height);
  const cctx = c.getContext('2d');
  cctx.drawImage(logo, 0, 0, w, height);
  cctx.globalCompositeOperation = 'source-in';
  cctx.fillStyle = color;
  cctx.fillRect(0, 0, w, height);
  return c;
}

/** Footer: hairline border, logomark + FLOW OS text. */
async function drawFooter(ctx, { line, tint, alpha }) {
  const yLine = HEIGHT - FOOTER_H;
  ctx.save();
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, yLine);
  ctx.lineTo(WIDTH - PAD, yLine);
  ctx.stroke();

  const logo = await getLogoMark();
  const midY = yLine + FOOTER_H / 2 - 5;
  ctx.globalAlpha = alpha;
  let tx = PAD;
  if (logo) {
    const logoH = 56;
    const mark = tintedLogo(logo, tint, logoH);
    ctx.drawImage(mark, PAD, midY - logoH / 2);
    tx = PAD + mark.width + 24;
  }
  ctx.fillStyle = tint;
  ctx.font = '600 24px "Montserrat"';
  ctx.textBaseline = 'middle';
  drawTrackedText(ctx, 'FLOW OS', tx, midY, 6);
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
}

// ─── Card Renderers ──────────────────────────────────────────

async function renderEditorial(ctx, { headline, subtext, post_type }) {
  ctx.fillStyle = DARK_BG;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  drawRadialGlow(ctx, WIDTH - 80, 80, 720, 'rgba(153,204,204,0.08)');

  // Pill label — post type. Spec said 10px; at 1080px wide that is illegible, so 2× applied.
  const label = (post_type || 'FLOW OS').toUpperCase();
  ctx.font = 'bold 20px "Montserrat"';
  const track = 4;
  const labelW = measureTracked(ctx, label, track);
  const pillH = 44;
  roundRectPath(ctx, PAD, PAD, labelW + 48, pillH, pillH / 2);
  ctx.fillStyle = 'rgba(153,204,204,0.08)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(153,204,204,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = TEAL_ACCENT;
  ctx.textBaseline = 'middle';
  drawTrackedText(ctx, label, PAD + 24, PAD + pillH / 2 + 1, track);
  ctx.textBaseline = 'alphabetic';

  // Teal accent bar above headline
  let y = PAD + 150;
  ctx.fillStyle = TEAL_ACCENT;
  ctx.fillRect(PAD, y, 60, 5);
  y += 85;

  // Headline
  ctx.fillStyle = CREAM_TEXT;
  ctx.font = 'bold 48px "Montserrat"';
  for (const l of wrapText(ctx, headline, TEXT_W, 3)) {
    ctx.fillText(l, PAD, y);
    y += 62;
  }

  // Body
  if (subtext) {
    y += 30;
    ctx.fillStyle = 'rgba(234,229,218,0.65)';
    ctx.font = '28px "Raleway"';
    for (const l of wrapText(ctx, subtext, TEXT_W, 4)) {
      ctx.fillText(l, PAD, y);
      y += 42;
    }
  }

  await drawFooter(ctx, { line: 'rgba(153,204,204,0.2)', tint: TEAL_ACCENT, alpha: 0.4 });
}

async function renderStat(ctx, { stat, stat_label, headline }) {
  ctx.fillStyle = DARK_BG;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  drawRadialGlow(ctx, WIDTH - 80, 80, 720, 'rgba(153,204,204,0.08)');

  // Accent bar top-left
  ctx.fillStyle = TEAL_ACCENT;
  ctx.fillRect(PAD, PAD, 60, 5);

  // Stat number — auto-shrink to fit width
  let size = 120;
  ctx.font = `bold ${size}px "Montserrat"`;
  while (size > 48 && ctx.measureText(stat).width > TEXT_W) {
    size -= 4;
    ctx.font = `bold ${size}px "Montserrat"`;
  }
  ctx.fillStyle = TEAL_ACCENT;
  const statBaseline = PAD + 160 + size;
  ctx.fillText(stat, PAD, statBaseline);

  // Stat label
  ctx.fillStyle = 'rgba(234,229,218,0.70)';
  ctx.font = '28px "Raleway"';
  let ly = statBaseline + 70;
  for (const l of wrapText(ctx, stat_label, TEXT_W, 2)) {
    ctx.fillText(l, PAD, ly);
    ly += 42;
  }

  // Hook line — bottom third
  ctx.fillStyle = CREAM_TEXT;
  ctx.font = '600 36px "Montserrat"';
  const hookLines = wrapText(ctx, headline, TEXT_W, 3);
  let hy = HEIGHT - FOOTER_H - 70 - (hookLines.length - 1) * 50;
  for (const l of hookLines) {
    ctx.fillText(l, PAD, hy);
    hy += 50;
  }

  await drawFooter(ctx, { line: 'rgba(153,204,204,0.2)', tint: TEAL_ACCENT, alpha: 0.4 });
}

async function renderFeature(ctx, { headline, subtext, badge_label, feature_line }) {
  ctx.fillStyle = LIGHT_BG;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  drawRadialGlow(ctx, WIDTH - 120, HEIGHT - 160, 760, 'rgba(153,204,204,0.15)');

  // Badge pill. Spec said 9px; at 1080px wide that is illegible, so 2× applied.
  const label = (badge_label || 'Feature spotlight').toUpperCase();
  ctx.font = 'bold 18px "Montserrat"';
  const track = 3;
  const labelW = measureTracked(ctx, label, track);
  const pillH = 42;
  roundRectPath(ctx, PAD, PAD, labelW + 56, pillH, 20);
  ctx.fillStyle = 'rgba(153,204,204,0.25)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(153,204,204,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = TEAL_DEEP;
  ctx.textBaseline = 'middle';
  drawTrackedText(ctx, label, PAD + 28, PAD + pillH / 2 + 1, track);
  ctx.textBaseline = 'alphabetic';

  // Headline
  let y = PAD + 170;
  ctx.fillStyle = TEAL_DARK;
  ctx.font = 'bold 48px "Montserrat"';
  for (const l of wrapText(ctx, headline, TEXT_W, 3)) {
    ctx.fillText(l, PAD, y);
    y += 62;
  }

  // Body
  if (subtext) {
    y += 30;
    ctx.fillStyle = TEAL_BODY;
    ctx.font = '28px "Raleway"';
    for (const l of wrapText(ctx, subtext, TEXT_W, 4)) {
      ctx.fillText(l, PAD, y);
      y += 42;
    }
  }

  // Feature callout strip — white rounded rect, bottom third
  if (feature_line) {
    const stripH = 150;
    const stripY = HEIGHT - FOOTER_H - stripH - 60;
    ctx.save();
    ctx.shadowColor = 'rgba(42,90,90,0.10)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 6;
    roundRectPath(ctx, PAD, stripY, TEXT_W, stripH, 24);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    const dotX = PAD + 48;
    const dotY = stripY + stripH / 2;
    ctx.fillStyle = TEAL_DEEP;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 9, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = TEAL_MID;
    ctx.font = '600 26px "Montserrat"';
    const fx = dotX + 36;
    const fLines = wrapText(ctx, feature_line, PAD + TEXT_W - 40 - fx, 2);
    ctx.textBaseline = 'middle';
    let fy = dotY - (fLines.length - 1) * 19;
    for (const l of fLines) {
      ctx.fillText(l, fx, fy);
      fy += 38;
    }
    ctx.textBaseline = 'alphabetic';
  }

  await drawFooter(ctx, { line: 'rgba(42,90,90,0.15)', tint: TEAL_MID, alpha: 0.5 });
}

// ─── Public API ──────────────────────────────────────────────

export async function generateImageCard(opts = {}) {
  const card_type = opts.card_type;
  if (!CARD_TYPES.includes(card_type)) {
    throw invalid(`card_type must be one of: ${CARD_TYPES.join(', ')} (got: ${card_type ?? 'undefined'})`);
  }
  const headline = sanitise(opts.headline);
  if (!headline) throw invalid('headline is required and must be a non-empty string');

  const fields = {
    headline,
    subtext: sanitise(opts.subtext),
    post_type: sanitise(opts.post_type).slice(0, 40),
    stat: sanitise(opts.stat).slice(0, 40),
    stat_label: sanitise(opts.stat_label),
    badge_label: sanitise(opts.badge_label).slice(0, 60),
    feature_line: sanitise(opts.feature_line),
  };
  if (card_type === 'stat') {
    if (!fields.stat) throw invalid('stat is required for stat cards');
    if (!fields.stat_label) throw invalid('stat_label is required for stat cards');
  }

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.antialias = 'subpixel';
  ctx.quality = 'best';

  if (card_type === 'editorial') await renderEditorial(ctx, fields);
  else if (card_type === 'stat') await renderStat(ctx, fields);
  else await renderFeature(ctx, fields);

  return canvas.toBuffer('image/png');
}

// ─── CLI ─────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('generate-image-card.js');
if (isMain) {
  const { values } = parseArgs({
    options: {
      card_type:    { type: 'string', default: 'editorial' },
      headline:     { type: 'string', default: '' },
      subtext:      { type: 'string', default: '' },
      post_type:    { type: 'string', default: '' },
      stat:         { type: 'string', default: '' },
      stat_label:   { type: 'string', default: '' },
      badge_label:  { type: 'string', default: '' },
      feature_line: { type: 'string', default: '' },
      output:       { type: 'string', default: '/tmp/flowos-card.png' },
    },
    strict: false,
  });

  try {
    const buf = await generateImageCard(values);
    writeFileSync(values.output, buf);
    console.log(`✓ ${values.output} (${buf.length} bytes, ${WIDTH}×${HEIGHT})`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
