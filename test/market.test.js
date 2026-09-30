'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, started } = require('./harness');

const SWORD = { item: 'Iron Sword', rarity: 'Rare', qty: 3, effect: { type: 'atk', val: 7 } };
const fullBag = () => Array.from({ length: 200 }, (_, i) => ({ item: 'Junk' + i, rarity: 'Common', qty: 1 }));

async function scene({ sellerInv = [{ ...SWORD }], buyerGold = 1000, buyerInv = [] } = {}) {
  const w = makeWorld();
  w.seed('alice', { gold: 50, inventory: sellerInv, display: 'Alice' });
  w.seed('bob', { gold: buyerGold, inventory: buyerInv, display: 'Bob' });
  w.seed('carol', { gold: 1000, inventory: [], display: 'Carol' });
  const b = await started(w);
  return { w, ...b };
}
const list = (eco, qty = 1, price = 100, who = 'alice', item = 'Iron Sword') => eco.createListing(who, { itemName: item, qty, totalPrice: price });

// ───────────────────────── create ─────────────────────────
test('create listing: item leaves inventory, listing persisted, snapshot comes from the REAL inventory', async () => {
  const { w, eco } = await scene();
  // client lies about rarity/effect — extra fields must be ignored
  const r = await eco.createListing('alice', { itemName: 'Iron Sword', qty: 1, totalPrice: 100, rarity: 'Mythic', effect: '9999 damage', item: 'Legendary Sword' });
  assert.equal(r.ok, true);
  const l = w.db.listings.get(r.listingId);
  assert.equal(l.item, 'Iron Sword'); assert.equal(l.rarity, 'Rare'); assert.deepEqual(l.effect, SWORD.effect);
  assert.deepEqual(l.snapshot, { itemId: 'Iron Sword', item: 'Iron Sword', rarity: 'Rare', effect: SWORD.effect, quantity: 1 });
  assert.equal(w.qty('alice', 'Iron Sword'), 2);
  assert.equal(w.db.txs.get(`market:${r.listingId}:list`).state, 'done');
});
test('cannot list an item you do not own / more than you own', async () => {
  const { eco } = await scene();
  assert.equal((await list(eco, 1, 100, 'alice', 'Legendary Sword')).ok, false);
  assert.equal((await list(eco, 4, 100)).ok, false);
});
test('invalid prices and quantities are rejected (NaN, Infinity, negative, decimal, string, overflow, zero)', async () => {
  const { eco, w } = await scene();
  for (const bad of [NaN, Infinity, -Infinity, -5, 0, 1.5, '100', '1e3', null, undefined, {}, [], 1e12, 2 ** 53, 1_000_000_000])
    assert.equal((await eco.createListing('alice', { itemName: 'Iron Sword', qty: 1, totalPrice: bad })).ok, false, `price ${String(bad)}`);
  for (const bad of [NaN, Infinity, -1, 0, 0.5, '1', null, undefined, 1000, 1e12])
    assert.equal((await eco.createListing('alice', { itemName: 'Iron Sword', qty: bad, totalPrice: 10 })).ok, false, `qty ${String(bad)}`);
  assert.equal(w.qty('alice', 'Iron Sword'), 3);         // nothing was taken
  assert.equal(w.db.listings.size, 0);
});
test('per-player listing limit holds even under a burst of concurrent requests', async () => {
  const { eco } = await scene({ sellerInv: [{ item: 'Iron Sword', rarity: 'Rare', qty: 50 }] });
  const rs = await Promise.all(Array.from({ length: 25 }, () => list(eco, 1, 10)));
  assert.equal(rs.filter(r => r.ok).length, 10);
});
test('concurrent listing of the last unit: only one listing is created (no item duplication)', async () => {
  const { eco, w } = await scene({ sellerInv: [{ item: 'Iron Sword', rarity: 'Rare', qty: 1 }] });
  const rs = await Promise.all([list(eco, 1, 10), list(eco, 1, 20), list(eco, 1, 30)]);
  assert.equal(rs.filter(r => r.ok).length, 1);
  assert.equal(w.db.listings.size, 1);
  assert.equal(w.totals().items['Iron Sword'], 1);
});

