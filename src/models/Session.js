import mongoose from 'mongoose';

// SEC-06: one document per active admin login. Keeps JWTs "stateful enough"
// to support per-device sign-out: requireAuth looks up the Session by the
// JWT's `sid` claim and rejects the request if it's missing (revoked).
//
// Not used for customer tokens — customers use the simpler
// tokenInvalidBefore timestamp on the Customer doc.

const SessionSchema = new mongoose.Schema({
  _id: { type: String, required: true },     // short random id, embedded in JWT as `sid`
  uid: { type: String, required: true, index: true }, // User._id (stringified ObjectId)
  // Parsed from the request's User-Agent on login.
  deviceLabel: { type: String, default: 'Unknown device' },
  location: { type: String, default: '' },
  // Full UA + IP kept for forensic use if an owner audits sessions. Not
  // shown in the admin UI today; leaving them here means we don't have
  // to migrate when we eventually surface them.
  userAgent: { type: String, default: '' },
  ip: { type: String, default: '' },
  lastActiveAt: { type: Date, default: () => new Date() },
}, { timestamps: true, _id: false });

// Lookups are driven by `sid` (the _id) or the full-list-for-user query.
SessionSchema.index({ uid: 1, lastActiveAt: -1 });

export const Session = mongoose.model('Session', SessionSchema);
