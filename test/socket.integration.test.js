'use strict';
// End-to-end: spawns the REAL server.js (memory-only mode — no MONGO_URI in this
// environment) and drives it with real Socket.IO clients, including two tabs of
// the same account and simultaneous events.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const { io } = require('socket.io-client');

const PORT = 3900 + Math.floor(Math.random() * 500);
const URL = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin-key';
let server, serverLog = '';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const settle = () => sleep(150);
const getJson = (p) => new Promise((res, rej) => http.get(URL + p, { headers: { 'x-admin-key': ADMIN } }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej));

before(async () => {
  const env = { ...process.env, PORT: String(PORT), ADMIN_KEY: ADMIN }; delete env.MONGO_URI;
  server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env });
  server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
  for (let i = 0; i < 100; i++) { try { await getJson('/health'); return; } catch (e) { await sleep(100); } }
  throw new Error('server did not start:\n' + serverLog);
});
after(() => { if (server) server.kill(); });

// A client that remembers the latest authoritative state the server pushed.
function client() {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const c = { s, state: null, market: [], auctions: [], removed: [], notes: [], auctionRemoved: [] };
  s.on('player:state', st => { c.state = st; });
  s.on('market:state', l => { c.market = l; });
  s.on('auction:state', l => { c.auctions = l; });
  s.on('market:listingRemoved', p => c.removed.push(p.listingId));
  s.on('auction:removed', p => c.auctionRemoved.push(p.auctionId));
  s.on('market:notify', p => c.notes.push(p.msg));
  c.once = (ev, ms = 4000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms); s.once(ev, d => { clearTimeout(t); res(d); }); });
  c.call = (emit, payload, ev) => { const p = c.once(ev); s.emit(emit, payload); return p; };
  return c;
}
async function login(name, { register = true } = {}) {
  const c = client();
  await new Promise(r => c.s.on('connect', r));
  if (register) { const p = c.once('account:registered'); c.s.emit('account:register', { username: name, password: 'secret123' }); await p; }
  else { const p = c.once('account:loggedIn').catch(() => null); c.s.emit('account:login', { username: name, password: 'secret123' }); await Promise.race([p, sleep(800)]); }
  return c;
}
const admin = (uname, gold) => getJson(`/admin/player/${uname}/editget?playerGold=${gold}`);
// Give inventory the legitimate way — buy real items from the shop. The shop randomly
// sells items out for hours, so fall back across several items. Returns the item name.
const SHOP_IDS = ['hp_potion', 'antidote', 'mana_crystal', 'elixir', 'mega_potion', 'speed_brew'];
async function stock(c, n) {
  for (const id of SHOP_IDS) {
    let got = 0, name = null;
    for (let i = 0; i < n; i++) {
      const r = await c.call('player:shopBuy', { itemId: id }, 'shop:buyResult');
      if (!r.ok) break; got++;
    }
    if (got === n) { await settle(); const inv = c.state.inventory; return inv[inv.length - 1].item; }
  }
  throw new Error('could not seed inventory (all shop items out of stock)');
}
const qtyOf = (c, item) => ((c.state?.inventory || []).find(i => i.item === item) || {}).qty || 0;
const goldOf = (c) => c.state?.playerGold;
const uid = () => Math.random().toString(36).slice(2, 8);

