'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  AETHERION — PLAYER MARKET + AUCTION HOUSE ECONOMY ENGINE
//
//  Every Gold/item movement between players goes through ONE mechanism:
//
//    TRANSACTION = { id, legs[], finalize[], record }
//      leg       one idempotent change to ONE account (gold delta, item
//                add/remove, history entry). Applied at most once, ever:
//                the leg id is written into the account's own save
//                (save.econLedger) in the same document as the balance.
//      finalize  changes to the listing/auction tables (put/delete/patch).
//
//    VALIDATE → LOCK → JOURNAL → RE-VALIDATE → APPLY (one sync tick) →
//    PERSIST → MARK DONE → BROADCAST
//
//    • LOCK      listing/auction._lock is set synchronously, before any await,
//                so two handlers can never process the same listing/auction.
//    • JOURNAL   the full transaction is written to the store BEFORE anything
//                changes. If that write fails nothing has happened → clean
//                failure, no rollback needed.
//    • APPLY     all legs + table changes are applied to the in-memory
//                accounts in a single synchronous tick — no await in between,
//                so the in-memory state can never be observed half-applied.
//    • PERSIST   accounts are written (serialised per account, retried);
//                if the DB fails here the tx stays journaled ("deferred") and
//                is retried by the sweep; after a crash, recoverTx() replays it.
//                Replays are safe because legs are idempotent (ledger markers).
//
//  The store/db is injected, so the same code is unit-testable with a fake
//  store that can fail on demand and "restart" (see test/).
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const DEFAULTS = {
  FEE_PERCENT: 5,
  MAX_LISTINGS_PER_PLAYER: 10,
  MAX_ACTIVE_LISTINGS: 1000,
  MAX_AUCTIONS_PER_PLAYER: 5,
  MAX_ACTIVE_AUCTIONS: 500,
  ALLOWED_HOURS: [1, 6, 12, 24, 48],
  MIN_RAISE_PCT: 5,
  MAX_PRICE: 999_999_999,
  GOLD_CAP: 999_999_999,
  INVENTORY_LIMIT: 200,
  MAX_QTY: 999,
  HOUR_MS: 60 * 60 * 1000,
  LEDGER_MAX: 400,
  PERSIST_RETRIES: 3,
  RETRY_DELAY_MS: 50,
  PENDING_NOTIFY_MS: 10 * 60 * 1000,
};

const ERR = {
  UNAVAILABLE: 'Trading is temporarily unavailable. Please try again.',
  INV_FULL: 'Your inventory is full.',
  NO_GOLD: 'Not enough Gold.',
};

const isInt = (v, min, max) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
// strip transient (_lock, _notifiedAt …) fields before anything goes to the DB
const toDoc = (o) => { const d = {}; for (const k of Object.keys(o)) if (k[0] !== '_') d[k] = o[k]; return d; };

// ── inventory helpers (item snapshots keep rarity + effect intact) ────────
function removeInventoryQty(save, itemName, qty) {
  if (!Array.isArray(save.inventory)) return null;
  const idx = save.inventory.findIndex(i => i.item === itemName);
  if (idx < 0) return null;
  const entry = save.inventory[idx];
  const have = entry.qty || 1;
  if (have < qty) return null;
  const snapshot = { item: entry.item, rarity: entry.rarity || 'Common', effect: entry.effect };
  entry.qty = have - qty;
  if (entry.qty <= 0) save.inventory.splice(idx, 1);
  return snapshot;
}
// Returns false (and changes NOTHING) when the item cannot be inserted.
// `force` is used only when finishing an already-committed transaction:
// an item must never be lost, so it may exceed the soft slot limit.
function addInventoryItemSnapshot(save, snapshot, qty, { force = false, limit = DEFAULTS.INVENTORY_LIMIT } = {}) {
  if (!Array.isArray(save.inventory)) save.inventory = [];
  const existing = save.inventory.find(i => i.item === snapshot.item);
  if (existing) {
    existing.qty = (existing.qty || 1) + qty;
    if (snapshot.effect && !existing.effect) existing.effect = snapshot.effect;
    return true;
  }
  if (!force && save.inventory.length >= limit) return false;
  save.inventory.push({ item: snapshot.item, rarity: snapshot.rarity || 'Common', qty, effect: snapshot.effect || undefined });
  return true;
}
function addMarketHistory(save, entry) {
  if (!save.marketHistory) save.marketHistory = [];
  save.marketHistory.unshift({ ...entry, date: Date.now() });
  if (save.marketHistory.length > 30) save.marketHistory.length = 30;
}

const loadSave = (acc) => { try { return acc.save ? JSON.parse(acc.save) : {}; } catch (e) { return {}; } };
const ledgerHas = (save, id) => Array.isArray(save.econLedger) && save.econLedger.includes(id);
const snapOf = (doc) => doc.snapshot || { itemId: doc.item, item: doc.item, rarity: doc.rarity, effect: doc.effect || null };

