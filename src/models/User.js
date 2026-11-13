import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  passwordHash: { type: String, required: true },
  name: { type: String, default: '' },
  role: { type: String, enum: ['admin', 'staff'], default: 'admin' },
  lastLoginAt: { type: Date, default: null },
}, { timestamps: true });

export const User = mongoose.model('User', UserSchema);
