'use strict';
// Unit tests for auth.js (sessions, cookies, tickets, password-reset tokens).
// No Express / Socket.IO / MongoDB needed: uses the in-memory store and an injectable clock.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../auth');

const DAY = 86_400_000;
function setup(config) {
  let t = 1_700_000_000_000;
  const store = A.createMemoryStore();
  const auth = A.createAuth({ store, config, now: () => t });
  return { auth, store, advance: (ms) => { t += ms; }, now: () => t };
}
async function login(ctx, uname = 'hero', remember = true) {
  const s = await ctx.auth.startSession(uname, { remember });
  assert.equal(s.status, 'ok');
  const c = await ctx.auth.redeemCookieTicket(s.cookieTicket);
  assert.equal(c.status, 'ok');
  return { sid: s.sid, token: c.token, cookie: c };
}

test('tokens are 256-bit, unique, base64url; only the hash is stored', async () => {
  const ctx = setup();
  const a = await login(ctx), b = await login(ctx);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/); // 32 bytes
  assert.notEqual(a.token, b.token);
  const doc = await ctx.store.getBySid(a.sid);
  assert.equal(doc.tokenHash, A.sha256(a.token));
  assert.ok(!JSON.stringify(doc).includes(a.token), 'raw token must not be stored');
});

test('a valid cookie restores the session; garbage / unknown tokens do not', async () => {
  const ctx = setup();
  const { token } = await login(ctx);
  const ok = await ctx.auth.resolveCookie(token);
  assert.equal(ok.status, 'ok'); assert.equal(ok.uname, 'hero');
  assert.equal((await ctx.auth.resolveCookie(A.newToken(32))).status, 'invalid');
  assert.equal((await ctx.auth.resolveCookie('')).status, 'invalid');
  assert.equal(A.readCookieToken('aeth_sid=short'), null);
  assert.equal(A.readCookieToken(`x=1; aeth_sid=${token}`), token);
});

test('a username alone never authenticates (no token => invalid)', async () => {
  const ctx = setup();
  await login(ctx, 'victim');
  assert.equal((await ctx.auth.resolveCookie('victim')).status, 'invalid');
});

test('cookie tickets are single-use and expire', async () => {
  const ctx = setup();
  const s = await ctx.auth.startSession('hero', { remember: true });
  assert.equal((await ctx.auth.redeemCookieTicket(s.cookieTicket)).status, 'ok');
  assert.equal((await ctx.auth.redeemCookieTicket(s.cookieTicket)).status, 'invalid'); // replay
  const s2 = await ctx.auth.startSession('hero', { remember: true });
  ctx.advance(31_000);
  assert.equal((await ctx.auth.redeemCookieTicket(s2.cookieTicket)).status, 'invalid'); // too late
});

test('a bind ticket cannot be used as a cookie ticket and vice versa', async () => {
  const ctx = setup();
  const { sid } = await login(ctx);
  const bind = ctx.auth.issueBindTicket(sid);
  assert.equal((await ctx.auth.redeemCookieTicket(bind)).status, 'invalid');
  const s = await ctx.auth.startSession('hero', {});
  assert.equal((await ctx.auth.redeemBindTicket(s.cookieTicket)).status, 'invalid');
});

test('bind ticket: single use, and a revoke between the two steps wins', async () => {
  const ctx = setup();
  const { sid } = await login(ctx);
  const t1 = ctx.auth.issueBindTicket(sid);
  assert.equal((await ctx.auth.redeemBindTicket(t1)).status, 'ok');
  assert.equal((await ctx.auth.redeemBindTicket(t1)).status, 'invalid');
  const t2 = ctx.auth.issueBindTicket(sid);
  await ctx.auth.revokeSession(sid);
  assert.equal((await ctx.auth.redeemBindTicket(t2)).status, 'revoked');
});

test('Remember Me: ~30-day persistent cookie; unchecked: session cookie + short server expiry', async () => {
  const ctx = setup();
  const r = await login(ctx, 'a', true);
  assert.ok(Math.abs(r.cookie.maxAgeSec - 30 * 86400) <= 1);
  assert.match(A.buildSetCookie(r.token, { maxAgeSec: r.cookie.maxAgeSec, secure: true }), /Max-Age=\d+.*Secure/);
  const n = await login(ctx, 'b', false);
  assert.equal(n.cookie.maxAgeSec, null);
  const header = A.buildSetCookie(n.token, { maxAgeSec: null });
  assert.ok(!/Max-Age|Expires/i.test(header), 'session cookie has no expiry attribute');
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/); assert.match(header, /Path=\//);
  // server-side: non-persistent session dies after 12h even though the client still holds the token
  ctx.advance(13 * 3_600_000);
  assert.equal((await ctx.auth.resolveCookie(n.token)).status, 'expired');
  assert.equal((await ctx.auth.resolveCookie(r.token)).status, 'ok');
});

