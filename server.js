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

// ── Get local WiFi IP (shown in console) ──────────────────
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
    leaderboard.set(name.trim().toLowerCase(), {
      name: name.trim(),
      wins: parseInt(wins)||0,
      rankName: rankName||'Stone',
      updatedAt: Date.now(),
    });
    console.log(`[LB] ${name}: ${wins} wins`);
  });

  socket.on('leaderboard:request', () => {
    const data = [...leaderboard.values()]
      .sort((a,b) => b.wins - a.wins)
      .slice(0, 100); // top 100
    socket.emit('leaderboard:data', data);
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
