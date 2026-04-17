/**
 * Crete Projects — Instagram Text Card Generator
 *
 * Generates branded 1080×1080 PNG images for Instagram.
 * Two styles:
 *   - quote:     Large italic quote text centred on cream background
 *   - editorial: Bold headline + body text, structured layout
 *
 * Usage (CLI):
 *   node generate-text-card.js --style quote --text "..." --output /tmp/out.png
 *   node generate-text-card.js --style editorial --headline "..." --body "..." --output /tmp/out.png
 *
 * Usage (module):
 *   import { generateTextCard } from './generate-text-card.js';
 *   const buffer = await generateTextCard({ style: 'quote', text: '...' });
 */

import { createCanvas, registerFont } from 'canvas';
import { writeFileSync } from 'fs';
import { parseArgs } from 'util';

// ─── Brand Palette ───────────────────────────────────────────
const CREAM      = '#F5F0EB';
const OLIVE_DARK = '#4A5A3C';
const OLIVE_MID  = '#6B7F58';
const OLIVE_LIGHT= '#A8B89A';
const CHARCOAL   = '#2C2C2C';
const WARM_GREY  = '#8C8478';
const ACCENT_GOLD= '#B8A179';

const SIZE = 1080;
const PAD  = 100;           // outer padding
const TEXT_W = SIZE - PAD * 2; // usable text width

// ─── Helpers ─────────────────────────────────────────────────

/** Strip dangerous chars; keep printable text + common punctuation + emojis. */
function sanitise(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, 2000);
}

/** Word-wrap text to fit within maxWidth using the current ctx font. */
function wrapText(ctx, text, maxWidth) {
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
  return lines;
}

/** Draw a small olive branch accent (stylised). */
function drawOliveBranch(ctx, x, y, scale = 1, flip = false) {
  ctx.save();
  ctx.translate(x, y);
  if (flip) ctx.scale(-1, 1);
  ctx.scale(scale, scale);

  // Main stem
  ctx.strokeStyle = OLIVE_MID;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(40, -8, 80, -2);
  ctx.stroke();

  // Leaves along stem
  const leaves = [
    { x: 15, y: -4,  angle: -0.6 },
    { x: 28, y: -6,  angle: -0.4 },
    { x: 42, y: -5,  angle:  0.5 },
    { x: 55, y: -4,  angle: -0.3 },
    { x: 68, y: -3,  angle:  0.4 },
  ];
  ctx.fillStyle = OLIVE_LIGHT;
  for (const leaf of leaves) {
    ctx.save();
    ctx.translate(leaf.x, leaf.y);
    ctx.rotate(leaf.angle);
    ctx.beginPath();
    ctx.ellipse(0, 0, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** Draw thin decorative horizontal line. */
function drawDivider(ctx, y, width = 120) {
  const x = (SIZE - width) / 2;
  ctx.strokeStyle = ACCENT_GOLD;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + width, y);
  ctx.stroke();
}

// ─── Card Renderers ──────────────────────────────────────────

function renderQuoteCard(ctx, text) {
  // Background
  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Top olive branch accents
  drawOliveBranch(ctx, PAD - 20, PAD + 20, 1.2, false);
  drawOliveBranch(ctx, SIZE - PAD + 20, PAD + 20, 1.2, true);

  // Opening quote mark
  ctx.fillStyle = OLIVE_LIGHT;
  ctx.font = 'bold 120px "Cormorant Garamond"';
  ctx.textAlign = 'center';
  ctx.fillText('\u201C', SIZE / 2, PAD + 130);

  // Quote text — large italic serif
  ctx.fillStyle = CHARCOAL;
  ctx.font = 'italic 42px "Cormorant Garamond"';
  ctx.textAlign = 'center';

  const lines = wrapText(ctx, text, TEXT_W - 40);
  const lineHeight = 58;
  const totalHeight = lines.length * lineHeight;
  let startY = (SIZE / 2) - (totalHeight / 2) + 40;
  // Clamp so text doesn't overflow
  startY = Math.max(PAD + 170, Math.min(startY, SIZE - PAD - 180 - totalHeight));

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], SIZE / 2, startY + i * lineHeight);
  }

  // Closing quote mark
  ctx.fillStyle = OLIVE_LIGHT;
  ctx.font = 'bold 120px "Cormorant Garamond"';
  ctx.fillText('\u201D', SIZE / 2, startY + totalHeight + 60);

  // Divider
  const divY = SIZE - PAD - 80;
  drawDivider(ctx, divY);

  // Brand footer
  ctx.fillStyle = OLIVE_DARK;
  ctx.font = '600 22px "Montserrat"';
  ctx.textAlign = 'center';
  ctx.fillText('C R E T E   P R O J E C T S', SIZE / 2, divY + 36);

  ctx.fillStyle = WARM_GREY;
  ctx.font = '14px "Montserrat"';
  ctx.fillText('creteprojects.com', SIZE / 2, divY + 60);
}