test('expiry is enforced on the server: a remembered session dies after 30 days idle', async () => {
  const ctx = setup({ rotateMs: 365 * DAY }); // disable rotation so the lifetime is not extended
  const { token } = await login(ctx);
  ctx.advance(29 * DAY);
  assert.equal((await ctx.auth.resolveCookie(token)).status, 'ok');
  ctx.advance(2 * DAY);
  assert.equal((await ctx.auth.resolveCookie(token)).status, 'expired');
});

test('revocation: logout, revoke-all, and except-current', async () => {
  const ctx = setup();
  const a = await login(ctx), b = await login(ctx), other = await login(ctx, 'someone-else');
  await ctx.auth.revokeSession(a.sid);
  assert.equal((await ctx.auth.resolveCookie(a.token)).status, 'revoked');
  const c = await login(ctx);
  await ctx.auth.revokeAllForUser('hero', c.sid); // password change keeps the current device
  assert.equal((await ctx.auth.resolveCookie(b.token)).status, 'revoked');
  assert.equal((await ctx.auth.resolveCookie(c.token)).status, 'ok');
  assert.equal((await ctx.auth.resolveCookie(other.token)).status, 'ok'); // other accounts untouched
  await ctx.auth.revokeAllForUser('hero');
  assert.equal((await ctx.auth.resolveCookie(c.token)).status, 'revoked');
});

test('account deletion removes the sessions entirely', async () => {
  const ctx = setup();
  const { token } = await login(ctx);
  await ctx.auth.deleteAllForUser('hero');
  assert.equal((await ctx.auth.resolveCookie(token)).status, 'invalid');
});

test('rotation: stale token is replaced; old token survives only a short grace window', async () => {
  const ctx = setup();
  const { token } = await login(ctx);
  assert.equal((await ctx.auth.resolveCookie(token)).newToken, undefined); // fresh: no rotation
  ctx.advance(8 * DAY);
  const r = await ctx.auth.resolveCookie(token);
  assert.equal(r.status, 'ok');
  assert.match(r.newToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(r.maxAgeSec > 29 * 86400, 'sliding expiry renewed');
  // second tab still holding the old token right after rotation: allowed, and does NOT rotate again
  const again = await ctx.auth.resolveCookie(token);
  assert.equal(again.status, 'ok'); assert.equal(again.newToken, undefined);
  assert.equal((await ctx.auth.resolveCookie(r.newToken)).status, 'ok');
  ctx.advance(61_000);
  assert.equal((await ctx.auth.resolveCookie(token)).status, 'invalid'); // grace over
  assert.equal((await ctx.auth.resolveCookie(r.newToken)).status, 'ok');
});

test('sliding expiry never exceeds the absolute cap', async () => {
  const ctx = setup({ rememberMs: 30 * DAY, absoluteMaxMs: 40 * DAY, rotateMs: 7 * DAY });
  let { token } = await login(ctx);
  for (let i = 0; i < 4; i++) { ctx.advance(8 * DAY); const r = await ctx.auth.resolveCookie(token); assert.equal(r.status, 'ok'); token = r.newToken || token; }
  // 32 days in: capped expiry is day 40, so only ~8 days remain, not 30
  ctx.advance(9 * DAY);
  assert.equal((await ctx.auth.resolveCookie(token)).status, 'expired');
});

test('storage outage is reported as unavailable, never as a bad credential', async () => {
  const ctx = setup();
  const { token } = await login(ctx);
  ctx.store.findByTokenHash = async () => { throw new Error('db down'); };
  assert.equal((await ctx.auth.resolveCookie(token)).status, 'unavailable');
});

test('password reset token: random, single-use, expires, one live token per account', async () => {
  const ctx = setup();
  const a = await ctx.auth.createResetToken('hero');
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  const doc = [...[]]; void doc;
  assert.equal((await ctx.auth.consumeResetToken(a.token)).uname, 'hero');
  assert.equal((await ctx.auth.consumeResetToken(a.token)).status, 'invalid'); // replay
  const b = await ctx.auth.createResetToken('hero');
  const c = await ctx.auth.createResetToken('hero'); // requesting again kills the earlier link
  assert.equal((await ctx.auth.consumeResetToken(b.token)).status, 'invalid');
  ctx.advance(31 * 60_000);
  assert.equal((await ctx.auth.consumeResetToken(c.token)).status, 'expired');
  assert.equal((await ctx.auth.consumeResetToken('not-a-token')).status, 'invalid');
  assert.equal((await ctx.auth.consumeResetToken(A.newToken(32))).status, 'invalid');
});

test('cookie helpers: parsing and clearing', () => {
  assert.deepEqual(A.parseCookies('a=1; b=hello%20world; ; junk'), { a: '1', b: 'hello world' });
  assert.deepEqual(A.parseCookies(undefined), {});
  const clear = A.buildClearCookie({ secure: true });
  assert.match(clear, /Max-Age=0/); assert.match(clear, /Secure/); assert.match(clear, /HttpOnly/);
});

test('rate limiter blocks after max within the window', () => {
  const lim = A.createLimiter(3, 60_000);
  assert.deepEqual([1, 2, 3, 4].map(() => lim('ip')), [true, true, true, false]);
  assert.equal(lim('other-ip'), true);
});