// ───────────────────────── buy ─────────────────────────
test('BUG FIX: quantity 1 listing disappears completely after purchase (memory, DB, broadcast)', async () => {
  const { w, eco, events } = await scene();
  const { listingId } = await list(eco, 1, 100);
  const before = w.totals();
  const r = await eco.buyListing('bob', listingId);
  assert.equal(r.ok, true);
  assert.equal(eco._listings.has(listingId), false);
  assert.equal(w.db.listings.has(listingId), false);
  assert.equal(eco.marketPayload().some(l => l.id === listingId), false);
  assert.ok(events.some(([e, p]) => e === 'market:listingRemoved' && p.listingId === listingId));
  const state = events.filter(([e]) => e === 'market:state').pop()[1];
  assert.equal(state.some(l => l.id === listingId), false);
  assert.equal(w.gold('bob'), 900);
  assert.equal(w.gold('alice'), 50 + 95);                // 5% fee
  assert.equal(w.qty('bob', 'Iron Sword'), 1);
  const after = w.totals();
  assert.equal(after.items['Iron Sword'], before.items['Iron Sword']);   // no item created/destroyed
  assert.equal(before.gold - after.gold, 5);                              // only the fee left the economy
  assert.equal(w.db.txs.get(`market:${listingId}:purchase`).state, 'done');
  assert.equal(w.db.txs.get(`market:${listingId}:purchase`).record.price, 100);
});
test('quantity > 1 purchase moves the whole stack and preserves rarity/effect', async () => {
  const { w, eco } = await scene();
  const { listingId } = await list(eco, 3, 300);
  assert.equal((await eco.buyListing('bob', listingId)).ok, true);
  const got = w.dbSave('bob').inventory.find(i => i.item === 'Iron Sword');
  assert.deepEqual(got, { item: 'Iron Sword', rarity: 'Rare', qty: 3, effect: SWORD.effect });
  assert.equal(w.qty('alice', 'Iron Sword'), 0);
});
test('insufficient Gold: nothing changes, listing stays', async () => {
  const { w, eco } = await scene({ buyerGold: 99 });
  const { listingId } = await list(eco, 1, 100);
  const r = await eco.buyListing('bob', listingId);
  assert.equal(r.ok, false); assert.equal(r.msg, 'Not enough Gold.'); assert.equal(r.playerGold, 99);
  assert.equal(w.gold('bob'), 99); assert.equal(w.gold('alice'), 50);
  assert.ok(eco._listings.has(listingId) && w.db.listings.has(listingId));
  assert.equal(eco._listings.get(listingId)._lock, undefined);   // lock released
});
test('INVENTORY FULL: purchase rejected, Gold unchanged, listing remains, seller unpaid', async () => {
  const { w, eco } = await scene({ buyerInv: fullBag() });
  const { listingId } = await list(eco, 1, 100);
  const before = w.totals();
  const r = await eco.buyListing('bob', listingId);
  assert.equal(r.ok, false); assert.equal(r.msg, 'Your inventory is full.');
  assert.equal(w.gold('bob'), 1000); assert.equal(w.gold('alice'), 50);
  assert.ok(eco._listings.has(listingId) && w.db.listings.has(listingId));
  assert.deepEqual(w.totals(), before);
  // …but a full bag that already holds a stack of that item can still receive more
  const w2 = await scene({ buyerInv: [...fullBag().slice(1), { item: 'Iron Sword', rarity: 'Rare', qty: 1 }] });
  const l2 = await list(w2.eco, 1, 100);
  assert.equal((await w2.eco.buyListing('bob', l2.listingId)).ok, true);
});
test('seller cannot buy own listing', async () => {
  const { eco, w } = await scene();
  const { listingId } = await list(eco, 1, 100);
  const r = await eco.buyListing('alice', listingId);
  assert.equal(r.ok, false); assert.match(r.msg, /own listing/);
  assert.equal(w.gold('alice'), 50);
});
test('double purchase (same buyer, two events at once): exactly one succeeds, Gold charged once', async () => {
  const { eco, w } = await scene();
  const { listingId } = await list(eco, 1, 100);
  const rs = await Promise.all([eco.buyListing('bob', listingId), eco.buyListing('bob', listingId)]);
  assert.equal(rs.filter(r => r.ok).length, 1);
  assert.equal(w.gold('bob'), 900); assert.equal(w.qty('bob', 'Iron Sword'), 1);
  assert.equal(w.gold('alice'), 145);
  // and a third, later attempt (stale tab)
  const late = await eco.buyListing('bob', listingId);
  assert.equal(late.ok, false); assert.match(late.msg, /already been sold/);
});
test('two different buyers race for the same listing: one wins, the other is rejected, no duplication', async () => {
  const { eco, w } = await scene();
  const { listingId } = await list(eco, 1, 100);
  const before = w.totals();
  const rs = await Promise.all([eco.buyListing('bob', listingId), eco.buyListing('carol', listingId)]);
  assert.equal(rs.filter(r => r.ok).length, 1);
  assert.equal(w.qty('bob', 'Iron Sword') + w.qty('carol', 'Iron Sword'), 1);
  assert.equal(w.gold('bob') + w.gold('carol'), 2000 - 100);
  assert.equal(w.totals().items['Iron Sword'], before.items['Iron Sword']);
});
test('100 simultaneous buyers: exactly one purchase', async () => {
  const w = makeWorld(); w.seed('alice', { inventory: [{ ...SWORD }] });
  for (let i = 0; i < 100; i++) w.seed('b' + i, { gold: 500 });
  const { eco } = await started(w);
  const { listingId } = await list(eco, 1, 100);
  const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => eco.buyListing('b' + i, listingId)));
  assert.equal(rs.filter(r => r.ok).length, 1);
  let sum = 0; for (let i = 0; i < 100; i++) sum += w.gold('b' + i);
  assert.equal(sum, 100 * 500 - 100);
});
test('stale request for an unknown / tampered listing id', async () => {
  const { eco } = await scene();
  for (const bad of ['nope', '', null, undefined, 42, {}, '__proto__', 'x'.repeat(500)])
    assert.equal((await eco.buyListing('bob', bad)).ok, false);
});
test('banned / on-hold players cannot trade', async () => {
  const w = makeWorld(); w.seed('alice', { inventory: [{ ...SWORD }] }); w.seed('bob', { gold: 999 });
  const { eco } = await started(w, { canTrade: (u) => u !== 'bob' });
  const { listingId } = await list(eco, 1, 100);
  assert.equal((await eco.buyListing('bob', listingId)).ok, false);
});

