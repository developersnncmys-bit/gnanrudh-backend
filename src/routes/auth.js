import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { loginLimit, recordLoginFailure } from '../middleware/loginLimiter.js';
import { permsFor } from '../permissions.js';
import { newSessionId, parseUserAgent } from '../sessions.js';

export const authRouter = Router();

// POST /api/auth/login  { email, password } → { token, user }
authRouter.post('/login', loginLimit, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const user = await User.findOne({ email: String(email).toLowerCase().trim() });
  if (!user) {
    await recordLoginFailure(req.loginAttempt);
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  const ok = await bcrypt.compare(String(password), user.passwordHash);
  if (!ok) {
    await recordLoginFailure(req.loginAttempt);
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  // SEC-03: disabled users can authenticate (correct password) but can't
  // log in. Message deliberately generic so an attacker can't tell the
  // difference between "wrong password" and "disabled account".
  if (user.disabled) {
    await recordLoginFailure(req.loginAttempt);
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  user.lastLoginAt = new Date();
  await user.save();

  // SEC-06: register this login as a Session so the admin can revoke
  // specific devices from Settings → Admin login. sid rides inside the
  // JWT; requireAuth checks it's still live on every request.
  const sid = newSessionId();
  await Session.create({
    _id: sid,
    uid: String(user._id),
    deviceLabel: parseUserAgent(req.headers['user-agent']),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
    ip: req.ip || '',
    lastActiveAt: new Date(),
  });

  const token = signToken(user, sid);
  res.json({
    token,
    user: {
      id: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      // Effective permission list — the per-user override if the admin
      // ticked any boxes in Settings → Team, otherwise the role defaults.
      // The sidebar filter picks it up on the admin's first paint.
      permissions: permsFor(user),
    },
  });
}));

// GET /api/auth/me — validates the current token
authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.sub).lean();
  if (!user) return res.status(401).json({ error: 'User no longer exists' });
  res.json({
    id: user._id,
    email: user.email,
    name: user.name,
    role: user.role,
    lastLoginAt: user.lastLoginAt,
    permissions: permsFor(user),
  });
}));

// GET /api/auth/sessions — the signed-in user's live device sessions.
// Current session (the one driving this request) is flagged so the UI
// can show a "this device" tag + suppress its Sign out button.
authRouter.get('/sessions', requireAuth, asyncHandler(async (req, res) => {
  const items = await Session.find({ uid: req.user.sub })
    .sort({ lastActiveAt: -1 })
    .lean();
  res.json({
    items: items.map((s) => ({
      id: s._id,
      deviceLabel: s.deviceLabel,
      location: s.location || '',
      lastActiveAt: s.lastActiveAt,
      createdAt: s.createdAt,
      current: s._id === req.user.sid,
    })),
  });
}));

// DELETE /api/auth/sessions/:id — revoke one session (sign out that
// device). Refuses to delete the current session so the owner doesn't
// accidentally boot themselves while trying to clean up old devices —
// they can use the top-right Sign out instead.
authRouter.delete('/sessions/:id', requireAuth, asyncHandler(async (req, res) => {
  const sid = String(req.params.id || '');
  if (!sid) return res.status(400).json({ error: 'Session id required' });
  if (sid === req.user.sid) {
    return res.status(409).json({ error: "This is your current device — use Sign out at the top-right instead." });
  }
  const result = await Session.deleteOne({ _id: sid, uid: req.user.sub });
  if (!result.deletedCount) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true, deletedId: sid });
}));

// POST /api/auth/password — change own password  { current, next }
authRouter.post('/password', requireAuth, asyncHandler(async (req, res) => {
  const { current, next } = req.body || {};
  if (!current || !next) return res.status(400).json({ error: 'Current and new password required' });
  if (String(next).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const user = await User.findById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'User no longer exists' });
  const ok = await bcrypt.compare(String(current), user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
  user.passwordHash = await bcrypt.hash(String(next), 10);
  await user.save();
  res.json({ ok: true });
}));
