import mongoose from 'mongoose';

const CouponSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // code
  kind: { type: String, enum: ['Percent', 'Flat'], required: true },
  value: { type: Number, required: true },
  min: { type: Number, default: 0 },
  scope: String,
  uses: { type: Number, default: 0 },
  limit: { type: Number, default: null },
  ends: { type: String, default: null },
  on: { type: Boolean, default: true },
}, { timestamps: true, _id: false });

export const Coupon = mongoose.model('Coupon', CouponSchema);
