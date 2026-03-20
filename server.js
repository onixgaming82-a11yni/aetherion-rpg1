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

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout:  60000,
  pingInterval: 25000,
});

// ── Static files ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
const ADMIN_KEY = process.env.ADMIN_KEY || 'onixadmin2025';
const adminAuth = (req,res,next) => { if(req.headers['x-admin-key']!==ADMIN_KEY){res.status(403).json({error:'Forbidden'});return;} next(); };

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
const DEFAULT_PASSWORD = '12345';

function hashPassword(pw) {
  let hash = 0;
  for(let i = 0; i < pw.length; i++){
    hash = ((hash << 5) - hash) + pw.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

// ── MongoDB Schema ─────────────────────────────────────────
const AccountSchema = new mongoose.Schema({
  username:  { type: String, required: true, unique: true },
  uname:     { type: String, required: true, unique: true }, // lowercase key
  password:  { type: String, required: true },
  save:      { type: String, default: null }, // JSON string of game save
  createdAt: { type: Number, default: Date.now },
  lastLogin: { type: Number, default: Date.now },
});
const Account = mongoose.model('Account', AccountSchema);

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
  if (!MONGO_URI) return;
  try {
    await Account.findOneAndUpdate(
      { uname: data.uname },
      data,
      { upsert: true, new: true }
    );
  } catch(e) { console.warn('[DB] Save error:', e.message); }
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
    onlinePlayers.set(socket.id, {
      id:       socket.id,
      username: username.trim().substring(0, 20),
      level:    level    || 1,
      deckSize: deckSize || 0,
      gold:     gold     || 0,
      joinedAt: Date.now(),
    });
    socket.emit('player:registered', { id: socket.id });
    broadcastLobby();
    console.log(`[REG] ${username} registered`);
  });

  // ── HOST ROOM ─────────────────────────────────────────
  // Payload: { username, deck, level }
  socket.on('room:host', ({ username, deck, level } = {}) => {
    if (!username) { socket.emit('error', { msg: 'Username required' }); return; }

    const code = genCode();
    const room = {
      code,
      host: socket.id,
      players: [{
        id:       socket.id,
        username: username.trim().substring(0, 20),
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

    const player = {
      id:       socket.id,
      username: username.trim().substring(0, 20),
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
    if (storyBlocks) room.storyBlocks = storyBlocks;

    if (mode === 'duel') {
      const [p1, p2] = room.players;
      const makeCombatant = (p) => {
        const activeCard = p.deck?.[0] || {};
        return {
          id:              p.id,
          name:            p.username,
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
    }
  });

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
  // Payload: { hp, gold, level, deckSize }
  socket.on('player:sync', ({ hp, gold, level, deckSize } = {}) => {
    const room = getRoomOf(socket.id);
    if (room) {
      const p = room.players.find(p => p.id === socket.id);
      if (p) {
        if (hp       !== undefined) p.hp       = hp;
        if (gold     !== undefined) p.gold     = gold;
        if (level    !== undefined) p.level    = level;
        if (deckSize !== undefined) p.deckSize = deckSize;
        broadcastRoom(room);
      }
    }
    const op = onlinePlayers.get(socket.id);
    if (op) {
      if (level    !== undefined) op.level    = level;
      if (deckSize !== undefined) op.deckSize = deckSize;
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
  // Payload: { username, password? }
  // ── ACCOUNT: REGISTER ────────────────────────────────
  socket.on('account:register', async ({ username, password } = {}) => {
    if (!username?.trim()) { socket.emit('account:error', { msg: 'Username required' }); return; }

    let base  = username.trim();
    let uname = base.toLowerCase();

    // Check if taken (MongoDB first, fallback to memory)
    const existsDB  = await dbGetAccount(uname);
    const existsMem = accounts.has(uname);

    if (existsDB || existsMem) {
      let counter = 2;
      while ((await dbGetAccount((base+counter).toLowerCase())) || accounts.has((base+counter).toLowerCase())) counter++;
      base  = base + counter;
      uname = base.toLowerCase();
      socket.emit('account:renamed', { suggestedName: base });
    }

    const pw   = password?.trim() || DEFAULT_PASSWORD;
    const data = { username: base, uname, password: hashPassword(pw), save: null, createdAt: Date.now(), lastLogin: Date.now() };

    // Save to MongoDB + memory
    await dbSaveAccount(data);
    accounts.set(uname, data);

    socket.emit('account:registered', { username: base, isNew: true });
    console.log(`[ACCOUNT] Registered: ${base}`);
  });

  // ── ACCOUNT: LOGIN ────────────────────────────────────
  socket.on('account:login', async ({ username, password } = {}) => {
    if (!username?.trim()) { socket.emit('account:error', { msg: 'Username required' }); return; }
    const uname = username.trim().toLowerCase();

    // Try MongoDB first, then memory fallback
    let acc = await dbGetAccount(uname) || accounts.get(uname);

    if (!acc) {
      // New account — auto create
      const pw   = password?.trim() || DEFAULT_PASSWORD;
      const data = { username: username.trim(), uname, password: hashPassword(pw), save: null, createdAt: Date.now(), lastLogin: Date.now() };
      await dbSaveAccount(data);
      accounts.set(uname, data);
      socket.emit('account:loggedin', { username: username.trim(), save: null, isNew: true });
      console.log(`[ACCOUNT] Auto-created: ${username}`);
      return;
    }

    const pw = password?.trim() || DEFAULT_PASSWORD;
    if (acc.password !== hashPassword(pw)) {
      socket.emit('account:error', { msg: 'Wrong password! Try again.' });
      return;
    }

    // Update last login
    acc.lastLogin = Date.now();
    await dbSaveAccount({ ...acc, uname });
    accounts.set(uname, acc);

    socket.emit('account:loggedin', { username: acc.username, save: acc.save, isNew: false });
    console.log(`[ACCOUNT] Login: ${username}`);
  });

  // ── ACCOUNT: SAVE GAME ────────────────────────────────
  socket.on('account:save', async ({ username, password, save } = {}) => {
    if (!username?.trim()) return;
    const uname = username.trim().toLowerCase();
    // Block saves for banned or suspended accounts
    const f = flagged.get(uname);
    if (f && f.level === 'banned') {
      socket.emit('account:save:blocked', { reason: 'banned' });
      console.log(`[SAVE BLOCKED] ${username} — permanently banned`);
      return;
    }
    if (isOnHold(uname)) {
      socket.emit('account:save:blocked', { reason: 'suspended' });
      console.log(`[SAVE BLOCKED] ${username} — on hold`);
      return;
    }
    let acc = await dbGetAccount(uname) || accounts.get(uname);
    if (!acc) return;
    const pw = password?.trim() || DEFAULT_PASSWORD;
    if (acc.password !== hashPassword(pw)) return;
    acc.save = save;
    await dbSaveAccount({ ...acc, uname });
    accounts.set(uname, acc);
    socket.emit('account:saved', { ok: true });
  });

  // ── ACCOUNT: CHANGE PASSWORD ──────────────────────────
  socket.on('account:changepass', async ({ username, oldPassword, newPassword } = {}) => {
    if (!username?.trim()) { socket.emit('account:error', { msg: 'Not logged in' }); return; }
    const uname = username.trim().toLowerCase();
    let acc = await dbGetAccount(uname) || accounts.get(uname);
    if (!acc) { socket.emit('account:error', { msg: 'Account not found' }); return; }
    const oldPw = oldPassword?.trim() || DEFAULT_PASSWORD;
    if (acc.password !== hashPassword(oldPw)) { socket.emit('account:error', { msg: 'Current password is wrong!' }); return; }
    const newPw = newPassword?.trim();
    if (!newPw || newPw.length < 3) { socket.emit('account:error', { msg: 'New password must be at least 3 characters' }); return; }
    acc.password = hashPassword(newPw);
    await dbSaveAccount({ ...acc, uname });
    accounts.set(uname, acc);
    socket.emit('account:passchanged', { ok: true });
    console.log(`[ACCOUNT] Password changed: ${username}`);
  });

  // ── ACCOUNT: DELETE ───────────────────────────────────
  socket.on('account:delete', async ({ username, password } = {}) => {
    if (!username?.trim()) { socket.emit('account:error', { msg: 'Not logged in' }); return; }
    const uname = username.trim().toLowerCase();
    let acc = await dbGetAccount(uname) || accounts.get(uname);
    if (!acc) { socket.emit('account:error', { msg: 'Account not found' }); return; }
    const pw = password?.trim() || DEFAULT_PASSWORD;
    if (acc.password !== hashPassword(pw)) { socket.emit('account:error', { msg: 'Wrong password! Cannot delete account.' }); return; }
    await dbDeleteAccount(uname);
    accounts.delete(uname);
    socket.emit('account:deleted', { ok: true });
    console.log(`[ACCOUNT] Deleted: ${username}`);
  });

  // ── LEADERBOARD ───────────────────────────────────
  socket.on('leaderboard:update', ({ name, wins, rankName } = {}) => {
    if (!name?.trim() || wins === undefined) return;
    const uname = name.trim().toLowerCase();
    const f = flagged.get(uname);

    // Permanently banned — remove from leaderboard entirely
    if (f && f.level === 'banned') {
      leaderboard.delete(uname);
      console.log(`[LB] ${name} removed — permanently banned`);
      return;
    }

    leaderboard.set(uname, {
      name: name.trim(),
      wins: parseInt(wins)||0,
      rankName: rankName||'Stone',
      updatedAt: Date.now(),
      flagLevel: f?.level || null,
      flagReason: f?.reason || null,
    });
    console.log(`[LB] ${name}: ${wins} wins`);
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
        const accToBan = await dbGetAccount(uname) || accounts.get(uname);
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
  socket.on('raid:host', ({ code, bossId, bossName, hostName } = {}) => {
    if (!code?.trim()) return;
    rooms.set(`raid_${code}`, { code, bossId, bossName, hostName, guest: null, hostSocket: socket.id });
    console.log(`[RAID] ${hostName} hosted raid ${code} — boss: ${bossName}`);
  });

  socket.on('raid:join', ({ code, playerName } = {}) => {
    const raid = rooms.get(`raid_${code}`);
    if (!raid) { socket.emit('raid:error', { msg: 'Raid room not found!' }); return; }
    if (raid.guest) { socket.emit('raid:error', { msg: 'Raid room is full!' }); return; }
    raid.guest = playerName;
    raid.guestSocket = socket.id;
    rooms.set(`raid_${code}`, raid);
    // Notify host
    const hostSock = io.sockets.sockets.get(raid.hostSocket);
    if (hostSock) hostSock.emit('raid:partner_joined', { partnerName: playerName });
    socket.emit('raid:joined', { bossId: raid.bossId, bossName: raid.bossName, hostName: raid.hostName });
    console.log(`[RAID] ${playerName} joined ${raid.hostName}'s raid`);
  });

  socket.on('raid:attack', ({ code, damage, playerName } = {}) => {
    const raid = rooms.get(`raid_${code}`);
    if (!raid) return;
    // Broadcast to partner
    const partnerId = socket.id === raid.hostSocket ? raid.guestSocket : raid.hostSocket;
    const partnerSock = io.sockets.sockets.get(partnerId);
    if (partnerSock) partnerSock.emit('raid:partner_attack', { damage, partnerName: playerName });
  });

  socket.on('raid:cancel', ({ code } = {}) => {
    rooms.delete(`raid_${code}`);
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
