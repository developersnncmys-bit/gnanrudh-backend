import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/User.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Missing bearer token' });
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });

    // SEC-03: look up the user doc so we can enforce the `disabled` flag
    // and the `tokenInvalidBefore` watermark bumped by password resets /
    // role changes. One lean projection per authed request — cheap enough
    // for an admin-panel-scale workload. If this ever becomes a hot path,
    // cache per-sub in memory with a short TTL.
    // Customer tokens carry a string Customer._id in `sub`; User._id is an
    // ObjectId, so a User.findById on a customer sub throws a CastError
    // and lands in the Invalid-token branch below — breaking every
    // customer-auth route. requireCustomer re-validates the customer doc
    // (and its own tokenInvalidBefore) downstream, so for customer tokens
    // we skip the User lookup here entirely.
    if (payload.role !== 'customer') {
      const u = await User.findById(payload.sub).select('disabled tokenInvalidBefore').lean();
      if (!u) return res.status(401).json({ error: 'User no longer exists' });
      if (u.disabled) return res.status(401).json({ error: 'This account has been disabled' });
      if (u.tokenInvalidBefore && payload.iat && (payload.iat * 1000) < new Date(u.tokenInvalidBefore).getTime()) {
        return res.status(401).json({ error: 'Session ended, please sign in again' });
      }
    }

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
