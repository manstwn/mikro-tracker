import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const PIN = process.env.PIN || '';
const PIN_ENABLED = PIN.length > 0;
const COOKIE_NAME = 'mm_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

// Derive a stable HMAC secret from the PIN so tokens survive restarts.
// If no PIN is set this is irrelevant (PIN_ENABLED=false means auth is skipped).
const HMAC_SECRET = crypto
  .createHmac('sha256', 'mm-auth-secret-v1')
  .update(PIN || 'no-pin')
  .digest('hex');

export function isPinEnabled() {
  return PIN_ENABLED;
}

export function verifyPin(pin) {
  return PIN_ENABLED && pin === PIN;
}

// Create a stateless signed token: base64(payload).signature
export function createSession() {
  const payload = Buffer.from(
    JSON.stringify({ t: Date.now(), exp: Date.now() + SESSION_MAX_AGE * 1000 })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// No-op — stateless tokens can't be explicitly invalidated without a denylist.
// For a simple home-use monitor, logout just clears the client-side token.
export function destroySession(_token) {
  // stateless: nothing to do server-side
}

export function isValidSession(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  try {
    const expectedSig = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
    // Constant-time comparison to prevent timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Date.now() < data.exp;
  } catch {
    return false;
  }
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((part) => {
    const [key, ...rest] = part.trim().split('=');
    if (key) cookies[key] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

export function getSessionToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME];
}

export function buildSessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

const PUBLIC_EXACT = new Set([
  '/pin.html',
  '/api/auth/pin',
  '/api/auth/check',
  '/api/auth/logout',
  '/health'
]);

function isPublicPath(p) {
  if (PUBLIC_EXACT.has(p)) return true;
  if (p.startsWith('/webhook/')) return true;
  return false;
}

function shouldRedirectToPin(p) {
  return p === '/' || p === '/index.html';
}

export function authMiddleware(req, res, next) {
  if (!PIN_ENABLED) return next();
  if (isPublicPath(req.path)) return next();

  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    token = getSessionToken(req);
  }

  if (isValidSession(token)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  if (shouldRedirectToPin(req.path)) {
    return res.redirect('/pin.html');
  }

  // Static assets (app.js, style.css, etc.) return 401 — browser already has them
  // when the user is authenticated; a 401 won't create a redirect loop.
  return res.status(401).send('Unauthorized');
}

export function socketAuthMiddleware(socket, next) {
  if (!PIN_ENABLED) return next();
  const token =
    socket.handshake.auth?.token ||
    parseCookies(socket.handshake.headers.cookie)[COOKIE_NAME];
  if (isValidSession(token)) return next();
  next(new Error('Unauthorized'));
}
