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
}, { timestamps: true });

// TODO (SEC-03): existing seeded users have role 'admin' or 'staff' from the old enum.
// Owner must rename their account to 'owner' and reassign others to manager/packer/support
// before this validator will accept their next write. Run `scripts/migrate-user-roles.js`
// (dry-run first) when you have the mapping.

export const User = mongoose.model('User', UserSchema);