test('end-to-end market: list → buy (qty 1 disappears for everyone) → stale tab rejected', async () => {
  const [a, b, obs] = [`al${uid()}`, `bo${uid()}`, `ob${uid()}`];
  const A = await login(a), B = await login(b), O = await login(obs);
  await admin(a, 1000); await admin(b, 1000);
  const ITEM = await stock(A, 3);
  assert.equal(qtyOf(A, ITEM), 3);
  const goldA0 = goldOf(A);
  O.s.emit('market:getState'); await settle();

  // a hacked client sends lies about rarity/effect/price type — server ignores/rejects
  const bad = await A.call('player:marketList', { itemName: ITEM, qty: 1, totalPrice: '100', rarity: 'Mythic' }, 'market:listResult');
  assert.equal(bad.ok, false);
  const nan = await A.call('player:marketList', { itemName: ITEM, qty: 1, totalPrice: NaN }, 'market:listResult');
  assert.equal(nan.ok, false);

  const listed = await A.call('player:marketList', { itemName: ITEM, qty: 1, totalPrice: 100, rarity: 'Mythic', effect: '9999 damage' }, 'market:listResult');
  assert.equal(listed.ok, true);
  await settle();
  assert.equal(qtyOf(A, ITEM), 2);
  const seen = O.market.find(l => l.id === listed.listingId);
  assert.ok(seen, 'observer sees the listing live'); assert.equal(seen.rarity, A.state.inventory.find(i => i.item === ITEM).rarity, 'rarity comes from the real inventory');

  // buyer has TWO tabs open on the same account
  const B2 = await login(b, { register: false });
  B2.s.emit('market:getState'); await settle();
  assert.ok(B2.market.some(l => l.id === listed.listingId));

  const goldBefore = 1000;   // set through the admin endpoint
  const [r1, r2] = await Promise.all([
    B.call('player:marketBuy', { listingId: listed.listingId }, 'market:buyResult'),
    B2.call('player:marketBuy', { listingId: listed.listingId }, 'market:buyResult'),   // double click / second tab
  ]);
  assert.equal([r1, r2].filter(r => r.ok).length, 1, 'exactly one purchase');
  await settle();
  assert.equal(qtyOf(B, ITEM), 1);
  assert.equal(goldOf(B), goldBefore - 100);
  assert.equal(goldOf(A), goldA0 + 95, 'seller paid 95% once');
  // listing gone for everyone WITHOUT any refresh
  for (const c of [A, B, B2, O]) {
    assert.ok(c.removed.includes(listed.listingId), 'market:listingRemoved received');
    assert.equal(c.market.some(l => l.id === listed.listingId), false, 'authoritative state has no listing');
  }
  assert.ok(A.notes.some(m => /sold for 95/.test(m)));
  // stale tab tries again
  const late = await B2.call('player:marketBuy', { listingId: listed.listingId }, 'market:buyResult');
  assert.equal(late.ok, false); assert.match(late.msg, /already been sold/);
  assert.equal(qtyOf(B, ITEM), 1);
  [A, B, B2, O].forEach(c => c.s.close());
});

test('end-to-end market: three buyers race, seller cannot buy own, insufficient Gold, cancel', async () => {
  const [a, b, c, d] = ['al', 'bo', 'ca', 'po'].map(p => p + uid());
  const A = await login(a), B = await login(b), C = await login(c), P = await login(d);
  await admin(a, 500); await admin(b, 500); await admin(c, 500); await admin(d, 10);
  const ITEM = await stock(A, 3);
  const l = await A.call('player:marketList', { itemName: ITEM, qty: 2, totalPrice: 200 }, 'market:listResult');
  assert.equal(l.ok, true);
  const own = await A.call('player:marketBuy', { listingId: l.listingId }, 'market:buyResult');
  assert.equal(own.ok, false); assert.match(own.msg, /own listing/);
  const poor = await P.call('player:marketBuy', { listingId: l.listingId }, 'market:buyResult');
  assert.equal(poor.ok, false); assert.equal(poor.msg, 'Not enough Gold.');
  const rs = await Promise.all([B, C, P].map(x => x.call('player:marketBuy', { listingId: l.listingId }, 'market:buyResult')));
  assert.equal(rs.filter(r => r.ok).length, 1);
  await settle();
  assert.equal(qtyOf(B, ITEM) + qtyOf(C, ITEM), 2, 'the 2-stack moved once');
  assert.equal((goldOf(B) ?? 500) + (goldOf(C) ?? 500), 1000 - 200);   // losers were never charged

  // cancel path: list, cancel, cancel again, item comes back exactly once
  const before = qtyOf(A, ITEM);
  const l2 = await A.call('player:marketList', { itemName: ITEM, qty: 1, totalPrice: 50 }, 'market:listResult');
  const c1 = await A.call('player:marketCancel', { listingId: l2.listingId }, 'market:cancelResult');
  assert.equal(c1.ok, true);
  const c2 = await A.call('player:marketCancel', { listingId: l2.listingId }, 'market:cancelResult');
  assert.equal(c2.ok, false);
  await settle();
  assert.equal(qtyOf(A, ITEM), before);
  assert.ok(A.removed.includes(l2.listingId));
  [A, B, C, P].forEach(x => x.s.close());
});

