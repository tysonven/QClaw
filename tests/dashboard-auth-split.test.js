/**
 * #172 — dashboard auth precedence after splitting the browser session token
 * from the server-to-server api token, and after the session token stopped
 * being accepted as a machine credential.
 * Run: node tests/dashboard-auth-split.test.js
 *
 * Exercises the REAL resolveDashboardAuth from src/dashboard/server.js. The
 * function is pure so the precedence is asserted without an HTTP server: the
 * thing that matters is WHICH credential authenticates a request, and that a
 * machine caller never depends on the browser token.
 */

import { resolveDashboardAuth } from '../src/dashboard/server.js';

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };

const API = 'api-token-aaaaaaaaaaaaaaaa';
const SESSION = 'session-token-bbbbbbbbbbbb';
const okSession = () => { /* valid cookie */ };
const badSession = () => { throw new Error('expired'); };
const base = { cookie: null, bearer: null, queryToken: null, apiToken: API, authToken: SESSION, verifySession: okSession };

console.log('\nresolveDashboardAuth:');

// The split itself: a machine caller authenticates with the api token alone.
let r = resolveDashboardAuth({ ...base, bearer: API });
check('bearer api token authenticates', r.ok && r.via === 'bearer-api', JSON.stringify(r));
check('bearer api token is not flagged legacy', r.ok && !r.legacy, JSON.stringify(r));

// The failure this split removes: re-minting the session token must not break
// a machine caller that holds the api token.
r = resolveDashboardAuth({ ...base, authToken: 'freshly-re-minted-session', bearer: API });
check('api token still works after the session token is re-minted', r.ok && r.via === 'bearer-api', JSON.stringify(r));

// The tightening: the session token is no longer a machine credential.
r = resolveDashboardAuth({ ...base, bearer: SESSION });
check('bearer session token is REJECTED', !r.ok, JSON.stringify(r));
check('rejected bearer session token is named, not a bare 401', r.via === 'rejected-session-bearer', JSON.stringify(r));

r = resolveDashboardAuth({ ...base, queryToken: SESSION, isBrowser: false });
check('?token= session token is REJECTED for a non-browser caller', !r.ok && r.via === 'rejected-session-query', JSON.stringify(r));

// The browser hand-off survives: opening the dashboard link still works.
r = resolveDashboardAuth({ ...base, queryToken: SESSION, isBrowser: true });
check('?token= session token still authenticates a BROWSER', r.ok && r.via === 'query-browser', JSON.stringify(r));

// A browser cannot borrow the api token through the query param either.
r = resolveDashboardAuth({ ...base, queryToken: API, isBrowser: true });
check('api token is not accepted as a query param, even for a browser', !r.ok, JSON.stringify(r));

// Precedence: a correct api token wins even when a stale session token is also
// presented, so a machine caller is never resolved through the browser path.
r = resolveDashboardAuth({ ...base, bearer: API, queryToken: 'stale-session-value' });
check('api token wins over a stale query token', r.ok && r.via === 'bearer-api', JSON.stringify(r));

// A machine caller holding BOTH must still resolve through the api token.
r = resolveDashboardAuth({ ...base, bearer: API, queryToken: SESSION, isBrowser: false });
check('api token wins over a session query token', r.ok && r.via === 'bearer-api', JSON.stringify(r));

// Cookies keep priority for browsers.
r = resolveDashboardAuth({ ...base, cookie: 'jwt', verifySession: okSession });
check('valid cookie authenticates first', r.ok && r.via === 'cookie', JSON.stringify(r));

r = resolveDashboardAuth({ ...base, cookie: 'jwt', bearer: API, verifySession: badSession });
check('expired cookie falls through to the api token', r.ok && r.via === 'bearer-api', JSON.stringify(r));
check('expired cookie asks to be cleared', r.clearCookie === true, JSON.stringify(r));

r = resolveDashboardAuth({ ...base, cookie: 'jwt', verifySession: badSession });
check('expired cookie with no other credential fails', !r.ok && r.clearCookie === true, JSON.stringify(r));

// Rejections.
r = resolveDashboardAuth({ ...base, bearer: 'wrong' });
check('wrong bearer is rejected', !r.ok && r.via === null, JSON.stringify(r));

r = resolveDashboardAuth({ ...base, apiToken: null, bearer: 'anything' });
check('no api token configured: an arbitrary bearer is rejected', !r.ok, JSON.stringify(r));

r = resolveDashboardAuth({ cookie: null, bearer: null, queryToken: null, apiToken: null, authToken: null, verifySession: okSession });
check('nothing configured, nothing presented: rejected', !r.ok, JSON.stringify(r));

// An empty string must never authenticate by accident.
r = resolveDashboardAuth({ ...base, apiToken: '', bearer: '' });
check('empty api token and empty bearer do not authenticate', !r.ok, JSON.stringify(r));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
