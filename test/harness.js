'use strict';
// Test world: a fake "database" that survives economy restarts, with fault
// injection at every persistence step. A "crash" is simulated by throwing away
// the economy instance + its in-memory account cache and calling boot() again:
// only what reached the fake DB survives — exactly like a real restart.
const { createEconomy } = require('../economy');

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

function makeWorld() {
  const db = { listings: new Map(), auctions: new Map(), txs: new Map(), accounts: new Map() };
  const clock = { t: 1_800_000_000_000 };
  // faults[name] = number of upcoming calls to fail. faults.down = DB unreachable.
  const faults = { down: false, failAccounts: new Set() };
  const fail = (name) => {
    if (faults.down) throw new Error('injected: db down');
    if ((faults[name] || 0) > 0) { faults[name]--; throw new Error('injected: ' + name); }
  };

  const store = {
    isReady: () => !faults.down,
    async saveListing(d)    { fail('saveListing');    db.listings.set(d.id, clone(d)); },
    async deleteListing(id) { fail('deleteListing');  db.listings.delete(id); },
    async saveAuction(d)    { fail('saveAuction');    db.auctions.set(d.id, clone(d)); },
    async deleteAuction(id) { fail('deleteAuction');  db.auctions.delete(id); },
    async saveTx(tx)        { fail('saveTx');         db.txs.set(tx.id, clone(tx)); },
    async loadListings()    { fail('load'); return [...db.listings.values()].map(clone); },
    async loadAuctions()    { fail('load'); return [...db.auctions.values()].map(clone); },
    async loadPendingTxs()  { fail('load'); return [...db.txs.values()].filter(t => t.state === 'pending').map(clone); },
  };

  function seed(name, { gold = 0, inventory = [], display } = {}) {
    db.accounts.set(name, { username: display || name, uname: name, password: 'x', createdAt: 1,
      save: JSON.stringify({ playerGold: gold, inventory, marketHistory: [] }) });
  }

  function boot(opts = {}) {
    const accounts = new Map();            // fresh cache = fresh process
    const events = [], notes = [], pushes = [];
    const eco = createEconomy({
      store, accounts, now: () => clock.t,
      getAccount: async (u) => clone(db.accounts.get(u)) || null,
      persistAccount: async (u, acc) => {
        if (faults.down) throw new Error('injected: db down');
        if (faults.failAccounts.has(u)) throw new Error('injected: account ' + u);
        if ((faults.persistAccount || 0) > 0) { faults.persistAccount--; throw new Error('injected: persistAccount'); }
        db.accounts.set(u, clone({ ...acc, uname: u }));
        return true;
      },
      canTrade: opts.canTrade || (() => true),
      hooks: {
        broadcast: (e, p) => events.push([e, p]),
        notify: (u, m) => notes.push([u, m]),
        pushState: (u, s) => pushes.push([u, s]),
      },
      config: { RETRY_DELAY_MS: 0, ...(opts.config || {}) },
      log: () => {}, warn: () => {},
    });
    return { eco, accounts, events, notes, pushes };
  }

  const dbSave = (u) => JSON.parse(db.accounts.get(u).save);
  const gold = (u) => dbSave(u).playerGold || 0;
  const qty = (u, item) => ((dbSave(u).inventory || []).find(i => i.item === item) || {}).qty || 0;
  // whole-economy totals as stored in the DB (+ listings/auctions escrow)
  function totals() {
    let g = 0; const items = {};
    for (const [u] of db.accounts) {
      const s = dbSave(u); g += s.playerGold || 0;
      for (const i of s.inventory || []) items[i.item] = (items[i.item] || 0) + (i.qty || 1);
    }
    for (const l of db.listings.values()) items[l.item] = (items[l.item] || 0) + l.qty;
    for (const a of db.auctions.values()) {
      items[a.item] = (items[a.item] || 0) + 1;
      g += a.bidCount > 0 ? a.currentBid : 0;          // gold held in escrow by a live bid
    }
    return { gold: g, items };
  }
  return { db, clock, faults, store, seed, boot, dbSave, gold, qty, totals };
}

async function started(world, opts) { const b = world.boot(opts); await b.eco.initialize(); return b; }

module.exports = { makeWorld, started, clone };
