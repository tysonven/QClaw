/**
 * The public tunnel URL of a token tunnel comes from config, never from
 * cloudflared's output. Run: node tests/dashboard-tunnel-url.test.js
 *
 * dashboard.tunnelUrl is the Origin allowlist for cookie sessions
 * (isAllowedOrigin). Token mode used to resolve the tunnel URL to the FIRST
 * https:// URL anywhere in cloudflared's output and save it back to config, so
 * one stray log line would have locked every save, chat message and kill-switch
 * press out of the public dashboard.
 *
 * Drives the real DashboardServer.start() with a stand-in `cloudflared` on
 * PATH. Its output has the shape of a real start: a quic-go UDP buffer warning,
 * which links to github.com, printed BEFORE "Registered tunnel connection".
 */

import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';

const home = mkdtempSync(join(tmpdir(), 'qclaw-tunnel-url-'));
const bin = join(home, 'bin');
process.env.HOME = home;
process.env.DASHBOARD_SESSION_SECRET = 'test-session-secret-tunnel-0123456789';
delete process.env.DASHBOARD_AUTH_TOKEN;
delete process.env.QCLAW_API_TOKEN;
delete process.env.QCLAW_TUNNEL;
delete process.env.CLOUDFLARE_TUNNEL_TOKEN;

writeFileSync(join(home, '.keep'), '');
const { mkdirSync } = await import('node:fs');
mkdirSync(bin);
writeFileSync(join(bin, 'cloudflared'), [
  '#!/bin/sh',
  'echo "2026-09-19T00:00:00Z INF Starting tunnel tunnelID=00000000-0000-0000-0000-000000000000" >&2',
  'echo "2026-09-19T00:00:00Z INF failed to sufficiently increase receive buffer size (was: 208 kiB, wanted: 7168 kiB, got: 416 kiB). See https://github.com/quic-go/quic-go/wiki/UDP-Buffer-Sizes for details." >&2',
  'echo "2026-09-19T00:00:01Z INF Registered tunnel connection connIndex=0 event=0 ip=198.41.192.7 location=ams01 protocol=quic" >&2',
  'exec sleep 3600',
  '',
].join('\n'));
chmodSync(join(bin, 'cloudflared'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { DashboardServer } = await import('../src/dashboard/server.js');

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };

const SESSION = 'session-token-tunnel-cccccccccccccccccccccc';
const API = 'api-token-tunnel-dddddddddddddddddddddddddddddddd';
const TUNNEL = 'https://dash.example.test';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function run(label, dashboardExtra) {
  const port = await freePort();
  const file = join(home, `config-${label}.json`);
  const config = { _dir: home, _file: file, dashboard: { port, host: '127.0.0.1', tunnel: 'cloudflare', tunnelToken: 'stand-in-token', authToken: SESSION, apiToken: API, ...dashboardExtra } };
  const server = new DashboardServer({ config, agents: { count: 1, list: () => [], get: () => null, primary: () => ({ name: 'p', process: async () => ({ content: 'ok' }) }) }, memory: { getThreads: () => [] }, degradationLevel: 0 });
  await server.start();
  const origin = `http://127.0.0.1:${port}`;
  const cookie = (await fetch(`${origin}/?token=${SESSION}`, { redirect: 'manual' })).headers.getSetCookie()
    .find(c => c.startsWith('dashboard_session='))?.split(';')[0] || '';
  const post = (from) => fetch(`${origin}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: '*/*', Cookie: cookie, Origin: from },
    body: JSON.stringify({ message: 'hi' }),
  }).then(r => r.status);
  return { server, config, file, post };
}

try {
  console.log('\nToken tunnel, dashboard.tunnelUrl configured');
  let r = await run('configured', { tunnelUrl: TUNNEL });
  check('the tunnel URL is the configured one, not the first URL cloudflared printed', r.server.tunnelUrl === TUNNEL, String(r.server.tunnelUrl));
  check('config still holds the configured URL', r.config.dashboard.tunnelUrl === TUNNEL, String(r.config.dashboard.tunnelUrl));
  check('start() wrote nothing back to config.json', !existsSync(r.file), existsSync(r.file) ? readFileSync(r.file, 'utf8').slice(0, 200) : '');
  check('a save from the public URL still works', await r.post(TUNNEL) === 200);
  check('the URL cloudflared printed is not an allowed origin', await r.post('https://github.com') === 403);
  await r.server.stop();

  console.log('\nToken tunnel, dashboard.tunnelUrl NOT configured');
  r = await run('unset', {});
  check('the tunnel URL is not guessed from the output', r.server.tunnelUrl === null, String(r.server.tunnelUrl));
  check('nothing is written into config', r.config.dashboard.tunnelUrl === undefined && !existsSync(r.file), String(r.config.dashboard.tunnelUrl));
  check('the URL cloudflared printed is not an allowed origin', await r.post('https://github.com') === 403);
  check('the local dashboard still works', await r.post(`http://127.0.0.1:${r.config.dashboard.port}`) === 200);
  await r.server.stop();
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
