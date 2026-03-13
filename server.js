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

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const crypto   = require('crypto');
const os       = require('os');

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
      const makeCard = (p) => ({
        id:              p.id,
        name:            p.username,
        emoji:           p.deck?.[0]?.emoji  || '⚔️',
        cardName:        p.deck?.[0]?.name   || p.username,
        hp:              p.deck?.[0]?.hp     || 80,
        maxHp:           p.deck?.[0]?.hp     || 80,
        atk:             p.deck?.[0]?.attack  || 12,
        def:             p.deck?.[0]?.defense || 6,
        mag:             p.deck?.[0]?.magic   || 8,
        ability:         p.deck?.[0]?.ability || 'Strike',
        abilityCooldown: 0,
      });
      room.battleState = {
        turn:         0,
        activePlayer: p1.id,
        combatants:   [makeCard(p1), makeCard(p2)],
        log:          [`⚔️ Duel begins! ${p1.username} vs ${p2.username}`],
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
  socket.on('battle:action', ({ action } = {}) => {
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
