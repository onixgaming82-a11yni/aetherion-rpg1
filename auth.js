'use strict';
// ============================================================
//  AETHERION — persistent login + password-reset core
//
//  Pure logic, no Express / Socket.IO dependency, so it can be unit-tested.
//  server.js wires it to HTTP routes and socket events.
//
//  Model
//  -----
//  * The browser holds ONE opaque credential: a 256-bit random token in an
//    HttpOnly cookie (never in localStorage, never in the game save).
//  * The server stores only SHA-256(token). A DB leak does not yield usable
//    credentials.
//  * Sockets cannot set cookies, so login hands the client a short-lived,
//    single-use "cookie ticket"; the client POSTs it to /auth/cookie and the
//    HTTP response sets the cookie. The raw token is generated at that moment
//    and exists only in that response.
//  * Restore on page load: POST /auth/session (cookie -> validated, rotated if
//    due) returns a single-use "bind ticket"; the client sends it over the
//    socket (session:restore) to authenticate that socket.
//  * Expiry, revocation and rotation are enforced server-side.
// ============================================================
const crypto = require('crypto');

const COOKIE_NAME = 'aeth_sid';
const DAY = 86_400_000;

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultConfig() {
  return {
    rememberMs:    envNum('SESSION_REMEMBER_DAYS', 30) * DAY,   // Remember Me lifetime (sliding, on rotation)
    absoluteMaxMs: envNum('SESSION_ABSOLUTE_MAX_DAYS', 90) * DAY, // hard cap from first login
    shortMs:       envNum('SESSION_SHORT_HOURS', 12) * 3_600_000, // non-persistent session, absolute
    rotateMs:      envNum('SESSION_ROTATE_DAYS', 7) * DAY,       // re-issue token at most this stale
    graceMs:       60_000,                                       // old token still valid briefly after rotation (multi-tab races)
    ticketMs:      30_000,                                       // cookie/bind ticket lifetime
    resetMs:       envNum('RESET_TOKEN_MINUTES', 30) * 60_000,   // password-reset link lifetime
    retainMs:      7 * DAY,                                      // keep dead sessions this long so we can say "expired"
  };
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url'); // 32 bytes = 256 bits

// ── Cookies ──────────────────────────────────────────────
function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  }
  return out;
}
function readCookieToken(header) {
  const t = parseCookies(header)[COOKIE_NAME];
  // Tokens are 43 base64url chars; reject anything else before touching storage.
  return typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
}
// maxAgeSec null/undefined => session cookie (dropped when the browser closes).
function buildSetCookie(token, { maxAgeSec = null, secure = false } = {}) {
  let c = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAgeSec != null) c += `; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
  if (secure) c += '; Secure';
  return c;
}
function buildClearCookie({ secure = false } = {}) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
}

// ── Small fixed-window rate limiter ──────────────────────
function createLimiter(max, windowMs) {
  const hits = new Map();
  return function allow(key) {
    const t = Date.now();
    if (hits.size > 20_000) for (const [k, e] of hits) if (t - e.start > windowMs) hits.delete(k);
    const e = hits.get(key);
    if (!e || t - e.start > windowMs) { hits.set(key, { n: 1, start: t }); return true; }
    e.n++;
    return e.n <= max;
  };
}

// ── Storage: in-memory (no MONGO_URI) ────────────────────
function createMemoryStore() {
  const sessions = new Map(); // sid -> doc
  const resets = new Map();   // uname -> { uname, tokenHash, expiresAt }
  const clone = (d) => (d ? { ...d } : null);
  return {
    kind: 'memory',
    async insertSession(doc) { sessions.set(doc.sid, { ...doc }); },
    async getBySid(sid) { return clone(sessions.get(sid)); },
    async findByTokenHash(h, t) {
      for (const d of sessions.values()) {
        if (d.tokenHash === h) return { doc: clone(d), matchedPrev: false };
        if (d.prevTokenHash === h && d.prevValidUntil > t) return { doc: clone(d), matchedPrev: true };
      }
      return null;
    },
    async updateSession(sid, patch) { const d = sessions.get(sid); if (d) Object.assign(d, patch); },
    async revokeSession(sid, t) { const d = sessions.get(sid); if (d && !d.revokedAt) d.revokedAt = t; },
    async revokeAllForUser(uname, exceptSid, t) {
      for (const d of sessions.values()) if (d.uname === uname && d.sid !== exceptSid && !d.revokedAt) d.revokedAt = t;
    },
    async deleteAllForUser(uname) {
      for (const [sid, d] of sessions) if (d.uname === uname) sessions.delete(sid);
      resets.delete(uname);
    },
    async putReset(doc) { resets.set(doc.uname, { ...doc }); }, // one live reset per account
    async takeReset(tokenHash) {
      for (const [u, d] of resets) if (d.tokenHash === tokenHash) { resets.delete(u); return { ...d }; }
      return null;
    },
    async sweep(t, retainMs) {
      for (const [sid, d] of sessions) if (d.expiresAt + retainMs < t) sessions.delete(sid);
      for (const [u, d] of resets) if (d.expiresAt < t) resets.delete(u);
    },
  };
}

// ── Storage: MongoDB ─────────────────────────────────────
// `ready()` must throw when the DB is unusable, so callers can tell
// "storage down" apart from "token is bad" and avoid logging people out
// during a database blip.
function createMongoStore(mongoose, ready) {
  const SessionSchema = new mongoose.Schema({
    sid:           { type: String, required: true, unique: true },
    uname:         { type: String, required: true, index: true },
    tokenHash:     { type: String, default: null, index: true },
    prevTokenHash: { type: String, default: null },
    prevValidUntil:{ type: Number, default: 0 },
    remember:      { type: Boolean, default: false },
    createdAt:     { type: Number, required: true },
    lastUsedAt:    { type: Number, required: true },
    rotatedAt:     { type: Number, required: true },
    expiresAt:     { type: Number, required: true },
    revokedAt:     { type: Number, default: null },
    ua:            { type: String, default: '' },
    purgeAt:       { type: Date, required: true }, // TTL — real deletion happens well after expiry
  });
  // Indexes MUST be declared before mongoose.model() (same rule as the other schemas in server.js).
  SessionSchema.index({ prevTokenHash: 1 });
  SessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  const Session = mongoose.models.AuthSession || mongoose.model('AuthSession', SessionSchema);

  const ResetSchema = new mongoose.Schema({
    uname:     { type: String, required: true, unique: true },
    tokenHash: { type: String, required: true, index: true },
    expiresAt: { type: Number, required: true },
    purgeAt:   { type: Date, required: true },
  });
  ResetSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  const Reset = mongoose.models.AuthReset || mongoose.model('AuthReset', ResetSchema);

  const lean = (q) => q.lean().maxTimeMS(3000);
  return {
    kind: 'mongo',
    models: { Session, Reset },
    async insertSession(doc) { ready(); await Session.create({ ...doc, purgeAt: new Date(doc.expiresAt + defaultConfig().retainMs) }); },
    async getBySid(sid) { ready(); return lean(Session.findOne({ sid })); },
    async findByTokenHash(h, t) {
      ready();
      let doc = await lean(Session.findOne({ tokenHash: h }));
      if (doc) return { doc, matchedPrev: false };
      doc = await lean(Session.findOne({ prevTokenHash: h, prevValidUntil: { $gt: t } }));
      return doc ? { doc, matchedPrev: true } : null;
    },
    async updateSession(sid, patch) {
      ready();
      const p = { ...patch };
      if (p.expiresAt != null) p.purgeAt = new Date(p.expiresAt + defaultConfig().retainMs);
      await Session.updateOne({ sid }, { $set: p }).maxTimeMS(3000);
    },
    async revokeSession(sid, t) { ready(); await Session.updateOne({ sid, revokedAt: null }, { $set: { revokedAt: t } }).maxTimeMS(3000); },
    async revokeAllForUser(uname, exceptSid, t) {
      ready();
      const q = { uname, revokedAt: null };
      if (exceptSid) q.sid = { $ne: exceptSid };
      await Session.updateMany(q, { $set: { revokedAt: t } }).maxTimeMS(3000);
    },
    async deleteAllForUser(uname) {
      ready();
      await Session.deleteMany({ uname }).maxTimeMS(3000);
      await Reset.deleteMany({ uname }).maxTimeMS(3000);
    },
    async putReset(doc) {
      ready();
      await Reset.findOneAndUpdate({ uname: doc.uname }, { ...doc, purgeAt: new Date(doc.expiresAt + 3_600_000) }, { upsert: true, maxTimeMS: 3000 });
    },
    async takeReset(tokenHash) { ready(); return lean(Reset.findOneAndDelete({ tokenHash })); },
    async sweep() { /* TTL indexes handle it */ },
  };
}

// ── Core ─────────────────────────────────────────────────
function createAuth({ store, config = {}, now = () => Date.now() } = {}) {
  if (!store) throw new Error('createAuth: store required');
  const cfg = { ...defaultConfig(), ...config };
  const tickets = new Map(); // sha256(ticket) -> { type, sid, exp }

  function issueTicket(type, sid) {
    const raw = newToken(24);
    tickets.set(sha256(raw), { type, sid, exp: now() + cfg.ticketMs });
    return raw;
  }
  function takeTicket(raw, type) {
    if (typeof raw !== 'string' || raw.length > 100) return null;
    const h = sha256(raw);
    const t = tickets.get(h);
    if (!t) return null;
    tickets.delete(h); // single use, even if rejected below
    return t.type === type && t.exp > now() ? t : null;
  }

  function statusOf(doc) {
    if (!doc) return 'invalid';
    if (doc.revokedAt) return 'revoked';
    if (doc.expiresAt <= now()) return 'expired';
    return 'ok';
  }
  function cookieAgeSec(doc) { return doc.remember ? Math.max(1, Math.floor((doc.expiresAt - now()) / 1000)) : null; }

  // Wrap storage so an outage becomes status 'unavailable' instead of a false "invalid".
  async function guarded(fn) {
    try { return await fn(); } catch (e) { return { status: 'unavailable', error: e }; }
  }

  return {
    config: cfg,

    // Create a session record for a freshly authenticated account. No token exists yet:
    // the cookie ticket is exchanged for it over HTTP.
    startSession: (uname, { remember = false, userAgent = '' } = {}) => guarded(async () => {
      const t = now();
      const doc = {
        sid: newToken(16), uname, tokenHash: null, prevTokenHash: null, prevValidUntil: 0,
        remember: remember === true, createdAt: t, lastUsedAt: t, rotatedAt: t,
        expiresAt: t + (remember === true ? cfg.rememberMs : cfg.shortMs),
        revokedAt: null, ua: String(userAgent || '').slice(0, 200),
      };
      await store.insertSession(doc);
      return { status: 'ok', sid: doc.sid, remember: doc.remember, expiresAt: doc.expiresAt, cookieTicket: issueTicket('cookie', doc.sid) };
    }),

    // HTTP side of login: ticket -> raw token (returned once) for Set-Cookie.
    redeemCookieTicket: (ticket) => guarded(async () => {
      const tk = takeTicket(ticket, 'cookie');
      if (!tk) return { status: 'invalid' };
      const doc = await store.getBySid(tk.sid);
      const st = statusOf(doc);
      if (st !== 'ok') return { status: st };
      const token = newToken(32);
      const t = now();
      await store.updateSession(doc.sid, { tokenHash: sha256(token), prevTokenHash: null, prevValidUntil: 0, rotatedAt: t, lastUsedAt: t });
      return { status: 'ok', token, maxAgeSec: cookieAgeSec(doc), uname: doc.uname, sid: doc.sid };
    }),

    // Validate the cookie. Rotates the token when it is older than rotateMs.
    resolveCookie: (rawToken) => guarded(async () => {
      if (!rawToken) return { status: 'invalid' };
      const t = now();
      const hit = await store.findByTokenHash(sha256(rawToken), t);
      if (!hit) return { status: 'invalid' };
      const doc = hit.doc;
      const st = statusOf(doc);
      if (st !== 'ok') return { status: st, uname: doc.uname, sid: doc.sid };

      const patch = { lastUsedAt: t };
      let out = { status: 'ok', uname: doc.uname, sid: doc.sid, remember: doc.remember };
      if (!hit.matchedPrev && t - doc.rotatedAt >= cfg.rotateMs) {
        const token = newToken(32);
        patch.prevTokenHash = doc.tokenHash;
        patch.prevValidUntil = t + cfg.graceMs;
        patch.tokenHash = sha256(token);
        patch.rotatedAt = t;
        if (doc.remember) patch.expiresAt = Math.min(t + cfg.rememberMs, doc.createdAt + cfg.absoluteMaxMs);
        out.newToken = token;
        out.maxAgeSec = cookieAgeSec({ ...doc, ...patch });
      }
      await store.updateSession(doc.sid, patch);
      return out;
    }),

    issueBindTicket: (sid) => issueTicket('bind', sid),
    // Socket side of restore. Re-checks the session so a revoke between the two calls wins.
    redeemBindTicket: (ticket) => guarded(async () => {
      const tk = takeTicket(ticket, 'bind');
      if (!tk) return { status: 'invalid' };
      const doc = await store.getBySid(tk.sid);
      const st = statusOf(doc);
      return st === 'ok' ? { status: 'ok', uname: doc.uname, sid: doc.sid } : { status: st };
    }),

    getSession: (sid) => guarded(async () => store.getBySid(sid)),
    revokeSession: (sid) => guarded(async () => { await store.revokeSession(sid, now()); return { status: 'ok' }; }),
    revokeAllForUser: (uname, exceptSid = null) => guarded(async () => { await store.revokeAllForUser(uname, exceptSid, now()); return { status: 'ok' }; }),
    deleteAllForUser: (uname) => guarded(async () => { await store.deleteAllForUser(uname); return { status: 'ok' }; }),

    // Password reset: 256-bit single-use token, only its hash is stored, one live token per account.
    createResetToken: (uname) => guarded(async () => {
      const raw = newToken(32);
      await store.putReset({ uname, tokenHash: sha256(raw), expiresAt: now() + cfg.resetMs });
      return { status: 'ok', token: raw, expiresAt: now() + cfg.resetMs };
    }),
    consumeResetToken: (raw) => guarded(async () => {
      if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return { status: 'invalid' };
      const d = await store.takeReset(sha256(raw)); // atomic take: cannot be used twice
      if (!d) return { status: 'invalid' };
      if (d.expiresAt <= now()) return { status: 'expired' };
      return { status: 'ok', uname: d.uname };
    }),

    sweep: () => store.sweep(now(), cfg.retainMs).catch(() => {}),
    sweepTickets() { const t = now(); for (const [k, v] of tickets) if (v.exp <= t) tickets.delete(k); },
  };
}

module.exports = {
  COOKIE_NAME, createAuth, createMemoryStore, createMongoStore, createLimiter,
  parseCookies, readCookieToken, buildSetCookie, buildClearCookie, sha256, newToken, defaultConfig,
};
