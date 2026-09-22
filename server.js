// ============================================================
//  AETHERION — Multiplayer Server
//  Express + Socket.io
//
//  Supports:
//    • Room codes (works over internet or WiFi)
//    • Local WiFi auto-discovery (devices on same network
//      see each other automatically — no code needed)
//    • Turn-based duel battles
//    • Party trading between players
//    • Chat
//
//  Run:
//    npm install
//    node server.js
//
//  Local WiFi play:
//    1. Run this on any computer on the WiFi
//    2. Other devices open: http://[this computer's IP]:3000
//    3. They auto-see each other in the lobby
//
//  Cloud (Render):
//    Deploy as-is — PORT env var is set automatically
// ============================================================

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');
const crypto    = require('crypto');
const os        = require('os');
const mongoose  = require('mongoose');
const bcrypt    = require('bcryptjs');
const { BOSSES } = require('./monsters');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  60000,
  pingInterval: 25000,
});

// ── Static files ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check (used by UptimeRobot to keep server awake)
app.get('/health', (_req, res) => {
  res.json({
    status:      'ok',
    rooms:       rooms.size,
    connections: io.engine.clientsCount,
    uptime:      Math.floor(process.uptime()) + 's',
  });
});

// ── ADMIN API ─────────────────────────────────────────────
// SECURITY: Admin key must be set via environment variable.
// No hardcoded fallback — if ADMIN_KEY is missing, all admin endpoints are locked.
const ADMIN_KEY = process.env.ADMIN_KEY || null;
if (!ADMIN_KEY) {
  console.warn('[SECURITY] ADMIN_KEY env var not set — all /admin endpoints are disabled.');
}
const adminAuth = (req, res, next) => {
  if (!ADMIN_KEY) { res.status(503).json({ error: 'Admin not configured' }); return; }
  const provided = String(req.headers['x-admin-key'] || req.query.key || '');
  // timingSafeEqual requires equal-length buffers; hash both to normalize length
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(ADMIN_KEY).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
};

// Allow admin panel to connect from local files (CORS)
app.use('/admin', (req,res,next)=>{
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Headers','*');
  res.header('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS'){res.sendStatus(200);return;}
  next();
});

app.get('/admin/ping', adminAuth, (req,res)=>{ res.json({ok:true,players:accounts.size,uptime:process.uptime()}); });

app.get('/admin/player/:uname', adminAuth, async (req,res)=>{
  const uname=req.params.uname.toLowerCase();
  let acc=await dbGetAccount(uname)||accounts.get(uname);
  if(!acc){res.status(404).json({error:'Not found'});return;}
  let save={};try{save=acc.save?JSON.parse(acc.save):{};}catch(e){}
  const f=flagged.get(uname);
  res.json({username:acc.username,uname,createdAt:acc.createdAt,lastLogin:acc.lastLogin,banned:acc.banned||(f?.level==='banned')||false,onHold:isOnHold(uname),daysLeft:isOnHold(uname)?Math.ceil(getHoldTimeLeft(uname)/(24*60*60*1000)):0,flagLevel:f?.level||null,save});
});

