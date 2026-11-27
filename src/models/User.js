import mongoose from 'mongoose';

// SEC-03 role model:
//  - owner:   everything (business owner). Can manage users + Settings.
//  - manager: everything except user management and dangerous destructives.
//  - packer:  packing bench and barcodes only. Read-only on orders and products.
//  - support: orders read, returns, reviews.
export const ROLES = ['owner', 'manager', 'packer', 'support'];

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  passwordHash: { type: String, required: true },
  name: { type: String, default: '' },
  role: { type: String, enum: ROLES, default: 'manager' },
  lastLoginAt: { type: Date, default: null },
  // SEC-03 team management:
  //  - `disabled` is a soft-ban. Disabled users can't log in and their
  //    existing tokens are rejected on the next request.
  //  - `tokenInvalidBefore` is bumped whenever an owner resets the user's
  //    password or disables them. requireAuth rejects any token whose
  //    `iat` (issued-at) falls before this timestamp, so a disabled or
  //    just-reset user can't keep using the token that was in their
  //    browser a moment ago.
  disabled: { type: Boolean, default: false },
  tokenInvalidBefore: { type: Date, default: null },
  // SEC-05: per-user permission override. Empty array = use the role's
  // default permission list (ROLE_PERMISSIONS[role] in permissions.js).
  // Non-empty = authoritative list for this user, ignoring the role.
  // Owners always get every permission regardless of what's stored here —
  // enforced server-side in permsFor().
  permissions: { type: [String], default: [] },
}, { timestamps: true });

// TODO (SEC-03): existing seeded users have role 'admin' or 'staff' from the old enum.
// Owner must rename their account to 'owner' and reassign others to manager/packer/support
// before this validator will accept their next write. Run `scripts/migrate-user-roles.js`
// (dry-run first) when you have the mapping.

export const User = mongoose.model('User', UserSchema);
