import mongoose from 'mongoose';

// SEC-04: per-IP+email failure log for login rate limiting.
// TTL index wipes entries 15 minutes after creation so the limiter resets automatically.
const LoginAttemptSchema = new mongoose.Schema({
  key: { type: String, required: true, index: true },
  at: { type: Date, required: true, default: Date.now, expires: 60 * 15 },
});

export const LoginAttempt = mongoose.model('LoginAttempt', LoginAttemptSchema);
