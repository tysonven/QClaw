/**
 * Text card generator tests.
 * Run with: node tests/text-card.test.js
 */
import { generateTextCard, sanitise } from '../src/crete-marketing/generate-text-card.js';

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}

// PNG header: 8-byte signature, then IHDR = length(4) + "IHDR"(4) + width(4 BE) + height(4 BE).
// => width at byte offset 16, height at offset 20.
function pngDims(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

console.log('Text card — dimensions (1080×1350, 4:5):');

const quote = await generateTextCard({ style: 'quote', text: 'Design is the silent ambassador of your brand.' });
const q = pngDims(quote);
check('quote: is a non-trivial PNG buffer', Buffer.isBuffer(quote) && quote.length > 1000);
check(`quote: width 1080 (got ${q.width})`, q.width === 1080);
check(`quote: height 1350 (got ${q.height})`, q.height === 1350);

const editorial = await generateTextCard({
  style: 'editorial',
  headline: 'Built for the long term',
  body: 'Considered spaces, made to last a lifetime and beyond.',
});
const e = pngDims(editorial);
check('editorial: is a non-trivial PNG buffer', Buffer.isBuffer(editorial) && editorial.length > 1000);
check(`editorial: width 1080 (got ${e.width})`, e.width === 1080);
check(`editorial: height 1350 (got ${e.height})`, e.height === 1350);

console.log('\nText card — sanitise dash normalisation (context-aware → spaced hyphen):');

// — em-dash, – en-dash, ― horizontal bar
check('spaced em-dash → " - "', sanitise('I waited — then left') === 'I waited - then left');
check('tight em-dash → "-"', sanitise('cost—benefit') === 'cost-benefit');
check('en-dash range → "-"', sanitise('9am–5pm') === '9am-5pm');
check('spaced en-dash → " - "', sanitise('the plan – simple') === 'the plan - simple');
check('horizontal bar → " - "', sanitise('a ― b') === 'a - b');
check('multiple dashes', sanitise('Considered — timeless — design') === 'Considered - timeless - design');
check('extra spaces collapse to single', sanitise('a  —  b') === 'a - b');
check('plain text untouched', sanitise('Hello, world') === 'Hello, world');
check('control chars still stripped', sanitise('a\x00b') === 'ab');
check('surrounding whitespace trimmed', sanitise('  hi  ') === 'hi');
check('non-string → ""', sanitise(null) === '');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
