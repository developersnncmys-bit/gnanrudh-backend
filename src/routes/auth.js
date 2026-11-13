import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { loginLimit, recordLoginFailure } from '../middleware/loginLimiter.js';

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

  user.lastLoginAt = new Date();
  await user.save();

  const token = signToken(user);
  res.json({
    token,
    user: { id: user._id, email: user.email, name: user.name, role: user.role },
  });
}));

// GET /api/auth/me — validates the current token
authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.sub).lean();
  if (!user) return res.status(401).json({ error: 'User no longer exists' });
  res.json({ id: user._id, email: user.email, name: user.name, role: user.role, lastLoginAt: user.lastLoginAt });
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