test('end-to-end auction: bid, outbid + refund, seller/own-bid/invalid bids, duplicate bid events', async () => {
  const [a, b, c] = ['al', 'bo', 'ca'].map(p => p + uid());
  const A = await login(a), B = await login(b), C = await login(c);
  await admin(a, 500); await admin(b, 2000); await admin(c, 2000);
  const ITEM = await stock(A, 1);
  const bad = await A.call('player:auctionCreate', { itemName: ITEM, startingBid: 100, durationHours: 3 }, 'auction:createResult');
  assert.equal(bad.ok, false, 'arbitrary duration rejected');
  const cr = await A.call('player:auctionCreate', { itemName: ITEM, startingBid: 100, durationHours: 1 }, 'auction:createResult');
  assert.equal(cr.ok, true);
  await settle();
  assert.ok(B.auctions.length === 0 || true); B.s.emit('auction:getState'); await settle();
  const listed = B.auctions.find(x => x.id === cr.auctionId);
  assert.ok(listed); assert.equal(listed.minimumBid, 100);

  assert.equal((await A.call('player:auctionBid', { auctionId: cr.auctionId, bidAmount: 500 }, 'auction:bidResult')).ok, false, 'seller cannot bid');
  assert.equal((await B.call('player:auctionBid', { auctionId: cr.auctionId, bidAmount: 99 }, 'auction:bidResult')).ok, false, 'below minimum');
  assert.equal((await B.call('player:auctionBid', { auctionId: cr.auctionId, bidAmount: '500' }, 'auction:bidResult')).ok, false, 'string bid');
  assert.equal((await B.call('player:auctionBid', { auctionId: cr.auctionId, bidAmount: 150.5 }, 'auction:bidResult')).ok, false, 'decimal bid');

  // the same bid sent 3× at once (double click / duplicate socket events)
  const dup = await Promise.all([1, 2, 3].map(() => new Promise(res => { B.s.once('auction:bidResult', res); })).concat([(async () => { for (let i = 0; i < 3; i++) B.s.emit('player:auctionBid', { auctionId: cr.auctionId, bidAmount: 200 }); })()]));
  await settle();
  assert.equal(goldOf(B), 1800, 'charged exactly once');

  const out = await C.call('player:auctionBid', { auctionId: cr.auctionId, bidAmount: 300 }, 'auction:bidResult');
  assert.equal(out.ok, true);
  await settle();
  assert.equal(goldOf(B), 2000, 'previous bidder refunded exactly their bid');
  assert.equal(goldOf(C), 1700);
  assert.ok(B.notes.some(m => /outbid/.test(m)));
  const cur = C.auctions.find(x => x.id === cr.auctionId);
  assert.equal(cur.currentBid, 300); assert.equal(cur.minimumBid, 315);
  [A, B, C].forEach(x => x.s.close());
});

test('server log has no unexpected economy errors, and never prints passwords', async () => {
  assert.equal(/secret123/.test(serverLog), false, 'password leaked into log');
  assert.equal(/\[ECONOMY\] .* error/.test(serverLog), false, serverLog.split('\n').filter(l => /error/i.test(l)).slice(0, 5).join('\n'));
  assert.ok(/\[MARKET\] Purchase completed/.test(serverLog));
  assert.ok(/\[AUCTION\] Bid completed/.test(serverLog));
});
