/**
 * The dashboard's BROWSER auth, driven over real HTTP and a real WebSocket
 * against the real DashboardServer.start(), with requests shaped the way a
 * browser shapes them.
 * Run: node tests/dashboard-browser-auth.test.js
 *
 * Why this is not another resolveDashboardAuth() table: #179 was covered by
 * exactly such a table, which passed `isBrowser: true` into the resolver. The
 * dashboard's API calls are fetch(), and fetch() sends `Accept: *\/*`, never
 * the text/html that flag was derived from. The table passed while every tab
 * on the live dashboard returned `{"error":"Unauthorised"}`. The input the
 * test supplied was the fixture, not the request.
 *
 * So the requests here carry what a browser sends, and the UI half runs the
 * real apiFetch() and openTabFromHash() source taken out of ui.html rather
 * than a restatement of it.
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import vm from 'node:vm';
import WebSocket from 'ws';

// start() copies $HOME/.quantumclaw/.env into process.env. Point HOME at an
// empty directory so a developer's real dashboard credentials cannot leak in
// and make a check pass for the wrong reason.
const home = mkdtempSync(join(tmpdir(), 'qclaw-browser-auth-'));
process.env.HOME = home;
process.env.DASHBOARD_SESSION_SECRET = 'test-session-secret-0123456789abcdef';
delete process.env.DASHBOARD_AUTH_TOKEN;
delete process.env.QCLAW_API_TOKEN;
delete process.env.QCLAW_TUNNEL;

const { DashboardServer } = await import('../src/dashboard/server.js');

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };

const SESSION = 'session-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const API = 'api-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PIN = '4821';
const THREADS = [{ id: 'thread-marker-7f3a' }];

// What a browser sends for a page navigation, and what fetch() sends by
// default (the Fetch spec's default Accept is */*).
const NAV = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const FETCH = { Accept: '*/*' };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const qclaw = {
  config: { _dir: home, dashboard: { port, host: '127.0.0.1', tunnel: 'none', authToken: SESSION, apiToken: API, pin: PIN } },
  agents: {
    count: 1,
    list: () => [],
    get: () => null,
    primary: () => ({ name: 'primary', process: async (message) => ({ content: `echo:${message}` }) }),
  },
  memory: { getThreads: () => THREADS, cogneeConnected: false },
  degradationLevel: 0,
};
const server = new DashboardServer(qclaw);
await server.start();

const get = (path, headers = {}) => fetch(origin + path, { headers, redirect: 'manual' });
const postForm = (path, fields) => fetch(origin + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...NAV },
  body: new URLSearchParams(fields).toString(),
});
const sessionCookieFrom = (res) => {
  const raw = res.headers.getSetCookie().find(c => c.startsWith('dashboard_session='));
  return raw ? { pair: raw.split(';')[0], attrs: raw.split(';').slice(1).map(a => a.trim().toLowerCase()) } : null;
};

