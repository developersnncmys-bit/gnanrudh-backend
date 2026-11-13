import mongoose from 'mongoose';

const ShipEventSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  oid: { type: String, index: true },
  type: String,
  at: { type: String, index: true },
  courier: String,
  awb: String,
  webhook: { type: String, default: 'Received' },
  detail: { type: String, default: null },
}, { _id: false });

export const ShipEvent = mongoose.model('ShipEvent', ShipEventSchema);