// ───────────────────────── cancel ─────────────────────────
test('cancel returns the exact item; second cancel fails; wrong seller fails', async () => {
  const { eco, w, events } = await scene();
  const { listingId } = await list(eco, 2, 100);
  assert.equal((await eco.cancelListing('bob', listingId)).ok, false);        // not the seller
  assert.equal((await eco.cancelListing('alice', listingId)).ok, true);
  assert.deepEqual(w.dbSave('alice').inventory.find(i => i.item === 'Iron Sword'), { item: 'Iron Sword', rarity: 'Rare', qty: 3, effect: SWORD.effect });
  assert.equal(w.db.listings.has(listingId), false);
  assert.ok(events.some(([e, p]) => e === 'market:listingRemoved' && p.listingId === listingId));
  assert.equal((await eco.cancelListing('alice', listingId)).ok, false);      // cannot cancel twice
  assert.equal(w.qty('alice', 'Iron Sword'), 3);                              // not returned twice
});
test('cancel with a full inventory: listing is NOT deleted, item not lost, recoverable', async () => {
  const { eco, w } = await scene({ sellerInv: [{ item: 'Iron Sword', rarity: 'Rare', qty: 1 }] });
  const { listingId } = await list(eco, 1, 100);
  // seller fills the bag while the item is listed
  const s = w.dbSave('alice'); s.inventory = fullBag(); w.db.accounts.get('alice').save = JSON.stringify(s);
  eco._listings.get(listingId); // (cache already loaded the account → mirror the change there too)
  const acc = (await started(w)).eco; // fresh process sees the full bag
  const r = await acc.cancelListing('alice', listingId);
  assert.equal(r.ok, false); assert.equal(r.msg, 'Your inventory is full.');
  assert.ok(acc._listings.has(listingId) && w.db.listings.has(listingId));
  assert.equal(w.totals().items['Iron Sword'], 1);
  // make room → cancel now works
  const s2 = w.dbSave('alice'); s2.inventory.pop(); w.db.accounts.get('alice').save = JSON.stringify(s2);
  const eco3 = (await started(w)).eco;
  assert.equal((await eco3.cancelListing('alice', listingId)).ok, true);
  assert.equal(w.totals().items['Iron Sword'], 1);
});
test('cancel racing a purchase: exactly one wins', async () => {
  const { eco, w } = await scene();
  const { listingId } = await list(eco, 1, 100);
  const [c, b] = await Promise.all([eco.cancelListing('alice', listingId), eco.buyListing('bob', listingId)]);
  assert.equal([c, b].filter(r => r.ok).length, 1);
  assert.equal(w.totals().items['Iron Sword'], 3);
  if (b.ok) assert.equal(w.gold('bob'), 900); else assert.equal(w.gold('bob'), 1000);
});

