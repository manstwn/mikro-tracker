import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const PIN = process.env.PIN || '';
const PIN_ENABLED = PIN.length > 0;
const sessions = new Set();
const COOKIE_NAME = 'mm_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

export function isPinEnabled() {
  return PIN_ENABLED;
}

export function verifyPin(pin) {
  return PIN_ENABLED && pin === PIN;
}

export function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  return token;
}

export function destroySession(token) {
  if (token) sessions.delete(token);
}

export function isValidSession(token) {
  return !!token && sessions.has(token);
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

function isPublicPath(path) {
  if (PUBLIC_EXACT.has(path)) return true;
  if (path.startsWith('/webhook/')) return true;
  return false;
}

function shouldRedirectToPin(path) {
  return path === '/' || path === '/index.html' || path === '/app.js' || path === '/style.css';
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

  return res.status(401).send('Unauthorized');
}

export function socketAuthMiddleware(socket, next) {
  if (!PIN_ENABLED) return next();
  const token = socket.handshake.auth?.token || parseCookies(socket.handshake.headers.cookie)[COOKIE_NAME];
  if (isValidSession(token)) return next();
  next(new Error('Unauthorized'));
}
