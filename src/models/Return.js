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
}, { timestamps: true, _id: false });

export const Return = mongoose.model('Return', ReturnSchema);
