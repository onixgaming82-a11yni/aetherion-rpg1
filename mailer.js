'use strict';
// ============================================================
//  AETHERION — outbound mail (password reset)
//
//  Uses an HTTPS email API (Resend) through Node's built-in `https`,
//  so there is no new dependency and it works on hosts that block
//  outbound SMTP (e.g. Render's free tier).
//
//  Env:
//    RESEND_API_KEY   API key from resend.com
//    MAIL_FROM        e.g. "Aetherion <no-reply@yourdomain.com>" (domain must be verified)
//    PUBLIC_URL       e.g. "https://aetherion.onrender.com" — base of reset links
//
//  Without RESEND_API_KEY: in development the reset link is printed to the
//  server console so the flow can be tested; in production nothing secret is
//  logged and a warning is printed instead.
// ============================================================
const https = require('https');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function isConfigured() { return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM); }

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname + u.search, timeout: 8000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { if (buf.length < 4000) buf += c; });
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(buf) : reject(new Error(`mail API ${res.statusCode}: ${buf.slice(0, 200)}`))));
    });
    req.on('timeout', () => req.destroy(new Error('mail API timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

// links: [{ username, url }]
async function sendPasswordReset(to, links, minutes) {
  const subject = 'Reset your Aetherion password';
  const text = [
    'Someone asked to reset the password for your Aetherion account.',
    '',
    ...links.map((l) => `Account "${l.username}": ${l.url}`),
    '',
    `The link works once and expires in ${minutes} minutes.`,
    'If you did not request this, you can ignore this email — your password has not changed.',
  ].join('\n');
  const html = `<div style="font-family:Georgia,serif;max-width:480px;margin:auto;color:#2a1a40">
    <h2 style="color:#6a3fa0">Aetherion — Realm of Legends</h2>
    <p>Someone asked to reset the password for your account.</p>
    ${links.map((l) => `<p><a href="${esc(l.url)}" style="display:inline-block;padding:10px 16px;background:#c99a45;color:#1a0f2a;text-decoration:none;border-radius:6px">Reset password for ${esc(l.username)}</a></p>`).join('')}
    <p style="font-size:13px;color:#666">The link works once and expires in ${minutes} minutes. If you didn't request this, ignore this email — your password hasn't changed.</p></div>`;

  if (!isConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[MAIL] RESEND_API_KEY / MAIL_FROM not set — password-reset email NOT sent.');
    } else {
      console.log(`[MAIL:dev] Reset email for ${to}:\n${text}`);
    }
    return false;
  }
  await postJson('https://api.resend.com/emails', { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    { from: process.env.MAIL_FROM, to: [to], subject, text, html });
  return true;
}

module.exports = { sendPasswordReset, isConfigured };