app.get('/admin/players', adminAuth, async (req,res)=>{
  try{
    const accs=MONGO_URI?await Account.find({}).lean():[...accounts.values()];
    res.json(accs.map(acc=>{
      let save={};try{save=acc.save?JSON.parse(acc.save):{};}catch(e){}
      const uname=acc.uname||acc.username?.toLowerCase();
      const f=flagged.get(uname);
      return{username:acc.username,uname,duelWins:save.duelWins||0,playerLevel:save.playerLevel||1,playerGold:save.playerGold||0,banned:acc.banned||(f?.level==='banned')||false,onHold:isOnHold(uname)};
    }));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/admin/player/:uname/edit', express.json(), adminAuth, async (req,res)=>{
  const uname=req.params.uname.toLowerCase();
  let acc=await dbGetAccount(uname)||accounts.get(uname);
  if(!acc){res.status(404).json({error:'Not found'});return;}
  let save={};try{save=acc.save?JSON.parse(acc.save):{};}catch(e){}
  ['duelWins','playerLevel','playerGold','playerXp','skillXp','duelLosses'].forEach(k=>{if(req.body[k]!==undefined)save[k]=parseInt(req.body[k])||0;});
  acc.save=JSON.stringify(save);
  await dbSaveAccount({...acc,uname});accounts.set(uname,acc);
  const entry=leaderboard.get(uname);if(entry)leaderboard.set(uname,{...entry,wins:save.duelWins||0});
  console.log(`[ADMIN] Edited ${uname}`,req.body);res.json({ok:true});
});

// GET fallback for CORS — admin panel uses this when POST is blocked
app.get('/admin/player/:uname/editget', adminAuth, async (req,res)=>{
  const uname=req.params.uname.toLowerCase();
  let acc=await dbGetAccount(uname)||accounts.get(uname);
  if(!acc){res.status(404).json({error:'Not found'});return;}
  let save={};try{save=acc.save?JSON.parse(acc.save):{};}catch(e){}
  ['duelWins','playerLevel','playerGold','playerXp','skillXp','duelLosses'].forEach(k=>{if(req.query[k]!==undefined)save[k]=parseInt(req.query[k])||0;});
  acc.save=JSON.stringify(save);
  await dbSaveAccount({...acc,uname});accounts.set(uname,acc);
  const entry=leaderboard.get(uname);if(entry)leaderboard.set(uname,{...entry,wins:save.duelWins||0});
  console.log(`[ADMIN-GET] Edited ${uname}`,req.query);res.json({ok:true});
});

app.post('/admin/player/:uname/ban', adminAuth, async (req,res)=>{
  const uname=req.params.uname.toLowerCase();
  let acc=await dbGetAccount(uname)||accounts.get(uname);
  if(!acc){res.status(404).json({error:'Not found'});return;}
  acc.banned=true;acc.save=null;await dbSaveAccount({...acc,uname});accounts.set(uname,acc);
  flagged.set(uname,{level:'banned',reason:'Admin ban'});holds.set(uname,Date.now()+100*365*24*60*60*1000);leaderboard.delete(uname);
  console.log(`[ADMIN] Banned ${uname}`);res.json({ok:true});
});

app.post('/admin/player/:uname/liftban', adminAuth, async (req,res)=>{
  const uname=req.params.uname.toLowerCase();
  let acc=await dbGetAccount(uname)||accounts.get(uname);
  if(!acc){res.status(404).json({error:'Not found'});return;}
  acc.banned=false;await dbSaveAccount({...acc,uname});accounts.set(uname,acc);
  flagged.delete(uname);holds.delete(uname);offenses.delete(uname);
  console.log(`[ADMIN] Lifted ban ${uname}`);res.json({ok:true});
});

app.post('/admin/player/:uname/wipesave', adminAuth, async (req,res)=>{
  const uname=req.params.uname.toLowerCase();
  let acc=await dbGetAccount(uname)||accounts.get(uname);
  if(!acc){res.status(404).json({error:'Not found'});return;}
  acc.save=null;await dbSaveAccount({...acc,uname});accounts.set(uname,acc);leaderboard.delete(uname);
  console.log(`[ADMIN] Wiped save ${uname}`);res.json({ok:true});
});

// Dev/QA flag — a debug account plays normally but is excluded from the
// leaderboard entirely (see updateLeaderboardEntry). Use this for your own
// test accounts so testing duels/raids never shows up as a fake rank.
app.post('/admin/player/:uname/setdebug', express.json(), adminAuth, async (req,res)=>{
  const uname=req.params.uname.toLowerCase();
  let acc=await dbGetAccount(uname)||accounts.get(uname);
  if(!acc){res.status(404).json({error:'Not found'});return;}
  acc.isDebug = !!req.body?.enabled;
  await dbSaveAccount({...acc,uname});accounts.set(uname,acc);
  leaderboard.delete(uname); // immediately drop any existing entry either way
  console.log(`[ADMIN] Set isDebug=${acc.isDebug} for ${uname}`);
  res.json({ok:true, isDebug: acc.isDebug});
});
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ─────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────
const rooms         = new Map(); // code → room object
const socketToRoom  = new Map(); // socket.id → room code
const onlinePlayers = new Map(); // socket.id → player info (global lobby)
const trades        = new Map(); // tradeId → trade object
const leaderboard   = new Map(); // username → { name, wins, rankName, updatedAt }

// ── Rank thresholds (mirrors client RANKS in public/index.html) ─
// Server-computed so a client can never claim a rank it hasn't earned.
const RANKS = [
  { name: 'Stone',   winsNeeded: 0   },
  { name: 'Iron',    winsNeeded: 5   },
  { name: 'Bronze',  winsNeeded: 15  },
  { name: 'Silver',  winsNeeded: 30  },
  { name: 'Gold',    winsNeeded: 50  },
  { name: 'Diamond', winsNeeded: 75  },
  { name: 'Legend',  winsNeeded: 100 },
];
function rankForWins(wins) {
  let rank = RANKS[0];
  for (const r of RANKS) { if (wins >= r.winsNeeded) rank = r; else break; }
  return rank.name;
}

// ── Co-op raid combat guards ──────────────────────────────
const RAID_ATTACK_COOLDOWN_MS = 500; // min time between one socket's attacks
const DEFAULT_RAID_PARTICIPANT = { uname: null, atk: 10 }; // used until a real profile loads

// ── Push one account's authoritative wins onto the in-memory leaderboard ─
function updateLeaderboardEntry(uname, acc) {
  // Dev/QA accounts: never appear on the leaderboard, regardless of wins —
  // they're for testing, not for showing up as a fake rank to real players.
  if (acc.isDebug) { leaderboard.delete(uname); return; }
  const f = flagged.get(uname);
  if (f && f.level === 'banned') { leaderboard.delete(uname); return; }
  const save  = loadPlayerSave(acc);
  const wins  = safeNum(save.duelWins, 0, 999_999, 0);
  leaderboard.set(uname, {
    name:       (acc.username || uname).substring(0, 30),
    wins,
    rankName:   rankForWins(wins),
    updatedAt:  Date.now(),
    flagLevel:  f?.level || null,
    flagReason: f?.reason || null,
  });
}

// ── Anti-Cheat System ─────────────────────────────────────
const dailyWins     = new Map(); // username → { wins, lastReset, firstWinTime }
const holds         = new Map(); // username → holdExpiry timestamp
const offenses      = new Map(); // username → offense count
const flagged       = new Map(); // username → { level: 'flag'|'warn'|'hold'|'banned', reason }

const DAILY_WIN_LIMIT    = 100;  // warn at 100
const DAILY_FLAG_LIMIT   = 50;   // flag at 50
const HOLD_DURATION      = 8 * 24 * 60 * 60 * 1000; // 8 days

function resetDailyWinsIfNeeded(username) {
  const now = Date.now();
  const entry = dailyWins.get(username);
  if (!entry) {
    dailyWins.set(username, { wins: 0, lastReset: now, firstWinTime: now });
    return;
  }
  if (now - entry.lastReset > 24 * 60 * 60 * 1000) {
    dailyWins.set(username, { wins: 0, lastReset: now, firstWinTime: now });
    // Remove daily flags when wins reset
    const f = flagged.get(username);
    if (f && (f.level === 'flag' || f.level === 'warn')) flagged.delete(username);
  }
}

function checkAntiCheat(username) {
  const entry = dailyWins.get(username);
  if (!entry) return null;
  const { wins, firstWinTime } = entry;
  const timeSinceFirst = Date.now() - firstWinTime;

  // 100+ wins/day → warning + Veylor hold
  if (wins >= DAILY_WIN_LIMIT) {
    return 'hold';
  }
  // 100 wins in under 30 min → suspicious warning
  if (wins >= DAILY_WIN_LIMIT && timeSinceFirst < 30 * 60 * 1000) {
    return 'warn';
  }
  // 50+ wins/day → flag
  if (wins >= DAILY_FLAG_LIMIT) {
    return 'flag';
  }
  return null;
}

function isOnHold(username) {
  const expiry = holds.get(username);
  if (!expiry) return false;
  if (Date.now() > expiry) { holds.delete(username); return false; }
  return true;
}

function getHoldTimeLeft(username) {
  const expiry = holds.get(username);
  if (!expiry) return 0;
  return Math.max(0, expiry - Date.now());
}

// ── Account system ────────────────────────────────────────
// SECURITY: No default password. Clients must always supply a password.

// ═══════════════════════════════════════════════════════════
//  SERVER-AUTHORITATIVE PROGRESSION ENGINE
//  The server is the ONLY authority over gold, XP, level,
//  inventory, deck, and all other progression data.
//  The client requests ACTIONS. The server decides outcomes.
// ═══════════════════════════════════════════════════════════

// ── Server-side shop catalog (mirrors client, authoritative) ─
const SERVER_SHOP = {
  hp_potion:    { name:'Health Potion',   cost:40,   rarity:'Common', cat:'potions', effect:{type:'item',stat:'hp',val:40} },
  elixir:       { name:'Elixir',          cost:110,  rarity:'Rare',   cat:'potions', effect:{type:'item',stat:'hpAll',val:80} },
  mega_potion:  { name:'Mega Potion',     cost:180,  rarity:'Rare',   cat:'potions', effect:{type:'item',stat:'hpFull',val:0} },
  antidote:     { name:'Antidote',        cost:60,   rarity:'Common', cat:'potions', effect:{type:'item',stat:'cure',val:0} },
  speed_brew:   { name:'Speed Brew',      cost:90,   rarity:'Rare',   cat:'potions', effect:{type:'stat',stat:'speed',val:5} },
  mana_crystal: { name:'Mana Crystal',    cost:80,   rarity:'Rare',   cat:'potions', effect:{type:'item',stat:'cooldown',val:0} },
  iron_sword:   { name:'Iron Sword',      cost:160,  rarity:'Common', cat:'weapons', effect:{type:'statAll',stat:'attack',val:4} },
  flame_blade:  { name:'Flame Blade',     cost:320,  rarity:'Rare',   cat:'weapons', effect:{type:'statAll2',stats:['attack','magic'],vals:[8,3]} },
  shadow_dagger:{ name:'Shadow Dagger',   cost:240,  rarity:'Rare',   cat:'weapons', effect:{type:'statOne2',stats:['attack','speed'],vals:[6,4]} },
  thunder_axe:  { name:'Thunder Axe',     cost:400,  rarity:'Epic',   cat:'weapons', effect:{type:'statOne',stat:'attack',val:12} },
  void_blade:   { name:'Void Blade',      cost:560,  rarity:'Epic',   cat:'weapons', effect:{type:'statAll2',stats:['attack','magic'],vals:[10,5]} },
  leather:      { name:'Leather Vest',    cost:140,  rarity:'Common', cat:'armor',   effect:{type:'statAll',stat:'defense',val:5} },
  chain_mail:   { name:'Chain Mail',      cost:280,  rarity:'Rare',   cat:'armor',   effect:{type:'statAll',stat:'defense',val:10} },
  dragon_scale: { name:'Dragon Scale',    cost:440,  rarity:'Epic',   cat:'armor',   effect:{type:'statAll2',stats:['defense','maxHp'],vals:[8,20]} },
  void_cloak:   { name:'Void Cloak',      cost:360,  rarity:'Rare',   cat:'armor',   effect:{type:'statOne2',stats:['defense','speed'],vals:[6,6]} },
  titan_plate:  { name:'Titan Plate',     cost:600,  rarity:'Epic',   cat:'armor',   effect:{type:'statAll',stat:'defense',val:15} },
  spell_scroll: { name:'Spell Scroll',    cost:150,  rarity:'Common', cat:'magic',   effect:{type:'statAll',stat:'magic',val:5} },
  arcane_tome:  { name:'Arcane Tome',     cost:300,  rarity:'Rare',   cat:'magic',   effect:{type:'statAll2',stats:['magic','attack'],vals:[10,3]} },
  crystal_orb:  { name:'Crystal Orb',     cost:360,  rarity:'Epic',   cat:'magic',   effect:{type:'statOne',stat:'magic',val:15} },
  phoenix_dust: { name:'Phoenix Dust',    cost:500,  rarity:'Epic',   cat:'magic',   effect:{type:'item',stat:'revive',val:50} },
  void_essence: { name:'Void Essence',    cost:640,  rarity:'Epic',   cat:'magic',   effect:{type:'statAll2',stats:['magic','defense'],vals:[12,5]} },
  card_boost:   { name:'Card Boost',      cost:240,  rarity:'Rare',   cat:'cards',   effect:{type:'cardLevel',val:1} },
  card_boost2:  { name:'Double Boost',    cost:440,  rarity:'Epic',   cat:'cards',   effect:{type:'cardLevel',val:2} },
  xp_tome:      { name:'XP Tome',         cost:160,  rarity:'Rare',   cat:'cards',   effect:{type:'cardXp',val:200} },
  heal_all:     { name:'Full Restore',    cost:200,  rarity:'Rare',   cat:'cards',   effect:{type:'healAll',val:0} },
  reroll_token: { name:'Reroll Token',    cost:600,  rarity:'Epic',   cat:'cards',   effect:{type:'reroll',val:0} },
  legend_sword: { name:"Legend's Blade",  cost:1600, rarity:'Mythic', cat:'rare',    effect:{type:'statAll',stat:'attack',val:20} },
  god_armor:    { name:'Godplate Armor',  cost:1800, rarity:'Mythic', cat:'rare',    effect:{type:'statAll2',stats:['defense','maxHp'],vals:[25,50]} },
  void_heart:   { name:'Void Heart',      cost:2400, rarity:'Mythic', cat:'rare',    effect:{type:'statAll3',stats:['magic','attack','defense'],vals:[20,10,10]} },
  phoenix_core: { name:'Phoenix Core',    cost:1200, rarity:'Mythic', cat:'rare',    effect:{type:'fullRestorePlus',val:30} },
  abyss_crown:  { name:'Abyss Crown',     cost:4000, rarity:'Mythic', cat:'rare',    effect:{type:'allStats',val:15} },
};

// Items that are "consumable" (can be bought multiple times / stackable)
const CONSUMABLE_ITEM_TYPES = new Set(['item','healAll','fullRestorePlus','reroll','cardXp']);

// ── Server-side quest catalog (authoritative rewards) ─────
const SERVER_QUEST_CATALOG = {
  kill3:    { desc:'Defeat 3 monsters',          type:'kill',    target:3,   reward:{gold:30,  xp:60,  item:null} },
  kill8:    { desc:'Defeat 8 monsters',          type:'kill',    target:8,   reward:{gold:80,  xp:150, item:null} },
  kill15:   { desc:'Defeat 15 monsters',         type:'kill',    target:15,  reward:{gold:150, xp:300, item:null} },
  boss1:    { desc:'Defeat 1 boss',              type:'boss',    target:1,   reward:{gold:400, xp:800, item:'Health Potion'} },
  explore5: { desc:'Explore 5 times',            type:'explore', target:5,   reward:{gold:35,  xp:70,  item:null} },
  explore8: { desc:'Explore 8 times',            type:'explore', target:8,   reward:{gold:60,  xp:120, item:null} },
  combo3:   { desc:'Build a 3x Combo',           type:'combo',   target:3,   reward:{gold:60,  xp:120, item:null} },
  combo5:   { desc:'Build a 5x Combo',           type:'combo',   target:5,   reward:{gold:120, xp:250, item:'Mana Crystal'} },
  gold50:   { desc:'Earn 50 Gold from battles',  type:'gold',    target:50,  reward:{gold:40,  xp:80,  item:null} },
  gold200:  { desc:'Earn 200 Gold from battles', type:'gold',    target:200, reward:{gold:100, xp:200, item:null} },
  lvlup1:   { desc:'Level up your party',        type:'levelup', target:1,   reward:{gold:300, xp:600, item:'XP Tome'} },
  tame1:    { desc:'Tame a monster',             type:'tame',    target:1,   reward:{gold:350, xp:700, item:'Monster Bait'} },
  duel1:    { desc:'Win 1 duel',                 type:'duel',    target:1,   reward:{gold:200, xp:400, item:null} },
  duel3:    { desc:'Win 3 duels',                type:'duel',    target:3,   reward:{gold:500, xp:1000,item:'Elixir'} },
  dungeon1: { desc:'Complete a dungeon floor',   type:'dungeon', target:1,   reward:{gold:250, xp:500, item:'Health Potion'} },
};

// ── Rate-limiting map ─────────────────────────────────────
const actionRateLimit = new Map(); // uname → { count, windowStart }
const ACTION_RATE_WINDOW = 5_000;
const ACTION_RATE_MAX    = 30;

function checkActionRateLimit(uname) {
  const now = Date.now();
  const entry = actionRateLimit.get(uname) || { count: 0, windowStart: now };
  if (now - entry.windowStart > ACTION_RATE_WINDOW) {
    actionRateLimit.set(uname, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  actionRateLimit.set(uname, entry);
  return entry.count <= ACTION_RATE_MAX;
}

// ── Login/register rate limiting ──────────────────────────
// SECURITY: account:login had no throttling at all — a script could try
// unlimited password guesses against one account, or hammer account:register
// to spam-create accounts, as fast as the network allowed. Two keys are
// tracked: the username being attacked (so one target account gets locked
// out even from many IPs) and the connecting IP (so one attacker can't just
// spray many different usernames to dodge the per-account limit).
const loginAttemptsByUname = new Map(); // uname → { fails, lockedUntil }
const loginAttemptsByIp    = new Map(); // ip    → { count, windowStart }
const LOGIN_IP_WINDOW      = 60_000;
const LOGIN_IP_MAX         = 20; // login/register attempts per IP per minute
const LOGIN_LOCKOUT_AFTER  = 5;  // failed attempts before an account locks
// Progressive backoff: 5th failure locks 5s, 6th 10s, 7th 20s... capped.
function lockoutMsFor(fails) {
  return Math.min(15 * 60_000, 5_000 * Math.pow(2, Math.max(0, fails - LOGIN_LOCKOUT_AFTER)));
}
function checkLoginIpRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttemptsByIp.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > LOGIN_IP_WINDOW) {
    loginAttemptsByIp.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  loginAttemptsByIp.set(ip, entry);
  return entry.count <= LOGIN_IP_MAX;
}
// Returns ms remaining if locked, else 0.
function getLoginLockoutRemaining(uname) {
  const e = loginAttemptsByUname.get(uname);
  if (!e || !e.lockedUntil) return 0;
  const remaining = e.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}
function recordLoginFailure(uname) {
  const e = loginAttemptsByUname.get(uname) || { fails: 0, lockedUntil: 0 };
  e.fails++;
  if (e.fails >= LOGIN_LOCKOUT_AFTER) e.lockedUntil = Date.now() + lockoutMsFor(e.fails);
  loginAttemptsByUname.set(uname, e);
}
function recordLoginSuccess(uname) {
  loginAttemptsByUname.delete(uname);
}

// Clamp a number to [min, max], returning fallback if invalid
function safeNum(val, min, max, fallback = min) {
  const n = Number(val);
  if (!isFinite(n) || isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// ── Load player save from DB ──────────────────────────────
function loadPlayerSave(acc) {
  try { return acc.save ? JSON.parse(acc.save) : {}; } catch(e) { return {}; }
}

// ── Persist updated save back to DB ──────────────────────
async function persistSave(acc, save, uname) {
  acc.save = JSON.stringify(save);
  await dbSaveAccount({ ...acc, uname });
  accounts.set(uname, acc);
}

// ── Authoritative: add gold ───────────────────────────────
function addGold(save, amount, reason) {
  const n = safeNum(amount, 0, 500_000, 0); // max 500k per action
  save.playerGold = safeNum((save.playerGold || 0) + n, 0, 999_999_999, 0);
  if (n > 0) console.log(`[PROGRESSION] +${n} gold (${reason}) → total: ${save.playerGold}`);
  return n;
}

// ── Authoritative: remove gold ────────────────────────────
function removeGold(save, amount, reason) {
  const n = safeNum(amount, 0, 999_999_999, 0);
  if ((save.playerGold || 0) < n) return false; // insufficient
  save.playerGold = Math.max(0, (save.playerGold || 0) - n);
  console.log(`[PROGRESSION] -${n} gold (${reason}) → total: ${save.playerGold}`);
  return true;
}

// ── Authoritative: add XP + handle level-up ──────────────
function addXP(save, amount, reason) {
  const n = safeNum(amount, 0, 100_000, 0); // max 100k XP per action
  save.playerXp   = safeNum((save.playerXp   || 0) + n, 0, 999_999_999, 0);
  save.skillXp    = safeNum((save.skillXp     || 0) + n, 0, 999_999_999, 0);
  if (n > 0) console.log(`[PROGRESSION] +${n} XP (${reason})`);
  // Level-up loop
  let levelled = 0;
  while (save.playerXp >= (save.xpToNext || 100)) {
    save.playerXp  -= (save.xpToNext || 100);
    save.playerLevel = safeNum((save.playerLevel || 1) + 1, 1, 999, 1);
    save.xpToNext   = Math.floor(100 * Math.pow(1.18, save.playerLevel - 1));
    levelled++;
  }
  if (levelled > 0) console.log(`[PROGRESSION] Level up ×${levelled} → Level ${save.playerLevel}`);
  return levelled;
}

// ── Authoritative: give item ──────────────────────────────
function giveItem(save, itemName, qty, reason) {
  if (!save.inventory) save.inventory = [];
  if (save.inventory.length >= 200) {
    console.log(`[SECURITY] giveItem rejected — inventory full (${reason})`);
    return false;
  }
  const existing = save.inventory.find(i => i.item === itemName);
  if (existing) { existing.qty = (existing.qty || 1) + qty; }
  else { save.inventory.push({ item: itemName, qty, rarity: 'Common' }); }
  console.log(`[PROGRESSION] +${qty}× ${itemName} (${reason})`);
  return true;
}

// ── Authoritative: remove item ────────────────────────────
function removeItem(save, itemName, qty) {
  if (!save.inventory) return false;
  const idx = save.inventory.findIndex(i => i.item === itemName);
  if (idx < 0) return false;
  const item = save.inventory[idx];
  if ((item.qty || 1) < qty) return false;
  item.qty = (item.qty || 1) - qty;
  if (item.qty <= 0) save.inventory.splice(idx, 1);
  return true;
}

// ── Build authoritative state snapshot to send client ─────
function buildClientState(save) {
  return {
    playerLevel:    save.playerLevel    || 1,
    playerXp:       save.playerXp       || 0,
    xpToNext:       save.xpToNext       || 100,
    playerGold:     save.playerGold     || 0,
    skillXp:        save.skillXp        || 0,
    inventory:      save.inventory      || [],
    deck:           save.deck           || [],
    shopOwned:      save.shopOwned      || {},
    unlockedSkills: save.unlockedSkills || [],
    activeCardIdx:  save.activeCardIdx  || 0,
    duelWins:       save.duelWins       || 0,
    duelLosses:     save.duelLosses     || 0,
    questClaims:    save.questClaims    || {},
  };
}

// ── Safe deck sanitizer (for initial deck submission only) ─
// SECURITY: strips anything but safe display characters. Used for guest/
// unauthenticated display names (room:host, room:join fallback) — logged-in
// account names are already restricted to this same character set at
// account:register, so this never changes behavior for real accounts.
function sanitizeDisplayName(name, fallback) {
  return String(name || '').trim().substring(0, 20).replace(/[^a-zA-Z0-9_\- ]/g, '') || fallback;
}

function sanitizeDeck(deck) {
  if (!Array.isArray(deck)) return [];
  // SECURITY: these ceilings are not arbitrary — they're the real maximum a
  // legitimate account could ever reach: highest canonical base stat (~18
  // atk/def/mag, ~16 spd, ~70 hp — see CHARACTERS in public/index.html)
  // plus every permanent stat-boosting shop item bought once each (summing
  // the shop catalog: up to ~+82 atk, ~+79 def, ~+62 mag, ~+15 spd, ~+70
  // max HP). Ceilings below are set well above that real max, but nowhere
  // near the previous 999/9999, which let a raw socket call to
  // player:setDeck save an arbitrary, effectively-uncapped card.
  // NOTE: this is a bounds tightening, not full validation — it does not
  // verify a card's name/id/ability actually corresponds to a real,
  // player-owned catalog entry. That requires the client's embedded
  // CHARACTERS list to be extracted into a module both client and server
  // require, so the server can look up and enforce real per-card base
  // stats. Flagging as a follow-up, not attempted here.
  return deck.slice(0, 3).map(card => {
    if (!card || typeof card !== 'object') return null;
    return {
      name:      String(card.name    || '').substring(0, 40),
      emoji:     String(card.emoji   || '⚔️').substring(0, 10),
      title:     String(card.title   || '').substring(0, 40),
      hp:        safeNum(card.hp,      1, 250, 100),
      maxHp:     safeNum(card.maxHp,   1, 250, 100),
      attack:    safeNum(card.attack,  0, 150,  10),
      defense:   safeNum(card.defense, 0, 150,  5),
      magic:     safeNum(card.magic,   0, 150,  8),
      speed:     safeNum(card.speed,   0, 60,   8),
      ability:   String(card.ability  || 'Strike').substring(0, 40),
      fainted:   false, // never trust fainted state from client
      id:        card.id ? String(card.id).substring(0, 40) : undefined,
      cardLevel: safeNum(card.cardLevel, 1, 50, 1),
      cardXp:    safeNum(card.cardXp,    0, 999_999, 0),
    };
  }).filter(Boolean);
}

// SECURITY: bcrypt cost factor 10 — strong enough, ~100ms vs ~400ms at 12.
const BCRYPT_ROUNDS = 10;
async function hashPassword(pw) {
  return bcrypt.hash(pw, BCRYPT_ROUNDS);
}
// Pre-computed dummy hash used for timing-safe rejection of unknown usernames.
// Generated once at startup so failed logins don't pay the full bcrypt cost each time.
let _dummyHash = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012';
bcrypt.hash('dummy_timing_guard', BCRYPT_ROUNDS).then(h => { _dummyHash = h; });
// Constant-time comparison; also handles legacy integer-hash passwords (returns false — user must reset)
async function verifyPassword(pw, stored) {
  try {
    if (stored && stored.startsWith('$2')) {
      // bcrypt hash
      return await bcrypt.compare(pw, stored);
    }
    // Legacy weak hash — reject and force re-registration
    return false;
  } catch(e) {
    return false;
  }
}

// SECURITY: session-based identity for actions that don't touch the
// password itself (shop, battle reward, quests, deck, etc). These used to
// re-verify a bcrypt password on every single call — expensive (bcrypt is
// deliberately slow) and it meant the plaintext password had to live in
// client memory/localStorage for the whole session. Now they trust the
// socket's own login (see account:login/register, which set socket.data.uname),
// exactly like a normal HTTP session cookie. Sensitive actions
// (account:changepass, account:delete) still re-verify the real password —
// see those handlers.
async function requireSession(socket) {
  const uname = socket.data.uname;
  if (!uname) {
    socket.emit('player:actionError', { msg: 'Not logged in — please log in again.' });
    return null;
  }
  const acc = await dbGetAccount(uname) || accounts.get(uname);
  if (!acc) {
    socket.emit('player:actionError', { msg: 'Account not found.' });
    return null;
  }
  return { uname, acc };
}

// ── MongoDB Schema ─────────────────────────────────────────
const AccountSchema = new mongoose.Schema({
  username:  { type: String, required: true, unique: true },
  uname:     { type: String, required: true, unique: true }, // lowercase key
  password:  { type: String, required: true },
  save:      { type: String, default: null }, // JSON string of game save
  createdAt: { type: Number, default: Date.now },
  lastLogin: { type: Number, default: Date.now },
  // Dev/QA accounts only — set via /admin/player/:uname/setdebug. A debug
  // account plays normally (duels, raids, everything) but is invisible to
  // the leaderboard/rankings, so testing never pollutes real player stats.
  isDebug:   { type: Boolean, default: false },
});
const Account = mongoose.model('Account', AccountSchema);

// ── Friendship Schema ──────────────────────────────────────
// status: 'pending' (A→B waiting) | 'accepted' (both friends)
// Compound unique index prevents duplicate pairs.
const FriendshipSchema = new mongoose.Schema({
  fromUname: { type: String, required: true },  // sender (lowercase)
  toUname:   { type: String, required: true },  // recipient (lowercase)
  status:    { type: String, enum: ['pending','accepted'], default: 'pending' },
  createdAt: { type: Number, default: Date.now },
  updatedAt: { type: Number, default: Date.now },
});
FriendshipSchema.index({ fromUname: 1, toUname: 1 }, { unique: true });
FriendshipSchema.index({ toUname: 1, status: 1 });   // fast: incoming pending
FriendshipSchema.index({ fromUname: 1, status: 1 }); // fast: outgoing pending
const Friendship = mongoose.model('Friendship', FriendshipSchema);

// In-memory fallback (when no MongoDB)
// Key: `${a}:${b}` where a < b alphabetically for accepted; `${from}>${to}` for pending
const friendshipMem = new Map();

// ── Friendship DB helpers ──────────────────────────────────
async function dbGetFriendships(uname) {
  // Returns all friendships involving this user (both directions)
  if (MONGO_URI) {
    try {
      return await Friendship.find({
        $or: [{ fromUname: uname }, { toUname: uname }]
      }).lean();
    } catch(e) { console.warn('[FRIEND DB]', e.message); }
  }
  return [...friendshipMem.values()].filter(f => f.fromUname===uname || f.toUname===uname);
}

async function dbGetFriendship(a, b) {
  // Find a relationship between a and b in either direction
  if (MONGO_URI) {
    try {
      return await Friendship.findOne({
        $or: [{ fromUname: a, toUname: b }, { fromUname: b, toUname: a }]
      }).lean();
    } catch(e) {}
  }
  return friendshipMem.get(a+'>'+b) || friendshipMem.get(b+'>'+a) || null;
}

async function dbUpsertFriendship(fromUname, toUname, status) {
  const now = Date.now();
  if (MONGO_URI) {
    try {
      return await Friendship.findOneAndUpdate(
        { fromUname, toUname },
        { fromUname, toUname, status, updatedAt: now,
          $setOnInsert: { createdAt: now } },
        { upsert: true, new: true }
      );
    } catch(e) { console.warn('[FRIEND DB upsert]', e.message); }
  }
  const rec = { fromUname, toUname, status, createdAt: now, updatedAt: now };
  friendshipMem.set(fromUname+'>'+toUname, rec);
  return rec;
}

async function dbDeleteFriendship(a, b) {
  if (MONGO_URI) {
    try {
      await Friendship.deleteOne({ $or: [
        { fromUname: a, toUname: b }, { fromUname: b, toUname: a }
      ]});
    } catch(e) {}
  }
  friendshipMem.delete(a+'>'+b);
  friendshipMem.delete(b+'>'+a);
}

// Build the client-safe friend list payload for a user
async function buildFriendPayload(uname) {
  const ships = await dbGetFriendships(uname);
  const friends  = [];
  const incoming = [];
  const outgoing = [];

  for (const s of ships) {
    if (s.status === 'accepted') {
      const otherUname = s.fromUname === uname ? s.toUname : s.fromUname;
      // Check if online
      const isOnline = !!getSocketOfPlayer(otherUname);   // verified-login lookup (see getSocketOfPlayer)
      friends.push({ uname: otherUname, online: isOnline, since: s.updatedAt });
    } else if (s.status === 'pending') {
      if (s.fromUname === uname) {
        outgoing.push({ uname: s.toUname, since: s.createdAt });
      } else {
        incoming.push({ uname: s.fromUname, since: s.createdAt });
      }
    }
  }
  return { friends, incoming, outgoing };
}

// Find the socket.id of an online player by uname (for real-time notifications)
function getSocketOfPlayer(uname) {
  // Match on the server-verified account name (socket.data.uname), never on a client-declared display name.
  for (const [sid, s] of io.sockets.sockets) {
    if (s.data && s.data.uname === uname) return sid;
  }
  return null;
}

// ── Guild Schema ───────────────────────────────────────────
const GuildMemberSchema = new mongoose.Schema({
  uname:    { type: String, required: true },
  display:  { type: String, required: true },
  rank:     { type: String, enum: ['Leader','Officer','Member'], default: 'Member' },
  joined:   { type: Number, default: Date.now },
  kills:    { type: Number, default: 0 },
  bossKills:{ type: Number, default: 0 },
}, { _id: false });

const GuildSchema = new mongoose.Schema({
  code:           { type: String, required: true, unique: true },
  name:           { type: String, required: true },
  nameLower:      { type: String, required: true, unique: true },
  tag:            { type: String, required: true },
  emblem:         { type: String, default: '\u{1F6E1}' },
  leaderUname:    { type: String, required: true },
  members:        { type: [GuildMemberSchema], default: [] },
  level:          { type: Number, default: 1 },
  xp:             { type: Number, default: 0 },
  xpToNext:       { type: Number, default: 500 },
  totalKills:     { type: Number, default: 0 },
  totalBossKills: { type: Number, default: 0 },
  notice:         { type: String, default: 'Welcome to the guild!' },
  createdAt:      { type: Number, default: Date.now },
});
// Indexes MUST be defined before mongoose.model() — Mongoose ignores indexes added after.
GuildSchema.index({ 'members.uname': 1 });          // hot path: player→guild lookup
GuildSchema.index({ code: 1 },      { unique: true }); // invite-code lookup
GuildSchema.index({ nameLower: 1 }, { unique: true }); // duplicate-name check
const Guild = mongoose.model('Guild', GuildSchema);

// In-memory guild cache  code → guild object
const guildCache = new Map();
// O(1) reverse index: player uname → guild code  (avoids O(n*m) scan on every fetch)
const playerGuildIndex = new Map();

// Keep playerGuildIndex in sync whenever a guild is saved
function _indexGuild(guild) {
  if (!guild || !guild.members) return;
  (guild.members).forEach(m => playerGuildIndex.set(m.uname, guild.code));
}
function _unindexPlayer(uname) { playerGuildIndex.delete(uname); }
// Codes of guilds modified in memory but not yet flushed to MongoDB
const guildDirtySet = new Set();
// Flush dirty guilds to DB every 30 seconds (non-critical stat updates)
setInterval(async () => {
  if (!MONGO_URI || guildDirtySet.size === 0) return;
  const codes = [...guildDirtySet];
  guildDirtySet.clear();
  for (const code of codes) {
    const g = guildCache.get(code);
    if (g) {
      try {
        await Guild.findOneAndUpdate({ code }, g, { upsert: true });
      } catch(e) {
        console.warn('[GUILD FLUSH]', code, e.message);
        guildDirtySet.add(code); // retry next cycle
      }
    }
  }
  if (codes.length > 0) console.log('[GUILD FLUSH] Persisted', codes.length, 'guild(s)');
}, 30000);

async function dbGetGuild(code) {
  if (MONGO_URI) { try { const g = await Guild.findOne({ code }); if(g) return g.toObject(); } catch(e){} }
  return guildCache.get(code) || null;
}
async function dbGetGuildByName(nameLower) {
  if (MONGO_URI) { try { const g = await Guild.findOne({ nameLower }); if(g) return g.toObject(); } catch(e){} }
  for (const g of guildCache.values()) { if (g.nameLower === nameLower) return g; }
  return null;
}
async function dbSaveGuild(guild) {
  guildCache.set(guild.code, guild);
  _indexGuild(guild); // keep O(1) reverse index in sync
  if (MONGO_URI) { try { await Guild.findOneAndUpdate({ code: guild.code }, guild, { upsert: true, new: true }); } catch(e){ console.warn('[GUILD DB]', e.message); } }
}
async function dbDeleteGuild(code) {
  const g = guildCache.get(code);
  if (g && g.members) g.members.forEach(m => _unindexPlayer(m.uname));
  guildCache.delete(code);
  if (MONGO_URI) { try { await Guild.deleteOne({ code }); } catch(e){} }
}
async function dbGetPlayerGuild(uname) {
  // O(1) fast path: reverse index built from in-memory cache
  const code = playerGuildIndex.get(uname);
  if (code) {
    const cached = guildCache.get(code);
    if (cached) return cached;
  }
  // DB path (first access or cache miss)
  if (MONGO_URI) {
    try {
      const g = await Guild.findOne({ 'members.uname': uname });
      if (g) {
        const plain = g.toObject();
        guildCache.set(plain.code, plain);
        _indexGuild(plain); // populate reverse index for next time
        return plain;
      }
    } catch(e) { console.warn('[GUILD DB getPlayer]', e.message); }
  }
  // Memory-only fallback (no MongoDB)
  for (const g of guildCache.values()) {
    if (g.members && g.members.some(m => m.uname === uname)) return g;
  }
  return null;
}

// ── Connect to MongoDB ─────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || '';

async function connectDB() {
  if (!MONGO_URI) {
    console.warn('[DB] No MONGO_URI set — accounts will not persist between restarts!');
    console.warn('[DB] Set MONGO_URI in Render environment variables to enable persistence.');
    return false;
  }
  try {
    await mongoose.connect(MONGO_URI);
    console.log('[DB] ✅ Connected to MongoDB Atlas — accounts will persist forever!');
    return true;
  } catch(e) {
    console.error('[DB] ❌ MongoDB connection failed:', e.message);
    return false;
  }
}

// ── DB helper functions ────────────────────────────────────
async function dbGetAccount(uname) {
  if (!MONGO_URI) return null;
  try { return await Account.findOne({ uname }); } catch(e) { return null; }
}

async function dbSaveAccount(data) {
  if (!MONGO_URI) return true; // memory-only mode — always succeeds
  try {
    await Account.findOneAndUpdate(
      { uname: data.uname },
      data,
      { upsert: true, new: true }
    );
    return true;
  } catch(e) {
    console.error('[DB] dbSaveAccount error:', e.message);
    return false;
  }
}

async function dbDeleteAccount(uname) {
  if (!MONGO_URI) return;
  try { await Account.deleteOne({ uname }); } catch(e) {}
}

// ── In-memory fallback (used when no MongoDB) ──────────────
const accounts = new Map();

// ─────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────
function genCode() {
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); }
  while (rooms.has(code));
  return code;
}

function getRoomOf(socketId) {
  const code = socketToRoom.get(socketId);
  return code ? rooms.get(code) : null;
}

function broadcastRoom(room) {
  if (!room) return;
  io.to(room.code).emit('room:update', {
    code:    room.code,
    players: room.players.map(p => ({
      id:       p.id,
      username: p.username,
      level:    p.level,
      deckSize: p.deckSize,
      isHost:   p.id === room.host,
      hp:       p.hp,
      maxHp:    p.maxHp,
    })),
    mode:          room.mode,
    storyProgress: room.storyProgress,
    battleState:   room.battleState,
  });
}

function broadcastLobby() {
  const list = [...onlinePlayers.values()].map(p => ({
    id:       p.id,
    username: p.username,
    level:    p.level,
    deckSize: p.deckSize,
    inRoom:   !!socketToRoom.get(p.id),
  }));
  io.emit('lobby:players', list);
}

// ─────────────────────────────────────────────────────────
//  SOCKET EVENTS
// ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  // ── REGISTER (call right after connecting) ─────────────
  // Payload: { username, level, deckSize, gold }
  socket.on('player:register', ({ username, level, deckSize, gold } = {}) => {
    if (!username) return;
    // SECURITY: unlike account:register, this name is never verified against
    // a password, yet it's what gets shown to *other players* in chat
    // ("chat-from"), the lobby list, and duel logs — several of those render
    // it via innerHTML without escaping. account:register already restricts
    // real account names to a safe character set; this path had no such
    // restriction, so a raw socket call could plant an HTML/script payload
    // that runs in every other player's browser who sees it.
    const safeUsername = username.trim().substring(0, 20).replace(/[^a-zA-Z0-9_\- ]/g, '');
    onlinePlayers.set(socket.id, {
      id:       socket.id,
      username: safeUsername || 'Hero',
      level:    safeNum(level,    1, 999, 1),
      deckSize: safeNum(deckSize, 0, 3,   0),
      gold:     safeNum(gold,     0, 999_999_999, 0),
      joinedAt: Date.now(),
    });
    socket.emit('player:registered', { id: socket.id });
    broadcastLobby();
    console.log(`[REG] ${safeUsername} registered`);
  });

  // ── HOST ROOM ─────────────────────────────────────────
  // Payload: { username, deck, level }
  socket.on('room:host', ({ username, deck, level } = {}) => {
    if (!username) { socket.emit('error', { msg: 'Username required' }); return; }

    // SECURITY: if this socket is logged in, use the verified account name
    // and remember its uname so duel results can be persisted authoritatively.
    // Unauthenticated sockets can still play (guest/offline modes aren't
    // gated on login elsewhere in this file), but their duel wins won't be
    // recorded to any account — there's nothing verified to record them to.
    const displayName = socket.data.username || sanitizeDisplayName(username, 'Hero');
    const authUname    = socket.data.uname || null;

    const code = genCode();
    const room = {
      code,
      host: socket.id,
      players: [{
        id:       socket.id,
        username: displayName,
        authUname,
        deck:     deck  || [],
        level:    level || 1,
        deckSize: deck?.length || 0,
        hp:       deck?.[0]?.hp || 100,
        maxHp:    deck?.[0]?.hp || 100,
      }],
      mode:          null,
      battleState:   null,
      storyProgress: 0,
      storyBlocks:   [],
      created:       Date.now(),
    };

    rooms.set(code, room);
    socketToRoom.set(socket.id, code);
    socket.join(code);

    socket.emit('room:hosted', { code });
    broadcastRoom(room);
    broadcastLobby();
    console.log(`[HOST] Room ${code} by ${username}`);
  });

  // ── JOIN ROOM ─────────────────────────────────────────
  // Payload: { username, code, deck, level }
  socket.on('room:join', ({ username, code, deck, level } = {}) => {
    if (!username || !code) { socket.emit('error', { msg: 'Username and code required' }); return; }
    code = code.trim().toUpperCase();
    const room = rooms.get(code);

    if (!room)                    { socket.emit('error', { msg: `Room ${code} not found` }); return; }
    if (room.players.length >= 6) { socket.emit('error', { msg: 'Room is full (max 6)' }); return; }

    const displayName = socket.data.username || sanitizeDisplayName(username, 'Hero');
    const authUname    = socket.data.uname || null;

    const player = {
      id:       socket.id,
      username: displayName,
      authUname,
      deck:     deck  || [],
      level:    level || 1,
      deckSize: deck?.length || 0,
      hp:       deck?.[0]?.hp || 100,
      maxHp:    deck?.[0]?.hp || 100,
    };
    room.players.push(player);
    socketToRoom.set(socket.id, code);
    socket.join(code);

    socket.emit('room:joined', { code });
    io.to(code).emit('player:joined', { username: player.username });
    broadcastRoom(room);
    broadcastLobby();
    console.log(`[JOIN] ${username} → Room ${code}`);
  });

  // ── START GAME ────────────────────────────────────────
  // Payload: { mode: 'duel'|'story', storyBlocks? }
  socket.on('game:start', ({ mode, storyBlocks } = {}) => {
    const room = getRoomOf(socket.id);
    if (!room)                   { socket.emit('error', { msg: 'Not in a room' }); return; }
    if (socket.id !== room.host) { socket.emit('error', { msg: 'Only host can start' }); return; }
    if (room.players.length < 2) { socket.emit('error', { msg: 'Need at least 2 players' }); return; }

    room.mode = mode;

    // Validate storyBlocks — strip HTML and clamp values so client can't inject scripts
    if (storyBlocks && Array.isArray(storyBlocks)) {
      room.storyBlocks = storyBlocks.slice(0, 200).map(b => {
        if (!b || typeof b !== 'object') return null;
        const safe = {};
        if (typeof b.type    === 'string') safe.type    = b.type.substring(0,30);
        if (typeof b.text    === 'string') safe.text    = b.text.substring(0,1000).replace(/<[^>]*>/g,'');
        if (typeof b.speaker === 'string') safe.speaker = b.speaker.substring(0,50).replace(/<[^>]*>/g,'');
        if (b.monster && typeof b.monster === 'object') {
          safe.monster = {
            name:    String(b.monster.name||'').substring(0,50),
            hp:      safeNum(b.monster.hp,    1,99999,100),
            attack:  safeNum(b.monster.attack,0,9999,10),
            defense: safeNum(b.monster.defense,0,9999,5),
            magic:   safeNum(b.monster.magic, 0,9999,5),
            speed:   safeNum(b.monster.speed, 0,9999,5),
            emoji:   typeof b.monster.emoji==='string'?b.monster.emoji.substring(0,4):'👾',
          };
          safe.monster.maxHp = safe.monster.hp;
        }
        if (b.boss && typeof b.boss === 'object') {
          safe.boss = {
            name:    String(b.boss.name||'').substring(0,50),
            hp:      safeNum(b.boss.hp,    1,99999,500),
            attack:  safeNum(b.boss.attack,0,9999,20),
            defense: safeNum(b.boss.defense,0,9999,10),
            magic:   safeNum(b.boss.magic, 0,9999,10),
            speed:   safeNum(b.boss.speed, 0,9999,5),
            emoji:   typeof b.boss.emoji==='string'?b.boss.emoji.substring(0,4):'👿',
          };
          safe.boss.maxHp = safe.boss.hp;
        }
        return Object.keys(safe).length ? safe : null;
      }).filter(Boolean);
    }

    if (mode === 'duel') {
      // Duel only supports 2 combatants — guard against rooms with more players
      if (room.players.length !== 2) {
        socket.emit('error', { msg: 'Duel requires exactly 2 players.' });
        return;
      }
      const [p1, p2] = room.players;
      const makeCombatant = (p) => {
        const activeCard = p.deck?.[0] || {};
        return {
          id:              p.id,
          name:            p.username,
          authUname:       p.authUname || null,
          // Full deck stored so player can switch cards
          deck:            (p.deck||[]).map(c=>({
            name:     c.name,
            emoji:    c.emoji||'⚔️',
            hp:       c.hp,
            maxHp:    c.maxHp||c.hp,
            atk:      c.attack||10,
            def:      c.defense||5,
            mag:      c.magic||8,
            spd:      c.speed||8,
            ability:  c.ability||'Strike',
            title:    c.title||'',
            fainted:  c.fainted||false,
          })),
          activeIdx:       0,
          // Current active card stats (mirrored from deck[activeIdx])
          emoji:           activeCard.emoji  || '⚔️',
          cardName:        activeCard.name   || p.username,
          hp:              activeCard.hp     || 80,
          maxHp:           activeCard.maxHp  || activeCard.hp || 80,
          atk:             activeCard.attack  || 12,
          def:             activeCard.defense || 6,
          mag:             activeCard.magic   || 8,
          ability:         activeCard.ability || 'Strike',
          abilityCooldown: 0,
        };
      };
      room.battleState = {
        turn:         0,
        activePlayer: p1.id,
        combatants:   [makeCombatant(p1), makeCombatant(p2)],
        log:          [`⚔️ Duel begins! ${p1.username} vs ${p2.username}`],
        chatLog:      [],
        over:         false,
        winner:       null,
      };
    }

    io.to(room.code).emit('game:started', { mode, battleState: room.battleState });
    broadcastRoom(room);
    console.log(`[START] Room ${room.code} → ${mode}`);
  });

  // ── BATTLE ACTION ─────────────────────────────────────
  // Payload: { action: 'attack'|'ability'|'heal'|'flee' }
  socket.on('battle:action', (data = {}) => {
    const { action } = data;
    const room = getRoomOf(socket.id);
    if (!room?.battleState) { socket.emit('error', { msg: 'No active battle' }); return; }
    const bs = room.battleState;
    if (bs.over) return;
    if (bs.activePlayer !== socket.id) { socket.emit('error', { msg: 'Not your turn' }); return; }

    const isFirst = bs.combatants[0].id === socket.id;
    const [me, opp] = isFirst
      ? [bs.combatants[0], bs.combatants[1]]
      : [bs.combatants[1], bs.combatants[0]];

    let msg = '';

    // Handle card switch separately
    if(action === 'switch') {
      const { cardIdx } = data || {};
      if(cardIdx !== undefined && me.deck && me.deck[cardIdx] && !me.deck[cardIdx].fainted){
        const newCard = me.deck[cardIdx];
        me.activeIdx   = cardIdx;
        me.emoji       = newCard.emoji;
        me.cardName    = newCard.name;
        me.hp          = newCard.hp;
        me.maxHp       = newCard.maxHp;
        me.atk         = newCard.atk;
        me.def         = newCard.def;
        me.mag         = newCard.mag;
        me.ability     = newCard.ability;
        me.abilityCooldown = 0;
        const switchMsg = `🔄 ${me.name} switches to <b>${newCard.emoji} ${newCard.name}</b>!`;
        bs.log.push(switchMsg);
        bs.turn++;
        bs.activePlayer = opp.id;
        io.to(room.code).emit('battle:update', { battleState: bs, message: switchMsg });
      }
      return;
    }

    switch (action) {
      case 'attack': {
        const dmg = Math.max(1, me.atk + Math.floor(Math.random()*4) - Math.max(0, opp.def - 2));
        opp.hp = Math.max(0, opp.hp - dmg);
        msg = `⚔️ ${me.name} attacks ${opp.name} for <b>${dmg}</b>!`;
        break;
      }
      case 'ability': {
        if (me.abilityCooldown > 0) { socket.emit('error', { msg: 'Ability on cooldown' }); return; }
        const dmg = Math.floor(me.mag * 1.6 + Math.random()*6);
        opp.hp = Math.max(0, opp.hp - dmg);
        me.abilityCooldown = 2;
        msg = `✨ ${me.name} uses <b>${me.ability}</b> for <b>${dmg}</b> magic!`;
        break;
      }
      case 'heal': {
        const h = Math.floor(18 + Math.random()*14);
        me.hp = Math.min(me.maxHp, me.hp + h);
        msg = `🧪 ${me.name} heals <b>${h} HP</b>! (${me.hp}/${me.maxHp})`;
        break;
      }
      case 'flee': {
        msg = `🏃 ${me.name} fled the duel!`;
        bs.over   = true;
        bs.winner = null;
        break;
      }
    }

    // Tick ability cooldown each turn
    if (action !== 'ability' && me.abilityCooldown > 0) me.abilityCooldown--;

    bs.log.push(msg);
    bs.turn++;

    if (opp.hp <= 0) {
      bs.over   = true;
      bs.winner = me.id;
      bs.log.push(`🏆 <b>${me.name} wins the duel!</b>`);
    } else if (!bs.over) {
      bs.activePlayer = opp.id;
    }

    io.to(room.code).emit('battle:update', { battleState: bs, message: msg });
    if (bs.over) {
      io.to(room.code).emit('battle:over', {
        winner:     bs.winner,
        winnerName: bs.winner ? bs.combatants.find(c => c.id === bs.winner)?.name : null,
        log:        bs.log,
      });
      // Only a real knockout (not a flee) counts as a scored duel.
      if (bs.winner) {
        const winnerC = bs.combatants.find(c => c.id === bs.winner);
        const loserC  = bs.combatants.find(c => c.id !== bs.winner);
        recordDuelResult(winnerC, loserC).catch(e => console.error('[DUEL] record failed', e));
      }
    }
  });

  // ── AUTHORITATIVE DUEL RESULT ─────────────────────────
  // The server just decided the winner in battle:action above — this is
  // the ONLY place duelWins/duelLosses are ever incremented. It never
  // trusts anything the client claims about who won; it trusts bs.winner,
  // which this same server process computed from real HP values.
  async function recordDuelResult(winnerC, loserC) {
    // Guests (no verified account bound to their socket) can still play,
    // but there's no authoritative identity to record a win against.
    if (winnerC?.authUname) {
      const wUname = winnerC.authUname;
      let wAcc = await dbGetAccount(wUname) || accounts.get(wUname);
      if (wAcc) {
        const save = loadPlayerSave(wAcc);
        save.duelWins = safeNum(save.duelWins, 0, 999_999, 0) + 1;
        save.rankName = rankForWins(save.duelWins);
        await persistSave(wAcc, save, wUname);
        updateLeaderboardEntry(wUname, wAcc);

        // Route the win through the existing anti-cheat rate machinery,
        // driven by the server's own result instead of a client self-report.
        resetDailyWinsIfNeeded(wUname);
        const entry = dailyWins.get(wUname);
        entry.wins++;
        dailyWins.set(wUname, entry);
        const result = checkAntiCheat(wUname);
        const winnerSocket = io.sockets.sockets.get(winnerC.id);
        if (result === 'hold' && winnerSocket) {
          holds.set(wUname, Date.now() + HOLD_DURATION);
          const off = (offenses.get(wUname) || 0) + 1;
          offenses.set(wUname, off);
          if (off >= 2) {
            flagged.set(wUname, { level: 'banned', reason: 'Repeat offense' });
            holds.set(wUname, Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
            leaderboard.delete(wUname);
            wAcc.save = null;
            wAcc.banned = true;
            await dbSaveAccount({ ...wAcc, uname: wUname });
            accounts.set(wUname, wAcc);
            winnerSocket.emit('anticheat:banned', {
              dialogue: 'The God of Banishment, Veylor, is merciless now. Your account is permanently flagged. No victories will count.',
              veylor: { name: 'Veylor, the Eternal Judge', phase: 'permanent', emoji: '⚖️' },
            });
          } else {
            flagged.set(wUname, { level: 'hold', reason: `${entry.wins} wins in one day` });
            winnerSocket.emit('anticheat:veylor', {
              phase: 'hold',
              daysLeft: 8,
              dialogue: [
                'You have been found guilty of excessive victories.',
                'Veylor, the Eternal Judge, rises from the void.',
                'Your progress is reset. You are banished for 8 days.',
                'When you return... Veylor will be watching.'
              ],
              veylor: { name: 'Veylor, the Eternal Judge', emoji: '⚖️', hp: 9999, attack: 999, defense: 999, ability: 'Eternal Judgement', abilityDesc: 'Cannot be defeated. Judges all who abuse power.' },
            });
          }
        } else if (result === 'warn' && winnerSocket) {
          flagged.set(wUname, { level: 'warn', reason: `${entry.wins} wins/day` });
          winnerSocket.emit('anticheat:warning', { wins: entry.wins, dialogue: `Veylor watches you closely… ${entry.wins} victories today. The Eternal Judge grows suspicious.` });
        } else if (result === 'flag' && winnerSocket) {
          flagged.set(wUname, { level: 'flag', reason: `${entry.wins} wins/day` });
          winnerSocket.emit('anticheat:flag', { wins: entry.wins, dialogue: `Veylor notes your activity. ${entry.wins} wins today.` });
        }

        if (winnerSocket) {
          winnerSocket.emit('duel:result', { won: true, duelWins: save.duelWins, duelLosses: save.duelLosses || 0, rankName: save.rankName });
        }
      }
    }
    if (loserC?.authUname) {
      const lUname = loserC.authUname;
      let lAcc = await dbGetAccount(lUname) || accounts.get(lUname);
      if (lAcc) {
        const save = loadPlayerSave(lAcc);
        save.duelLosses = safeNum(save.duelLosses, 0, 999_999, 0) + 1;
        await persistSave(lAcc, save, lUname);
        const loserSocket = io.sockets.sockets.get(loserC.id);
        if (loserSocket) {
          loserSocket.emit('duel:result', { won: false, duelWins: save.duelWins || 0, duelLosses: save.duelLosses, rankName: save.rankName || rankForWins(save.duelWins || 0) });
        }
      }
    }
  }

  // ── STORY PROGRESS ────────────────────────────────────
  socket.on('story:progress', ({ blockResult } = {}) => {
    const room = getRoomOf(socket.id);
    if (!room || socket.id !== room.host) return;
    if (blockResult === 'complete') room.storyProgress++;
    io.to(room.code).emit('story:update', {
      progress:  room.storyProgress,
      total:     room.storyBlocks.length,
      completed: room.storyProgress >= room.storyBlocks.length,
    });
  });

  // ── PLAYER SYNC ───────────────────────────────────────
  // Payload: { hp, level, deckSize }
  // NOTE: gold is intentionally NOT accepted here — it's display-only in rooms
  // and must not be settable by clients directly.
  socket.on('player:sync', ({ hp, level, deckSize } = {}) => {
    const room = getRoomOf(socket.id);
    if (room) {
      const p = room.players.find(p => p.id === socket.id);
      if (p) {
        if (hp       !== undefined) p.hp       = safeNum(hp,       0, 99999, p.hp);
        if (level    !== undefined) p.level    = safeNum(level,    1, 999,   p.level);
        if (deckSize !== undefined) p.deckSize = safeNum(deckSize, 0, 3,     p.deckSize);
        broadcastRoom(room);
      }
    }
    const op = onlinePlayers.get(socket.id);
    if (op) {
      if (level    !== undefined) op.level    = safeNum(level,    1, 999, op.level);
      if (deckSize !== undefined) op.deckSize = safeNum(deckSize, 0, 3,   op.deckSize);
      broadcastLobby();
    }
  });

  // ── TRADE OFFER ───────────────────────────────────────
  // Payload: { toSocketId, card }
  socket.on('trade:offer', ({ toSocketId, card } = {}) => {
    if (!toSocketId || !card) { socket.emit('error', { msg: 'Invalid trade' }); return; }
    const from = onlinePlayers.get(socket.id);
    if (!from) { socket.emit('error', { msg: 'Not registered' }); return; }

    const tradeId = crypto.randomBytes(4).toString('hex');
    trades.set(tradeId, { id: tradeId, from: socket.id, to: toSocketId, card, offeredAt: Date.now() });

    io.to(toSocketId).emit('trade:incoming', {
      tradeId,
      from:   from.username,
      fromId: socket.id,
      card,
    });
    socket.emit('trade:sent', { tradeId });
    console.log(`[TRADE] ${from.username} → ${toSocketId}`);
  });

  // ── TRADE RESPONSE ────────────────────────────────────
  // Payload: { tradeId, accepted, counterCard? }
  socket.on('trade:respond', ({ tradeId, accepted, counterCard } = {}) => {
    const trade = trades.get(tradeId);
    if (!trade) { socket.emit('error', { msg: 'Trade expired' }); return; }

    // SECURITY: only the intended recipient may respond to a trade offer.
    if (socket.id !== trade.to) {
      socket.emit('error', { msg: 'Not your trade to respond to.' });
      return;
    }

    if (accepted && counterCard) {
      io.to(trade.from).emit('trade:complete', {
        tradeId,
        receivedCard: counterCard,
        fromUsername: onlinePlayers.get(socket.id)?.username || 'Opponent',
      });
      io.to(trade.to).emit('trade:complete', {
        tradeId,
        receivedCard: trade.card,
        fromUsername: onlinePlayers.get(trade.from)?.username || 'Opponent',
      });
      console.log(`[TRADE] ${tradeId} completed`);
    } else {
      io.to(trade.from).emit('trade:declined', { tradeId });
      console.log(`[TRADE] ${tradeId} declined`);
    }
    trades.delete(tradeId);
  });

  // ── CHAT ──────────────────────────────────────────────
  // Payload: { message, global? }
  socket.on('chat:send', ({ message, global: isGlobal } = {}) => {
    if (!message?.trim()) return;
    const player   = onlinePlayers.get(socket.id);
    const username = player?.username || 'Unknown';
    const payload  = { from: username, message: message.substring(0, 200).trim(), time: Date.now() };

    if (isGlobal) {
      io.emit('chat:message', payload);
    } else {
      const room = getRoomOf(socket.id);
      if (room) io.to(room.code).emit('chat:message', payload);
      else socket.emit('chat:message', payload);
    }
  });

  // ── LOBBY REQUEST (local WiFi discovery) ──────────────
  socket.on('lobby:request', () => {
    const list = [...onlinePlayers.values()].map(p => ({
      id:       p.id,
      username: p.username,
      level:    p.level,
      deckSize: p.deckSize,
      inRoom:   !!socketToRoom.get(p.id),
    }));
    socket.emit('lobby:players', list);
  });

  // ── DUEL CHAT ─────────────────────────────────────────
  socket.on('duel:chat', ({ message } = {}) => {
    const room = getRoomOf(socket.id);
    if(!room?.battleState) return;
    const player = onlinePlayers.get(socket.id);
    const from = player?.username || 'Unknown';
    const msg = message?.substring(0,200)?.trim();
    if(!msg) return;
    room.battleState.chatLog = room.battleState.chatLog || [];
    room.battleState.chatLog.push({ from, msg, time: Date.now() });
    io.to(room.code).emit('duel:chat', { from, message: msg, time: Date.now() });
  });

  // ── ACCOUNT: REGISTER ────────────────────────────────
  // Payload: { username, password }
  socket.on('account:register', async ({ username, password } = {}) => {
    // SECURITY: throttle registration spam per IP (account:register has no
    // password to brute-force, but nothing previously stopped a script from
    // mass-creating accounts as fast as the network allowed).
    const ip = socket.handshake.address || socket.id;
    if (!checkLoginIpRateLimit(ip)) { socket.emit('account:error', { msg: 'Too many attempts. Please wait a moment and try again.' }); return; }

    if (!username?.trim()) { socket.emit('account:error', { msg: 'Username required' }); return; }

    const pw = password ?? ''; // do NOT trim — preserve intentional spaces
    if (!pw || pw.length < 6) {
      socket.emit('account:error', { msg: 'Password must be at least 6 characters.' });
      return;
    }
    if (pw.length > 128) {
      socket.emit('account:error', { msg: 'Password too long.' });
      return;
    }

    let base  = username.trim().substring(0, 20);
    let uname = base.toLowerCase();

    // Only allow safe username characters
    if (!/^[a-zA-Z0-9_\- ]+$/.test(base)) {
      socket.emit('account:error', { msg: 'Username may only contain letters, numbers, spaces, _ and -' });
      return;
    }

    // Check if taken (MongoDB first, fallback to memory)
    const existsMem = accounts.has(uname);
    const existsDB  = existsMem ? null : await dbGetAccount(uname);

    // Bug 10 fix: server-side username character validation
    if (!/^[a-zA-Z0-9_\- ]+$/.test(base)) {
      socket.emit('account:error', { msg: 'Username may only contain letters, numbers, spaces, _ and -.' });
      return;
    }

    if (existsDB || existsMem) {
      // Suggest a free name rather than auto-creating silently
      let counter = 2;
      let suggestedBase = base;
      while ((await dbGetAccount((suggestedBase+counter).toLowerCase())) || accounts.has((suggestedBase+counter).toLowerCase())) counter++;
      socket.emit('account:nameTaken', { suggestedName: suggestedBase + counter });
      return;
    }

    const hashed = await hashPassword(pw);
    const data   = { username: base, uname, password: hashed, save: null, createdAt: Date.now(), lastLogin: Date.now() };

    const saved = await dbSaveAccount(data);
    if (saved === false && MONGO_URI) {
      // DB is configured but write failed — do not tell client account was created
      socket.emit('account:error', { msg: 'Account could not be saved. Please try again.' });
      return;
    }
    accounts.set(uname, data);

    // Registration logs the player in immediately client-side, so bind the
    // session here too — see the matching comment in account:login.
    socket.data.uname    = uname;
    socket.data.username = base;

    socket.emit('account:registered', { username: base, isNew: true });
    console.log(`[ACCOUNT] Registered: ${base}`);
  });

  // ── ACCOUNT: LOGIN ────────────────────────────────────
  socket.on('account:login', async ({ username, password } = {}) => {
    // SECURITY: two independent throttles. The per-IP one stops a script
    // from spraying many different usernames from one connection; the
    // per-username lockout (below, after uname is known) stops repeated
    // guesses against one specific account regardless of how many IPs the
    // attempt come from.
    const ip = socket.handshake.address || socket.id;
    if (!checkLoginIpRateLimit(ip)) { socket.emit('account:error', { msg: 'Too many attempts. Please wait a moment and try again.' }); return; }

    if (!username?.trim()) { socket.emit('account:error', { msg: 'Username required' }); return; }
    const uname = username.trim().toLowerCase();
    const pw    = password ?? ''; // do NOT trim — client doesn't trim, must match

    // SECURITY: checked before touching the DB, and before the dummy-hash
    // timing guard below, so a locked-out account and an account mid-guess
    // both just see "too many attempts" — nothing here reveals whether the
    // account actually exists.
    const lockedMs = getLoginLockoutRemaining(uname);
    if (lockedMs > 0) {
      socket.emit('account:error', { msg: `Too many failed attempts. Try again in ${Math.ceil(lockedMs / 1000)}s.` });
      return;
    }

    // Check memory cache first — avoids DB round trip for active players
    let acc = accounts.get(uname) || await dbGetAccount(uname);

    // SECURITY: use identical error message whether account missing or password wrong
    // to prevent username enumeration
    const INVALID_MSG = 'Invalid username or password.';

    if (!acc) {
      // Use pre-computed dummy hash so unknown-username rejections take ~same time as wrong-password
      await bcrypt.compare('dummy_timing_guard', _dummyHash);
      recordLoginFailure(uname);
      socket.emit('account:error', { msg: INVALID_MSG });
      return;
    }

    // Check ban before anything else
    const f = flagged.get(uname);
    if (f && f.level === 'banned') {
      socket.emit('account:error', { msg: 'This account has been suspended.' });
      return;
    }

    const ok = pw ? await verifyPassword(pw, acc.password) : false;
    if (!ok) {
      recordLoginFailure(uname);
      socket.emit('account:error', { msg: INVALID_MSG });
      return;
    }
    recordLoginSuccess(uname);

    // Update last login — fire-and-forget so it never delays the login response
    acc.lastLogin = Date.now();
    accounts.set(uname, acc);
    dbSaveAccount({ ...acc, uname }).catch(e => console.warn('[AUTH] lastLogin save failed:', e.message));

    // SECURITY: bind this socket to the verified account identity.
    // Everything downstream (rooms, duels, wins) should trust socket.data,
    // never the username string the client happens to send in a payload.
    socket.data.uname    = uname;
    socket.data.username = acc.username;

    const loginSave = loadPlayerSave(acc);
    socket.emit('account:loggedin', { username: acc.username, save: acc.save, isNew: false });
    socket.emit('player:state', buildClientState(loginSave));
    console.log(`[ACCOUNT] Login: ${username}`);
  });

  // ── ACCOUNT: SAVE GAME (DECK/UI STATE ONLY) ──────────
  // The client may only save non-progression UI state:
  // active card index, deck card HP (battle state), fainted flags.
  // Gold, XP, level, inventory, shopOwned are ALL server-controlled.
  socket.on('account:save', async ({ save } = {}) => {
    const session = await requireSession(socket);
    if (!session) return;
    const { uname, acc } = session;

    const f = flagged.get(uname);
    if (f && f.level === 'banned') {
      socket.emit('account:save:blocked', { reason: 'banned' });
      return;
    }
    if (isOnHold(uname)) {
      socket.emit('account:save:blocked', { reason: 'suspended' });
      return;
    }

    // Load authoritative save — only allow client to update non-progression fields
    const authoritative = loadPlayerSave(acc);

    // Parse client save safely
    let client = {};
    try { client = typeof save === 'string' ? JSON.parse(save) : (save || {}); } catch(e) {}

    // ALLOWED: deck battle state (HP/fainted per card) and activeCardIdx
    // NOT ALLOWED: gold, xp, level, inventory, shopOwned (those come from server actions)
    if (Array.isArray(client.deck) && Array.isArray(authoritative.deck)) {
      // Only update per-card HP and fainted — never stats
      authoritative.deck = authoritative.deck.map((serverCard, i) => {
        const clientCard = client.deck[i];
        if (!clientCard || typeof clientCard !== 'object') return serverCard;
        return {
          ...serverCard,
          hp:     safeNum(clientCard.hp,     0, serverCard.maxHp || 9999, serverCard.hp),
          fainted: !!clientCard.fainted,
        };
      });
    }
    if (client.activeCardIdx !== undefined) {
      authoritative.activeCardIdx = safeNum(client.activeCardIdx, 0, 2, 0);
    }
    // Allow unlockedSkills (cosmetic/progression tracked client-side, low value)
    if (Array.isArray(client.unlockedSkills)) {
      authoritative.unlockedSkills = client.unlockedSkills
        .filter(s => typeof s === 'string' && s.length <= 40)
        .slice(0, 50);
    }

    await persistSave(acc, authoritative, uname);
    socket.emit('account:saved', { ok: true });
  });

  // ── ACTION: SHOP PURCHASE ─────────────────────────────
  // Client requests to buy an item. Server verifies gold, deducts, gives item.
  socket.on('player:shopBuy', async ({ itemId } = {}) => {
    if (!itemId) return;
    const session = await requireSession(socket);
    if (!session) return;
    const { uname, acc } = session;
    if (!checkActionRateLimit(uname)) return;

    const f = flagged.get(uname);
    if (f && f.level === 'banned') return;
    if (isOnHold(uname)) return;

    const shopItem = SERVER_SHOP[itemId];
    if (!shopItem) {
      console.log(`[SECURITY] ${uname} tried to buy unknown item: ${itemId}`);
      socket.emit('player:actionError', { msg: 'Unknown item.' });
      return;
    }

    const save = loadPlayerSave(acc);

    // Check if already owned (for permanent upgrades)
    const isPermanent = !CONSUMABLE_ITEM_TYPES.has(shopItem.effect.type);
    if (isPermanent && save.shopOwned?.[itemId]) {
      socket.emit('player:actionError', { msg: 'Already owned.' });
      return;
    }

    // Check gold
    if ((save.playerGold || 0) < shopItem.cost) {
      socket.emit('player:actionError', { msg: 'Not enough Gold.' });
      return;
    }

    // Deduct gold
    const removed = removeGold(save, shopItem.cost, `shop:${itemId}`);
    if (!removed) { socket.emit('player:actionError', { msg: 'Not enough Gold.' }); return; }

    // Grant item or apply permanent upgrade
    const e = shopItem.effect;
    if (CONSUMABLE_ITEM_TYPES.has(e.type)) {
      // Consumable — goes into inventory
      giveItem(save, shopItem.name, 1, `shop:${itemId}`);
    } else {
      // Permanent upgrade — mark as owned; client applies buff to deck
      if (!save.shopOwned) save.shopOwned = {};
      save.shopOwned[itemId] = true;
      // Apply stat buffs to server deck too
      if (e.type === 'statAll' && save.deck) {
        save.deck.forEach(c => { c[e.stat] = safeNum((c[e.stat]||0)+e.val,0,9999,0); if(e.stat==='maxHp') c.hp=Math.min((c.hp||0)+e.val,c.maxHp); });
      } else if ((e.type === 'statAll2' || e.type === 'statAll3') && save.deck) {
        save.deck.forEach(c => { e.stats.forEach((s,i) => { c[s]=safeNum((c[s]||0)+e.vals[i],0,9999,0); if(s==='maxHp')c.hp=Math.min((c.hp||0)+e.vals[i],c.maxHp); }); });
      } else if (e.type === 'allStats' && save.deck) {
        save.deck.forEach(c => { ['attack','defense','magic','speed'].forEach(s=>c[s]=safeNum((c[s]||0)+e.val,0,9999,0)); c.maxHp=safeNum((c.maxHp||100)+e.val*2,1,9999,100); c.hp=c.maxHp; });
      } else if ((e.type === 'statOne' || e.type === 'statOne2') && save.deck?.[save.activeCardIdx||0]) {
        const card = save.deck[save.activeCardIdx||0];
        if (e.type==='statOne') { card[e.stat]=safeNum((card[e.stat]||0)+e.val,0,9999,0); }
        else { e.stats.forEach((s,i)=>card[s]=safeNum((card[s]||0)+e.vals[i],0,9999,0)); }
      } else if (e.type === 'fullRestorePlus' && save.deck) {
        save.deck.forEach(c => { c.maxHp=safeNum((c.maxHp||100)+e.val,1,9999,100); c.hp=c.maxHp; c.fainted=false; });
      }
    }

    await persistSave(acc, save, uname);
    socket.emit('player:state', buildClientState(save));
    console.log(`[SHOP] ${uname} bought ${itemId} for ${shopItem.cost}g`);
  });

  // ── ACTION: SELL ITEM ─────────────────────────────────
  socket.on('player:sellItem', async ({ itemName, qty } = {}) => {
    if (!itemName) return;
    const session = await requireSession(socket);
    if (!session) return;
    const { uname, acc } = session;
    if (!checkActionRateLimit(uname)) return;

    const save = loadPlayerSave(acc);
    const sellQty = safeNum(qty, 1, 999, 1);

    // Validate item exists in inventory
    const invItem = save.inventory?.find(i => i.item === itemName);
    if (!invItem) { socket.emit('player:actionError', { msg: 'Item not in inventory.' }); return; }

    // Calculate sell price server-side
    const BASE_SELL = { Common:5, Rare:20, Epic:70, Mythic:300 };
    const sellPrice = BASE_SELL[invItem.rarity || 'Common'] || 5;
    const totalGold = sellPrice * sellQty;

    const removed = removeItem(save, itemName, sellQty);
    if (!removed) { socket.emit('player:actionError', { msg: 'Not enough items.' }); return; }

    addGold(save, totalGold, `sell:${itemName}`);
    await persistSave(acc, save, uname);
    socket.emit('player:state', buildClientState(save));
    console.log(`[SELL] ${uname} sold ${sellQty}× ${itemName} for ${totalGold}g`);
  });

  // ── ACTION: BATTLE REWARD ─────────────────────────────
  // Client reports battle outcome. Server calculates the reward.
  // The client CANNOT choose the reward amount.
  socket.on('player:battleReward', async ({ monsterLevel, isBoss, deckState } = {}) => {
    const session = await requireSession(socket);
    if (!session) return;
    const { uname, acc } = session;
    if (!checkActionRateLimit(uname)) return;

    const f = flagged.get(uname);
    if (f && f.level === 'banned') return;
    if (isOnHold(uname)) return;

    const save = loadPlayerSave(acc);
    const playerLv = save.playerLevel || 1;
    const monLv    = safeNum(monsterLevel, 1, 200, playerLv);

    // Server calculates reward based on player level and monster level
    const lvScale  = Math.max(0.2, Math.min(3.0, (monLv + 2) / Math.max(1, playerLv)));
    const gold     = Math.floor((3 + Math.random() * 8) * (1 + playerLv * 0.12) * lvScale);
    const xp       = Math.floor((10 + Math.random() * 20) * (1 + playerLv * 0.08) * lvScale);
    const bossBonus = isBoss ? 4 : 1;

    addGold(save, gold * bossBonus, 'battle');
    addXP(save, xp * bossBonus, 'battle');

    // Random drop (server decides)
    let drop = null;
    const dropChance = isBoss ? 0.8 : 0.15;
    if (Math.random() < dropChance) {
      const commonDrops = ['Health Potion','Rusty Dagger','Bat Wing','Rat Tail','Charcoal','Fire Shard','Leather Gloves','Bee Stinger','Spider Silk','Toxic Gland'];
      drop = commonDrops[Math.floor(Math.random() * commonDrops.length)];
      giveItem(save, drop, 1, 'battle-drop');
    }

    // Update deck state from client (HP changes only)
    if (Array.isArray(deckState) && Array.isArray(save.deck)) {
      save.deck = save.deck.map((serverCard, i) => {
        const clientCard = deckState[i];
        if (!clientCard) return serverCard;
        return { ...serverCard, hp: safeNum(clientCard.hp, 0, serverCard.maxHp || 9999, serverCard.hp), fainted: !!clientCard.fainted };
      });
    }

    await persistSave(acc, save, uname);
    socket.emit('player:state', buildClientState(save));
    socket.emit('player:battleRewardResult', { gold: gold * bossBonus, xp: xp * bossBonus, drop });
    console.log(`[BATTLE] ${uname} earned ${gold * bossBonus}g + ${xp * bossBonus}xp (boss:${!!isBoss})`);
    if (socket._recordGuildKill) socket._recordGuildKill(uname, !!isBoss).catch(()=>{});
  });

  // ── ACTION: QUEST REWARD CLAIM ────────────────────────
  // Client reports quest completed. Server validates and awards reward.
  socket.on('player:claimQuest', async ({ questId, questDay } = {}) => {
    if (!questId) return;
    const session = await requireSession(socket);
    if (!session) return;
    const { uname, acc } = session;
    if (!checkActionRateLimit(uname)) return;

    const questTemplate = SERVER_QUEST_CATALOG[questId];
    if (!questTemplate) {
      console.log(`[SECURITY] ${uname} tried to claim unknown quest: ${questId}`);
      return;
    }

    const save = loadPlayerSave(acc);
    if (!save.questClaims) save.questClaims = {};

    // SECURITY: always use server-side date — never trust client-supplied questDay
    const today = new Date().toISOString().split('T')[0];
    const claimKey = `${questId}_${today}`;
    if (save.questClaims[claimKey]) {
      console.log(`[SECURITY] ${uname} tried to double-claim quest ${questId} on ${today}`);
      socket.emit('player:actionError', { msg: 'Quest already claimed today.' });
      return;
    }

    // Award server-determined reward (from catalog, not from client)
    const r = questTemplate.reward;
    addGold(save, r.gold, `quest:${questId}`);
    addXP(save, r.xp, `quest:${questId}`);
    if (r.item) giveItem(save, r.item, 1, `quest:${questId}`);

    // Mark as claimed
    save.questClaims[claimKey] = Date.now();

    await persistSave(acc, save, uname);
    socket.emit('player:state', buildClientState(save));
    socket.emit('player:questClaimed', { questId, reward: r });
    console.log(`[QUEST] ${uname} claimed ${questId}: +${r.gold}g +${r.xp}xp`);
  });

  // ── ACTION: SET DECK (first pick / reroll) ────────────
  // Client submits new deck (only on fresh game start / reroll).
  // Server sanitizes stats to prevent inflated cards.
  socket.on('player:setDeck', async ({ deck } = {}) => {
    if (!Array.isArray(deck)) return;
    const session = await requireSession(socket);
    if (!session) return;
    const { uname, acc } = session;
    if (!checkActionRateLimit(uname)) return;

    const save = loadPlayerSave(acc);
    const cleanDeck = sanitizeDeck(deck);
    if (cleanDeck.length === 0) { socket.emit('player:actionError', { msg: 'Invalid deck.' }); return; }

    save.deck = cleanDeck;
    save.activeCardIdx = 0;

    await persistSave(acc, save, uname);
    socket.emit('player:state', buildClientState(save));
    console.log(`[DECK] ${uname} set deck (${cleanDeck.map(c=>c.name).join(', ')})`);
  });

  // ── ACTION: UPGRADE PARTY (gold cost, server-side) ───
  socket.on('player:upgradeParty', async ({ cost } = {}) => {
    const session = await requireSession(socket);
    if (!session) return;
    const { uname, acc } = session;
    if (!checkActionRateLimit(uname)) return;

    const save = loadPlayerSave(acc);
    const expectedCost = Math.floor(50 * Math.pow(1.3, (save.playerLevel || 1) - 1));
    const clientCost   = safeNum(cost, 0, 999_999, 0);

    // Verify cost matches server calculation (within 5 gold tolerance)
    if (Math.abs(clientCost - expectedCost) > 5) {
      console.log(`[SECURITY] ${uname} upgrade cost mismatch: claimed ${clientCost}, expected ${expectedCost}`);
      socket.emit('player:actionError', { msg: 'Invalid upgrade cost.' });
      return;
    }

    if ((save.playerGold || 0) < expectedCost) {
      socket.emit('player:actionError', { msg: 'Not enough Gold.' });
      return;
    }

    removeGold(save, expectedCost, 'party-upgrade');
    save.playerLevel = safeNum((save.playerLevel || 1) + 1, 1, 999, 1);
    console.log(`[UPGRADE] ${uname} upgraded party to level ${save.playerLevel} for ${expectedCost}g`);

    await persistSave(acc, save, uname);
    socket.emit('player:state', buildClientState(save));
  });

  // ── ACTION: DUNGEON REWARD ────────────────────────────
  socket.on('player:dungeonReward', async ({ floors, deckState } = {}) => {
    const session = await requireSession(socket);
    if (!session) return;
    const { uname, acc } = session;
    if (!checkActionRateLimit(uname)) return;

    const save = loadPlayerSave(acc);
    const playerLv = save.playerLevel || 1;
    const floorCount = safeNum(floors, 1, 100, 1);

    // Server-calculated dungeon reward
    const gold = Math.floor((15 + playerLv * 4 + floorCount * 8) * (0.8 + Math.random() * 0.4));
    const xp   = Math.floor(gold * 1.5);

    addGold(save, gold, `dungeon:${floorCount}floors`);
    addXP(save, xp, `dungeon:${floorCount}floors`);

    // Bonus item for 10+ floors
    let bonusItem = null;
    if (floorCount >= 10 && Math.random() < 0.5) {
      bonusItem = floorCount >= 20 ? 'Elixir' : 'Health Potion';
      giveItem(save, bonusItem, 1, 'dungeon-bonus');
    }

    if (Array.isArray(deckState) && Array.isArray(save.deck)) {
      save.deck = save.deck.map((sc, i) => {
        const cc = deckState[i];
        if (!cc) return sc;
        return { ...sc, hp: safeNum(cc.hp, 0, sc.maxHp || 9999, sc.hp), fainted: !!cc.fainted };
      });
    }

    await persistSave(acc, save, uname);
    socket.emit('player:state', buildClientState(save));
    socket.emit('player:dungeonRewardResult', { gold, xp, bonusItem });
    console.log(`[DUNGEON] ${uname} cleared ${floorCount} floors: +${gold}g +${xp}xp`);
  });

  // ── ACCOUNT: CHANGE PASSWORD ──────────────────────────
  socket.on('account:changepass', async ({ username, oldPassword, newPassword } = {}) => {
    if (!username?.trim()) { socket.emit('account:error', { msg: 'Not logged in' }); return; }
    const uname = username.trim().toLowerCase();
    const lockedMs = getLoginLockoutRemaining(uname);
    if (lockedMs > 0) { socket.emit('account:error', { msg: `Too many failed attempts. Try again in ${Math.ceil(lockedMs / 1000)}s.` }); return; }
    let acc = accounts.get(uname) || await dbGetAccount(uname);
    if (!acc) { socket.emit('account:error', { msg: 'Account not found' }); return; }
    const oldPw = oldPassword ?? ''; // do NOT trim
    if (!oldPw || !(await verifyPassword(oldPw, acc.password))) { recordLoginFailure(uname); socket.emit('account:error', { msg: 'Current password is wrong!' }); return; }
    recordLoginSuccess(uname);
    const newPw = newPassword?.trim();
    if (!newPw || newPw.length < 3) { socket.emit('account:error', { msg: 'New password must be at least 3 characters' }); return; }
    acc.password = await hashPassword(newPw);
    await dbSaveAccount({ ...acc, uname });
    accounts.set(uname, acc);
    socket.emit('account:passchanged', { ok: true });
    console.log(`[ACCOUNT] Password changed: ${username}`);
  });

  // ── ACCOUNT: DELETE ───────────────────────────────────
  socket.on('account:delete', async ({ username, password } = {}) => {
    if (!username?.trim()) { socket.emit('account:error', { msg: 'Not logged in' }); return; }
    const uname = username.trim().toLowerCase();
    const lockedMs = getLoginLockoutRemaining(uname);
    if (lockedMs > 0) { socket.emit('account:error', { msg: `Too many failed attempts. Try again in ${Math.ceil(lockedMs / 1000)}s.` }); return; }
    let acc = accounts.get(uname) || await dbGetAccount(uname);
    if (!acc) { socket.emit('account:error', { msg: 'Account not found' }); return; }
    const pw = password ?? ''; // do NOT trim
    if (!pw || !(await verifyPassword(pw, acc.password))) { recordLoginFailure(uname); socket.emit('account:error', { msg: 'Wrong password! Cannot delete account.' }); return; }
    recordLoginSuccess(uname);
    await dbDeleteAccount(uname);
    accounts.delete(uname);
    socket.emit('account:deleted', { ok: true });
    console.log(`[ACCOUNT] Deleted: ${username}`);
  });

  // ── LEADERBOARD ───────────────────────────────────
  // SECURITY: Client sends username only. Wins are read from the authoritative server save.
  socket.on('leaderboard:update', async ({ name } = {}) => {
    if (!name?.trim()) return;
    const uname = name.trim().toLowerCase();
    const f = flagged.get(uname);

    if (f && f.level === 'banned') {
      leaderboard.delete(uname);
      console.log(`[LB] ${name} removed — permanently banned`);
      return;
    }

    try {
      const acc = await dbGetAccount(uname) || accounts.get(uname);
      if (!acc) return;
      updateLeaderboardEntry(uname, acc);
      console.log(`[LB] ${uname}: ${leaderboard.get(uname)?.wins ?? 0} wins (server-authoritative)`);
    } catch(e) { /* non-fatal */ }
  });

  socket.on('leaderboard:request', () => {
    const data = [...leaderboard.values()]
      .sort((a,b) => b.wins - a.wins)
      .slice(0, 100);
    socket.emit('leaderboard:data', data);
  });

  // ── ANTI-CHEAT: WIN REPORT ────────────────────────
  // Called by client after every duel win
  socket.on('anticheat:win', async ({ username } = {}) => {
    if (!username?.trim()) return;
    const uname = username.trim().toLowerCase();

    // Check if on hold first
    if (isOnHold(uname)) {
      const msLeft = getHoldTimeLeft(uname);
      const daysLeft = Math.ceil(msLeft / (24*60*60*1000));
      socket.emit('anticheat:hold', {
        daysLeft,
        dialogue: `Veylor's judgement stands. You remain banished for ${daysLeft} more day${daysLeft!==1?'s':''}. No victories count while under hold.`,
      });
      return;
    }

    resetDailyWinsIfNeeded(uname);
    const entry = dailyWins.get(uname);
    entry.wins++;
    dailyWins.set(uname, entry);

    const result = checkAntiCheat(uname);

    if (result === 'hold') {
      // Issue hold — stats reset handled client side
      holds.set(uname, Date.now() + HOLD_DURATION);
      const off = (offenses.get(uname)||0) + 1;
      offenses.set(uname, off);
      flagged.set(uname, { level: 'hold', reason: `${entry.wins} wins in one day` });

      if (off >= 2) {
        // Repeat offense — permanent ban flag
        flagged.set(uname, { level: 'banned', reason: 'Repeat offense' });
        holds.set(uname, Date.now() + 100*365*24*60*60*1000); // effectively permanent
        // Remove from leaderboard immediately
        leaderboard.delete(uname);
        // Wipe their cloud save
        const accToBan = accounts.get(uname) || await dbGetAccount(uname);
        if (accToBan) {
          accToBan.save = null; // invalidate save
          accToBan.banned = true;
          await dbSaveAccount({ ...accToBan, uname });
          accounts.set(uname, accToBan);
        }
        socket.emit('anticheat:banned', {
          dialogue: 'The God of Banishment, Veylor, is merciless now. Your account is permanently flagged. No victories will count.',
          veylor: {
            name: 'Veylor, the Eternal Judge',
            phase: 'permanent',
            emoji: '⚖️',
          }
        });
        console.log(`[ANTICHEAT] PERMANENT BAN: ${username} (repeat offense)`);
      } else {
        socket.emit('anticheat:veylor', {
          phase: 'hold',
          daysLeft: 8,
          dialogue: [
            'You have been found guilty of excessive victories.',
            'Veylor, the Eternal Judge, rises from the void.',
            'Your progress is reset. You are banished for 8 days.',
            'When you return... Veylor will be watching.'
          ],
          veylor: {
            name: 'Veylor, the Eternal Judge',
            emoji: '⚖️',
            hp: 9999,
            attack: 999,
            defense: 999,
            ability: 'Eternal Judgement',
            abilityDesc: 'Cannot be defeated. Judges all who abuse power.',
          }
        });
        console.log(`[ANTICHEAT] HOLD: ${username} — ${entry.wins} wins today`);
      }
    } else if (result === 'warn') {
      flagged.set(uname, { level: 'warn', reason: `${entry.wins} wins/day` });
      socket.emit('anticheat:warning', {
        wins: entry.wins,
        dialogue: `Veylor watches you closely… ${entry.wins} victories today. The Eternal Judge grows suspicious.`,
      });
      console.log(`[ANTICHEAT] WARNING: ${username} — ${entry.wins} wins today`);
    } else if (result === 'flag') {
      flagged.set(uname, { level: 'flag', reason: `${entry.wins} wins/day` });
      socket.emit('anticheat:flag', {
        wins: entry.wins,
        dialogue: `Veylor notes your activity. ${entry.wins} wins today.`,
      });
    }
  });

  // ── ANTI-CHEAT: STATUS CHECK ──────────────────────
  // ── PROFILE IMPORT VALIDATION ────────────────────
  // Client sends username to check before loading a JSON profile
  socket.on('profile:validate', ({ username } = {}) => {
    if (!username?.trim()) { socket.emit('profile:invalid', { reason: 'No username' }); return; }
    const uname = username.trim().toLowerCase();
    const f = flagged.get(uname);

    if (f && f.level === 'banned') {
      // Remove from leaderboard too
      leaderboard.delete(uname);
      socket.emit('profile:invalid', {
        reason: 'banned',
        message: 'This profile belongs to a banned account. Veylor has invalidated it.'
      });
      console.log(`[PROFILE BLOCKED] ${username} — banned account tried to import save`);
      return;
    }

    if (isOnHold(uname)) {
      const daysLeft = Math.ceil(getHoldTimeLeft(uname) / (24*60*60*1000));
      socket.emit('profile:invalid', {
        reason: 'suspended',
        daysLeft,
        message: `This account is suspended for ${daysLeft} more day${daysLeft!==1?'s':''}. Profile cannot be loaded.`
      });
      console.log(`[PROFILE BLOCKED] ${username} — suspended account tried to import save`);
      return;
    }

    socket.emit('profile:valid', { username: username.trim() });
  });

  socket.on('anticheat:check', ({ username } = {}) => {
    if (!username?.trim()) return;
    const uname = username.trim().toLowerCase();
    const onHold = isOnHold(uname);
    const daysLeft = onHold ? Math.ceil(getHoldTimeLeft(uname)/(24*60*60*1000)) : 0;
    const f = flagged.get(uname);
    socket.emit('anticheat:status', {
      onHold,
      daysLeft,
      flagLevel: f?.level || null,
      flagReason: f?.reason || null,
    });
  });

  // ── CO-OP RAIDS ───────────────────────────────────
  // Authoritative raid boss catalog — HP tracked server-side
  const RAID_BOSS_CATALOG = {
    raid_colossus:  { name:'The Iron Colossus',  hp:2000, emoji:'\u{1F5FF}' },
    raid_leviathan: { name:'Sea Leviathan',       hp:3000, emoji:'\u{1F30A}' },
    raid_inferno:   { name:'Inferno Warlord',     hp:4000, emoji:'\u{1F525}' },
    raid_void_king: { name:'The Void King',       hp:6000, emoji:'\u{1F451}' },
    raid_eternal:   { name:'Eternal Destroyer',   hp:9999, emoji:'\u{1F4A0}' },
  };

  // Helper: notify both raid participants
  function emitToRaid(raid, event, data) {
    const h = io.sockets.sockets.get(raid.hostSocket);
    const g = io.sockets.sockets.get(raid.guestSocket);
    if (h) h.emit(event, data);
    if (g) g.emit(event, data);
  }

  // SECURITY: build a raid combat profile from the player's own DB save —
  // never from anything sent in the raid:host/raid:join payload itself.
  // Unauthenticated sockets (no session — see account:login) get the
  // conservative default profile instead of an attacker-chosen one.
  async function buildRaidParticipant(raid, sock) {
    const uname = sock.data.uname || null;
    let atk = DEFAULT_RAID_PARTICIPANT.atk;
    if (uname) {
      try {
        const acc = await dbGetAccount(uname) || accounts.get(uname);
        const save = acc ? loadPlayerSave(acc) : {};
        const idx = safeNum(save.activeCardIdx, 0, 2, 0);
        const card = (save.deck && save.deck[idx]) || (save.deck && save.deck[0]) || {};
        atk = safeNum(card.attack, 1, 500, DEFAULT_RAID_PARTICIPANT.atk);
      } catch (e) { /* fall back to default profile */ }
    }
    raid.participants = raid.participants || {};
    raid.participants[sock.id] = { uname, atk };
  }

  socket.on('raid:host', async ({ bossId } = {}) => {
    // SECURITY: validate bossId against server-authoritative catalog — client never picks the code
    const bossData = RAID_BOSS_CATALOG[bossId];
    if (!bossData) { socket.emit('raid:error', { msg: 'Invalid boss selection.' }); return; }

    const player = onlinePlayers.get(socket.id);
    const hostName = player?.username || 'Unknown';

    // Server generates the raid code — client no longer uses Math.random()
    let code;
    do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); }
    while (rooms.has('raid_' + code));

    rooms.set('raid_' + code, {
      code,
      bossId,
      bossName:   bossData.name,
      bossMaxHp:  bossData.hp,
      bossHp:     bossData.hp,   // authoritative server-side HP
      hostName,
      guest:      null,
      hostSocket: socket.id,
      guestSocket: null,
      created:    Date.now(),
      // SECURITY: per-participant attack power and cooldown, populated from
      // the player's own DB-authoritative deck — never from anything the
      // client sends in the raid itself. See buildRaidParticipant().
      participants: {},
    });

    await buildRaidParticipant(rooms.get('raid_' + code), socket);

    // Return the server-generated code so the host can display and share it
    socket.emit('raid:hosted', { code, bossId, bossName: bossData.name, bossHp: bossData.hp });
    console.log('[RAID] ' + hostName + ' hosted raid ' + code + ' — boss: ' + bossData.name + ' (' + bossData.hp + ' HP)');
  });

  socket.on('raid:join', async ({ code } = {}) => {
    const raid = rooms.get('raid_' + code);
    if (!raid) { socket.emit('raid:error', { msg: 'Raid room not found!' }); return; }
    if (raid.guest) { socket.emit('raid:error', { msg: 'Raid room is full!' }); return; }

    const player = onlinePlayers.get(socket.id);
    const playerName = player?.username || 'Unknown';
    raid.guest = playerName;
    raid.guestSocket = socket.id;
    rooms.set('raid_' + code, raid);
    await buildRaidParticipant(raid, socket);

    const hostSock = io.sockets.sockets.get(raid.hostSocket);
    if (hostSock) hostSock.emit('raid:partner_joined', { partnerName: playerName });
    // Send current (authoritative) boss HP so both players start in sync
    socket.emit('raid:joined', {
      bossId:   raid.bossId,
      bossName: raid.bossName,
      bossHp:   raid.bossHp,
      bossMaxHp: raid.bossMaxHp,
      hostName: raid.hostName,
    });
    console.log('[RAID] ' + playerName + ' joined ' + raid.hostName + "'s raid");
  });

  socket.on('raid:attack', async ({ code, damage } = {}) => {
    const raid = rooms.get('raid_' + code);
    if (!raid) return;

    // SECURITY: verify sender is actually a participant
    if (socket.id !== raid.hostSocket && socket.id !== raid.guestSocket) {
      socket.emit('raid:error', { msg: 'Not a participant in this raid.' });
      return;
    }

    // SECURITY: per-player attack cooldown — blocks scripted/automated spam
    // regardless of what damage number is attached.
    const now = Date.now();
    raid.lastAttack = raid.lastAttack || {};
    const last = raid.lastAttack[socket.id] || 0;
    if (now - last < RAID_ATTACK_COOLDOWN_MS) return;
    raid.lastAttack[socket.id] = now;

    const player = onlinePlayers.get(socket.id);
    const playerName = player?.username || 'Unknown';

    // SECURITY: clamp the claimed damage to what this player's real,
    // DB-loaded attack stat could plausibly produce (attack combined with
    // combos/elemental bonuses/crits on the client), rather than trusting
    // the raw client number up to an arbitrary flat ceiling. A participant
    // we don't have a profile for (e.g. reconnect race) gets the
    // conservative default profile, never an unclamped value.
    const participant = raid.participants?.[socket.id] || DEFAULT_RAID_PARTICIPANT;
    const maxHit = Math.round(participant.atk * 6 + 40);
    const safeDamage = safeNum(damage, 0, maxHit, 0);
    raid.bossHp = Math.max(0, raid.bossHp - safeDamage);

    // Broadcast authoritative HP to both players (not just the partner)
    emitToRaid(raid, 'raid:boss_update', {
      bossHp:      raid.bossHp,
      bossMaxHp:   raid.bossMaxHp,
      damage:      safeDamage,
      attackerName: playerName,
    });

    // Check for raid completion
    if (raid.bossHp <= 0) {
      emitToRaid(raid, 'raid:ended', { won: true, bossName: raid.bossName });
      rooms.delete('raid_' + code);
      console.log('[RAID] ' + code + ' completed — boss defeated');
    }
  });

  socket.on('raid:cancel', ({ code } = {}) => {
    const raid = rooms.get('raid_' + code);
    if (!raid) return;
    // SECURITY: only the host may cancel
    if (socket.id !== raid.hostSocket) {
      socket.emit('raid:error', { msg: 'Only the raid host can cancel.' });
      return;
    }
    emitToRaid(raid, 'raid:cancelled', { msg: 'The host cancelled the raid.' });
    rooms.delete('raid_' + code);
    console.log('[RAID] ' + raid.hostName + ' cancelled raid ' + code);
  });

  // ════════════════════════════════════════════════════
  //  GUILD SYSTEM — fully server-authoritative
  // ════════════════════════════════════════════════════

  const ALLOWED_EMBLEMS = ['🛡️','⚔️','🔥','❄️','⚡','🌑','👑','🐉'];
  const GUILD_NAME_RE   = /^[a-zA-Z0-9 '_\-]{2,20}$/;
  const GUILD_TAG_RE    = /^[A-Z0-9]{2,5}$/;

  // helper: get authenticated player identity from the socket's real login
  // session (see account:login/register, which set socket.data.uname) —
  // NOT from onlinePlayers/player:register, which is just unauthenticated
  // lobby presence and accepts any display name with no password at all.
  // Keying guild identity off that would let anyone impersonate any account
  // for guild purposes just by registering the same display name.
  function authName(sid) {
    const s = io.sockets.sockets.get(sid);
    return s?.data?.username || null;
  }
  function authUname(sid) {
    const s = io.sockets.sockets.get(sid);
    return s?.data?.uname || null;
  }
  // safe text for HTML insertion
  function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ── session:restore ──────────────────────────────
  // Called by frontend on reconnect instead of re-sending password.
  // Uses the server-side onlinePlayers map to validate the socket session.
  socket.on('session:restore', async (payload, callback) => {
    // For now: restore from onlinePlayers map (populated on account:login).
    // If the socket reconnected and account:login fires on the 'connect' handler,
    // this will be called after. Check if this socket is already authenticated.
    const player = onlinePlayers.get(socket.id);
    if (player?.username) {
      const acc = accounts.get(player.username.toLowerCase()) || await dbGetAccount(player.username.toLowerCase());
      if (acc) {
        callback?.({ ok: true, player: { username: acc.username } });
        return;
      }
    }
    callback?.({ ok: false });
  });

  // ── guild:create ─────────────────────────────────
  socket.on('guild:create', async ({ name, tag, emblem } = {}) => {
    const uname   = authUname(socket.id);
    const display = authName(socket.id);
    if (!uname) { socket.emit('guild:error', { msg: 'Not logged in.' }); return; }

    const cleanName = String(name||'').trim();
    const cleanTag  = String(tag||'').trim().toUpperCase();
    const cleanEmb  = ALLOWED_EMBLEMS.includes(emblem) ? emblem : '🛡️';

    if (!GUILD_NAME_RE.test(cleanName)) { socket.emit('guild:error', { msg: 'Guild name must be 2-20 alphanumeric chars.' }); return; }
    if (!GUILD_TAG_RE.test(cleanTag))   { socket.emit('guild:error', { msg: 'Tag must be 2-5 uppercase letters/numbers.' }); return; }

    // Already in a guild?
    const existing = await dbGetPlayerGuild(uname);
    if (existing) { socket.emit('guild:error', { msg: 'Leave your current guild first.' }); return; }

    // Name taken?
    if (await dbGetGuildByName(cleanName.toLowerCase())) { socket.emit('guild:error', { msg: 'That guild name is already taken.' }); return; }

    // Generate unique code
    let code;
    do { code = require('crypto').randomBytes(3).toString('hex').toUpperCase(); }
    while (await dbGetGuild(code));

    const guild = {
      code, name: cleanName, nameLower: cleanName.toLowerCase(), tag: cleanTag, emblem: cleanEmb,
      leaderUname: uname,
      members: [{ uname, display, rank: 'Leader', joined: Date.now(), kills: 0, bossKills: 0 }],
      level: 1, xp: 0, xpToNext: 500,
      totalKills: 0, totalBossKills: 0,
      notice: 'Welcome to the guild!',
      createdAt: Date.now(),
    };
    await dbSaveGuild(guild);
    socket.join('guild:' + guild.code);
    socket.emit('guild:data', { guild: sanitizeGuild(guild) });
    console.log('[GUILD] Created: ' + cleanName + ' [' + cleanTag + '] by ' + display);
  });

  // ── guild:join ───────────────────────────────────
  socket.on('guild:join', async ({ code } = {}) => {
    const uname   = authUname(socket.id);
    const display = authName(socket.id);
    if (!uname) { socket.emit('guild:error', { msg: 'Not logged in.' }); return; }

    const cleanCode = String(code||'').trim().toUpperCase();
    if (!cleanCode) { socket.emit('guild:error', { msg: 'Enter an invite code.' }); return; }

    const guild = await dbGetGuild(cleanCode);
    if (!guild) { socket.emit('guild:error', { msg: 'Guild not found. Check the code.' }); return; }

    // Already a member?
    if (guild.members.some(m => m.uname === uname)) { socket.emit('guild:error', { msg: 'You are already in this guild.' }); return; }

    // Already in another guild?
    if (await dbGetPlayerGuild(uname)) { socket.emit('guild:error', { msg: 'Leave your current guild first.' }); return; }

    if (guild.members.length >= 30) { socket.emit('guild:error', { msg: 'Guild is full (30 members max).' }); return; }

    guild.members.push({ uname, display, rank: 'Member', joined: Date.now(), kills: 0, bossKills: 0 });
    await dbSaveGuild(guild);
    socket.join('guild:' + guild.code);
    const sanitized = sanitizeGuild(guild);
    socket.emit('guild:data', { guild: sanitized });
    // Notify existing members in real time
    socket.to('guild:' + guild.code).emit('guild:member_joined', { display, uname });
    console.log('[GUILD] ' + display + ' joined ' + guild.name);
  });

  // ── guild:fetch ──────────────────────────────────
  socket.on('guild:fetch', async () => {
    const t0 = Date.now();
    const uname = authUname(socket.id);
    if (!uname) { socket.emit('guild:data', { guild: null }); return; }
    // O(1) lookup via reverse index → guildCache → MongoDB
    const guild = await dbGetPlayerGuild(uname);
    console.log('[GUILD] fetch:', uname, guild ? guild.name : 'none', Date.now()-t0+'ms');
    // Join the guild's Socket.IO room for real-time push updates
    if (guild) socket.join('guild:' + guild.code);
    socket.emit('guild:data', { guild: guild ? sanitizeGuild(guild) : null });
  });

  // ── guild:notice ─────────────────────────────────
  socket.on('guild:notice', async ({ notice } = {}) => {
    const uname = authUname(socket.id);
    if (!uname) return;
    const guild = await dbGetPlayerGuild(uname);
    if (!guild) { socket.emit('guild:error', { msg: 'Not in a guild.' }); return; }

    const member = guild.members.find(m => m.uname === uname);
    if (!member || (member.rank !== 'Leader' && member.rank !== 'Officer')) {
      socket.emit('guild:error', { msg: 'Only Leader or Officer can edit the notice.' }); return;
    }
    guild.notice = String(notice||'').trim().substring(0, 200);
    await dbSaveGuild(guild);
    const noticeSanitized = sanitizeGuild(guild);
    // Push update to all guild members in the room
    io.to('guild:' + guild.code).emit('guild:data', { guild: noticeSanitized });
  });

  // ── guild:leave ──────────────────────────────────
  socket.on('guild:leave', async () => {
    const uname = authUname(socket.id);
    if (!uname) return;
    const guild = await dbGetPlayerGuild(uname);
    if (!guild) { socket.emit('guild:error', { msg: 'Not in a guild.' }); return; }
    if (guild.leaderUname === uname) { socket.emit('guild:error', { msg: 'Transfer leadership or disband before leaving.' }); return; }
    guild.members = guild.members.filter(m => m.uname !== uname);
    _unindexPlayer(uname);
    await dbSaveGuild(guild);
    socket.leave('guild:' + guild.code);
    socket.to('guild:' + guild.code).emit('guild:member_left', { uname });
    socket.emit('guild:data', { guild: null });
  });

  // ── guild:disband ────────────────────────────────
  socket.on('guild:disband', async () => {
    const uname = authUname(socket.id);
    if (!uname) return;
    const guild = await dbGetPlayerGuild(uname);
    if (!guild) { socket.emit('guild:error', { msg: 'Not in a guild.' }); return; }
    if (guild.leaderUname !== uname) { socket.emit('guild:error', { msg: 'Only the guild leader can disband.' }); return; }
    const disbandCode = guild.code;
    await dbDeleteGuild(disbandCode);
    // Notify all guild members and remove them from the room
    io.to('guild:' + disbandCode).emit('guild:disbanded', { msg: 'The guild has been disbanded.' });
    io.socketsLeave('guild:' + disbandCode);
    socket.emit('guild:data', { guild: null });
    console.log('[GUILD] Disbanded: ' + guild.name);
  });

  // ── guild:kick ───────────────────────────────────
  socket.on('guild:kick', async ({ targetUname } = {}) => {
    const uname = authUname(socket.id);
    if (!uname || !targetUname) return;
    const guild = await dbGetPlayerGuild(uname);
    if (!guild) { socket.emit('guild:error', { msg: 'Not in a guild.' }); return; }
    const actor  = guild.members.find(m => m.uname === uname);
    const target = guild.members.find(m => m.uname === targetUname);
    if (!actor || !target) { socket.emit('guild:error', { msg: 'Member not found.' }); return; }
    if (actor.rank !== 'Leader' && actor.rank !== 'Officer') {
      socket.emit('guild:error', { msg: 'Only Leader or Officer can kick members.' }); return;
    }
    if (target.rank === 'Leader') { socket.emit('guild:error', { msg: 'Cannot kick the guild leader.' }); return; }
    if (actor.rank === 'Officer' && target.rank === 'Officer') {
      socket.emit('guild:error', { msg: 'Officers cannot kick other officers.' }); return;
    }
    guild.members = guild.members.filter(m => m.uname !== targetUname);
    _unindexPlayer(targetUname);
    await dbSaveGuild(guild);
    const sanitized = sanitizeGuild(guild);
    io.to('guild:' + guild.code).emit('guild:data', { guild: sanitized });
    io.to('guild:' + guild.code).emit('guild:kicked', { uname: targetUname });
    console.log('[GUILD] ' + uname + ' kicked ' + targetUname + ' from ' + guild.name);
  });

  // ── guild:promote ─────────────────────────────────
  socket.on('guild:promote', async ({ targetUname } = {}) => {
    const uname = authUname(socket.id);
    if (!uname || !targetUname) return;
    const guild = await dbGetPlayerGuild(uname);
    if (!guild) { socket.emit('guild:error', { msg: 'Not in a guild.' }); return; }
    if (guild.leaderUname !== uname) { socket.emit('guild:error', { msg: 'Only the Leader can promote members.' }); return; }
    const target = guild.members.find(m => m.uname === targetUname);
    if (!target) { socket.emit('guild:error', { msg: 'Member not found.' }); return; }
    if (target.rank === 'Officer' || target.rank === 'Leader') {
      socket.emit('guild:error', { msg: 'Member is already an Officer or Leader.' }); return;
    }
    target.rank = 'Officer';
    await dbSaveGuild(guild);
    io.to('guild:' + guild.code).emit('guild:data', { guild: sanitizeGuild(guild) });
    console.log('[GUILD] ' + uname + ' promoted ' + targetUname + ' in ' + guild.name);
  });

  // ── guild:demote ──────────────────────────────────
  socket.on('guild:demote', async ({ targetUname } = {}) => {
    const uname = authUname(socket.id);
    if (!uname || !targetUname) return;
    const guild = await dbGetPlayerGuild(uname);
    if (!guild) { socket.emit('guild:error', { msg: 'Not in a guild.' }); return; }
    if (guild.leaderUname !== uname) { socket.emit('guild:error', { msg: 'Only the Leader can demote members.' }); return; }
    const target = guild.members.find(m => m.uname === targetUname);
    if (!target) { socket.emit('guild:error', { msg: 'Member not found.' }); return; }
    if (target.rank !== 'Officer') { socket.emit('guild:error', { msg: 'Member is not an Officer.' }); return; }
    target.rank = 'Member';
    await dbSaveGuild(guild);
    io.to('guild:' + guild.code).emit('guild:data', { guild: sanitizeGuild(guild) });
    console.log('[GUILD] ' + uname + ' demoted ' + targetUname + ' in ' + guild.name);
  });

  // ── guild:transfer ────────────────────────────────
  socket.on('guild:transfer', async ({ targetUname } = {}) => {
    const uname = authUname(socket.id);
    if (!uname || !targetUname) return;
    const guild = await dbGetPlayerGuild(uname);
    if (!guild) { socket.emit('guild:error', { msg: 'Not in a guild.' }); return; }
    if (guild.leaderUname !== uname) { socket.emit('guild:error', { msg: 'Only the current Leader can transfer ownership.' }); return; }
    const target = guild.members.find(m => m.uname === targetUname);
    if (!target) { socket.emit('guild:error', { msg: 'Member not found.' }); return; }
    // Demote old leader, promote new
    const oldLeader = guild.members.find(m => m.uname === uname);
    if (oldLeader) oldLeader.rank = 'Member';
    target.rank = 'Leader';
    guild.leaderUname = targetUname;
    await dbSaveGuild(guild);
    io.to('guild:' + guild.code).emit('guild:data', { guild: sanitizeGuild(guild) });
    console.log('[GUILD] Leadership transferred: ' + uname + ' → ' + targetUname);
  });

  // ── guild:kill ───────────────────────────────────
  // Kills are batched in memory and flushed to DB every 30s to avoid
  // a DB write on every single battle. Critical ops (create/join/leave/disband)
  // still persist immediately.
  async function recordGuildKill(uname, isBoss) {
    // O(1) lookup via reverse index
    const code = playerGuildIndex.get(uname);
    let guild = code ? guildCache.get(code) : null;
    if (!guild) {
      guild = await dbGetPlayerGuild(uname);
      if (!guild) return;
    }
    guild.totalKills = (guild.totalKills||0) + 1;
    if (isBoss) guild.totalBossKills = (guild.totalBossKills||0) + 1;
    guild.xp = (guild.xp||0) + (isBoss ? 50 : 5);
    const member = guild.members && guild.members.find(m => m.uname === uname);
    if (member) {
      member.kills = (member.kills||0) + 1;
      if(isBoss) member.bossKills = (member.bossKills||0) + 1;
    }
    while (guild.xp >= guild.xpToNext) {
      guild.xp -= guild.xpToNext;
      guild.level = (guild.level||1) + 1;
      guild.xpToNext = Math.floor((guild.xpToNext||500) * 1.5);
    }
    // Update cache with mutated guild — DB flush happens on schedule
    guildCache.set(guild.code, guild);
    guildDirtySet.add(guild.code);
  }
  socket._recordGuildKill = recordGuildKill;

  // ── Sanitize guild for client (escape all text fields) ──
  function sanitizeGuild(g) {
    return {
      code:           esc(g.code),
      name:           esc(g.name),
      tag:            esc(g.tag),
      emblem:         ALLOWED_EMBLEMS.includes(g.emblem) ? g.emblem : '🛡️',
      leaderUname:    g.leaderUname,
      level:          Math.max(1, g.level||1),
      xp:             Math.max(0, g.xp||0),
      xpToNext:       Math.max(1, g.xpToNext||500),
      totalKills:     Math.max(0, g.totalKills||0),
      totalBossKills: Math.max(0, g.totalBossKills||0),
      notice:         esc(g.notice||''),
      createdAt:      g.createdAt||0,
      members:        (g.members||[]).map(m => ({
        uname:    m.uname,
        display:  esc(m.display||m.uname),
        rank:     ['Leader','Officer','Member'].includes(m.rank) ? m.rank : 'Member',
        joined:   m.joined||0,
        kills:    Math.max(0, m.kills||0),
        bossKills:Math.max(0, m.bossKills||0),
      })),
    };
  }

  // ════════════════════════════════════════════════════
  //  FRIEND SYSTEM — server-authoritative, persistent
  // ════════════════════════════════════════════════════

  // ── friend:list ──────────────────────────────────────
  socket.on('friend:list', async (_, cb) => {
    const uname = authUname(socket.id);
    if (!uname) { cb?.({ ok: false, error: 'Not logged in.' }); return; }
    try {
      const payload = await buildFriendPayload(uname);
      cb?.({ ok: true, ...payload });
    } catch(e) {
      console.error('[FRIEND] list error:', e.message);
      cb?.({ ok: false, error: 'Could not load friends.' });
    }
  });

  // ── friend:search ─────────────────────────────────────
  socket.on('friend:search', async ({ query } = {}, cb) => {
    const uname = authUname(socket.id);
    if (!uname) { cb?.({ ok: false, error: 'Not logged in.' }); return; }
    const q = String(query||'').trim().toLowerCase();
    if (!q || q.length < 2) { cb?.({ ok: false, error: 'Enter at least 2 characters.' }); return; }
    if (q === uname) { cb?.({ ok: false, error: "That's you!" }); return; }
    try {
      let found = null;
      if (MONGO_URI) {
        const acc = await Account.findOne({ uname: q }).lean();
        if (acc) found = { uname: acc.uname, display: acc.username };
      } else {
        const acc = accounts.get(q);
        if (acc) found = { uname: acc.uname || q, display: acc.username || q };
      }
      if (!found) { cb?.({ ok: false, error: 'Player not found.' }); return; }

      // Check existing relationship
      const existing = await dbGetFriendship(uname, found.uname);
      let relationStatus = 'none';
      if (existing) {
        if (existing.status === 'accepted') relationStatus = 'friends';
        else if (existing.fromUname === uname) relationStatus = 'outgoing';
        else relationStatus = 'incoming';
      }
      // Is the player online?
      const isOnline = !!getSocketOfPlayer(found.uname);
      cb?.({ ok: true, player: { ...found, online: isOnline, relationStatus } });
    } catch(e) {
      console.error('[FRIEND] search error:', e.message);
      cb?.({ ok: false, error: 'Search failed.' });
    }
  });

  // ── friend:request:send ───────────────────────────────
  socket.on('friend:request:send', async ({ toUname } = {}, cb) => {
    const fromUname = authUname(socket.id);
    if (!fromUname) { cb?.({ ok: false, error: 'Not logged in.' }); return; }
    const to = String(toUname||'').trim().toLowerCase();
    if (!to) { cb?.({ ok: false, error: 'Invalid player.' }); return; }
    if (to === fromUname) { cb?.({ ok: false, error: 'You cannot add yourself.' }); return; }

    try {
      // Confirm target account exists
      const targetAcc = MONGO_URI
        ? await Account.findOne({ uname: to }).lean()
        : accounts.get(to);
      if (!targetAcc) { cb?.({ ok: false, error: 'Player not found.' }); return; }

      const existing = await dbGetFriendship(fromUname, to);
      if (existing) {
        if (existing.status === 'accepted') { cb?.({ ok: false, error: 'Already friends.' }); return; }
        if (existing.fromUname === fromUname) { cb?.({ ok: false, error: 'Request already sent.' }); return; }
        // They already sent us a request → auto-accept
        await dbUpsertFriendship(existing.fromUname, existing.toUname, 'accepted');
        cb?.({ ok: true, autoAccepted: true });
        // Notify both sides
        socket.emit('friend:list:update');
        const theirSid = getSocketOfPlayer(to);
        if (theirSid) io.to(theirSid).emit('friend:list:update');
        console.log('[FRIEND] Auto-accepted:', fromUname, '↔', to);
        return;
      }

      await dbUpsertFriendship(fromUname, to, 'pending');
      cb?.({ ok: true });

      // Notify recipient in real time if online
      const recipientSid = getSocketOfPlayer(to);
      if (recipientSid) {
        io.to(recipientSid).emit('friend:request:received', {
          fromUname,
          fromDisplay: authName(socket.id) || fromUname,
        });
      }
      console.log('[FRIEND] Request sent:', fromUname, '→', to);
    } catch(e) {
      console.error('[FRIEND] send error:', e.message);
      cb?.({ ok: false, error: 'Could not send request.' });
    }
  });

  // ── friend:request:cancel ─────────────────────────────
  socket.on('friend:request:cancel', async ({ toUname } = {}, cb) => {
    const fromUname = authUname(socket.id);
    if (!fromUname) { cb?.({ ok: false, error: 'Not logged in.' }); return; }
    const to = String(toUname||'').trim().toLowerCase();
    try {
      const existing = await dbGetFriendship(fromUname, to);
      if (!existing || existing.status !== 'pending' || existing.fromUname !== fromUname) {
        cb?.({ ok: false, error: 'No outgoing request found.' }); return;
      }
      await dbDeleteFriendship(fromUname, to);
      cb?.({ ok: true });
      const theirSid = getSocketOfPlayer(to);
      if (theirSid) io.to(theirSid).emit('friend:list:update');
      console.log('[FRIEND] Cancelled:', fromUname, '→', to);
    } catch(e) {
      cb?.({ ok: false, error: 'Could not cancel request.' });
    }
  });

  // ── friend:request:accept ─────────────────────────────
  socket.on('friend:request:accept', async ({ fromUname: reqFrom } = {}, cb) => {
    const uname = authUname(socket.id);
    if (!uname) { cb?.({ ok: false, error: 'Not logged in.' }); return; }
    const from = String(reqFrom||'').trim().toLowerCase();
    try {
      const existing = await dbGetFriendship(from, uname);
      // Must be a pending request where 'uname' is the recipient
      if (!existing || existing.status !== 'pending' || existing.toUname !== uname) {
        cb?.({ ok: false, error: 'No pending request from that player.' }); return;
      }
      await dbUpsertFriendship(existing.fromUname, existing.toUname, 'accepted');
      cb?.({ ok: true });
      // Notify both
      socket.emit('friend:list:update');
      const theirSid = getSocketOfPlayer(from);
      if (theirSid) io.to(theirSid).emit('friend:list:update');
      console.log('[FRIEND] Accepted:', from, '↔', uname);
    } catch(e) {
      cb?.({ ok: false, error: 'Could not accept request.' });
    }
  });

  // ── friend:request:reject ─────────────────────────────
  socket.on('friend:request:reject', async ({ fromUname: reqFrom } = {}, cb) => {
    const uname = authUname(socket.id);
    if (!uname) { cb?.({ ok: false, error: 'Not logged in.' }); return; }
    const from = String(reqFrom||'').trim().toLowerCase();
    try {
      const existing = await dbGetFriendship(from, uname);
      if (!existing || existing.status !== 'pending' || existing.toUname !== uname) {
        cb?.({ ok: false, error: 'No pending request from that player.' }); return;
      }
      await dbDeleteFriendship(from, uname);
      cb?.({ ok: true });
      const theirSid = getSocketOfPlayer(from);
      if (theirSid) io.to(theirSid).emit('friend:list:update');
      console.log('[FRIEND] Rejected:', from, '→', uname);
    } catch(e) {
      cb?.({ ok: false, error: 'Could not reject request.' });
    }
  });

  // ── friend:remove ─────────────────────────────────────
  socket.on('friend:remove', async ({ otherUname } = {}, cb) => {
    const uname = authUname(socket.id);
    if (!uname) { cb?.({ ok: false, error: 'Not logged in.' }); return; }
    const other = String(otherUname||'').trim().toLowerCase();
    try {
      const existing = await dbGetFriendship(uname, other);
      if (!existing || existing.status !== 'accepted') {
        cb?.({ ok: false, error: 'Not friends with that player.' }); return;
      }
      await dbDeleteFriendship(uname, other);
      cb?.({ ok: true });
      const theirSid = getSocketOfPlayer(other);
      if (theirSid) io.to(theirSid).emit('friend:list:update');
      console.log('[FRIEND] Removed:', uname, '↔', other);
    } catch(e) {
      cb?.({ ok: false, error: 'Could not remove friend.' });
    }
  });

  // ── DISCONNECT ────────────────────────────────────────
  socket.on('disconnect', () => {
    const room = getRoomOf(socket.id);
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        io.to(room.code).emit('player:left', { username: player.username });
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
          rooms.delete(room.code);
          console.log(`[ROOM] Deleted empty room: ${room.code}`);
        } else {
          if (room.host === socket.id) {
            room.host = room.players[0].id;
            io.to(room.code).emit('host:transferred', { username: room.players[0].username });
          }
          broadcastRoom(room);
        }
      }
    }
    socketToRoom.delete(socket.id);
    onlinePlayers.delete(socket.id);
    trades.forEach((t, id) => {
      if (t.from === socket.id || t.to === socket.id) trades.delete(id);
    });
    // SECURITY/CLEANUP: raids live in the same `rooms` map under a
    // 'raid_' key but weren't covered by the duel-room cleanup above —
    // an abandoned raid used to linger forever and leave the remaining
    // partner stuck with no 'raid:ended'/'raid:cancelled' ever arriving.
    rooms.forEach((raid, key) => {
      if (!key.startsWith('raid_')) return;
      if (raid.hostSocket !== socket.id && raid.guestSocket !== socket.id) return;
      const otherId = raid.hostSocket === socket.id ? raid.guestSocket : raid.hostSocket;
      const other = otherId ? io.sockets.sockets.get(otherId) : null;
      if (other) other.emit('raid:cancelled', { msg: 'Your raid partner disconnected.' });
      rooms.delete(key);
      console.log(`[RAID] Cleaned up raid ${key} after disconnect`);
    });
    broadcastLobby();
    console.log(`[-] ${socket.id} disconnected`);
  });
});

