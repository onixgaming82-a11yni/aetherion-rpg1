# Aetherion — persistent login & password reset

## How it works
- **Remember Me** (login checkbox) controls the lifetime of one server-issued, 256-bit opaque token kept in an
  `HttpOnly; SameSite=Lax` cookie (`Secure` automatically over HTTPS). Checked: 30-day persistent cookie.
  Unchecked: browser-session cookie + 12 h server-side expiry. Only SHA-256(token) is stored server-side.
- The browser never sees the token in JS and it is never put in localStorage or the game save.
  `aetherion_hero_name` still only prefills the username; it grants nothing.
- Flow: login -> `auth:cookieTicket` (one-time, 30 s) -> `POST /auth/cookie` sets the cookie.
  Page load / reconnect -> `POST /auth/session` (cookie checked, rotated if >7 days old) -> one-time bind ticket ->
  socket `session:restore`.
- Expired/revoked sessions are rejected server-side, the cookie is cleared and the login screen shows a message.
  Logout, password change (other devices), password reset (all devices) and account deletion revoke sessions.
- **Forgot password**: username or recovery email -> single-use, 30-minute, hashed reset token emailed as
  `PUBLIC_URL/#reset=<token>` (fragment is stripped from the address bar on load). Identical response whether or not
  the account exists. Recovery email is optional at registration and editable in Settings (needs current password).

## Environment variables
| Var | Purpose |
|---|---|
| `MONGO_URI` | Sessions persist in MongoDB when set (collections `authsessions`, `authresets`); otherwise memory only |
| `PUBLIC_URL` | **Required in production** for reset links, e.g. `https://yourgame.onrender.com` |
| `RESEND_API_KEY`, `MAIL_FROM` | Email delivery via Resend's HTTPS API (no SMTP, works on Render free tier) |
| `ALLOWED_ORIGINS` | Comma list; default is same-origin only (was `*`) |
| `COOKIE_SECURE` | `true`/`false` to override auto-detection |
| `TRUST_PROXY=1` | Use X-Forwarded-For for the new per-IP limits (auto-on when `RENDER` is set) |
| `SESSION_REMEMBER_DAYS` (30), `SESSION_ABSOLUTE_MAX_DAYS` (90), `SESSION_SHORT_HOURS` (12), `SESSION_ROTATE_DAYS` (7), `RESET_TOKEN_MINUTES` (30) | Lifetimes |

Without mail settings, development prints the reset link to the server console; production logs a warning only.

## Tests
`node --test test/auth.test.js` (no dependencies) and `node --test test/auth.integration.test.js` (needs `npm install` + `socket.io-client`).
