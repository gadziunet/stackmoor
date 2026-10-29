import crypto from 'node:crypto';

const COOKIE = 'sp_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// --- hasła (scrypt z biblioteki standardowej, bez dodatkowych zależności) ---

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [algo, saltB64, hashB64] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: 16384, r: 8, p: 1,
  });
  return crypto.timingSafeEqual(expected, actual);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Hasło musi mieć co najmniej 10 znaków.';
  }
  return null;
}

// --- sesje w SQLite ---

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(db, userId, req, res) {
  const id = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(id, userId, Date.now() + SESSION_TTL_MS);
  setCookie(req, res, id, SESSION_TTL_MS / 1000);
}

export function destroySession(db, req, res) {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  setCookie(req, res, '', 0);
}

function setCookie(req, res, value, maxAge) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAge)}`,
  ];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function sessionMiddleware(db) {
  const find = db.prepare(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`
  );
  const cleanup = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  setInterval(() => cleanup.run(Date.now()), 60 * 60 * 1000).unref();

  return (req, _res, next) => {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    req.user = id ? find.get(id, Date.now()) ?? null : null;
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Zaloguj się ponownie.' });
  next();
}

// Dodatkowa ochrona przed CSRF: żądania zmieniające stan muszą mieć nagłówek,
// którego przeglądarka nie doda sama przy wysłaniu formularza z obcej strony.
export function requireAppHeader(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.get('X-Requested-With') !== 'stackpanel') {
    return res.status(403).json({ error: 'Nieprawidłowe żądanie.' });
  }
  next();
}

// Prosty limit prób logowania: 10 na 15 minut z jednego adresu.
const attempts = new Map();
export function loginRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.reset < now) {
    attempts.set(key, { count: 1, reset: now + 15 * 60 * 1000 });
    return next();
  }
  if (++entry.count > 10) {
    return res.status(429).json({ error: 'Za dużo prób logowania. Spróbuj za kilka minut.' });
  }
  next();
}
