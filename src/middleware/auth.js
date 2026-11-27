import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';

// `sid` is optional so legacy pre-session tokens still verify — they just
// won't have per-device sign-out (they fall through the Session check in
// requireAuth below). Once every live token has rolled over past expiry
// this fallback can go.
export function signToken(user, sid) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, role: user.role, sid: sid || undefined },
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
      // SEC-05: load the per-user permissions override too. Empty array
      // (the default) means "fall back to role defaults" — permsFor()
      // handles the resolution.
      const u = await User.findById(payload.sub).select('disabled tokenInvalidBefore permissions role').lean();
      if (!u) return res.status(401).json({ error: 'User no longer exists' });
      if (u.disabled) return res.status(401).json({ error: 'This account has been disabled' });
      if (u.tokenInvalidBefore && payload.iat && (payload.iat * 1000) < new Date(u.tokenInvalidBefore).getTime()) {
        return res.status(401).json({ error: 'Session ended, please sign in again' });
      }
      // SEC-06: per-device session check. If the token carries a `sid`,
      // the matching Session must still exist and belong to this user.
      // Revoking a session (via DELETE /auth/sessions/:id) deletes the
      // Session doc, which makes every subsequent request fail here with
      // a clear "signed out" message.
      if (payload.sid) {
        const session = await Session.findOne({ _id: payload.sid, uid: payload.sub }).lean();
        if (!session) return res.status(401).json({ error: 'Signed out on this device' });
        // Non-blocking: update lastActiveAt so the Admin > Signed-in
        // devices list orders by recency. Any failure is swallowed —
        // the request already succeeded from the auth side.
        Session.updateOne({ _id: payload.sid }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
      }
      payload.permissions = Array.isArray(u.permissions) ? u.permissions : [];
      // The DB is the source of truth for role too — a token minted before
      // a role change would otherwise keep the old privileges until expiry.
      payload.role = u.role || payload.role;
    }

    req.user = payload;
    // SEC-03: sliding window refresh. If the token has less than the configured
    // threshold left, issue a fresh one and send it via a response header so the
    // client can rotate without the user noticing. Carries the sid forward so
    // the refreshed token stays attached to the same device session.
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && (payload.exp - now) < config.jwtRefreshThresholdSec) {
      const next = signToken({ _id: payload.sub, email: payload.email, role: payload.role }, payload.sid);
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