try {
  console.log('\nThe `qclaw dashboard` link: GET /?token= exchanges the token for the session cookie');
  let res = await get(`/?token=${SESSION}`, NAV);
  check('valid link -> 302 to / (token leaves the address bar)', res.status === 302 && res.headers.get('location') === '/',
    `${res.status} ${res.headers.get('location')}`);
  const cookie = sessionCookieFrom(res);
  check('valid link sets dashboard_session', !!cookie, JSON.stringify(res.headers.getSetCookie()));
  check('cookie is HttpOnly, Secure, SameSite=Strict',
    !!cookie && ['httponly', 'secure', 'samesite=strict'].every(a => cookie.attrs.includes(a)), JSON.stringify(cookie?.attrs));

  // The exact call that failed live: a tab's fetch(), Accept */*.
  res = await get('/api/threads', { ...FETCH, Cookie: cookie?.pair || '' });
  let body = await res.json().catch(() => null);
  check('a tab\'s fetch() with the cookie -> 200 and the real data', res.status === 200 && body?.[0]?.id === 'thread-marker-7f3a',
    `${res.status} ${JSON.stringify(body)}`);

  // What the UI sent before this change, and what the live log recorded as
  // rejected-session-query. Still rejected: the session token is not an API credential.
  res = await get(`/api/threads?token=${SESSION}`, FETCH);
  body = await res.json().catch(() => null);
  check('fetch() with ?token=<session> and no cookie -> 401 Unauthorised', res.status === 401 && body?.error === 'Unauthorised',
    `${res.status} ${JSON.stringify(body)}`);
  check('that 401 is marked login-required, so the UI can send the reader to /login',
    res.headers.get('x-dashboard-auth') === 'login-required', String(res.headers.get('x-dashboard-auth')));

  res = await get('/?token=not-the-session-token', NAV);
  check('stale or wrong link -> /login?error=1, not a dashboard of failing tabs',
    res.status === 302 && res.headers.get('location') === '/login?error=1', `${res.status} ${res.headers.get('location')}`);
  check('wrong link sets no session cookie', !sessionCookieFrom(res), JSON.stringify(res.headers.getSetCookie()));

  res = await get('/?token=api-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NAV);
  check('the api token cannot be exchanged for a browser session', res.status === 302 && !sessionCookieFrom(res),
    `${res.status} ${JSON.stringify(res.headers.getSetCookie())}`);

  res = await get('/', NAV);
  const shell = await res.text();
  check('bare / still serves the dashboard shell', res.status === 200 && shell.includes('async function apiFetch('), String(res.status));

  // A page navigation straight to an API route with the token was the one
  // thing #179's isBrowser branch accepted. The hand-off at / replaces it.
  res = await get(`/api/threads?token=${SESSION}`, NAV);
  check('navigating to an API route with ?token= is not a way in (-> /login)',
    res.status === 302 && res.headers.get('location') === '/login', `${res.status} ${res.headers.get('location')}`);

  console.log('\nMachine callers are unchanged (#177/#179)');
  res = await get('/api/threads', { ...FETCH, Authorization: `Bearer ${API}` });
  check('Bearer api token -> 200', res.status === 200, String(res.status));
  res = await get('/api/threads', { ...FETCH, Authorization: `Bearer ${SESSION}` });
  check('Bearer session token -> 401', res.status === 401, String(res.status));

  console.log('\n/login returns the reader to the tab they were sent to');
  res = await postForm('/api/auth/login', { password: SESSION, tab: 'ghl' });
  check('sign-in with tab=ghl -> /#ghl', res.status === 302 && res.headers.get('location') === '/#ghl',
    `${res.status} ${res.headers.get('location')}`);
  check('sign-in sets the same session cookie', !!sessionCookieFrom(res));
  for (const evil of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', 'ghl"><script>x</script>', 'GHL', 'ghl/../x']) {
    res = await postForm('/api/auth/login', { password: SESSION, tab: evil });
    check(`sign-in with tab=${JSON.stringify(evil)} -> plain /`, res.headers.get('location') === '/', String(res.headers.get('location')));
  }
  res = await postForm('/api/auth/login', { password: 'wrong', tab: 'ghl' });
  check('failed sign-in keeps the tab', res.headers.get('location') === '/login?error=1&tab=ghl', String(res.headers.get('location')));

  res = await get('/login?tab=ghl', NAV);
  let page = await res.text();
  check('login page carries the tab', page.includes('<input type="hidden" name="tab" value="ghl">'));
  check('login page says where the token comes from', page.includes('<code>qclaw dashboard</code>'));
  res = await get(`/login?tab=${encodeURIComponent('"><script>x</script>')}`, NAV);
  page = await res.text();
  check('an unsafe tab is not reflected into the login page', !page.includes('<script>x') && !page.includes('name="tab"'));

  console.log('\nThe login-required marker is only on "no valid session" 401s');
  res = await fetch(origin + '/api/auth/verify-pin', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...FETCH }, body: JSON.stringify({ pin: '0000' }),
  });
  check('wrong PIN is a 401 WITHOUT the marker (must not sign anyone out)',
    res.status === 401 && res.headers.get('x-dashboard-auth') === null, `${res.status} ${res.headers.get('x-dashboard-auth')}`);

  console.log('\nChat socket: the cookie now works, and the terminal UI\'s ?token= still does');
  const wsOutcome = (path, headers = {}) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const frames = [];
    const done = (outcome) => { clearTimeout(timer); try { ws.terminate(); } catch { /* closed */ } resolve({ outcome, frames }); };
    const timer = setTimeout(() => done('timeout'), 3000);
    ws.on('open', () => ws.send(JSON.stringify({ message: 'ping' })));
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString());
      frames.push(f);
      if (f.type === 'response') done('response');
      if (f.type === 'error') done('error');
    });
    ws.on('close', (code) => done(`closed:${code}`));
    ws.on('error', (err) => done(`socket-error:${err.message}`));
  });
  let w = await wsOutcome('/ws', { Cookie: cookie?.pair || '' });
  check('socket with the session cookie gets an agent response',
    w.outcome === 'response' && w.frames.some(f => f.type === 'response' && f.content === 'echo:ping'), JSON.stringify(w));
  w = await wsOutcome(`/ws?token=${SESSION}`);
  check('socket with ?token=<session> (src/cli/tui.js) still gets a response', w.outcome === 'response', JSON.stringify(w));
  w = await wsOutcome('/ws');
  check('socket with nothing is refused', w.outcome === 'error' && w.frames[0]?.error === 'Unauthorised', JSON.stringify(w));
  w = await wsOutcome('/ws', { Cookie: 'dashboard_session=forged.jwt.value' });
  check('socket with a forged cookie is refused', w.outcome === 'error', JSON.stringify(w));

  console.log('\nui.html: the real client code');
  const uiPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'dashboard', 'ui.html');
  const script = readFileSync(uiPath, 'utf-8').match(/<script>([\s\S]*?)<\/script>/)[1];
  check('no token is put into any URL', !/token=/.test(script), (script.match(/.{0,60}token=.{0,40}/) || [''])[0]);
  check('no token is written to script-readable storage', !/sessionStorage\.setItem|localStorage\.setItem\(\s*['"]dashboard_token/.test(script));
  // `fetch()` with no argument only appears in a comment; every real call has one.
  const rawFetches = [...script.matchAll(/(?<![\w.])fetch\(([^,)]*)/g)].map(m => m[1].trim()).filter(Boolean);
  const nonApi = rawFetches.filter(a => a !== 'path' && !a.startsWith("'https://") && a !== '_agencyCurrent.url');
  check('every same-origin call goes through apiFetch (raw fetch only for external webhooks)', rawFetches.length > 0 && nonApi.length === 0,
    JSON.stringify(rawFetches));
  check('the chat socket URL carries no token', /new WebSocket\(proto \+ ':\/\/' \+ location\.host \+ '\/ws'\)/.test(script));

  // Pull the real functions out of the page source and run them.
  const extract = (header) => {
    const start = script.indexOf(header);
    if (start < 0) throw new Error(`ui.html: ${header} not found`);
    let depth = 0;
    for (let i = script.indexOf('{', start); i < script.length; i++) {
      if (script[i] === '{') depth++;
      else if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
    }
    throw new Error(`ui.html: ${header} is unbalanced`);
  };
  const clientSource = [extract('function currentTab()'), extract('async function apiFetch('), extract('function openTabFromHash()')].join('\n');

  // A browser's same-origin fetch: relative URL resolved against the page,
  // the cookie jar attached for credentials 'same-origin', Accept */* by default.
  const makeClient = ({ jar, activeTab, hash = '' }) => {
    const replaced = [];
    const clicked = [];
    const navItems = ['chat', 'ghl', 'crete'].map(page => ({
      dataset: { page }, classList: { contains: () => page === activeTab }, click: () => clicked.push(page),
    }));
    const ctx = {
      location: { replace: (u) => replaced.push(u), hash },
      document: {
        querySelector: (sel) => (sel === '.nav-item.active[data-page]' ? navItems.find(n => n.dataset.page === activeTab) || null : null),
        querySelectorAll: (sel) => (sel === '.nav-item[data-page]' ? navItems : []),
      },
      encodeURIComponent,
      fetch: (path, opts = {}) => fetch(origin + path, {
        ...opts,
        headers: { ...FETCH, ...(opts.headers || {}), ...(opts.credentials === 'same-origin' && jar ? { Cookie: jar } : {}) },
      }),
    };
    vm.createContext(ctx);
    vm.runInContext(clientSource, ctx);
    return { ctx, replaced, clicked };
  };

  let client = makeClient({ jar: null, activeTab: 'ghl' });
  let threw = null;
  try { await client.ctx.apiFetch('/api/threads'); } catch (e) { threw = e; }
  check('apiFetch with no session sends the reader to /login?tab=ghl', client.replaced[0] === '/login?tab=ghl', JSON.stringify(client.replaced));
  check('...and does not hand the failure to the tab as data', threw !== null);

  // A throw here is a failed check, not an aborted run: the rest must still report.
  const settle = async (p) => { try { return { res: await p }; } catch (err) { return { err }; } };

  client = makeClient({ jar: cookie?.pair, activeTab: 'ghl' });
  let call = await settle(client.ctx.apiFetch('/api/threads'));
  body = call.res ? await call.res.json().catch(() => null) : null;
  check('apiFetch with the cookie returns the data',
    call.res?.status === 200 && body?.[0]?.id === 'thread-marker-7f3a' && client.replaced.length === 0,
    `${call.res?.status ?? call.err} ${JSON.stringify(client.replaced)}`);

  client = makeClient({ jar: cookie?.pair, activeTab: 'chat' });
  call = await settle(client.ctx.apiFetch('/api/auth/verify-pin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0000' }),
  }));
  check('apiFetch leaves an unmarked 401 (wrong PIN) to the caller', call.res?.status === 401 && client.replaced.length === 0,
    `${call.res?.status ?? call.err} ${JSON.stringify(client.replaced)}`);

  client = makeClient({ jar: null, activeTab: 'chat', hash: '#ghl' });
  client.ctx.openTabFromHash();
  check('/#ghl opens the GHL Marketing tab', JSON.stringify(client.clicked) === '["ghl"]', JSON.stringify(client.clicked));
  for (const h of ['#nope', '#ghl"]', '#', '']) {
    client = makeClient({ jar: null, activeTab: 'chat', hash: h });
    let err = null;
    try { client.ctx.openTabFromHash(); } catch (e) { err = e; }
    check(`hash ${JSON.stringify(h)} opens nothing and does not throw`, !err && client.clicked.length === 0, `${err} ${JSON.stringify(client.clicked)}`);
  }
} finally {
  await server.stop();
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
