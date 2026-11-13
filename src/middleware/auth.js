import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Missing bearer token' });
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    req.user = payload;
    // SEC-03: sliding window refresh. If the token has less than the configured
    // threshold left, issue a fresh one and send it via a response header so the
    // client can rotate without the user noticing.
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && (payload.exp - now) < config.jwtRefreshThresholdSec) {
      const next = signToken({ _id: payload.sub, email: payload.email, role: payload.role });
      res.setHeader('X-Refreshed-Token', next);
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
    next();
  };
}