// ── Cleanup: stale rooms (3h) + stale trades (5min) ───────
setInterval(() => {
  const roomCutoff  = Date.now() - 3 * 60 * 60 * 1000;
  const tradeCutoff = Date.now() - 5 * 60 * 1000;
  for (const [code, room] of rooms)   if (room.created    < roomCutoff)  { rooms.delete(code);  }
  for (const [id, trade]  of trades)  if (trade.offeredAt < tradeCutoff) { trades.delete(id);   }
  // Clear login-lockout entries once expired/stale so these maps don't grow forever
  const now = Date.now();
  for (const [uname, e] of loginAttemptsByUname) if (e.lockedUntil && e.lockedUntil < now) loginAttemptsByUname.delete(uname);
  for (const [ip, e]    of loginAttemptsByIp)    if (now - e.windowStart > LOGIN_IP_WINDOW) loginAttemptsByIp.delete(ip);
}, 10 * 60 * 1000);

// ─────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────
const PORT    = process.env.PORT || 3000;
const localIP = getLocalIP();

// Connect to MongoDB then start server
connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║        AETHERION — Multiplayer Server        ║
╠══════════════════════════════════════════════╣
║                                              ║
║  Local:   http://localhost:${PORT}               ║
║  WiFi:    http://${localIP}:${PORT}          ║
║  Health:  /health                            ║
║                                              ║
║  📡 Local WiFi play:                         ║
║     Share the WiFi URL with players on       ║
║     the same network — no code needed!       ║
║                                              ║
╚══════════════════════════════════════════════╝
`);
  });
});