function createEconomy(deps) {
  const cfg = { ...DEFAULTS, ...(deps.config || {}) };
  const {
    store,            // { isReady, saveListing, deleteListing, saveAuction, deleteAuction, saveTx, loadListings, loadAuctions, loadPendingTxs }
    accounts,         // Map<uname, acc>  (shared, authoritative cache)
    getAccount,       // async uname → acc|null   (DB lookup)
    persistAccount,   // async (uname, acc) → boolean
  } = deps;
  const canTrade  = deps.canTrade  || (() => true);
  const hooks     = deps.hooks     || {};
  const now       = deps.now       || (() => Date.now());
  const newId     = deps.newId     || (() => crypto.randomBytes(8).toString('hex'));
  const log       = deps.log       || ((...a) => console.log(...a));
  const warn      = deps.warn      || ((...a) => console.warn(...a));

  const listings = new Map();   // id → listing
  const auctions = new Map();   // id → auction
  const deferredTxs = new Map();  // committed in memory, DB persistence still owed
  const pendingAborts = new Map(); // aborted, abort marker not yet persisted
  const loading = new Map();
  const chains = new Map();
  const inflightCreates = { listings: new Map(), auctions: new Map() };
  let ready = false;

  // ── accounts ──────────────────────────────────────────────────────────
  function ensureAcc(uname) {
    const cached = accounts.get(uname);
    if (cached) return Promise.resolve(cached);
    let p = loading.get(uname);
    if (!p) {
      p = Promise.resolve(getAccount(uname)).then(a => {
        if (a && !accounts.has(uname)) accounts.set(uname, a);
        return accounts.get(uname) || null;
      }).finally(() => loading.delete(uname));
      loading.set(uname, p);
    }
    return p;
  }

  // Serialised per account so an older snapshot can never land after a newer
  // one. Always writes the CURRENT in-memory save.
  function persistAcc(uname) {
    const prev = chains.get(uname) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const acc = accounts.get(uname);
      if (!acc) return;
      const ok = await persistAccount(uname, acc);
      if (ok === false) throw new Error(`account persist failed (${uname})`);
    });
    chains.set(uname, next);
    next.catch(() => {}).finally(() => { if (chains.get(uname) === next) chains.delete(uname); });
    return next;
  }
  const sleep = (ms) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
  async function persistAccRetry(uname) {
    let last;
    for (let i = 0; i < cfg.PERSIST_RETRIES; i++) {
      try { await persistAcc(uname); return; } catch (e) { last = e; await sleep(cfg.RETRY_DELAY_MS * (i + 1)); }
    }
    throw last;
  }

  // ── leg validation / application ──────────────────────────────────────
  // returns null if the leg can be applied, else { code, msg }
  function validateLeg(save, leg) {
    if (ledgerHas(save, leg.id)) return null; // already applied earlier — nothing to do
    const gold = save.playerGold || 0;
    if (leg.gold < 0 && gold < -leg.gold) return { code: 'NO_GOLD', msg: ERR.NO_GOLD, playerGold: gold };
    if (leg.gold > 0 && !leg.soft && gold + leg.gold > cfg.GOLD_CAP) return { code: 'CAP', msg: 'The other player cannot hold that much Gold.' };
    if (leg.remove) {
      const e = (save.inventory || []).find(i => i.item === leg.remove.item);
      if (!e || (e.qty || 1) < leg.remove.qty) return { code: 'NO_ITEM', msg: 'You do not have that many to sell.' };
    }
    if (leg.add) {
      const inv = save.inventory || [];
      if (!inv.some(i => i.item === leg.add.snapshot.item) && inv.length >= cfg.INVENTORY_LIMIT) return { code: 'INV_FULL', msg: ERR.INV_FULL };
    }
    return null;
  }
  // applies a leg to the cached account. Idempotent via the ledger marker.
  function applyLeg(acc, leg, force) {
    const save = loadSave(acc);
    if (!Array.isArray(save.econLedger)) save.econLedger = [];
    if (save.econLedger.includes(leg.id)) return false;
    if (leg.remove) {
      if (!removeInventoryQty(save, leg.remove.item, leg.remove.qty)) warn(`[ECONOMY] leg ${leg.id}: item to remove missing (forced replay)`);
    }
    if (leg.gold) {
      const target = (save.playerGold || 0) + leg.gold;
      if (target > cfg.GOLD_CAP) warn(`[ECONOMY] leg ${leg.id}: gold cap reached, clamping`);
      save.playerGold = Math.max(0, Math.min(cfg.GOLD_CAP, target));
    }
    if (leg.add) {
      if (!addInventoryItemSnapshot(save, leg.add.snapshot, leg.add.qty, { force, limit: cfg.INVENTORY_LIMIT })) {
        // cannot happen after validateLeg in the same tick; belt and braces:
        addInventoryItemSnapshot(save, leg.add.snapshot, leg.add.qty, { force: true });
        warn(`[ECONOMY] leg ${leg.id}: forced item delivery past slot limit`);
      }
    }
    if (leg.history) addMarketHistory(save, leg.history);
    save.econLedger.push(leg.id);
    if (save.econLedger.length > cfg.LEDGER_MAX) save.econLedger.splice(0, save.econLedger.length - cfg.LEDGER_MAX);
    acc.save = JSON.stringify(save);
    return true;
  }

  // ── table (listing/auction) changes: memory + store ───────────────────
  function applyFinalizeMemory(op) {
    switch (op.op) {
      case 'putListing': listings.set(op.doc.id, clone(op.doc)); break;
      case 'delListing': listings.delete(op.id); break;
      case 'putAuction': auctions.set(op.doc.id, clone(op.doc)); break;
      case 'delAuction': auctions.delete(op.id); break;
      case 'patchAuction': {
        const a = auctions.get(op.id);
        if (a && a.bidCount === op.expect) Object.assign(a, op.set); // idempotent: only the expected predecessor state
        break;
      }
      case 'setAuctionStatus': { const a = auctions.get(op.id); if (a) a.status = op.status; break; }
      default: throw new Error('unknown finalize op ' + op.op);
    }
  }
  async function persistFinalize(op) {
    switch (op.op) {
      case 'putListing': { const l = listings.get(op.doc.id); if (l) await store.saveListing(toDoc(l)); break; } // gone since? then a later delete is authoritative
      case 'delListing': await store.deleteListing(op.id); break;
      case 'putAuction': { const a = auctions.get(op.doc.id); if (a) await store.saveAuction(toDoc(a)); break; }
      case 'delAuction': await store.deleteAuction(op.id); break;
      case 'patchAuction': case 'setAuctionStatus': { const a = auctions.get(op.id); if (a) await store.saveAuction(toDoc(a)); break; }
    }
  }

  // ── transaction runner ────────────────────────────────────────────────
  const liveLegs = (tx) => tx.legs.filter(l => !l.skip);
  function validateAll(tx) {
    for (const leg of liveLegs(tx)) {
      const acc = accounts.get(leg.uname);
      if (!acc) { if (leg.optional) { leg.skip = true; continue; } return { code: 'NO_ACCOUNT', msg: 'Account not found.' }; }
      const err = validateLeg(loadSave(acc), leg);
      if (err) return err;
    }
    return null;
  }
  function applyAll(tx, force) {
    for (const leg of liveLegs(tx)) {
      const acc = accounts.get(leg.uname);
      if (acc) applyLeg(acc, leg, force);
    }
    for (const op of tx.finalize) applyFinalizeMemory(op);
  }
  async function persistCommitted(tx) {
    for (const u of new Set(liveLegs(tx).map(l => l.uname))) if (accounts.get(u)) await persistAccRetry(u);
    for (const op of tx.finalize) await persistFinalize(op);
    tx.state = 'done'; tx.completedAt = now();
    await store.saveTx(tx);
  }
  async function abortTx(tx, err) {
    tx.state = 'aborted'; tx.abortReason = err.code || 'aborted';
    try { await store.saveTx(tx); } catch (e) { pendingAborts.set(tx.id, tx); warn(`[ECONOMY] abort marker for ${tx.id} not persisted (will retry): ${e.message}`); }
    log(`[ECONOMY] Transaction rollback ${tx.id}: ${err.code || err.msg}`);
  }
  function afterCommit(tx) {
    for (const u of new Set(liveLegs(tx).map(l => l.uname))) {
      const acc = accounts.get(u);
      if (acc && hooks.pushState) { try { hooks.pushState(u, loadSave(acc)); } catch (e) {} }
    }
    for (const leg of liveLegs(tx)) if (leg.notify && hooks.notify) { try { hooks.notify(leg.uname, leg.notify); } catch (e) {} }
    broadcastFor(tx.broadcast || {});
  }
  function broadcastFor(b) {
    if (!hooks.broadcast) return;
    if (b.marketRemoved) hooks.broadcast('market:listingRemoved', { listingId: b.marketRemoved });
    if (b.auctionRemoved) hooks.broadcast('auction:removed', { auctionId: b.auctionRemoved });
    if (b.market)  hooks.broadcast('market:state', marketPayload());
    if (b.auction) hooks.broadcast('auction:state', auctionPayload());
  }

  async function runTx(tx) {
    tx.state = 'pending'; tx.createdAt = now();
    const pre = validateAll(tx);                   // fast, clean rejection (nothing journaled)
    if (pre) return fail(pre);
    try { await store.saveTx(tx); }                // ── JOURNAL (commit-intent) ──
    catch (e) { warn(`[ECONOMY] journal write failed for ${tx.id}: ${e.message}`); return { ok: false, msg: ERR.UNAVAILABLE, code: 'UNAVAILABLE' }; }
    const err = validateAll(tx);                   // state may have moved during the await
    if (err) { await abortTx(tx, err); return fail(err); }
    applyAll(tx, false);                           // ── APPLY (one sync tick) ──
    let deferred = false;
    try { await persistCommitted(tx); }            // ── PERSIST ──
    catch (e) { deferred = true; deferredTxs.set(tx.id, tx); warn(`[ECONOMY] ${tx.id} committed but persistence deferred: ${e.message}`); }
    afterCommit(tx);
    return { ok: true, deferred, txId: tx.id };
  }
  const fail = (err) => ({ ok: false, msg: err.msg, code: err.code, ...(err.playerGold !== undefined ? { playerGold: err.playerGold } : {}) });

  // ── startup recovery (crash / restart safety) ─────────────────────────
  async function recoverTx(tx) {
    const legs = tx.legs;
    for (const leg of legs) { const a = await ensureAcc(leg.uname); if (!a) leg.skip = true; }
    // If ANY leg marker already reached the DB the tx was committed → finish it unconditionally.
    const committed = liveLegs(tx).some(l => ledgerHas(loadSave(accounts.get(l.uname)), l.id));
    if (!committed) {
      const err = validateAll(tx);
      if (err) { await abortTx(tx, err); log(`[ECONOMY] recovery: aborted ${tx.id} (${err.code})`); return; }
    }
    applyAll(tx, committed);
    try { await persistCommitted(tx); } catch (e) { deferredTxs.set(tx.id, tx); warn(`[ECONOMY] recovery of ${tx.id} persisted late: ${e.message}`); }
    log(`[ECONOMY] recovery: ${committed ? 'completed' : 'applied'} ${tx.id}`);
  }
  async function initialize() {
    if (ready) return true;
    if (!store.isReady()) return false;
    try {
      const ls = await store.loadListings(), as = await store.loadAuctions(), txs = await store.loadPendingTxs();
      listings.clear(); auctions.clear();
      for (const l of ls) listings.set(l.id, { ...l, status: 'active' });
      for (const a of as) auctions.set(a.id, { ...a });
      for (const tx of txs) await recoverTx(tx);
      ready = true;
      log(`[MARKET] Restored ${listings.size} listing(s) and ${auctions.size} auction(s); recovered ${txs.length} journaled transaction(s)`);
      return true;
    } catch (e) { warn('[MARKET] initialize failed (will retry):', e.message); return false; }
  }
  const usable = () => ready && store.isReady();

  // ── public payloads ───────────────────────────────────────────────────
  function calculateMinimumBid(a) {
    if (!(a.bidCount > 0)) return a.startingBid;
    // integer math only, so the minimum never depends on floating-point rounding
    return Math.floor((a.currentBid * (100 + cfg.MIN_RAISE_PCT) + 99) / 100);
  }
  function marketPayload() {
    return [...listings.values()].filter(l => l.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 300)
      .map(l => ({ id: l.id, item: l.item, rarity: l.rarity, qty: l.qty, totalPrice: l.totalPrice,
        sellerUname: l.sellerUname, sellerDisplay: l.sellerDisplay, createdAt: l.createdAt }));
  }
  function auctionPayload() {
    return [...auctions.values()].filter(a => a.status === 'active')
      .sort((a, b) => a.endsAt - b.endsAt).slice(0, 300)
      .map(a => ({ id: a.id, item: a.item, rarity: a.rarity, startingBid: a.startingBid, currentBid: a.currentBid,
        minimumBid: calculateMinimumBid(a),
        currentBidderDisplay: a.currentBidderDisplay, bidCount: a.bidCount,
        sellerUname: a.sellerUname, sellerDisplay: a.sellerDisplay, createdAt: a.createdAt, endsAt: a.endsAt }));
  }

  // ═════════════════════════ MARKET ═════════════════════════════════════
  async function createListing(uname, { itemName, qty, totalPrice } = {}) {
    if (!usable()) return { ok: false, msg: ERR.UNAVAILABLE };
    if (!canTrade(uname)) return { ok: false, msg: 'Trading is unavailable right now.' };
    if (typeof itemName !== 'string' || !itemName.trim() || itemName.length > 60) return { ok: false, msg: 'Invalid item.' };
    if (!isInt(qty, 1, cfg.MAX_QTY)) return { ok: false, msg: 'Quantity must be a whole number of at least 1.' };
    if (!isInt(totalPrice, 1, cfg.MAX_PRICE)) return { ok: false, msg: 'Price must be a whole number of at least 1 Gold.' };
    const name = itemName.trim();

    const mine = () => [...listings.values()].filter(l => l.sellerUname === uname && l.status === 'active').length + (inflightCreates.listings.get(uname) || 0);
    const total = () => listings.size + [...inflightCreates.listings.values()].reduce((s, n) => s + n, 0);
    if (total() >= cfg.MAX_ACTIVE_LISTINGS) return { ok: false, msg: 'The Market is full right now — try again soon.' };
    if (mine() >= cfg.MAX_LISTINGS_PER_PLAYER) return { ok: false, msg: `You can only have ${cfg.MAX_LISTINGS_PER_PLAYER} active listings at once.` };

    const acc = await ensureAcc(uname);
    if (!acc) return { ok: false, msg: 'Account not found.' };
    if (!usable()) return { ok: false, msg: ERR.UNAVAILABLE };
    if (total() >= cfg.MAX_ACTIVE_LISTINGS || mine() >= cfg.MAX_LISTINGS_PER_PLAYER) return { ok: false, msg: `You can only have ${cfg.MAX_LISTINGS_PER_PLAYER} active listings at once.` };

    // authoritative item data comes from the seller's REAL inventory, never the client
    const entry = (loadSave(acc).inventory || []).find(i => i.item === name);
    if (!entry || (entry.qty || 1) < qty) return { ok: false, msg: 'You do not have that many to sell.' };
    const snapshot = Object.freeze({ itemId: entry.item, item: entry.item, rarity: entry.rarity || 'Common', effect: entry.effect || null, quantity: qty });

    const id = newId();
    const txId = `market:${id}:list`;
    const listing = {
      id, sellerUname: uname, sellerDisplay: acc.username,
      item: snapshot.item, rarity: snapshot.rarity, effect: snapshot.effect, qty, totalPrice,
      snapshot: { ...snapshot }, createdAt: now(), status: 'active',
    };
    const tx = {
      id: txId, type: 'market_list',
      legs: [{ uname, id: `${txId}:seller`, remove: { item: snapshot.item, qty } }],
      finalize: [{ op: 'putListing', doc: listing }],
      broadcast: { market: true },
      record: { transactionId: txId, type: 'market_list', listingId: id, sellerId: uname, item: snapshot.item, quantity: qty, price: totalPrice },
    };
    inflightCreates.listings.set(uname, (inflightCreates.listings.get(uname) || 0) + 1);
    try {
      log(`[MARKET] Listing started ${txId}`);
      const res = await runTx(tx);
      if (res.ok) { log(`[MARKET] ${uname} listed ${qty}× ${snapshot.item} for ${totalPrice}g`); return { ok: true, listingId: id, deferred: res.deferred }; }
      return res;
    } finally {
      const n = (inflightCreates.listings.get(uname) || 1) - 1;
      if (n <= 0) inflightCreates.listings.delete(uname); else inflightCreates.listings.set(uname, n);
    }
  }

  async function buyListing(buyerUname, listingId) {
    if (!usable()) return { ok: false, msg: ERR.UNAVAILABLE };
    const id = typeof listingId === 'string' ? listingId.slice(0, 64) : '';
    if (!id) return { ok: false, msg: 'Unknown listing.' };
    if (!canTrade(buyerUname)) return { ok: false, msg: 'Trading is unavailable right now.' };
    // ── LOCK: everything up to `_lock = …` is synchronous ──
    const listing = listings.get(id);
    if (!listing || listing.status !== 'active') return { ok: false, msg: 'This item has already been sold.' };
    if (listing._lock) return { ok: false, msg: 'This listing is being processed. Please try again in a moment.' };
    if (listing.sellerUname === buyerUname) return { ok: false, msg: 'You cannot buy your own listing.' };
    const txId = `market:${id}:purchase`;
    listing._lock = txId;
    try {
      log(`[MARKET] Purchase started ${txId} buyer=${buyerUname}`);
      const [buyerAcc, sellerAcc] = [await ensureAcc(buyerUname), await ensureAcc(listing.sellerUname)];
      if (!buyerAcc) return { ok: false, msg: 'Account not found.' };
      if (!sellerAcc) return { ok: false, msg: 'The seller no longer exists.' };
      if (!usable()) return { ok: false, msg: ERR.UNAVAILABLE };
      if (listings.get(id) !== listing || listing.status !== 'active') return { ok: false, msg: 'This item has already been sold.' };

      const snap = snapOf(listing), price = listing.totalPrice, qty = listing.qty;
      const fee = Math.floor(price * cfg.FEE_PERCENT / 100), proceeds = price - fee;
      const tx = {
        id: txId, type: 'market_purchase',
        legs: [
          { uname: buyerUname, id: `${txId}:buyer`, gold: -price, add: { snapshot: { item: snap.item, rarity: snap.rarity, effect: snap.effect }, qty },
            history: { type: 'purchase', item: snap.item, qty, price, other: listing.sellerDisplay } },
          { uname: listing.sellerUname, id: `${txId}:seller`, gold: proceeds,
            history: { type: 'sale', item: snap.item, qty, price: proceeds, other: buyerAcc.username },
            notify: `💰 Your ${snap.item} sold for ${proceeds.toLocaleString()} Gold!` },
        ],
        finalize: [{ op: 'delListing', id }],
        broadcast: { market: true, marketRemoved: id },
        record: { transactionId: txId, type: 'market_purchase', listingId: id, buyerId: buyerUname, sellerId: listing.sellerUname,
          item: snap.item, quantity: qty, price, fee, timestamp: now() },
      };
      const res = await runTx(tx);
      if (res.ok) { log(`[MARKET] Purchase completed ${txId}; Listing removed ${id}`); return { ok: true, listingId: id, deferred: res.deferred }; }
      log(`[MARKET] Purchase failed ${txId}: ${res.msg}`);
      return { ...res, listingId: id };
    } finally { delete listing._lock; }
  }

  async function cancelListing(uname, listingId) {
    if (!usable()) return { ok: false, msg: ERR.UNAVAILABLE };
    const id = typeof listingId === 'string' ? listingId.slice(0, 64) : '';
    if (!id) return { ok: false, msg: 'Unknown listing.' };
    const listing = listings.get(id);
    if (!listing || listing.status !== 'active') return { ok: false, msg: 'Listing not found — it may already be sold or cancelled.' };
    if (listing.sellerUname !== uname) return { ok: false, msg: 'This is not your listing.' };
    if (listing._lock) return { ok: false, msg: 'This listing is being processed. Please try again in a moment.' };
    const txId = `market:${id}:cancel`;
    listing._lock = txId;
    try {
      const acc = await ensureAcc(uname);
      if (!acc) return { ok: false, msg: 'Account not found.' };
      if (!usable()) return { ok: false, msg: ERR.UNAVAILABLE };
      const snap = snapOf(listing);
      const tx = {
        id: txId, type: 'market_cancel',
        legs: [{ uname, id: `${txId}:seller`, add: { snapshot: { item: snap.item, rarity: snap.rarity, effect: snap.effect }, qty: listing.qty } }],
        finalize: [{ op: 'delListing', id }],
        broadcast: { market: true, marketRemoved: id },
        record: { transactionId: txId, type: 'market_cancel', listingId: id, sellerId: uname, item: snap.item, quantity: listing.qty },
      };
      const res = await runTx(tx);   // listing is only deleted if the item can really be returned
      if (res.ok) { log(`[MARKET] ${uname} cancelled listing ${id}; Listing removed`); return { ok: true, listingId: id, deferred: res.deferred }; }
      return { ...res, listingId: id };
    } finally { delete listing._lock; }
  }

  // ═════════════════════════ AUCTIONS ═══════════════════════════════════
  async function createAuction(uname, { itemName, startingBid, durationHours } = {}) {
    if (!usable()) return { ok: false, msg: ERR.UNAVAILABLE };
    if (!canTrade(uname)) return { ok: false, msg: 'Trading is unavailable right now.' };
    if (typeof itemName !== 'string' || !itemName.trim() || itemName.length > 60) return { ok: false, msg: 'Invalid item.' };
    if (!isInt(startingBid, 1, cfg.MAX_PRICE)) return { ok: false, msg: 'Starting bid must be a whole number of at least 1 Gold.' };
    if (!cfg.ALLOWED_HOURS.includes(durationHours)) return { ok: false, msg: 'Invalid auction duration.' };
    const name = itemName.trim();
    const mine = () => [...auctions.values()].filter(a => a.sellerUname === uname).length + (inflightCreates.auctions.get(uname) || 0);
    const total = () => auctions.size + [...inflightCreates.auctions.values()].reduce((s, n) => s + n, 0);
    if (total() >= cfg.MAX_ACTIVE_AUCTIONS) return { ok: false, msg: 'The Auction House is full right now — try again soon.' };
    if (mine() >= cfg.MAX_AUCTIONS_PER_PLAYER) return { ok: false, msg: `You can only run ${cfg.MAX_AUCTIONS_PER_PLAYER} auctions at once.` };
    const acc = await ensureAcc(uname);
    if (!acc) return { ok: false, msg: 'Account not found.' };
    if (!usable()) return { ok: false, msg: ERR.UNAVAILABLE };
    if (total() >= cfg.MAX_ACTIVE_AUCTIONS || mine() >= cfg.MAX_AUCTIONS_PER_PLAYER) return { ok: false, msg: `You can only run ${cfg.MAX_AUCTIONS_PER_PLAYER} auctions at once.` };

    const entry = (loadSave(acc).inventory || []).find(i => i.item === name);
    if (!entry) return { ok: false, msg: 'You do not have that item.' };
    const snapshot = { itemId: entry.item, item: entry.item, rarity: entry.rarity || 'Common', effect: entry.effect || null, quantity: 1 };
    const id = newId(), txId = `auction:${id}:create`, t = now();
    const auction = {
      id, sellerUname: uname, sellerDisplay: acc.username,
      item: snapshot.item, rarity: snapshot.rarity, effect: snapshot.effect, snapshot,
      startingBid, currentBid: 0, currentBidderUname: null, currentBidderDisplay: null,
      bidCount: 0, createdAt: t, endsAt: t + durationHours * cfg.HOUR_MS, status: 'active',
    };
    const tx = {
      id: txId, type: 'auction_create',
      legs: [{ uname, id: `${txId}:seller`, remove: { item: snapshot.item, qty: 1 } }],
      finalize: [{ op: 'putAuction', doc: auction }],
      broadcast: { auction: true },
      record: { transactionId: txId, type: 'auction_create', auctionId: id, sellerId: uname, item: snapshot.item, quantity: 1, price: startingBid },
    };
    inflightCreates.auctions.set(uname, (inflightCreates.auctions.get(uname) || 0) + 1);
    try {
      const res = await runTx(tx);
      if (res.ok) { log(`[AUCTION] ${uname} listed ${snapshot.item} — starting bid ${startingBid}g, ${durationHours}h`); return { ok: true, auctionId: id, deferred: res.deferred }; }
      return res;
    } finally {
      const n = (inflightCreates.auctions.get(uname) || 1) - 1;
      if (n <= 0) inflightCreates.auctions.delete(uname); else inflightCreates.auctions.set(uname, n);
    }
  }

  async function placeBid(bidderUname, auctionId, bidAmount) {
    if (!usable()) return { ok: false, msg: ERR.UNAVAILABLE };
    const id = typeof auctionId === 'string' ? auctionId.slice(0, 64) : '';
    if (!id) return { ok: false, msg: 'Unknown auction.' };
    if (!canTrade(bidderUname)) return { ok: false, msg: 'Trading is unavailable right now.' };
    const a = auctions.get(id);
    if (!a || a.status !== 'active' || a.endsAt <= now()) return { ok: false, msg: 'This auction has ended.' };
    if (a._lock) return { ok: false, msg: 'Another bid is being processed on this auction. Please try again.' };
    if (a.sellerUname === bidderUname) return { ok: false, msg: 'You cannot bid on your own auction.' };
    if (!isInt(bidAmount, 1, cfg.MAX_PRICE)) return { ok: false, msg: 'Enter a valid bid.' };
    const minimum = calculateMinimumBid(a);                    // server decides the minimum
    if (bidAmount < minimum) return { ok: false, msg: `Bid must be at least ${minimum.toLocaleString()} Gold.`, minimumBid: minimum };
    const seq = a.bidCount + 1, txId = `auction:${id}:bid:${seq}`;
    a._lock = txId;                                            // ── LOCK (sync) ──
    try {
      log(`[AUCTION] Bid started ${txId} bidder=${bidderUname} amount=${bidAmount}`);
      const bidderAcc = await ensureAcc(bidderUname);
      const prev = a.bidCount > 0 ? a.currentBidderUname : null;
      if (prev) await ensureAcc(prev);
      if (!bidderAcc) return { ok: false, msg: 'Account not found.' };
      if (!usable()) return { ok: false, msg: ERR.UNAVAILABLE };
      if (auctions.get(id) !== a || a.status !== 'active' || a.endsAt <= now()) return { ok: false, msg: 'This auction has ended.' };

      const legs = [{ uname: bidderUname, id: `${txId}:bidder`, gold: -bidAmount }];
      if (prev) legs.push({ uname: prev, id: `${txId}:refund`, gold: a.currentBid, optional: true,
        history: undefined, notify: `⚠️ You've been outbid on ${a.item}!` });
      const tx = {
        id: txId, type: 'auction_bid', legs,
        finalize: [{ op: 'patchAuction', id, expect: a.bidCount,
          set: { currentBid: bidAmount, currentBidderUname: bidderUname, currentBidderDisplay: bidderAcc.username, bidCount: seq } }],
        broadcast: { auction: true },
        record: { transactionId: txId, type: 'auction_bid', auctionId: id, bidderId: bidderUname, previousBidderId: prev, sellerId: a.sellerUname,
          item: a.item, price: bidAmount, refunded: prev ? a.currentBid : 0, timestamp: now() },
      };
      const res = await runTx(tx);
      if (res.ok) { log(`[AUCTION] Bid completed ${txId}${prev ? '; Bid refunded to ' + prev : ''}`); return { ok: true, auctionId: id, deferred: res.deferred }; }
      log(`[AUCTION] Bid failed ${txId}: ${res.msg}`);
      return { ...res, auctionId: id };
    } finally { delete a._lock; }
  }

  // settlement: idempotent (tx id auction:<id>:settlement), never deletes the
  // auction until the item has really been delivered.
  async function settleAuction(a) {
    if (a._lock || !auctions.has(a.id)) return;
    a._lock = 'settlement';
    try {
      const txId = `auction:${a.id}:settlement`;
      const snap = snapOf(a), itemSnap = { item: snap.item, rarity: snap.rarity, effect: snap.effect };
      const hasWinner = a.bidCount > 0 && !!a.currentBidderUname;
      let winnerAcc = null;
      const sellerAcc = await ensureAcc(a.sellerUname);
      if (hasWinner) winnerAcc = await ensureAcc(a.currentBidderUname);
      if (!usable()) return;

      let tx;
      if (hasWinner && winnerAcc) {
        const fee = Math.floor(a.currentBid * cfg.FEE_PERCENT / 100), proceeds = a.currentBid - fee;
        tx = {
          id: txId, type: 'auction_settlement',
          legs: [
            { uname: a.currentBidderUname, id: `${txId}:winner`, add: { snapshot: itemSnap, qty: 1 },
              history: { type: 'auction_won', item: snap.item, price: a.currentBid, other: a.sellerDisplay },
              notify: `🏆 Auction won! ${snap.item} is now yours.` },
            { uname: a.sellerUname, id: `${txId}:seller`, gold: proceeds, soft: true, optional: true,
              history: { type: 'auction_sale', item: snap.item, price: proceeds, other: a.currentBidderDisplay },
              notify: `⚖️ Your auction for ${snap.item} sold for ${proceeds.toLocaleString()} Gold!` },
          ],
          finalize: [{ op: 'delAuction', id: a.id }],
          broadcast: { auction: true, auctionRemoved: a.id },
          record: { transactionId: txId, type: 'auction_settlement', auctionId: a.id, buyerId: a.currentBidderUname, sellerId: a.sellerUname,
            item: snap.item, quantity: 1, price: a.currentBid, fee, timestamp: now() },
        };
      } else {
        // no bids (or the winner's account no longer exists) → item returns to the seller
        if (!sellerAcc) {   // seller account is gone too: nobody to return to
          log(`[AUCTION] ${a.id}: seller and winner accounts missing — removing auction`);
          tx = { id: txId, type: 'auction_settlement', legs: [], finalize: [{ op: 'delAuction', id: a.id }], broadcast: { auction: true, auctionRemoved: a.id },
            record: { transactionId: txId, type: 'auction_orphan', auctionId: a.id, timestamp: now() } };
        } else {
          tx = {
            id: txId, type: 'auction_settlement',
            legs: [{ uname: a.sellerUname, id: `${txId}:seller`, add: { snapshot: itemSnap, qty: 1 },
              notify: `↩️ Your auction for ${snap.item} ended with no bids — item returned.` }],
            finalize: [{ op: 'delAuction', id: a.id }],
            broadcast: { auction: true, auctionRemoved: a.id },
            record: { transactionId: txId, type: 'auction_return', auctionId: a.id, sellerId: a.sellerUname, item: snap.item, quantity: 1, timestamp: now() },
          };
        }
      }
      const res = await runTx(tx);
      if (res.ok) { log(`[AUCTION] Settlement completed ${txId}`); return; }
      if (res.code === 'INV_FULL') return markSettlementPending(a, hasWinner && winnerAcc ? a.currentBidderUname : a.sellerUname);
      warn(`[AUCTION] Settlement ${txId} not completed (${res.msg}) — will retry`);
    } catch (e) {
      warn(`[AUCTION] settlement error for ${a.id}: ${e && e.message} — will retry (nothing was delivered without a journal entry)`);
    } finally { delete a._lock; }
  }
  async function markSettlementPending(a, who) {
    const first = a.status !== 'settlement_pending';
    a.status = 'settlement_pending';
    if (first || !a._notifiedAt || now() - a._notifiedAt > cfg.PENDING_NOTIFY_MS) {
      a._notifiedAt = now();
      if (hooks.notify) hooks.notify(who, `📦 Make room in your bag: ${a.item} from an auction is waiting and will be delivered automatically.`);
    }
    if (first) {
      broadcastFor({ auctionRemoved: a.id, auction: true });
      try { await store.saveAuction(toDoc(a)); } catch (e) { /* DB still says active+expired → same retry after restart */ }
    }
    log(`[AUCTION] ${a.id} settlement pending — ${who} inventory full (item and gold are safe)`);
  }

  // ── periodic sweep ────────────────────────────────────────────────────
  async function retryDeferred() {
    for (const [id, tx] of [...deferredTxs]) {
      try { await persistCommitted(tx); deferredTxs.delete(id); log(`[ECONOMY] deferred persistence completed ${id}`); } catch (e) { /* try again next sweep */ }
    }
    for (const [id, tx] of [...pendingAborts]) {
      try { await store.saveTx(tx); pendingAborts.delete(id); } catch (e) {}
    }
  }
  async function sweep() {
    if (!ready && !(await initialize())) return;
    if (!store.isReady()) return;
    await retryDeferred();
    const t = now();
    for (const a of [...auctions.values()]) {
      if (a._lock) continue;
      if ((a.status === 'active' && a.endsAt <= t) || a.status === 'settlement_pending') await settleAuction(a);
    }
  }

  return {
    initialize, sweep, retryDeferred,
    createListing, buyListing, cancelListing, createAuction, placeBid,
    persistAccount: persistAcc,
    marketPayload, auctionPayload, calculateMinimumBid,
    // introspection (tests / diagnostics)
    _listings: listings, _auctions: auctions, _deferred: deferredTxs,
    isReady: () => ready,
  };
}

module.exports = { createEconomy, removeInventoryQty, addInventoryItemSnapshot, addMarketHistory, DEFAULTS };