function renderEditorialCard(ctx, headline, body) {
  // Background
  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Accent bar at top
  ctx.fillStyle = OLIVE_DARK;
  ctx.fillRect(0, 0, SIZE, 6);

  // Brand header
  ctx.fillStyle = OLIVE_MID;
  ctx.font = '600 16px "Montserrat"';
  ctx.textAlign = 'left';
  ctx.fillText('C R E T E   P R O J E C T S', PAD, PAD + 10);

  // Olive branch next to header
  drawOliveBranch(ctx, PAD + ctx.measureText('C R E T E   P R O J E C T S').width + 20, PAD + 5, 0.8, false);

  // Divider below header
  ctx.strokeStyle = ACCENT_GOLD;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, PAD + 30);
  ctx.lineTo(SIZE - PAD, PAD + 30);
  ctx.stroke();

  // Headline
  ctx.fillStyle = CHARCOAL;
  ctx.font = 'bold 48px "Cormorant Garamond"';
  ctx.textAlign = 'left';

  const headLines = wrapText(ctx, headline, TEXT_W);
  const headLineH = 62;
  let y = PAD + 80;
  for (const line of headLines) {
    ctx.fillText(line, PAD, y);
    y += headLineH;
  }

  // Small divider between headline and body
  y += 15;
  ctx.strokeStyle = ACCENT_GOLD;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(PAD + 60, y);
  ctx.stroke();
  y += 35;

  // Body text
  ctx.fillStyle = CHARCOAL;
  ctx.font = '26px "DM Sans"';
  ctx.textAlign = 'left';

  const bodyLines = wrapText(ctx, body, TEXT_W);
  const bodyLineH = 40;
  for (const line of bodyLines) {
    if (y + bodyLineH > SIZE - PAD - 70) break; // prevent overflow
    ctx.fillText(line, PAD, y);
    y += bodyLineH;
  }

  // Bottom olive branches
  drawOliveBranch(ctx, PAD - 10, SIZE - PAD + 10, 1.0, false);
  drawOliveBranch(ctx, SIZE - PAD + 10, SIZE - PAD + 10, 1.0, true);

  // Footer
  ctx.fillStyle = WARM_GREY;
  ctx.font = '14px "Montserrat"';
  ctx.textAlign = 'center';
  ctx.fillText('creteprojects.com', SIZE / 2, SIZE - PAD + 35);
}

// ─── Public API ──────────────────────────────────────────────

export async function generateTextCard(opts) {
  const style = opts.style || 'quote';
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  // Anti-aliasing
  ctx.antialias = 'subpixel';
  ctx.quality = 'best';

  if (style === 'quote') {
    const text = sanitise(opts.text);
    if (!text) throw new Error('text is required for quote style');
    renderQuoteCard(ctx, text);
  } else if (style === 'editorial') {
    const headline = sanitise(opts.headline);
    const body = sanitise(opts.body);
    if (!headline) throw new Error('headline is required for editorial style');
    renderEditorialCard(ctx, headline, body || '');
  } else {
    throw new Error(`Unknown style: ${style}`);
  }

  return canvas.toBuffer('image/png');
}

// ─── CLI ─────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('generate-text-card.js');
if (isMain) {
  const { values } = parseArgs({
    options: {
      style:    { type: 'string', default: 'quote' },
      text:     { type: 'string', default: '' },
      headline: { type: 'string', default: '' },
      body:     { type: 'string', default: '' },
      output:   { type: 'string', default: '/tmp/text-card.png' },
    },
    strict: false,
  });

  try {
    const buf = await generateTextCard(values);
    writeFileSync(values.output, buf);
    console.log(`✓ ${values.output} (${buf.length} bytes, ${SIZE}×${SIZE})`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
