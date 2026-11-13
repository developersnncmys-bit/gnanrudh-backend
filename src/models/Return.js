import mongoose from 'mongoose';

const ReturnSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  oid: { type: String, required: true, index: true },
  pid: String,
  cid: { type: String, index: true },
  reason: String,
  requested: String,
  amount: Number,
  excluded: { type: Boolean, default: false },
  stitched: { type: Boolean, default: false },
  status: { type: String, index: true },
  awb: { type: String, default: null },
  // RET-01: snapshot of the delivered-at timestamp and the window applied, so
  // historical eligibility decisions remain auditable even if Settings changes later.
  deliveredAt: { type: String, default: null },
  windowDays: { type: Number, default: null },
  // RET-02: customer-uploaded evidence (URLs on the uploads host).
  photos: { type: [String], default: [] },
}, { timestamps: true, _id: false });

// PERF-01: compound index for status queue + chronological scan.
ReturnSchema.index({ status: 1, requested: -1 });

export const Return = mongoose.model('Return', ReturnSchema);
