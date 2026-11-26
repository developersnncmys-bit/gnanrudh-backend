// Team management — CRUD for admin users (owner only).
// Mounted at /api/team.
//
// Access:
//   - GET  /team                       owner, manager  (read-only listing)
//   - POST /team                       owner           (invite / create user)
//   - PATCH  /team/:id                 owner           (name, role, disabled)
//   - POST   /team/:id/reset-password  owner           (force-set password)
//   - DELETE /team/:id                 owner           (hard delete; forbids self-delete)
//
// Disabling or resetting a password bumps User.tokenInvalidBefore so the
// target user's existing token is rejected on their next request — see
// requireAuth in middleware/auth.js.

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User, ROLES } from '../models/User.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const teamRouter = Router();

// Strip the passwordHash from any response. Nothing else on the admin
// client should ever see it.
function publicUser(u) {
  if (!u) return null;
  return {
    id: u._id,
    email: u.email,
    name: u.name || '',
    role: u.role,
    disabled: !!u.disabled,
    lastLoginAt: u.lastLoginAt || null,
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null,
  };
}

function validEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// GET /team — list every admin user. Owners and managers can read; packer /
// support don't need the roster and shouldn't see it.
teamRouter.get(
  '/',
  requireAuth,
  requireRole('owner', 'manager'),
  asyncHandler(async (req, res) => {
    const users = await User.find({}).sort({ createdAt: 1 }).lean();
    res.json({ items: users.map(publicUser), total: users.length });
  }),
);

// POST /team — invite a new admin.
// Body: { email, name?, role, password }
// Password is set by the owner at invite time and shared out-of-band; a
// proper email-invite flow can replace this later without changing the
// client contract.
teamRouter.post(
  '/',
  requireAuth,
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim();
    const role = String(req.body?.role || '').trim();
    const password = String(req.body?.password || '');
    if (!validEmail(email)) return res.status(400).json({ error: 'A valid email is required' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const exists = await User.findOne({ email }).lean();
    if (exists) return res.status(409).json({ error: 'A user with that email already exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, name, role, passwordHash });
    res.status(201).json(publicUser(user.toObject()));
  }),
);

// PATCH /team/:id — update name / role / disabled.
// Email changes aren't supported here (would break existing login + audit
// trails); a user who wants a different email should be invited fresh and
// the old row deleted.
teamRouter.patch(
  '/:id',
  requireAuth,
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const body = req.body || {};
    if (typeof body.name === 'string') target.name = body.name.trim();
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
      // Don't let the last owner demote themselves — that bricks the admin.
      if (target.role === 'owner' && body.role !== 'owner') {
        const owners = await User.countDocuments({ role: 'owner', disabled: { $ne: true } });
        if (owners <= 1) return res.status(409).json({ error: 'This is the last active owner. Promote someone else to owner first.' });
      }
      target.role = body.role;
    }
    if (body.disabled !== undefined) {
      const wantDisabled = !!body.disabled;
      // Same safety net — don't let the last owner disable themselves.
      if (wantDisabled && target.role === 'owner') {
        const owners = await User.countDocuments({ role: 'owner', disabled: { $ne: true } });
        if (owners <= 1) return res.status(409).json({ error: 'This is the last active owner. Promote someone else to owner before disabling.' });
      }
      // Prevent disabling yourself — nothing stopping a re-enable, but an
      // accidental self-disable while logged in is a locked-out footgun.
      if (wantDisabled && String(target._id) === String(req.user.sub)) {
        return res.status(409).json({ error: "You can't disable your own account." });
      }
      if (wantDisabled && !target.disabled) target.tokenInvalidBefore = new Date();
      target.disabled = wantDisabled;
    }
    await target.save();
    res.json(publicUser(target.toObject()));
  }),
);

// POST /team/:id/reset-password — force-set a new password on another user.
// Bumps tokenInvalidBefore so their active token stops working immediately.
teamRouter.post(
  '/:id/reset-password',
  requireAuth,
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    const password = String(req.body?.password || '');
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    target.passwordHash = await bcrypt.hash(password, 10);
    target.tokenInvalidBefore = new Date();
    await target.save();
    res.json({ ok: true });
  }),
);

// DELETE /team/:id — hard delete. Forbid self-delete and last-owner delete.
teamRouter.delete(
  '/:id',
  requireAuth,
  requireRole('owner'),
  asyncHandler(async (req, res) => {
    if (String(req.params.id) === String(req.user.sub)) {
      return res.status(409).json({ error: "You can't delete your own account." });
    }
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'owner') {
      const owners = await User.countDocuments({ role: 'owner', disabled: { $ne: true } });
      if (owners <= 1) return res.status(409).json({ error: 'This is the last active owner. Promote someone else to owner first.' });
    }
    await User.deleteOne({ _id: target._id });
    res.json({ ok: true, deletedId: target._id });
  }),
);