// ───────────────────────── restart ─────────────────────────
test('MANDATORY RESTART TEST: listing survives restart; after purchase it does NOT come back', async () => {
  const { w, eco } = await scene();
  const { listingId } = await list(eco, 1, 100);
  const r1 = await started(w);                                   // restart #1
  assert.ok(r1.eco._listings.has(listingId), 'Listing A still exists');
  assert.equal(r1.eco.marketPayload().length, 1);
  assert.equal((await r1.eco.buyListing('bob', listingId)).ok, true);
  const r2 = await started(w);                                   // restart #2
  assert.equal(r2.eco._listings.has(listingId), false, 'Listing A must NOT return');
  assert.equal(r2.eco.marketPayload().length, 0);
  assert.equal((await r2.eco.buyListing('carol', listingId)).ok, false);
  assert.equal(w.qty('bob', 'Iron Sword'), 1); assert.equal(w.totals().items['Iron Sword'], 3);
});

// ───────────────────────── database failure ─────────────────────────
test('DB failure while journaling: purchase fails cleanly, nothing changes', async () => {
  const { w, eco } = await scene();
  const { listingId } = await list(eco, 1, 100);
  const before = w.totals();
  w.faults.saveTx = 1;
  const r = await eco.buyListing('bob', listingId);
  assert.equal(r.ok, false); assert.match(r.msg, /temporarily unavailable/);
  assert.equal(w.gold('bob'), 1000); assert.equal(w.qty('bob', 'Iron Sword'), 0);
  assert.ok(eco._listings.has(listingId) && w.db.listings.has(listingId));
  assert.deepEqual(w.totals(), before);
  assert.equal((await eco.buyListing('bob', listingId)).ok, true);   // works once the DB is back
});
test('DB completely down: all market operations are refused, state untouched', async () => {
  const { w, eco } = await scene();
  const { listingId } = await list(eco, 1, 100);
  w.faults.down = true;
  assert.equal((await eco.buyListing('bob', listingId)).ok, false);
  assert.equal((await eco.cancelListing('alice', listingId)).ok, false);
  assert.equal((await list(eco, 1, 5)).ok, false);
  w.faults.down = false;
  assert.equal(w.totals().items['Iron Sword'], 3);
});
test('DB failure while persisting accounts: committed tx is deferred, retried by the sweep, listing gone meanwhile', async () => {
  const { w, eco } = await scene();
  const { listingId } = await list(eco, 1, 100);
  w.faults.persistAccount = 99;
  const r = await eco.buyListing('bob', listingId);
  assert.equal(r.ok, true); assert.equal(r.deferred, true);
  assert.equal(eco._listings.has(listingId), false);              // memory already authoritative
  assert.equal(w.db.txs.get(`market:${listingId}:purchase`).state, 'pending');   // journal is durable
  assert.equal(eco._deferred.size, 1);
  w.faults.persistAccount = 0;
  await eco.sweep();
  assert.equal(eco._deferred.size, 0);
  assert.equal(w.db.txs.get(`market:${listingId}:purchase`).state, 'done');
  assert.equal(w.gold('bob'), 900); assert.equal(w.gold('alice'), 145); assert.equal(w.qty('bob', 'Iron Sword'), 1);
  assert.equal(w.db.listings.has(listingId), false);
});
test('CRASH after apply, before any account reached the DB: recovery completes it exactly once', async () => {
  const { w, eco } = await scene();
  const { listingId } = await list(eco, 1, 100);
  w.faults.persistAccount = 99;
  assert.equal((await eco.buyListing('bob', listingId)).deferred, true);
  w.faults.persistAccount = 0;
  // process dies here: DB has the pending journal entry, the old balances, and the old listing
  assert.ok(w.db.listings.has(listingId)); assert.equal(w.gold('bob'), 1000);
  const r = await started(w);
  assert.equal(r.eco._listings.has(listingId), false, 'listing must not be resurrected');
  assert.equal(w.gold('bob'), 900); assert.equal(w.gold('alice'), 145); assert.equal(w.qty('bob', 'Iron Sword'), 1);
  assert.equal(w.db.listings.has(listingId), false);
  assert.equal(w.db.txs.get(`market:${listingId}:purchase`).state, 'done');
  const r2 = await started(w);                                    // and another restart changes nothing
  assert.equal(w.gold('bob'), 900); assert.equal(w.gold('alice'), 145);
});
test('CRASH after buyer persisted but seller did not: seller paid once, buyer charged once', async () => {
  const { w, eco } = await scene();
  const { listingId } = await list(eco, 1, 100);
  w.faults.failAccounts.add('alice');
  assert.equal((await eco.buyListing('bob', listingId)).deferred, true);
  w.faults.failAccounts.clear();
  assert.equal(w.gold('bob'), 900); assert.equal(w.gold('alice'), 50);   // partial state in the DB
  await started(w);
  assert.equal(w.gold('bob'), 900, 'buyer not charged twice');
  assert.equal(w.gold('alice'), 145, 'seller paid exactly once');
  assert.equal(w.qty('bob', 'Iron Sword'), 1, 'item delivered once');
  assert.equal(w.db.listings.has(listingId), false);
});
test('CRASH after both accounts persisted but listing delete failed: listing does not return after restart', async () => {
  const { w, eco } = await scene();
  const { listingId } = await list(eco, 1, 100);
  w.faults.deleteListing = 99;
  assert.equal((await eco.buyListing('bob', listingId)).deferred, true);
  assert.ok(w.db.listings.has(listingId));                        // DB still shows it (the dangerous state)
  w.faults.deleteListing = 0;
  const r = await started(w);
  assert.equal(r.eco._listings.has(listingId), false);
  assert.equal(w.db.listings.has(listingId), false);
  assert.equal((await r.eco.buyListing('carol', listingId)).ok, false);
  assert.equal(w.gold('carol'), 1000);
});
test('CRASH during listing creation: item is neither lost nor duplicated', async () => {
  const { w, eco } = await scene({ sellerInv: [{ item: 'Iron Sword', rarity: 'Rare', qty: 1 }] });
  w.faults.persistAccount = 99;
  const r = await list(eco, 1, 100);
  assert.equal(r.deferred, true);
  w.faults.persistAccount = 0;
  await started(w);
  assert.equal(w.totals().items['Iron Sword'], 1);
  assert.equal(w.db.listings.size, 1);
  assert.equal(w.qty('alice', 'Iron Sword'), 0);
});
test('offline seller: paid through the database while not connected', async () => {
  const { w, eco, accounts } = await scene();
  const { listingId } = await list(eco, 1, 100);
  const fresh = await started(w);                                 // nobody cached, both accounts offline
  assert.equal(fresh.accounts.size, 0);
  assert.equal((await fresh.eco.buyListing('bob', listingId)).ok, true);
  assert.equal(w.gold('alice'), 145);
});
test('two sales to the same OFFLINE seller at once: no lost update', async () => {
  const w = makeWorld();
  w.seed('alice', { inventory: [{ item: 'Iron Sword', rarity: 'Rare', qty: 2 }, { item: 'Bat Wing', rarity: 'Common', qty: 2 }] });
  w.seed('bob', { gold: 1000 }); w.seed('carol', { gold: 1000 });
  const first = await started(w);
  const a = await list(first.eco, 1, 100), b = await list(first.eco, 1, 200, 'alice', 'Bat Wing');
  const { eco } = await started(w);                               // seller cold (offline)
  const rs = await Promise.all([eco.buyListing('bob', a.listingId), eco.buyListing('carol', b.listingId)]);
  assert.deepEqual(rs.map(r => r.ok), [true, true]);
  assert.equal(w.gold('alice'), 95 + 190);
});
test('history is only written for successful transactions', async () => {
  const { w, eco } = await scene({ buyerGold: 10 });
  const { listingId } = await list(eco, 1, 100);
  await eco.buyListing('bob', listingId);                         // fails (no gold)
  assert.equal(w.dbSave('bob').marketHistory.length, 0);
  assert.equal(w.dbSave('alice').marketHistory.length, 0);
  assert.equal(w.db.txs.get(`market:${listingId}:purchase`), undefined);
});
