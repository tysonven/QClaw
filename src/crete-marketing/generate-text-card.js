/**
 * Crete Projects — Instagram Text Card Generator
 *
 * Generates branded 1080×1350 PNG images for Instagram.
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

const WIDTH  = 1080;
const HEIGHT = 1350;
const PAD  = 100;           // outer padding
const TEXT_W = WIDTH - PAD * 2; // usable text width

// ─── Helpers ─────────────────────────────────────────────────

/** Strip dangerous chars; keep printable text + common punctuation + emojis. */
export function sanitise(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')   // strip control chars
    .replace(/\s+[–—―]\s+/g, ' - ')      // spaced clause dash -> " - "
    .replace(/[–—―]/g, '-')              // tight/compound dash -> "-"
    .replace(/ {2,}/g, ' ')                             // collapse doubled spaces
    .trim()
    .slice(0, 2000);
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
  const x = (WIDTH - width) / 2;
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
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Top olive branch accents
  drawOliveBranch(ctx, PAD - 20, PAD + 20, 1.2, false);
  drawOliveBranch(ctx, WIDTH - PAD + 20, PAD + 20, 1.2, true);

  // Opening quote mark
  ctx.fillStyle = OLIVE_LIGHT;
  ctx.font = 'bold 120px "Cormorant Garamond"';
  ctx.textAlign = 'center';
  ctx.fillText('\u201C', WIDTH / 2, PAD + 130);

  // Quote text — large italic serif
  ctx.fillStyle = CHARCOAL;
  ctx.font = 'italic 42px "Cormorant Garamond"';
  ctx.textAlign = 'center';

  const lines = wrapText(ctx, text, TEXT_W - 40);
  const lineHeight = 58;
  const totalHeight = lines.length * lineHeight;
  let startY = (HEIGHT / 2) - (totalHeight / 2) + 40;
  // Clamp so text doesn't overflow
  startY = Math.max(PAD + 170, Math.min(startY, HEIGHT - PAD - 180 - totalHeight));

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], WIDTH / 2, startY + i * lineHeight);
  }

  // Closing quote mark
  ctx.fillStyle = OLIVE_LIGHT;
  ctx.font = 'bold 120px "Cormorant Garamond"';
  ctx.fillText('\u201D', WIDTH / 2, startY + totalHeight + 60);

  // Divider
  const divY = HEIGHT - PAD - 80;
  drawDivider(ctx, divY);

  // Brand footer
  ctx.fillStyle = OLIVE_DARK;
  ctx.font = '600 22px "Montserrat"';
  ctx.textAlign = 'center';
  ctx.fillText('C R E T E   P R O J E C T S', WIDTH / 2, divY + 36);

  ctx.fillStyle = WARM_GREY;
  ctx.font = '14px "Montserrat"';
  ctx.fillText('creteprojects.com', WIDTH / 2, divY + 60);
}

function renderEditorialCard(ctx, headline, body) {
  // Background
  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Accent bar at top
  ctx.fillStyle = OLIVE_DARK;
  ctx.fillRect(0, 0, WIDTH, 6);

  const HEADER_FONT   = '600 22px "Montserrat"';
  const HEADLINE_FONT = 'bold 92px "Cormorant Garamond"';
  const BODY_FONT     = '40px "DM Sans"';

  const headerH        = 22;  // block top -> header baseline
  const headLineH      = 106;
  const bodyLineH      = 58;
  const gapHeaderDiv   = 20;  // header baseline -> full divider
  const gapDivHeadline = 90;  // full divider -> headline first baseline
  const gapHeadSmall   = 30;  // headline last baseline -> small divider
  const gapSmallBody   = 60;  // small divider -> body first baseline
  const bodyDescender  = 12;  // visual allowance below last body baseline

  const minTop = 140;         // clear of the accent bar
  const maxBottom = 1150;     // clear of the olive branches + footer

  // Measure with the target fonts before positioning
  ctx.textAlign = 'left';
  ctx.font = HEADLINE_FONT;
  const headLines = wrapText(ctx, headline, TEXT_W);
  ctx.font = BODY_FONT;
  let bodyLines = body ? wrapText(ctx, body, TEXT_W) : [];

  // Block height from top through the small divider
  const fixedH = headerH + gapHeaderDiv + gapDivHeadline
    + (headLines.length - 1) * headLineH + gapHeadSmall;

  // Truncate body BEFORE centring so a trimmed block still sits centred
  if (bodyLines.length) {
    const maxBodyLines = Math.max(1, Math.floor(
      (maxBottom - minTop - fixedH - gapSmallBody - bodyDescender) / bodyLineH
    ) + 1);
    if (bodyLines.length > maxBodyLines) bodyLines = bodyLines.slice(0, maxBodyLines);
  }

  const blockH = fixedH + (bodyLines.length
    ? gapSmallBody + (bodyLines.length - 1) * bodyLineH + bodyDescender
    : 0);
  const blockTop = Math.max(minTop, Math.min((HEIGHT - blockH) / 2, maxBottom - blockH));

  // Brand header
  const headerY = blockTop + headerH;
  ctx.fillStyle = OLIVE_MID;
  ctx.font = HEADER_FONT;
  ctx.fillText('C R E T E   P R O J E C T S', PAD, headerY);

  // Olive branch next to header
  drawOliveBranch(ctx, PAD + ctx.measureText('C R E T E   P R O J E C T S').width + 20, headerY - 5, 0.8, false);

  // Divider below header
  const dividerY = headerY + gapHeaderDiv;
  ctx.strokeStyle = ACCENT_GOLD;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, dividerY);
  ctx.lineTo(WIDTH - PAD, dividerY);
  ctx.stroke();

  // Headline
  ctx.fillStyle = CHARCOAL;
  ctx.font = HEADLINE_FONT;
  const headY = dividerY + gapDivHeadline;
  for (let i = 0; i < headLines.length; i++) {
    ctx.fillText(headLines[i], PAD, headY + i * headLineH);
  }
  const lastHeadY = headY + (headLines.length - 1) * headLineH;

  // Small divider between headline and body
  const smallDivY = lastHeadY + gapHeadSmall;
  ctx.strokeStyle = ACCENT_GOLD;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PAD, smallDivY);
  ctx.lineTo(PAD + 80, smallDivY);
  ctx.stroke();

  // Body text
  if (bodyLines.length) {
    ctx.fillStyle = CHARCOAL;
    ctx.font = BODY_FONT;
    for (let i = 0; i < bodyLines.length; i++) {
      ctx.fillText(bodyLines[i], PAD, smallDivY + gapSmallBody + i * bodyLineH);
    }
  }

  // Bottom olive branches
  drawOliveBranch(ctx, PAD - 10, HEIGHT - PAD + 10, 1.0, false);
  drawOliveBranch(ctx, WIDTH - PAD + 10, HEIGHT - PAD + 10, 1.0, true);

  // Footer
  ctx.fillStyle = OLIVE_DARK;
  ctx.font = '600 28px "Montserrat"';
  ctx.textAlign = 'center';
  ctx.fillText('creteprojects.com', WIDTH / 2, HEIGHT - PAD + 40);
}

// ─── Public API ──────────────────────────────────────────────

export async function generateTextCard(opts) {
  const style = opts.style || 'quote';
  const canvas = createCanvas(WIDTH, HEIGHT);
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
    console.log(`✓ ${values.output} (${buf.length} bytes, ${WIDTH}×${HEIGHT})`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
