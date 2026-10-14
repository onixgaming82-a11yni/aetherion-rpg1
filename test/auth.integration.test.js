'use strict';
// End-to-end: spawns the REAL server.js (memory-only mode) and exercises
// Remember Me, cookie restore, logout/revocation, forgot + reset password.
// Run: npm install && node --test test/auth.integration.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 4500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
let server, serverLog = '';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
  const env = { ...process.env, PORT: String(PORT) };
  delete env.MONGO_URI; delete env.NODE_ENV; delete env.RESEND_API_KEY; delete env.PUBLIC_URL;
  server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env });
  server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
  for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch (_) { await sleep(100); } }
  throw new Error('server did not start:\n' + serverLog);
});
after(() => { if (server) server.kill(); });

function client() {
  const s = io(BASE, { transports: ['websocket'], forceNew: true });
  const once = (ev, ms = 4000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout: ' + ev)), ms); s.once(ev, d => { clearTimeout(t); res(d); }); });
  return { s, once, ready: new Promise(r => s.on('connect', r)) };
}
const post = (p, body, cookie) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body || {}),
});
const cookieOf = (res) => { const raw = (res.headers.getSetCookie?.() || [])[0] || ''; return { raw, pair: raw.split(';')[0] }; };

async function register(name, password, email) {
  const c = client(); await c.ready;
  const p = c.once('account:registered');
  c.s.emit('account:register', { username: name, password, email });
  await p; c.s.close();
}
// Log in and trade the cookie ticket for a cookie, exactly like the browser does.
async function loginWithCookie(name, password, remember) {
  const c = client(); await c.ready;
  const li = c.once('account:loggedin'), tk = c.once('auth:cookieTicket');
  c.s.emit('account:login', { username: name, password, remember });
  await li; const { ticket } = await tk;
  const res = await post('/auth/cookie', { ticket });
  assert.equal(res.status, 200);
  c.s.close();
  return { ...cookieOf(res), ticket };
}
async function restoreOnNewSocket(cookie) {
  const r = await (await post('/auth/session', {}, cookie)).json();
  if (!r.ok) return { http: r };
  const c = client(); await c.ready;
  const ack = await new Promise(res => c.s.emit('session:restore', { ticket: r.ticket }, res));
  const replay = await new Promise(res => c.s.emit('session:restore', { ticket: r.ticket }, res));
  c.s.close();
  return { http: r, ack, replay };
}

test('Remember Me: persistent HttpOnly cookie; restore works on a brand-new socket; ticket is single-use', async () => {
  await register('Rememberer', 'secret123', 'rem@example.com');
  const { raw, pair } = await loginWithCookie('Rememberer', 'secret123', true);
  assert.match(raw, /HttpOnly/); assert.match(raw, /SameSite=Lax/); assert.match(raw, /Max-Age=\d{6,}/);
  const out = await restoreOnNewSocket(pair);
  assert.equal(out.ack.ok, true); assert.equal(out.ack.username, 'Rememberer');
  assert.equal(out.replay.ok, false);
});

test('without Remember Me the cookie is a session cookie (no Max-Age/Expires)', async () => {
  const { raw } = await loginWithCookie('Rememberer', 'secret123', false);
  assert.ok(!/Max-Age|Expires/i.test(raw), raw);
});

test('logout revokes the session server-side; the old cookie is dead and gets cleared', async () => {
  const { pair } = await loginWithCookie('Rememberer', 'secret123', true);
  await post('/auth/logout', {}, pair);
  const res = await post('/auth/session', {}, pair);
  const j = await res.json();
  assert.equal(j.ok, false); assert.equal(j.reason, 'revoked');
  assert.match(cookieOf(res).raw, /Max-Age=0/);
});

test('no cookie / forged cookie never authenticates', async () => {
  assert.equal((await (await post('/auth/session', {})).json()).reason, 'none');
  const forged = 'aeth_sid=' + 'A'.repeat(43);
  assert.equal((await (await post('/auth/session', {}, forged)).json()).ok, false);
  const c = client(); await c.ready;
  const ack = await new Promise(res => c.s.emit('session:restore', { ticket: 'made-up' }, res));
  assert.equal(ack.ok, false); c.s.close();
});

test('cross-origin POST to /auth is rejected', async () => {
  const res = await fetch(BASE + '/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('forgot password answers identically for real and unknown accounts', async () => {
  const ask = async (identifier) => { const c = client(); await c.ready; const p = c.once('account:forgotSent'); c.s.emit('account:forgot', { identifier }); const r = await p; c.s.close(); return r; };
  assert.deepEqual(await ask('Rememberer'), await ask('no-such-user-xyz'));
});

test('reset flow: link works once, rejects weak passwords, revokes every session, old password dies', async () => {
  const { pair } = await loginWithCookie('Rememberer', 'secret123', true); // a session that must be revoked
  const c = client(); await c.ready;
  c.s.emit('account:forgot', { identifier: 'rem@example.com' });
  await c.once('account:forgotSent');
  let token = null;
  for (let i = 0; i < 40 && !token; i++) { await sleep(100); const m = /#reset=([A-Za-z0-9_-]{43})/.exec(serverLog); if (m) token = m[1]; }
  assert.ok(token, 'dev mailer should print the reset link');

  c.s.emit('account:resetPassword', { token, newPassword: 'abc' });
  assert.match((await c.once('account:resetError')).msg, /at least 6/);     // weak password does not burn the token
  c.s.emit('account:resetPassword', { token, newPassword: 'brand-new-pass' });
  assert.equal((await c.once('account:passwordReset')).ok, true);
  c.s.emit('account:resetPassword', { token, newPassword: 'another-pass-1' });
  assert.equal((await c.once('account:resetError')).fatal, true);             // single use
  c.s.close();

  assert.equal((await (await post('/auth/session', {}, pair)).json()).reason, 'revoked');
  const bad = client(); await bad.ready;
  const err = bad.once('account:error'); bad.s.emit('account:login', { username: 'Rememberer', password: 'secret123' });
  await err;
  const good = client(); await good.ready;
  const ok = good.once('account:loggedin'); good.s.emit('account:login', { username: 'Rememberer', password: 'brand-new-pass' });
  await ok; bad.s.close(); good.s.close();
});

test('changing the password signs out other devices', async () => {
  const other = await loginWithCookie('Rememberer', 'brand-new-pass', true);
  const c = client(); await c.ready;
  const li = c.once('account:loggedin'); c.s.emit('account:login', { username: 'Rememberer', password: 'brand-new-pass' }); await li;
  const done = c.once('account:passchanged');
  c.s.emit('account:changepass', { username: 'Rememberer', oldPassword: 'brand-new-pass', newPassword: 'changed-pass-9' });
  await done; c.s.close();
  assert.equal((await (await post('/auth/session', {}, other.pair)).json()).reason, 'revoked');
});
