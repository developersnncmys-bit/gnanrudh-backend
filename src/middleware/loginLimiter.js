import { LoginAttempt } from '../models/LoginAttempt.js';

// SEC-04: 10 failures per 15 minutes, counted separately per IP and per email.
// Either bucket hitting the cap returns 429 with Retry-After.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

function clientIp(req) {
  // Vercel sets x-forwarded-for with the real client IP first.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.ip || 'unknown';
}

export async function loginLimit(req, res, next) {
  const ip = clientIp(req);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const since = new Date(Date.now() - WINDOW_MS);
  const [ipFails, emailFails] = await Promise.all([
    LoginAttempt.countDocuments({ key: `ip:${ip}`, at: { $gte: since } }),
    email ? LoginAttempt.countDocuments({ key: `email:${email}`, at: { $gte: since } }) : Promise.resolve(0),
  ]);
  if (ipFails >= MAX_FAILS || emailFails >= MAX_FAILS) {
    res.setHeader('Retry-After', String(Math.ceil(WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Too many failed login attempts. Try again in 15 minutes.' });
  }
  // Give the login handler a way to record failures without duplicating the key logic.
  req.loginAttempt = { ip, email };
  next();
}

export async function recordLoginFailure({ ip, email }) {
  const at = new Date();
  const docs = [{ key: `ip:${ip}`, at }];
  if (email) docs.push({ key: `email:${email}`, at });
  await LoginAttempt.insertMany(docs);
}
