import mongoose from 'mongoose';

const MovementSchema = new mongoose.Schema({
  _id: { type: String, required: true },     // e.g. "MV123"
  code: { type: String, required: true, index: true },   // piece code
  pid: { type: String, required: true, index: true },
  vid: { type: String, required: true },
  from: { type: String, default: '—' },
  to: { type: String, required: true, index: true },
  note: { type: String, default: '' },
  oid: { type: String, default: null, index: true },
  by: { type: String, default: 'System' },
  at: { type: String, required: true, index: true },
}, { timestamps: true, _id: false });

export const Movement = mongoose.model('Movement', MovementSchema);
